import { fnv1a } from '../hash.js';
import { realpathSync } from 'node:fs';
import path from 'node:path';
import { compareCanonicalText } from './canonical-verification.js';
import {
  canonicalCropMetrics, canonicalBlockBands, leadingGalleySkip,
  canonicalCropWitness, certifiedCanonicalCrop,
} from './canonical-crop.js';
import { cropSvgAt } from './util/svg.js';
import { hfBandChunkKey, hfRenderChunkKey, hfSlotExtent } from './display-list.js';
import { slotFingerprint, pageHfSig } from './header-footer.js';
import { betweenUpdates, mapCurrent, rootKey } from './header-scheduler.js';
import { floatProbe, HF_FOLIO, HF_PARITY, HF_UNESTABLISHED, probeContext } from './page-metadata.js';
import { formatFolio } from './util/tex.js';
import { walkItemRuns } from './util/galley.js';

const PAPER_EPSILON_PT = 0.5;

/** A structured display has one document-wide viewport. Once the canonical
 * PDF proves that any page uses another displayed box or any `/Rotate`, its
 * pixels and the provisional source-hit SVG no longer share coordinates.
 * Return explicit reasons so the arrival path can fail closed to the exact
 * opaque renderer even when static source scanning missed an indirect macro,
 * class hook, included file, or package implementation. */
/** Every canonical page shares the first page's displayed box and has no
 * /Rotate: one coordinate system covers the whole document. */
export function uniformCanonicalGeometry(info) {
  const papers = Array.isArray(info?.papers) ? info.papers : [];
  const first = papers[0];
  return papers.every((paper) => !((Math.round(Number(paper?.rotation) || 0) % 360)) &&
    Math.abs(Number(paper?.w) - Number(first?.w)) <= PAPER_EPSILON_PT &&
    Math.abs(Number(paper?.h) - Number(first?.h)) <= PAPER_EPSILON_PT);
}

export function canonicalGeometryMismatchReasons(geometry, info) {
  const count = Math.max(0, Math.floor(Number(info?.pageCount) || 0));
  if (!count) return [];
  const width = Number(geometry?.paperwidth);
  const height = Number(geometry?.paperheight);
  if (!(width > 0 && height > 0)) return ['canonical geometry gate: resident paper geometry is unavailable'];
  const papers = Array.isArray(info?.papers) ? info.papers : [];
  if (papers.length < count || papers.slice(0, count).some((paper) =>
    !(Number(paper?.w) > 0 && Number(paper?.h) > 0))) {
    return ['canonical geometry gate: per-page PDF geometry is incomplete'];
  }
  const reasons = [];
  for (let index = 0; index < count; index++) {
    const paper = papers[index];
    const rotation = ((Math.round(Number(paper.rotation) || 0) % 360) + 360) % 360;
    if (rotation !== 0) {
      reasons.push(`canonical geometry gate: page ${index + 1} has /Rotate ${rotation}`);
      continue;
    }
    if (Math.abs(Number(paper.w) - width) > PAPER_EPSILON_PT ||
        Math.abs(Number(paper.h) - height) > PAPER_EPSILON_PT) {
      reasons.push(
        `canonical geometry gate: page ${index + 1} is ${Number(paper.w).toFixed(3)}x${Number(paper.h).toFixed(3)}pt, ` +
        `resident viewport is ${width.toFixed(3)}x${height.toFixed(3)}pt`
      );
    }
  }
  return reasons;
}

export function onCanonicalResult(
  engine,
  info,
  { verifyAgainstCanonical, cropCanonicalChunks, teardownTree = () => {} }
) {
  // A shipping-exact surface is canonical and ShippingChain pixels, each
  // page in its own displayed geometry; no resident page shares its
  // coordinates (tex64-internal #64: pdflscape keeps the document).
  if (!info.error && engine.mode === 'structured' && engine.previewPolicy !== 'shipping-exact' &&
      info.rev === engine.srcRev) {
    const reasons = canonicalGeometryMismatchReasons(engine.geometry, info);
    if (reasons.length) {
      const stickyPre = engine.preHash;
      engine.mode = 'opaque';
      engine.modeReasons = reasons;
      engine.opaqueStickyPre = stickyPre;
      engine.canonical.pressure = 'display';
      engine.diagnostics.push(`structured layer demoted to opaque: ${reasons.join('; ')}`);
      teardownTree();
    }
  }
  try {
    engine.onCanonical?.({ ...info, modeReasons: engine.modeReasons });
  } catch { /* observer errors are not ours */ }
  if (info.error || engine.closureDeferred || process.env.TDOM_NO_VERIFY) return;
  // verify only at convergence: the compile must be of the CURRENT source
  if (engine.mode !== 'structured' || info.rev !== engine.srcRev) return;
  // canonical-anchor deliberately does not claim that JS pagination maps
  // onto physical pages (two-column output is the motivating case). Its
  // resident tree is a TeX-native line-layout probe only; page text
  // comparison and coordinate cropping would therefore manufacture false
  // mismatches and wrong-page chunks.
  if (engine.previewPolicy !== 'structured') return;
  return verifyAgainstCanonical(info)
    .catch((err) => {
      engine.diagnostics.push('verification failed to run: ' + err.message);
    })
    .then(() => cropCanonicalChunks(info))
    .catch((err) => {
      engine.diagnostics.push('canonical crop failed: ' + err.message);
    });
}

// ---------------------------------------------------------------------------
// Exact bands and retained entries (docs/10 §10.7a, F1–F7). A head or foot
// that draws (TikZ, rules in PDF literals: the header entry's `hg`/`fg`) is
// shown from the canonical page's own band, or not at all (v0.1.32's
// presentation). Whether a band, or an entry the runs job made for another
// layout, is drawn on a page is one stateless predicate over what was
// recorded of it (its source, page, geometry, spec, fingerprint), evaluated
// every time the page is built.

// (pages whose two bands one pass cuts from a canonical page, between updates)
const CANON_BAND_SLICE = 8;
// Bound transient conversion failures to one queue per generation.
const CANON_BAND_TRIES = 3;
// (the generations whose pages are bound: the canonical layer keeps four PDFs)
const BINDINGS_KEPT = 4;
// (c53846b cut, per canonical arrival, the first 80 drawing pages of its
// header map in the order the map kept them, its keys sorted as strings:
// p1, p10, p100, ... A band of another source is reused only on those pages,
// F7)
const C53_BANDS = Number(process.env.TDOM_HF_CROP_MAX || 80);

/** Where the head and foot bands of a page are: above the text area, and
 * below it to the foot of the paper (\@outputpage). */
export function furnitureBands(geo) {
  const T = 72 + (geo.topmargin ?? 0) + (geo.headheight ?? 0) + (geo.headsep ?? 0);
  return { h: [0, T], f: [T + (geo.textheight ?? 0), geo.paperheight] };
}

const geometryKeys = new WeakMap();
export const geometryKey = (geo) => {
  if (!geo) return '';
  let key = geometryKeys.get(geo);
  if (key === undefined) {
    key = [geo.paperwidth, geo.paperheight, geo.topmargin, geo.headheight, geo.headsep,
      geo.textheight, geo.oddsidemargin, geo.evensidemargin, geo.footskip, geo.textwidth]
      .map((v) => Number(v ?? 0).toFixed(2)).join(':');
    geometryKeys.set(geo, key);
  }
  return key;
};
const folioKey = (spec) => (spec ? `${spec.fmt}:${spec.folio}` : null);

/** The spec the builder noted for `page`, while the noted pages are the ones
 * it belongs to (else null). */
function notedSpec(engine, page) {
  const noted = engine.currentSpecs;
  const n = page?.number;
  return noted && Number.isInteger(n) && noted.pages?.[n - 1] === page ? noted.specs[n - 1] ?? null : null;
}

/** Whether the engine holds the very source `gen` was compiled from (an undo
 * or redo back to it): the revision, else the text's length, then its hash
 * (once per revision). */
function sameSource(engine, gen) {
  if (engine.srcRev === gen.rev) return true;
  const source = engine.getSource();
  if (source.length !== gen.srcLength) return false;
  if (engine.hfSourceHash?.rev !== engine.srcRev) {
    engine.hfSourceHash = { rev: engine.srcRev, hash: engine.canonical.compilationIdentity(source).srcHash };
  }
  return engine.hfSourceHash.hash === gen.srcHash;
}

/** The exact-paper and resident-render source matches that affect slot validation. */
export function furnitureSourceKey(engine) {
  let key = engine.chunks.furnitureRenderRevs?.has(engine.srcRev) ? `r${engine.srcRev}` : '';
  for (const gen of engine.chunks.furnitureGenerations?.keys() ?? []) {
    if (sameSource(engine, gen)) key += `/${gen.id}`;
  }
  return key;
}

/** Whether the header map is the runs of the layout `page` belongs to (the
 * runs job for the current layout, from this root, has landed). */
export function runsCurrent(engine, page) {
  const noted = engine.currentSpecs;
  return mapCurrent(engine, noted) && noted.pages?.[page.number - 1] === page;
}

/** F4 iii: the runs of the current layout are still to come (not landed, and
 * the job for this layout did not fail). */
function runsPending(engine) {
  const noted = engine.currentSpecs;
  return !!noted && !mapCurrent(engine, noted) && engine.hfFailedSig !== noted.sig;
}

/**
 * F4 iii: whether the component in which spec `now` differs from `was` is
 * one the runs job measured slot `which` (the head `h`, the foot `f`, or
 * both when none is named) not to change with, in the context of `was`
 * (its template, the folio's parity and where floats landed: page-metadata.js
 * probeContext; header-scheduler.js measureSensitivity), for the root the
 * engine has now. The marks and LastPage are free only where, besides, the
 * slot did not read them at all as it was set for `was` (`reads`, the
 * entry's `hr`/`fr`, daemon.lua tdom_hf_trace): the probes' two values are
 * stand-ins, and a head that prints "Solutions" for one mark alone took the
 * same branch for both (audit/scratch r11 conditional). Where floats
 * landed is probed with the very state it changes to. Another style, chain
 * of body definitions or folio, a context not measured, what was read not
 * known, or more than one component at once (their joint effect was not
 * measured: audit/scratch r10 even) counts as a change.
 */
export function specInsensitive(engine, was, now, which = null, reads = null) {
  if (!was || !now || was.tpl == null || was.style !== now.style ||
      (was.tpl !== now.tpl && (was.tplBody == null || was.tplBody !== now.tplBody))) return false;
  const slots = which ? [which] : ['h', 'f'];
  if (folioKey(was) !== folioKey(now) && !slots.every((slot) => folioIndependent(engine, reads?.[slot]))) return false;
  if (!slots.every((slot) => sameSlotState(was, now, reads?.deps?.[slot]))) return false;
  if (was.fl === 'p' && now.fl === 'p' && was.flCarry !== now.flCarry) return false;
  const differs = [];
  if (was.lmark !== now.lmark || was.rmark !== now.rmark) differs.push('marks');
  if (was.lp !== now.lp) differs.push('lp');
  if (was.fl !== now.fl) differs.push(floatProbe(was.fl, now.fl));
  if (!differs.length) return true;
  if (differs.length > 1 || differs[0] == null) return false;
  const measured = engine.hfSens;
  if (!measured || measured.root !== rootKey(engine)) return false;
  const sens = measured.byTpl.get(probeContext(was));
  if (!sens) return false;
  const bit = SPEC_READS[differs[0]] ?? 0;
  return slots.every((slot) => sens[slot]?.[differs[0]] === false &&
    (!bit || (Number.isInteger(reads?.[slot]) && (reads[slot] & bit) === 0)));
}
// (what a slot's trace reports reading of a component: daemon.lua tdom_hf_read)
const SPEC_READS = { marks: 1, lp: 2 };

/** What an entry's slots read as they were set (`hr`/`fr`), or null. */
const entryReads = (entry) => (entry ? {
  h: entry.hr, f: entry.fr, deps: { h: entry.hdeps, f: entry.fdeps },
} : null);

const fingerprints = new WeakMap();
const coverage = new WeakMap();
const uncertainty = new WeakMap();
const readSets = new WeakMap();
const coveredReads = new WeakMap();
const noValues = new Map();
const noUncertainty = new Set();

function stateValues(state) {
  if (!state) return noValues;
  let values = fingerprints.get(state);
  if (!values) {
    values = new Map(state.values?.map(([name, digest]) => [name, digest]));
    fingerprints.set(state, values);
  }
  return values;
}

function stateCoverage(state) {
  if (!state?.covered) return null;
  const names = state.covered;
  if (!coverage.has(names)) coverage.set(names, new Set(names));
  return coverage.get(names);
}

function stateUncertainty(state) {
  if (!state?.uncertain?.length) return noUncertainty;
  if (!uncertainty.has(state)) uncertainty.set(state, new Set(state.uncertain));
  return uncertainty.get(state);
}

function sameSlotState(was, now, deps) {
  if (deps?.length === 0) return true;
  if (!deps && (was?.state?.guarded || now?.state?.guarded)) return false;
  if (deps && was?.state === now?.state && !now?.state?.covered && !now?.state?.uncertain?.length) return true;
  const a = stateValues(was?.state);
  const b = stateValues(now?.state);
  const aUncertain = stateUncertainty(was?.state);
  const bUncertain = stateUncertainty(now?.state);
  const aCovered = stateCoverage(was?.state);
  const bCovered = stateCoverage(now?.state);
  if (!deps) return !a.size && !b.size && !aUncertain.size && !bUncertain.size && !aCovered && !bCovered;
  let reads = readSets.get(deps);
  if (!reads) readSets.set(deps, reads = new Set(deps));
  for (const known of [aCovered, bCovered]) {
    if (!known) continue;
    let checks = coveredReads.get(known);
    if (!checks) coveredReads.set(known, checks = new WeakMap());
    let complete = checks.get(deps);
    if (complete === undefined) {
      complete = deps.every((name) => name === '$font' || name === '$color' || known.has(name));
      checks.set(deps, complete);
    }
    if (!complete) return false;
  }
  for (const name of aUncertain) if (reads.has(name)) return false;
  for (const name of bUncertain) if (reads.has(name)) return false;
  for (const [name, digest] of a) if (reads.has(name) && b.get(name) !== digest) return false;
  for (const name of b.keys()) if (reads.has(name) && !a.has(name)) return false;
  return true;
}

function canonicalAgrees(rec, slot) {
  if (!rec.canonicalState) return true;
  const resident = stateValues(rec.spec.state);
  const canonical = stateValues(rec.canonicalState);
  const covered = stateCoverage(rec.canonicalState);
  // Prior shipouts affect the canonical snapshot as well. Compare the
  // values that the actual resident body supplied to the furniture job.
  return (rec.reads?.deps?.[slot] ?? []).every((name) =>
    !resident.has(name) || (covered?.has(name) && resident.get(name) === canonical.get(name)));
}

function folioIndependent(engine, traced) {
  const geo = engine.geometry;
  return Number.isInteger(traced) && !(traced & (HF_FOLIO | HF_PARITY | 64)) &&
    (!geo?.twoside || (geo.oddsidemargin ?? 0) === (geo.evensidemargin ?? 0));
}

export function furnitureReadsEstablished(engine, traced, page) {
  const cut = folioUnknownFrom(engine);
  const hasUnknownFolio = cut <= (engine.currentSpecs?.pages?.length ?? engine.pages?.length ?? 0);
  if (page >= cut && !folioIndependent(engine, traced)) return false;
  const mask = HF_UNESTABLISHED | (hasUnknownFolio ? 2 : 0);
  return Number.isInteger(traced) && !(traced & mask);
}

function slotsEstablished(engine, spec, reads, which) {
  return (which ? [which] : ['h', 'f']).every((slot) => {
    const traced = reads?.[slot];
    return Number.isInteger(traced) ? furnitureReadsEstablished(engine, traced, spec?.page) :
      spec?.page < folioUnknownFrom(engine) && !spec?.state?.guarded &&
        !spec?.state?.values.length && !spec?.state?.uncertain.length && !spec?.state?.covered;
  });
}

// F7: the body's page-counter assignments. The spec folio follows
// \pagenumbering (the page builder resets it) and, from where each lands,
// every body \setcounter{page} and \addtocounter{page} (their events,
// tex-templates.js, page-metadata.js pageSpecs). What cannot be followed is an
// assignment inside a paragraph (TeX may apply it to the page before its
// line) or an executed assignment whose marker reached no page:
// from that page on the folio is not known (folioUnknownFrom).
const blockPages = new WeakMap(); // pages -> block id -> first page

function blockFirstPage(pages, id) {
  let first = blockPages.get(pages);
  if (!first) {
    first = new Map();
    for (const page of pages ?? []) {
      for (const d of page.draw ?? []) {
        const bid = d?.u?.blockId;
        if (bid != null && !first.has(String(bid))) first.set(String(bid), page.number);
      }
    }
    if (pages && typeof pages === 'object') blockPages.set(pages, first);
  }
  return first.get(String(id)) ?? null;
}

/** Where a layout breaks its pages: each page's first and last line (F6:
 * a binding is verified again when they move under the same source). */
const breakKeys = new WeakMap();
function layoutBreaks(pages) {
  let key = breakKeys.get(pages);
  if (key !== undefined) return key;
  const unit = (d) => (d?.u ? `${d.u.blockId}:${d.u.li ?? ''}` : '');
  key = fnv1a((pages ?? []).map((page) => `${unit(page.draw?.[0])}-${unit(page.draw?.[page.draw.length - 1])}`).join('|'));
  if (pages && typeof pages === 'object') breakKeys.set(pages, key);
  return key;
}

/**
 * F7: the first page whose folio is not known (Infinity: none). The spec
 * folio, which the job prints and the provisional folio shows, follows the
 * body's \setcounter{page} and \addtocounter{page} from where each lands,
 * so a reset that changes nothing keeps every slot (audit/scratch r12
 * reset-flat) and one that does prints TeX's number (r11 tail: "Sheet 74",
 * not "Sheet 84"). From an assignment that cannot be placed (inside a
 * paragraph, `ctr: 'unknown'`) or whose marker was lost, provisional folios
 * stop. A slot can continue to use its own evidence if neither its ink nor
 * its placement reads the folio or parity.
 */
export function folioUnknownFrom(engine) {
  const noted = engine.currentSpecs;
  if (!noted) return Infinity;
  if (engine.hfFolioCut?.noted === noted) return engine.hfFolioCut.page;
  let page = noted.specs?.find((spec) => spec?.ctr === 'unknown')?.page ?? Infinity;
  // Events are recorded at execution, independently of their layout markers.
  // An inactive reset never records an event, even if its block spans pages.
  const told = new Map();
  for (const spec of noted.specs ?? []) {
    for (const id of spec.ctrb ?? []) told.set(String(id), (told.get(String(id)) ?? 0) + 1);
  }
  for (const block of noted.blocks ?? []) {
    const reported = block.galley?.events?.filter((event) => event.k === 'pagectr' || event.k === 'pagenum').length ?? 0;
    if (reported > (told.get(String(block.id)) ?? 0)) {
      page = Math.min(page, blockFirstPage(noted.pages, block.id) ?? 1);
    }
  }
  engine.hfFolioCut = { noted, page };
  return page;
}

/** F6: whether a band may be drawn on a page of another source at all.
 * The physical page has been verified and c53846b held a band there. */
function crossSource(engine, rec) {
  return rec.verified === true && rec.c53 && !rec.pdfInk;
}

/** The pages of a header map c53846b would have held bands for (C53_BANDS). */
function c53Pages(map) {
  const drawing = [];
  for (const [n, entry] of map ?? []) if (entry?.hg || entry?.fg) drawing.push(`p${n}`);
  return new Set(drawing.sort().slice(0, C53_BANDS).map((key) => Number(key.slice(1))));
}

/** An entry with nothing in either slot: no runs, rules or graphics. */
function emptyEntry(entry) {
  if (!entry || entry.hg || entry.fg) return false;
  let runs = 0;
  walkItemRuns(entry.h, () => { runs++; });
  walkItemRuns(entry.f, () => { runs++; });
  return runs === 0;
}

/** The fingerprints of a binding's pages, slot by slot, filled once, from
 * the runs job of the binding's own source, layout and root (F4), and what
 * follows from its entries: where each slot's items stand on the page (a
 * band whose ink is all there is that slot's alone: bandsApart), which pages
 * draw, c53846b's set among them, and the pages whose entry is empty where
 * the page's style is not (F5: their canonical bands are looked at for ink). */
function fillFingerprints(binding, map, geo) {
  if (binding.gen.filled) return;
  const c53 = c53Pages(map);
  for (const [n, rec] of binding.pages) {
    const entry = map.get(n);
    rec.fp = { h: slotFingerprint(entry, 'h'), f: slotFingerprint(entry, 'f') };
    rec.reads = entryReads(entry);
    rec.extent = geo ? { h: hfSlotExtent(entry?.h, 'h', geo), f: hfSlotExtent(entry?.f, 'f', geo) } : null;
    rec.graphic = !!(entry?.hg || entry?.fg);
    rec.c53 = c53.has(n);
    const unresolved = ['h', 'f'].some((which) => Number.isInteger(rec.reads?.[which]) && (rec.reads[which] & HF_UNESTABLISHED));
    // A bridged page may already show correct runs. Its own canonical
    // bands let the viewer replace that furniture over retained paper.
    rec.inkCandidate = !rec.graphic && (unresolved ||
      (rec.spec?.state?.bridged || emptyEntry(entry)) && (rec.spec?.style !== 'empty' || rec.spec?.fl === 'p'));
  }
  binding.gen.filled = true;
}

/**
 * F3: a canonical generation of the source the resident layout is of binds,
 * at its arrival or once that layout agrees with it, each page to its
 * physical sheet: the generation (its source's revision, length and hash,
 * the root), the page number, the geometry, the page's spec, and, from the
 * runs job of this very source, layout and root, its fingerprint. A crop
 * made later carries what was bound here. A generation of another source,
 * or of another page count, binds nothing. The same generation over another
 * layout of its source binds again (F6: its pages are verified again); its
 * bands already cut stand for the new binding's pages.
 */
export function bindCanonicalFurniture(engine, info, { noteSpecs, asyncRepaginate = () => {}, waitForIdle = async () => true }) {
  // (a document the engine sets in vertical writing, update-prepare.js
  // tateExact, is shown as exact pages: its yoko-cut bands would hold body
  // text, and nothing binds)
  if (engine.opening || info.error || engine.mode !== 'structured' || engine.previewPolicy !== 'structured' || engine.tateExact) return null;
  if (engine.updating || info.rev !== engine.srcRev || engine.pages.length !== info.pageCount) return null;
  const source = engine.getSource();
  if (!engine.canonical.sourceMatches(source, info.id)) return null;
  const noted = noteSpecs(engine.pages);
  const root = rootKey(engine);
  const prior = engine.hfBindings?.get(info.id);
  const breaks = layoutBreaks(noted.pages);
  if (prior && prior.gen.layoutSig === noted.sig && prior.gen.breaks === breaks && prior.gen.root === root) return prior;
  const gen = {
    id: info.id, rev: info.rev, srcHash: engine.canonical.compilationIdentity(source).srcHash, srcLength: source.length,
    root, layoutSig: noted.sig, breaks, folioCut: folioUnknownFrom(engine), filled: false,
  };
  const binding = { gen, pages: new Map(), layout: noted.pages, checking: true };
  const geometry = geometryKey(engine.geometry);
  const c53 = c53Pages(engine.hf);
  for (const page of engine.pages) {
    binding.pages.set(page.number, {
      gen, n: page.number, geometry, spec: noted.specs[page.number - 1] ?? null,
      canonicalState: engine.canonical.furnitureState?.(info.id, page.number),
      fp: null, graphic: null, verified: null, c53: c53.has(page.number), inkCandidate: false, pdfInk: false,
    });
  }
  const made = engine.hfIdentity;
  if (mapCurrent(engine, noted) && made?.rev === info.rev) fillFingerprints(binding, engine.hf, engine.geometry);
  // (the same generation's bands, cut for its previous layout, are the same
  // pixels of the same sheets: they stand for this binding's pages)
  if (prior) {
    for (let n = 1; n <= (engine.hfBandTop ?? 0); n++) {
      const meta = engine.chunks.get(hfBandChunkKey(n, 'h'));
      const rec = binding.pages.get(n);
      if (!meta || !rec || meta.rec?.gen.id !== info.id) continue;
      rec.pdfInk = meta.rec.pdfInk;
      meta.rec = rec;
      const foot = engine.chunks.get(hfBandChunkKey(n, 'f'));
      if (foot) foot.rec = rec;
    }
  }
  engine.hfBindings ??= new Map();
  engine.hfBindings.delete(info.id);
  engine.hfBindings.set(info.id, binding);
  while (engine.hfBindings.size > BINDINGS_KEPT) engine.hfBindings.delete(engine.hfBindings.keys().next().value);
  // (where each block of the layout is in its source, taken now: the source is the generation's)
  const spans = blockSpans(engine, noted.pages, noted.blocks);
  void verifyCorrespondence(engine, binding, noted.pages, spans, asyncRepaginate, waitForIdle)
    .catch(() => {})
    .finally(() => { binding.checking = false; });
  return binding;
}

/** Rule F3, when the layout settles: the latest generation is of the source
 * the engine holds, and it has bound nothing for the layout of that source
 * the engine has now (it landed while the resident layout still had another
 * page count, or the walk moved breaks since). Bound the first time they
 * agree: a header job landing, the page set changing (engine-v3.js
 * #scheduleHeaders). Returns the binding made, if any. */
export function bindSettledFurniture(engine, helpers) {
  const info = engine.canonical.info?.();
  if (!info?.id || info.rev !== engine.srcRev || engine.pages?.length !== info.pageCount) return null;
  const prior = engine.hfBindings?.get(info.id);
  const noted = engine.currentSpecs;
  if (prior && noted?.pages === engine.pages && prior.gen.layoutSig === noted.sig && prior.gen.breaks === layoutBreaks(noted.pages) &&
      prior.gen.root === rootKey(engine)) return null;
  return bindCanonicalFurniture(engine, { id: info.id, rev: info.rev, pageCount: info.pageCount }, helpers);
}

// F6: a page's correspondence. The resident page's first and last lines
// (letters and digits only, NFKC, at least MIN_SNIPPET of them) are on the
// canonical page, in that order, with no more before the first than the
// head holds and no more after the last than the foot holds. A page without
// text is verified when the nearest text pages before and after it (or the
// ends of the document) are.
const MIN_SNIPPET = 12;
const BOUNDARY_SLACK = 16;
const VERIFY_SLICE = 24;
const normText = (s) => String(s ?? '').normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
const pageLines = new WeakMap(); // page -> its lines' normalized text

function residentLines(page) {
  let lines = pageLines.get(page);
  if (lines) return lines;
  lines = [];
  for (const d of page?.draw ?? []) {
    const runs = d?.u?.ln?.runs;
    if (!Array.isArray(runs)) continue;
    const text = normText(runs.map((r) => (typeof r?.t === 'string' ? r.t : '')).join(''));
    if (text) lines.push(text);
  }
  if (page && typeof page === 'object') pageLines.set(page, lines);
  return lines;
}

function slotText(items) {
  let text = '';
  walkItemRuns(items, (r) => { if (typeof r?.t === 'string') text += r.t; });
  return normText(text);
}

/** true, false, or null for a page without text. `hfText`: the page's head
 * and foot text as the runs have it (normalized). */
export function pageCorresponds(lines, pdfText, headLen, footLen, hfText = '') {
  let total = 0;
  for (const line of lines) total += line.length;
  if (total < MIN_SNIPPET) return null;
  return snippetsCorrespond(lines, pdfText, headLen, footLen) || sameLetters(lines, pdfText, hfText);
}

function snippetsCorrespond(lines, pdfText, headLen, footLen) {
  let first = '';
  for (let i = 0; i < lines.length && i < 4 && first.length < MIN_SNIPPET; i++) first += lines[i];
  let last = '';
  for (let i = lines.length - 1; i >= 0 && lines.length - 1 - i < 4 && last.length < MIN_SNIPPET; i--) last = lines[i] + last;
  const at = pdfText.indexOf(first);
  if (at < 0 || at > headLen + BOUNDARY_SLACK) return false;
  const end = pdfText.lastIndexOf(last);
  if (end < 0 || end + last.length < at + first.length) return false;
  return pdfText.length - (end + last.length) <= footLen + BOUNDARY_SLACK;
}

/** The same letters and digits, in any order: pdftotext reads a table by
 * its columns where the runs have it by rows (audit/scratch r9 repeat
 * table). One line more or less on the page (a paragraph begun on the
 * previous sheet) is more than the 1 % (at least 4) allowed. */
function sameLetters(lines, pdfText, hfText) {
  const count = new Map();
  for (const ch of pdfText) count.set(ch, (count.get(ch) ?? 0) + 1);
  for (const ch of lines.join('') + hfText) count.set(ch, (count.get(ch) ?? 0) - 1);
  let off = 0;
  for (const n of count.values()) off += Math.abs(n);
  return off <= Math.max(4, pdfText.length * 0.01);
}

// F6 by SyncTeX: where the layout puts a page's first block and its last
// block, the generation's page must have them. At the vertical middle of
// each (its lines on this page, in the middle of the text column) the PDF
// page is asked which source line it typeset there (`synctex edit`); the line
// must be one of that block's. A page shifted by a paragraph has the block
// before it there, or the one after (audit/scratch r9 cold-follow: 152 where
// the layout has 153). Most of a page drawn as exact pictures (example boxes,
// figures: no runs to read, the booklet) is decided here; the text check
// above decides a page SyncTeX does not answer for.

const blockKey = (id) => String(id ?? '').split('@')[0];

/** Each block on `pages`: its file and first/last source line. */
export function blockSpans(engine, pages, blocks) {
  const onPages = new Set();
  for (const page of pages ?? []) for (const d of page.draw ?? []) if (d?.u?.blockId) onPages.add(blockKey(d.u.blockId));
  const spans = new Map();
  const main = path.join(engine.canonical.workDir ?? '', 'canon.tex');
  for (const block of blocks ?? []) {
    const bid = blockKey(block?.id);
    if (!onPages.has(bid) || block.sourceParts) continue;
    try {
      const first = block.file ? block.sourceStart : engine.store.position(engine.file, block.start);
      const last = block.file ? block.sourceEnd : engine.store.position(engine.file, Math.max(block.start, block.end - 1));
      const file = block.file ? engine.includes?.get(block.file)?.readPath ?? block.file : main;
      // (the physical inputs the block was read from, by their full paths:
      // an included file as read and as named, the root as the canonical
      // build reads it and as the document's own file)
      const inputs = new Set((block.file ? [file, block.file] : [main, path.resolve(engine.canonical.docDir ?? '', engine.file ?? '')])
        .map(inputIdentity));
      const a = Number(first?.line), b = Number(last?.line);
      if (Number.isInteger(a) && Number.isInteger(b) && a >= 1 && b >= a) spans.set(bid, { file, inputs, first: a, last: b, until: b + 3, included: !!block.file });
    } catch { /* a block without a place: its page falls back to the text check */ }
  }
  // (the lines up to the next block's are this block's too: TeX ends a
  // paragraph, and SyncTeX names its last line, at the line it reads then,
  // a blank line or the next command)
  const byFile = new Map();
  for (const span of spans.values()) (byFile.get(span.file) ?? byFile.set(span.file, []).get(span.file)).push(span);
  for (const list of byFile.values()) {
    list.sort((x, y) => x.first - y.first);
    list.forEach((span, k) => { if (list[k + 1]) span.until = Math.max(span.last, list[k + 1].first - 1); });
  }
  return spans;
}

/** The points a page is asked at: the vertical middle of its first block's
 * lines and of its last block's, in the middle of the text column. */
export function probePoints(page, geo) {
  const T = 72 + (geo.topmargin ?? 0) + (geo.headheight ?? 0) + (geo.headsep ?? 0);
  const margin = page.number % 2 === 0 && Number.isFinite(geo.evensidemargin) ? geo.evensidemargin : geo.oddsidemargin ?? 0;
  const x = 72 + margin + (geo.textwidth ?? 0) / 2;
  const groups = [];
  for (const d of page.draw ?? []) {
    const bid = blockKey(d?.u?.blockId);
    if (!bid || !Number.isFinite(d.y)) continue;
    // (a line's height is its box's, as the display list draws it: display-list.js)
    const top = T + d.y - (d.u.ln?.boxH ?? d.u.h ?? 0), bottom = T + d.y + (d.u.d ?? 0);
    // (a line without extent, a mark or a cover's \null: nothing of the
    // block stands there to be asked about)
    if (!(bottom - top >= 2)) continue;
    const g = groups.at(-1);
    if (g?.bid === bid) { g.top = Math.min(g.top, top); g.bottom = Math.max(g.bottom, bottom); } else groups.push({ bid, top, bottom });
  }
  if (!groups.length) return [];
  const ends = groups.length > 1 ? [groups[0], groups.at(-1)] : [groups[0]];
  return ends.map((g) => ({ bid: g.bid, x, y: (g.top + g.bottom) / 2, top: g.top, bottom: g.bottom }));
}

/** An input file's identity: its full path, symbolic links resolved. */
const inputIdentities = new Map();
function inputIdentity(file) {
  const resolved = path.resolve(String(file ?? ''));
  let id = inputIdentities.get(resolved);
  if (id === undefined) {
    try { id = realpathSync(resolved); } catch { id = resolved; }
    if (inputIdentities.size >= 512) inputIdentities.clear();
    inputIdentities.set(resolved, id);
  }
  return id;
}

/** true, false, or null: each probe's hit (`{file, line}`, null where
 * SyncTeX has nothing) against the span of the block expected there (its
 * lines up to the next block's). A hit in another input (a package's or a
 * library's code: what TikZ draws from its own macros; another chapter
 * file of the same name, audit/scratch r10 check-capture) tells nothing:
 * the input is told by its full path. */
export function probesCorrespond(probes, hits, spans) {
  if (!probes.length) return null;
  let unknown = false;
  for (let k = 0; k < probes.length; k++) {
    const span = spans.get(probes[k].bid);
    const hit = hits[k];
    if (!span || !hit || !Number.isInteger(hit.line) || !(span.inputs ?? new Set([inputIdentity(span.file)])).has(inputIdentity(hit.file))) {
      unknown = true;
      continue;
    }
    if (hit.line < span.first || hit.line > (span.until ?? span.last)) return false;
  }
  return unknown ? null : true;
}

// A settled opening has a canonical authority. Its slot may only be used on
// the provisional body whose position was checked against that authority.
export function placementVerified(engine, page) {
  if (!page || page.pendingExact?.length) return false;
  const authority = engine.openingAuthority;
  if (!authority || authority.rev !== engine.srcRev) return true;
  const binding = engine.hfBindings?.get(authority.id);
  return binding?.layout[page.number - 1] === page && binding.pages.get(page.number)?.verified === true;
}

async function verifyCorrespondence(engine, binding, pages, spans, asyncRepaginate, waitForIdle) {
  const id = binding.gen.id;
  const live = () => !engine.closed && !engine.opening && engine.hfBindings?.get(id) === binding;
  if (!(await waitForIdle(live))) return;
  const geo = engine.geometry;
  const texts = await engine.canonical.pageTexts(id);
  if (!texts || !live()) return;
  if (engine.hfPdfText?.id !== id) engine.hfPdfText = { id, pages: new Map() };
  const pdf = engine.hfPdfText.pages;
  const verdicts = new Map();
  for (let start = 0; start < pages.length; start += VERIFY_SLICE) {
    // (a keystroke waiting for the engine goes first)
    if (start) await new Promise((resolve) => setImmediate(resolve));
    if (!live()) return;
    for (const page of pages.slice(start, start + VERIFY_SLICE)) {
      const n = page.number;
      if (!pdf.has(n)) pdf.set(n, normText(texts[n - 1] ?? ''));
      // (asked only where a band of this generation may be drawn across
      // sources: a page that draws, in c53846b's set. Each question is a
      // `synctex edit` run over the whole file: a 300-page document asks
      // about 80 pages, not 300, and a binding made again over the same
      // layout asks nothing new)
      const rec = binding.pages.get(n);
      const entry = engine.hf?.get(n);
      const asked = rec?.c53 !== false && (rec?.graphic ?? !!(entry?.hg || entry?.fg));
      const probes = asked && geo && spans?.size && typeof engine.canonical.reverseSync === 'function' ? probePoints(page, geo) : [];
      if (engine.hfProbeCache?.id !== id) engine.hfProbeCache = { id, hits: new Map() };
      const hits = [];
      for (const probe of probes) {
        const key = `${n}:${Math.round(probe.x)}:${Math.round(probe.y)}:${probe.bid}:${Math.round(probe.top)}:${Math.round(probe.bottom)}`;
        if (engine.hfProbeCache.hits.has(key)) {
          hits.push(engine.hfProbeCache.hits.get(key));
          continue;
        }
        if (!(await waitForIdle(live))) return;
        let hit = await engine.canonical.reverseSync({ page: n, x: probe.x, y: probe.y, id }).catch(() => null);
        // (SyncTeX names the box that holds a point, and a box built
        // elsewhere and placed there (an example box under a multicols
        // page) can be held by another block's: then the block's own lines
        // are looked up on this page; the first block's must begin where the
        // layout begins it, the last block's end where the layout ends it,
        // within 10 bp, less than a line: a page shifted by a line is not it)
        const span = spans?.get(probe.bid);
        if (span && hit && probesCorrespond([probe], [hit], spans) === false && span.last - span.first < 500) {
          if (!(await waitForIdle(live))) return;
          const groups = await engine.canonical.forwardSyncRange({ file: span.file, firstLine: span.first, lastLine: span.last, id }).catch(() => null);
          let top = Infinity, bottom = -Infinity;
          for (const items of groups ?? []) {
            for (const item of items ?? []) {
              if (item?.page !== n || !item.box) continue;
              top = Math.min(top, item.box.top);
              bottom = Math.max(bottom, item.box.bottom);
            }
          }
          const last = probes.length > 1 && probe === probes.at(-1);
          if (last ? Math.abs(bottom - probe.bottom) <= 10 : Math.abs(top - probe.top) <= 10) hit = { file: span.file, line: span.first };
        }
        if (engine.hfProbeCache?.id === id) engine.hfProbeCache.hits.set(key, hit);
        hits.push(hit);
      }
      if (!live()) return;
      const synced = probesCorrespond(probes, hits, spans ?? new Map());
      if (synced !== null) {
        verdicts.set(n, synced);
        continue;
      }
      const head = entry ? slotText(entry.h) : null;
      const foot = entry ? slotText(entry.f) : null;
      verdicts.set(n, pageCorresponds(residentLines(page), pdf.get(n), head?.length ?? 64, foot?.length ?? 64, (head ?? '') + (foot ?? '')));
    }
  }
  if (!(await waitForIdle(live))) return;
  const numbers = pages.map((page) => page.number);
  const textBefore = new Map(), textAfter = new Map();
  let prev = true;
  for (const n of numbers) {
    textBefore.set(n, prev);
    if (verdicts.get(n) !== null) prev = verdicts.get(n);
  }
  let next = true;
  for (const n of [...numbers].reverse()) {
    textAfter.set(n, next);
    if (verdicts.get(n) !== null) next = verdicts.get(n);
  }
  for (const n of numbers) {
    const rec = binding.pages.get(n);
    if (!rec) continue;
    const v = verdicts.get(n);
    rec.verified = v === null ? textBefore.get(n) === true && textAfter.get(n) === true : v;
  }
  asyncRepaginate();
}

/**
 * F4: whether the band `meta` (a page's exact band of slot `which`, the
 * head `h` or the foot `f`; both slots when none is named) is drawn on
 * `page`. Folio and geometry as bound, and: (i) the source it was compiled
 * from (an undo back to it); or (ii) the runs job of the current layout has
 * landed, the band's own job's fingerprint of the slot is known, and it is
 * the page's now; or (iii) that job is still pending and the one component
 * of the page's spec that differs from the bound one is measured not to
 * change the slot in the bound spec's context (header-scheduler.js
 * measureSensitivity). (ii) and (iii) only on a page whose correspondence
 * was verified, where c53846b held a band, with the dependencies of the
 * requested slot established (F6, F7). A band of a page whose runs did not
 * account for its ink (F5) takes (i) only. Otherwise the page shows its
 * header entry as v0.1.32 does, never another page's band. Whether a slot's
 * band may be drawn without the other's: bandsApart.
 */
export function bandShown(engine, page, meta, which = meta?.which ?? null) {
  const rec = meta?.rec;
  if (rec?.render) return renderShown(engine, page, rec, which);
  if (!rec || !page || rec.n !== page.number) return false;
  const spec = notedSpec(engine, page);
  if (!spec) return false;
  if (rec.geometry !== geometryKey(engine.geometry)) return false;
  if (sameSource(engine, rec.gen)) return folioKey(spec) === folioKey(rec.spec) ||
    (rec.canonicalState?.folio != null && page.number >= folioUnknownFrom(engine));
  if (!crossSource(engine, rec)) return false;
  if (!slotsEstablished(engine, rec.spec, rec.reads, which)) return false;
  const slots = which ? [which] : ['h', 'f'];
  const folioMayDiffer = folioKey(spec) !== folioKey(rec.spec) ||
    page.number >= Math.min(rec.gen.folioCut ?? Infinity, folioUnknownFrom(engine)) ||
    (rec.canonicalState?.folio != null && rec.canonicalState.folio !== spec.folio);
  if (folioMayDiffer && !slots.every((slot) => folioIndependent(engine, rec.reads?.[slot]))) return false;
  if (!slots.every((slot) => canonicalAgrees(rec, slot))) return false;
  if (runsCurrent(engine, page)) {
    return slotsEstablished(engine, spec, entryReads(engine.hf?.get(page.number)), which) &&
      rec.fp != null && slots.every((slot) =>
        sameSlotState(rec.spec, spec, rec.reads?.deps?.[slot]) && pageHfSig(engine.hf, page.number, slot) === rec.fp[slot]);
  }
  return runsPending(engine) && rec.gen.root === rootKey(engine) && specInsensitive(engine, rec.spec, spec, which, rec.reads);
}

/** A rendered band is proven for its source and target state. A later
 * source may have introduced a body dependency the old trace never saw. */
function renderShown(engine, page, rec, which) {
  if (rec.n !== page.number || rec.geometry !== geometryKey(engine.geometry) || rec.root !== rootKey(engine)) return false;
  const spec = notedSpec(engine, page);
  if (!spec || folioKey(spec) !== folioKey(rec.spec)) return false;
  const slots = rec.apart && which ? [which] : ['h', 'f'];
  if (page.number >= folioUnknownFrom(engine) && !slots.every((slot) => folioIndependent(engine, rec.reads?.[slot]))) return false;
  if (rec.gen.rev === engine.srcRev && rec.key === furnitureRenderKey(engine, spec)) return true;
  if (!rec.deps || !rec.reads || spec.state?.guarded) return false;
  if (JSON.stringify({ ...rec.spec, state: undefined }) !== JSON.stringify({ ...spec, state: undefined })) return false;
  return slots.every((slot) => furnitureReadsEstablished(engine, rec.reads[slot], page.number) &&
    sameSlotState(rec.spec, spec, rec.deps[slot]));
}

/** What a furniture render of a page is made from: its spec, root, geometry. */
export function furnitureRenderKey(engine, spec) {
  return JSON.stringify([spec, rootKey(engine), geometryKey(engine.geometry)]);
}

/** F4 for a retained entry, slot by slot (`which`; both when none is
 * named): the header map's entry for `page` is drawn while the map is the
 * runs of the current layout, or, those runs pending, the spec the map's job
 * had for the page (F3) differs from the page's now only in a component the
 * slot does not change with in that spec's context, folio and geometry as
 * they were. Otherwise the provisional presentation (display-list.js). */
export function entryShown(engine, page, which = null) {
  const now = notedSpec(engine, page);
  if (!now) return false;
  const reads = entryReads(engine.hf?.get(page.number));
  if (!slotsEstablished(engine, now, reads, which)) return false;
  if (runsCurrent(engine, page)) return true;
  const made = engine.hfIdentity;
  if (!made || made.root !== rootKey(engine) || made.geometry !== geometryKey(engine.geometry)) return false;
  const then = engine.hfSpecs?.[page.number - 1];
  if (!then) return false;
  return runsPending(engine) && specInsensitive(engine, then, now, which, reads);
}

// A band's ink near the text area (descenders of the page's last line, the
// ascenders of its first) is not the slot's art; ink the slot's items stand
// within to this much is (glyph rows are a baseline and 6 bp above it,
// svgInkRows; a rule hangs under its box).
const BAND_TEXT_EDGE = 4;
const SLOT_INK_SLACK = 3;

/** The ink of a page SVG's band `which` (rows, [top, bottom] in bp, cut to
 * the band and clear of its text-area edge): what bandsApart reads. */
export function bandInk(ink, bands, which) {
  const [top, bottom] = which === 'h' ? [bands.h[0], bands.h[1] - BAND_TEXT_EDGE] : [bands.f[0] + BAND_TEXT_EDGE, bands.f[1]];
  const rows = [];
  for (const [a, b] of ink) if (b >= top && a <= bottom) rows.push([Math.max(a, top), Math.min(b, bottom)]);
  return rows;
}

/**
 * F4 per slot: whether either band of a page may be drawn without the
 * other. A band holds what the canonical page painted there; it is the
 * slot's alone when all of that ink stands where the slot's items stand
 * (their extent on the page from the runs job of the band's own source,
 * fillFingerprints). Then a head that reads a changed mark no longer takes
 * the unchanged "Sheet 1" foot with it (audit/scratch r10 restore). Art that
 * crosses the bands (an overlay picture of the head painting into the foot
 * band, a page frame, a background) puts ink elsewhere, and both bands then
 * go together, as before. Until its slot's extent is known (the fingerprints
 * are filled), a band stays paired.
 */
export function bandsApart(engine, head, foot) {
  return [[head, 'h'], [foot, 'f']].every(([meta, which]) => {
    const extent = meta?.rec?.extent?.[which];
    return !!extent && Array.isArray(meta.ink) &&
      meta.ink.every(([top, bottom]) => top >= extent[0] - SLOT_INK_SLACK && bottom <= extent[1] + SLOT_INK_SLACK);
  });
}

/** The provisional presentation of a page without its entry: the folio,
 * unless the page's style draws nothing (\thispagestyle{empty}, a cover)
 * or the page is a float page (its style is the float page style's). */
export function provisionalFolio(engine, page) {
  if (page.number >= folioUnknownFrom(engine)) return false;
  const spec = notedSpec(engine, page);
  if (!spec) return true;
  // (what TeX numbers the page: its spec's folio in its format, F7)
  return spec.style !== 'empty' && spec.fl !== 'p' ? formatFolio(spec.folio, spec.fmt) : false;
}

/**
 * The header job of a layout has landed (header-scheduler.js): the bindings
 * of that very source, layout and root get their fingerprints, once. Nothing
 * else is decided here: the predicates above are evaluated every time a page
 * is built, so a band hidden while its page's fingerprint differed is drawn
 * again when it returns (audit/scratch r9 restore).
 */
export function furnitureLanded(engine, noted, { map = engine.hf, identity = engine.hfIdentity } = {}) {
  if (identity) identity.geometry ??= geometryKey(engine.geometry);
  for (const binding of engine.hfBindings?.values() ?? []) {
    const gen = binding.gen;
    if (gen.filled || !identity || gen.layoutSig !== identity.sig || gen.rev !== identity.rev || gen.root !== identity.root) continue;
    fillFingerprints(binding, map, engine.geometry);
  }
}

/** Rule 5: the bands of the generation in use (`engine.hfCanon`) are held
 * for all of its pages, whether the document has them now or not, until the
 * next generation's queue replaces it, as v0.1.32 held them: an undo back
 * shows them at once (audit/scratch r8 undo-window: sheets 26 and 40 waited
 * on fresh SVG reads after 42 -> 1 -> 42). The bands of other generations go
 * with the pages the document no longer has (deleting 301 pages down to one
 * kept 1,200 of them, audit/scratch r7 queue-lease). Memory: one generation's
 * bands. `engine.hfBandTop`: the highest page a band is held for. */
export function pruneFurniture(engine) {
  const count = engine.pages?.length ?? 0;
  const top = engine.hfBandTop ?? 0;
  if (top <= count) return;
  const inUse = engine.hfCanon?.id ?? null;
  let held = count;
  for (let n = count + 1; n <= top; n++) {
    const meta = engine.chunks.get(hfBandChunkKey(n, 'h'));
    if (meta && inUse !== null && meta.canonicalId === inUse) {
      held = n;
      continue;
    }
    engine.chunks.delete(hfBandChunkKey(n, 'h'));
    engine.chunks.delete(hfBandChunkKey(n, 'f'));
  }
  // (the furniture render's: of the pages the document has)
  for (let n = count + 1; n <= top; n++) for (const which of ['h', 'f']) engine.chunks.delete(hfRenderChunkKey(n, which));
  engine.hfBandTop = held;
}

/** Let go of what the furniture holds of a document (open, demotion to
 * opaque, close): the noted specs (they held the previous document's pages
 * and blocks), the bindings, what the header map was made of, the measured
 * templates, the source hash of a revision, the bands, the cut queue and its
 * retry. */
export function releaseFurniture(engine) {
  engine.hfDiscoveredRoot = null;
  engine.hfFolioRoot = null;
  engine.hfRenderTries?.clear();
  if (engine.canonical) engine.canonical.furnitureWatch = '';
  engine.hfWatchContents = undefined;
  engine.hfWatchVersion = null;
  engine.hfWatchFolio = false;
  engine.currentSpecs = null;
  engine.hfSpecs = null;
  engine.hfIdentity = null;
  engine.hfSens = null;
  engine.hfFailedSig = null;
  engine.hfFolioCut = null;
  engine.hfPdfText = null;
  engine.hfProbeCache = null;
  engine.hfBindings = null;
  engine.hfSourceHash = null;
  for (let n = 1; n <= (engine.hfBandTop ?? 0); n++) {
    for (const which of ['h', 'f']) {
      engine.chunks?.delete(hfBandChunkKey(n, which));
      engine.chunks?.delete(hfRenderChunkKey(n, which));
    }
  }
  engine.hfBandTop = 0;
  engine.hfWakeCount = null;
  engine.hfCanon = null;
  clearImmediate(engine.hfCanonRetry);
  engine.hfCanonRetry = null;
  // (a witness replay owed for that document is settled: its waiter goes on)
  const witness = engine.hfWitness;
  if (witness && !witness.settled) {
    witness.settled = 'superseded';
    clearTimeout(witness.retryTimer);
    witness.resolve?.('superseded');
  }
  engine.hfWitness = null;
}

/**
 * The cut of generation `info` (its canonical arrival, a header map landing
 * with the latest generation, an undo back to a bound generation's source:
 * rule 5). Only a bound generation is cut, and on its arrival only the
 * latest one (a late callback of an older generation, its verification held,
 * replaced the newer queue and stopped it after 8 of 33 pages, audit/scratch
 * r7 queue-supersede). The same generation asked again keeps its queue (a
 * failed page is tried now, within its tries).
 */
export function queueCanonicalFurniture(engine, info, helpers, { recut = false } = {}) {
  if (!info?.id || info.error || engine.closed) return Promise.resolve();
  const binding = engine.hfBindings?.get(info.id);
  if (!binding || (!recut && info.id !== engine.canonical.info()?.id)) return Promise.resolve();
  const c = engine.hfCanon;
  if (c?.id === info.id) {
    c.binding = binding;
  } else {
    engine.hfCanon = { id: info.id, binding, tries: new Map(), retry: new Set() };
    // (the old generation's retry wake is not this one's, audit/scratch r8 retry-generation)
    armRetry(engine, helpers);
    // (the generation it replaces is no longer held beyond the pages there are)
    pruneFurniture(engine);
  }
  return pumpCanonicalFurniture(engine, helpers);
}

/** Rule 5: the source the engine holds is a bound generation's (an undo, a
 * redo): its bands held in memory draw at once (pruneFurniture); a page of
 * that generation without its band is cut again from its PDF on disk, the
 * reader's first. */
export function recutCanonicalFurniture(engine, helpers) {
  for (const binding of engine.hfBindings?.values() ?? []) {
    if (!sameSource(engine, binding.gen)) continue;
    return queueCanonicalFurniture(engine, { id: binding.gen.id }, helpers, { recut: true });
  }
  return Promise.resolve();
}

function canonicalCurrent(engine, c) {
  if (!c || engine.hfCanon !== c || engine.closed || engine.opening || engine.mode !== 'structured') return false;
  const geo = engine.geometry;
  return !!geo && geo.paperheight > 0 && geo.paperwidth > 0;
}

/** Whether page `n` of binding `rec` is cut: it draws (as its own job had
 * it, else as the map has it now) and the band would be drawn; or its runs
 * left both slots empty where its style draws, and its own source is the
 * engine's (F5: the canonical page is looked at). */
export function cutWanted(engine, rec, page) {
  if (!page) return false;
  const entry = engine.hf?.get(rec.n);
  if (rec.graphic ?? !!(entry?.hg || entry?.fg)) return bandShown(engine, page, { rec }, 'h') || bandShown(engine, page, { rec }, 'f');
  // (a page whose own text the job cannot number shows its source's bands, F7)
  if (rec.n >= folioUnknownFrom(engine) && !emptyEntry(entry)) return sameSource(engine, rec.gen) && bandShown(engine, page, { rec });
  return rec.inkCandidate && sameSource(engine, rec.gen) && bandShown(engine, page, { rec });
}

/** The pages of generation `c` still to cut, the reader's first, then the
 * edited one's: bound, wanted (cutWanted), on a page the document still
 * has, without a band of this binding. */
function bandsWanted(engine, c) {
  const wanted = [];
  for (const [n, rec] of c.binding.pages) {
    if (n > engine.pages.length) continue;
    if ((c.tries.get(n) ?? 0) >= CANON_BAND_TRIES || c.retry.has(n)) continue;
    if (engine.chunks.get(hfBandChunkKey(n, 'h'))?.rec === rec || rec.inkChecked) continue;
    if (!cutWanted(engine, rec, engine.pages[n - 1])) continue;
    wanted.push(n);
  }
  const reader = Number.isInteger(engine.viewPage) ? engine.viewPage : null;
  const edit = Number.isInteger(engine.owedFocus) ? engine.owedFocus : null;
  const d = (focus, n) => (focus === null ? 0 : Math.abs(focus - n));
  return wanted.sort((a, b) => d(reader, a) - d(reader, b) || d(edit, a) - d(edit, b) || a - b);
}

/** Cut what generation `engine.hfCanon` still owes (one runner at a time;
 * a call while it runs makes it look again when it is done). */
export async function pumpCanonicalFurniture(engine, helpers) {
  if (engine.hfCanonRunning) {
    engine.hfCanonAgain = true;
    return;
  }
  engine.hfCanonRunning = true;
  try {
    do {
      engine.hfCanonAgain = false;
      await cutCanonicalBands(engine, helpers);
    } while (engine.hfCanonAgain && !engine.closed);
  } finally {
    engine.hfCanonRunning = false;
    armRetry(engine, helpers);
  }
}

async function cutCanonicalBands(engine, { asyncRepaginate, waitForIdle = async () => true }) {
  for (;;) {
    const c = engine.hfCanon;
    if (!canonicalCurrent(engine, c)) return;
    const slice = bandsWanted(engine, c).slice(0, CANON_BAND_SLICE);
    if (!slice.length) return;
    const staged = new Map();
    for (const n of slice) {
      // (Build goes first: the cut waits for its lease at a page boundary
      // and goes on with the same queue; 301 conversions ran under a held
      // lease, audit/scratch r7 queue-lease)
      while (engine.canonical.buildLease && !engine.closed) await engine.canonical.waitForBuildLease();
      if (!(await waitForIdle(() => canonicalCurrent(engine, c)))) break;
      const svg = await engine.canonical.pageSVG(n, c.id).catch(() => null);
      if (!canonicalCurrent(engine, c)) break;
      if (!svg) {
        const tries = (c.tries.get(n) ?? 0) + 1;
        c.tries.set(n, tries);
        if (tries < CANON_BAND_TRIES) c.retry.add(n);
        continue;
      }
      const geo = engine.geometry;
      const bands = furnitureBands(geo);
      const rec = c.binding.pages.get(n);
      const ink = svgInkRows(svg, geo.paperwidth);
      // F5: a page whose runs left both slots empty gets the canonical
      // page's bands where the page has ink in them (a float page after a
      // body \floatpagestyle{fancy}); the genuinely empty page none
      if (rec && !rec.graphic && rec.inkCandidate) {
        const inBand = (which) => ink.some(([top, bottom]) => bottom > bands[which][0] && top < bands[which][1]);
        if (!inBand('h') && !inBand('f')) {
          rec.inkChecked = true;
          continue;
        }
      }
      // (each band's ink, for bandsApart)
      staged.set(n, Object.fromEntries(['h', 'f'].map((which) => {
        const [top, bottom] = bands[which];
        return [which, { svg: cropSvgAt(svg, 0, top, geo.paperwidth, bottom - top), wBp: geo.paperwidth, hBp: bottom - top, which,
          ink: bandInk(ink, bands, which) }];
      })));
    }
    if (staged.size && await betweenUpdates(engine, () => canonicalCurrent(engine, c))) {
      for (const [n, bands] of staged) {
        const rec = c.binding.pages.get(n);
        if (!rec || n > engine.pages.length || !cutWanted(engine, rec, engine.pages[n - 1])) continue;
        if (!rec.graphic && rec.inkCandidate) rec.pdfInk = true;
        // both bands of the page at once, under new versions from one counter
        // that never goes back (a band cut again never takes the address of
        // one cut before: its pixels may be cached); the page's previous band
        // stands until here (rule 6)
        for (const which of ['h', 'f']) {
          engine.hfBandVersion = (engine.hfBandVersion ?? 0) + 1;
          engine.chunks.set(hfBandChunkKey(n, which), { ...bands[which], v: engine.hfBandVersion, canonicalId: c.id, rec });
          // (an exact PDF's band: the furniture render's of the page goes)
          engine.chunks.delete(hfRenderChunkKey(n, which));
        }
        engine.hfBandTop = Math.max(engine.hfBandTop ?? 0, n);
      }
      asyncRepaginate();
    }
    if (!canonicalCurrent(engine, c)) return;
    // (a keystroke waiting for the engine goes first)
    await new Promise((resolve) => setImmediate(resolve));
  }
}

/** Retry after the other pages have had a turn, for this generation only. */
function armRetry(engine, helpers) {
  clearImmediate(engine.hfCanonRetry);
  engine.hfCanonRetry = null;
  const c = engine.hfCanon;
  if (!c?.retry.size || engine.closed) return;
  engine.hfCanonRetry = setImmediate(() => {
    engine.hfCanonRetry = null;
    if (engine.hfCanon !== c || engine.closed) return;
    c.retry.clear();
    pumpCanonicalFurniture(engine, helpers).catch(() => {});
  });
  engine.hfCanonRetry.unref?.();
}

// The vertical extents ([top, bottom] in bp from the top of the page) of
// what a pdftocairo page SVG paints: paths (their points, under their own
// and their groups' transforms), glyphs (a baseline and a few points above
// it), images and rects. What <defs> holds (glyph outlines, clip paths) is
// not paint. Coarse by design: F5 asks only whether a band has ink at all.
const SVG_TAG = /<(\/?)(defs|g|path|use|image|rect)\b([^>]*?)(\/?)>/g;
const SVG_NUM = /-?\d*\.?\d+(?:e[-+]?\d+)?/gi;
const attr = (attrs, name) => new RegExp(`\\s${name}="([^"]*)"`).exec(attrs)?.[1];
function parseTransform(text) {
  let m = [1, 0, 0, 1, 0, 0];
  if (!text) return m;
  for (const [, op, args] of text.matchAll(/(matrix|translate|scale)\s*\(([^)]*)\)/g)) {
    const v = (args.match(SVG_NUM) ?? []).map(Number);
    const t = op === 'matrix' ? v : op === 'translate' ? [1, 0, 0, 1, v[0] ?? 0, v[1] ?? 0] : [v[0] ?? 1, 0, 0, v[1] ?? v[0] ?? 1, 0, 0];
    m = multiply(m, t);
  }
  return m;
}
function multiply([a, b, c, d, e, f], [A, B, C, D, E, F]) {
  return [a * A + c * B, b * A + d * B, a * C + c * D, b * C + d * D, a * E + c * F + e, b * E + d * F + f];
}
export function svgInkRows(svg, pageWidth = Infinity) {
  const rows = [];
  const stack = [[1, 0, 0, 1, 0, 0]];
  let defs = 0;
  const add = (m, points) => {
    let top = Infinity, bottom = -Infinity, left = Infinity, right = -Infinity;
    for (const [x, y] of points) {
      const X = m[0] * x + m[2] * y + m[4], Y = m[1] * x + m[3] * y + m[5];
      top = Math.min(top, Y); bottom = Math.max(bottom, Y); left = Math.min(left, X); right = Math.max(right, X);
    }
    if (top <= bottom && right >= 0 && left <= pageWidth) rows.push([top, bottom]);
  };
  for (const [, close, tag, attrs, selfClose] of String(svg ?? '').matchAll(SVG_TAG)) {
    if (tag === 'defs') {
      if (close) defs = Math.max(0, defs - 1);
      else if (!selfClose) defs++;
      continue;
    }
    if (defs) continue;
    if (tag === 'g') {
      if (close) { if (stack.length > 1) stack.pop(); } else if (!selfClose) stack.push(multiply(stack[stack.length - 1], parseTransform(attr(attrs, 'transform'))));
      continue;
    }
    if (close) continue;
    const m = multiply(stack[stack.length - 1], parseTransform(attr(attrs, 'transform')));
    if (tag === 'path') {
      const v = (attr(attrs, 'd')?.match(SVG_NUM) ?? []).map(Number);
      const points = [];
      for (let i = 0; i + 1 < v.length; i += 2) points.push([v[i], v[i + 1]]);
      if (points.length) add(m, points);
    } else if (tag === 'use') {
      const x = Number(attr(attrs, 'x') ?? 0), y = Number(attr(attrs, 'y') ?? 0);
      add(m, [[x, y - 6], [x, y + 1]]);
    } else {
      const x = Number(attr(attrs, 'x') ?? 0), y = Number(attr(attrs, 'y') ?? 0);
      const w = Number(attr(attrs, 'width') ?? 0), h = Number(attr(attrs, 'height') ?? 0);
      add(m, [[x, y], [x + w, y + h]]);
    }
  }
  return rows;
}

/**
 * Canonical-crop chunk source (the cheapest exact pixels in the system):
 * when a fresh canonical compile matches the current source, every block
 * whose exact preview chunk is missing/stale can be cropped from the
 * canonical page SVG only after a complete physical line proof. The pixels are the ones
 * the overlay already shows, but registering them as chunks means the
 * NEXT edit to that block holds a clean stale-exact band instead of
 * bridge glyphs. This is the ONLY bulk chunk source — the resident
 * RENDER pump serves just-edited blocks only (a whole-document RENDER
 * sweep spins on deep-lineage luatexja and starves the fork jobs), and
 * the isolated queue serves what drift keeps this pass from reaching.
 */
export async function cropCanonicalChunks(engine, info, { asyncRepaginate }) {
  if (engine.mode !== 'structured' || engine.srcRev !== info.rev) return;
  if (engine.previewPolicy !== 'structured') return;
  // Page-count equality only avoids needless proof work; it does not prove
  // that a provisional block occupies the same physical canonical band.
  if (engine.pages.length !== info.pageCount) return;
  if (!engine.canonical.sourceMatches(engine.getSource(), info.id)) return;
  const geo = engine.geometry;
  if (!geo) return;
  const pages = engine.pages;
  const cropMetrics = canonicalCropMetrics(geo);
  const bands = canonicalBlockBands(pages, cropMetrics.top);
  let budget = Number(process.env.TDOM_CANON_CROP_MAX || 40);
  let changed = false;
  for (const block of engine.blocks) {
    if (budget <= 0) break;
    if (!block.needsRender || !block.galley) continue;
    const bc = engine.chunks.get(block.id);
    if (bc && bc.forGalley === block.galleyHash) continue; // fresh already
    if (engine.renderWant.has(block.id)) continue; // a hot render is coming
    const band = bands.get(block.id);
    if (!band || band.split) continue;
    const witness = canonicalCropWitness(block);
    if (!witness) continue;
    budget--; // bound proof work as well as successful crops
    const galley = block.galley, forGalley = block.galleyHash;
    const candidates = await canonicalCropCandidates(engine, block, info.id);
    if (!candidates?.length) continue;
    const paintPages = await engine.canonical.pdfPaintPages(info.id, [band.page]);
    if (!paintPages) continue;
    const lead = leadingGalleySkip(block.galley);
    const crop = certifiedCanonicalCrop({ witness, band, left: cropMetrics.left, lead, candidates, paintPages });
    if (!crop) continue;
    const [pageSvg, editGlyphs] = await Promise.all([
      engine.canonical.pageSVG(crop.page, info.id).catch(() => null),
      engine.canonical.pageEditGlyphs(info.id, crop.page),
    ]);
    if (!pageSvg || !editGlyphs) continue;
    if (engine.srcRev !== info.rev || engine.pages !== pages ||
        !engine.canonical.sourceMatches(engine.getSource(), info.id)) return;
    if (block.galley !== galley || block.galleyHash !== forGalley || !engine.blocks.includes(block)) continue;
    const prev = engine.chunks.get(block.id);
    if (prev && prev.forGalley === forGalley) continue; // a resident render won during the proof
    engine.chunks.set(block.id, {
      svg: cropSvgAt(pageSvg, crop.left, crop.top, crop.width, crop.height),
      editCanonicalId: info.id,
      editPage: crop.page,
      editX: crop.left,
      editY: crop.top,
      // The chunk can outlive the four retained canonical generations.
      // Keep its immutable glyphs with its immutable SVG, not just an ID.
      editGlyphs: Promise.resolve(editGlyphs),
      wBp: crop.width,
      hBp: crop.height,
      v: (prev?.v ?? 0) + 1,
      forGalley,
    });
    changed = true;
  }
  if (changed) asyncRepaginate();
}

async function canonicalCropCandidates(engine, block, id) {
  if (block.sourceParts) return null;
  const source = block.file ? block.sourceStart : engine.store.position(engine.file, block.start);
  const end = block.file ? block.sourceEnd : engine.store.position(engine.file, block.end);
  const first = Number(source?.line), last = Number(end?.line);
  if (!Number.isInteger(first) || !Number.isInteger(last) || first < 1 || last < first || last - first >= 48) return null;
  const file = block.file
    ? engine.includes.get(block.file)?.readPath ?? block.file
    : path.join(engine.canonical.workDir, 'canon.tex');
  if (engine.canonical.generationCertificate(id)?.rev !== engine.srcRev) return null;
  const groups = await engine.canonical.forwardSyncRange({
    file,
    firstLine: first,
    lastLine: last,
    firstColumn: Number.isInteger(source.column) && source.column > 0 ? source.column : 1,
    id,
  });
  if (!groups || engine.canonical.generationCertificate(id)?.rev !== engine.srcRev) return null;
  return groups.flat();
}

/**
 * Exactness verification (structured → opaque demotion): compare each
 * provisional page's glyph text against the canonical PDF's text via
 * token containment (latin words + CJK bigrams). A page whose provisional
 * tokens are largely missing from the canonical page means the JS page
 * assembly diverged from the real output routine there — its blocks are
 * demoted to the isolated exact-render path (print-identical pixels) and
 * stay demoted until their source changes. Conservative thresholds: this
 * must never demote healthy pages en masse.
 */
export async function verifyAgainstCanonical(engine, info, { applyFidelity, asyncRepaginate }) {
  const texts = await engine.canonical.pageTexts(info.id);
  if (!texts) return; // pdftotext unavailable — canonical overlay still wins visually
  if (engine.srcRev !== info.rev || engine.mode !== 'structured' || engine.previewPolicy !== 'structured') return; // superseded meanwhile
  const { mismatches, demote } = compareCanonicalText(engine.pages, texts, info.pageCount, { joinCjkRuns: !engine.opening });
  engine.verifyState = {
    rev: info.rev,
    canonicalId: info.id,
    pagesChecked: Math.min(engine.pages.length, info.pageCount),
    mismatches,
  };
  if (demote.size) {
    let demoted = 0;
    let refidelity = false;
    for (const bid of demote) {
      const block = engine.blocks.find((b) => b.id === bid);
      if (!block) continue;
      const hash = fnv1a(block.text);
      // fidelity-gate demotion, sticky until the block's source changes:
      // glyph divergence costs the block its glyph privileges (exact
      // preview chunks only, no bridge); divergence while it ALREADY
      // showed exact pixels means the placement itself is wrong — stop
      // trusting the provisional layer there entirely (canonical-only)
      const level = block.rescued || block.fidelity?.blockExact ? 'canonical' : 'exact';
      const prev = engine.fidelityDemoted.get(bid);
      if (!prev || prev.hash !== hash || (prev.level !== level && level === 'canonical')) {
        engine.fidelityDemoted.set(bid, { hash, level });
        if (block.galley) applyFidelity(block, block.galley);
        refidelity = true;
      }
      if (!block.rescued && engine.poisoned.get(bid) !== hash) {
        engine.poisoned.set(bid, hash);
        demoted++;
      }
    }
    if (refidelity) {
      engine.fidelityEpoch++;
      // an earlier galley's fidelity predates the demotion (#103)
      for (const block of engine.blocks) block.exactHistory = null;
      asyncRepaginate();
    }
    if (demoted) {
      engine.diagnostics.push(
        `verification demoted ${demoted} block(s) to exact rendering: ${mismatches.join('; ')}`
      );
    }
  }
}
