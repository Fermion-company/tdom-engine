import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { normalizeHeaderFooterPayload, slotFingerprint } from './header-footer.js';
import { HF_FOLIO, HF_PARITY, HF_PROBES, HF_PROBE_KEYS, HF_UNESTABLISHED, furnitureStateKey, hfProbedTemplates,
  probeContext } from './page-metadata.js';
import { shippingPriorityQuietMs } from './interactive-priority.js';
import { withReplaceablePreviewJob } from './build-lease-preview.js';
import { scanPreamble } from './preamble-patch.js';
import { stripComments } from './safety.js';
import { extractBraced } from './util/tex.js';
import { isDeepStrictEqual } from 'node:util';

const TRACE_HF = !!process.env.TDOM_TRACE_HF;
const STANDARD_STYLES = new Set(['empty', 'plain', 'headings', 'myheadings']);

export function usesCustomFurniture(engine) {
  return !!engine.geometry?.fancyhdr || (engine.initialStyle != null && !STANDARD_STYLES.has(engine.initialStyle)) ||
    /\\(?:ps@\w+|@(?:odd|even)(?:head|foot))\b/.test(engine.lastPreamble ?? engine.bootPreamble ?? '') ||
    engine.currentSpecs?.specs?.some((spec) => spec.fancy?.length || !STANDARD_STYLES.has(spec.style));
}

/**
 * The header job (docs/10 §10.7a, rule 1), as in v0.1.32: one job over every
 * page's spec (page-metadata.js pageSpecs) typesets each page's head and
 * foot in the root's checkpoint 0 and returns their text runs and rules,
 * flagged when they draw (`hg`/`fg`). It makes no pixels. It runs when the
 * page specs change (`noted.sig`, engine-v3.js #noteSpecs) and the map it
 * returns replaces the whole map (latest wins).
 *
 * What it keeps of the later rounds makes the runs themselves righter:
 * ONE job in flight, with one owner (engine.hfJob: two used to share one
 * reply key, and the first reply was stored as the second's map; two opens
 * behind one Build lease started two), its own reply key, a child that dies
 * ends it at once (Build waited out the 60 s deadline behind it), and a
 * reply made from another preamble or root is not published.
 */
/** The root a header job forks and its preamble: a map made from another
 * is not of this document's heads (a preamble edit reboots the root). */
export function rootKey(engine) {
  return `${engine.file}#${engine.rootBoots ?? 0}#${engine.preDigest ?? ''}`;
}

/** Whether the header map is the runs of the layout `noted` describes:
 * the same page specs, made from the root the engine has now. */
export function mapCurrent(engine, noted) {
  const made = engine.hfIdentity;
  return !!made && !!noted && made.sig === noted.sig && engine.hfSig === noted.sig && made.root === rootKey(engine);
}

/**
 * What the runs job measured in each context (docs/10 §10.7a F2: a template
 * and where floats landed, page-metadata.js probeContext): which of the
 * spec's components its head, and which its foot, change with (each slot on
 * its own fingerprint, F4 per slot). A probe the job did not return, or an
 * entry it could not make, counts as a change.
 */
export function measureSensitivity(specs, map, probes) {
  const out = new Map();
  for (const [context, [index, page]] of hfProbedTemplates(specs)) {
    // (the page set again beside its probes, in the measuring pass's state:
    // a head that numbers each page reads another number there)
    const base = probes.get(`${index}.base`) ?? map.get(page);
    const sens = {};
    for (const slot of ['h', 'f']) {
      const fp = base ? slotFingerprint(base, slot) : null;
      const of = { marks: false, t: false, b: false, p: false, lp: false };
      for (const which of HF_PROBES) {
        const probe = probes.get(`${index}.${which}`);
        if (fp === null || !probe || slotFingerprint(probe, slot) !== fp) of[HF_PROBE_KEYS[which]] = true;
      }
      sens[slot] = of;
    }
    out.set(context, sens);
  }
  return out;
}

export function scheduleHeaders(engine, helpers) {
  const pages = engine.pages;
  if (!pages?.length || engine.closed || engine.opening) return;
  const noted = engine.currentSpecs;
  if (noted?.pages === pages && mapCurrent(engine, noted)) return;
  if (engine.hfJob) {
    if (engine.hfJob.sig !== noted?.sig) engine.hfQueued = true;
    return;
  }
  runHeaderJob(engine, helpers);
}

/** A forked render child that is gone: its reply will never come. Polled
 * while the job waits for it (the child is the checkpoint's, not Node's). */
function childGone(pid) {
  if (!(pid > 0)) return false;
  try {
    process.kill(pid, 0);
    return false;
  } catch (err) {
    return err?.code === 'ESRCH';
  }
}

/** `promise`, or a rejection once the job's announced child, or the
 * checkpoint that forks it, has been gone for `graceMs` (a reply written
 * before exiting is read in that time). */
function unlessChildGone(engine, id, promise, peer = null, graceMs = 1000) {
  let timer = null;
  const gone = new Promise((_, reject) => {
    let goneAt = null;
    timer = setInterval(() => {
      if (!childGone(engine.renderPids?.get(id)) && !childGone(peer?.pid)) return;
      goneAt ??= Date.now();
      if (Date.now() - goneAt >= graceMs) reject(new Error(`header child of ${id} exited without a reply`));
    }, 100);
    timer.unref?.();
  });
  return Promise.race([promise, gone]).finally(() => clearInterval(timer));
}

export function betweenUpdates(engine, stillWanted, { waitForOwed = false } = {}) {
  return new Promise((resolve) => {
    const step = () => {
      if (!engine.closed && stillWanted() && (engine.updating || (waitForOwed && engine.owedPaging))) return;
      engine.hfUpdateWaiters?.delete(step);
      resolve(!engine.closed && stillWanted());
    };
    (engine.hfUpdateWaiters ??= new Set()).add(step);
    step();
  });
}

export function wakeFurnitureUpdates(engine) {
  for (const wake of engine.hfUpdateWaiters ?? []) wake();
}

function readdirSafe(dir) {
  try { return readdirSync(dir); } catch { return []; }
}

async function rememberFurnitureReads(engine, map, awaitGalley, ck,
  current = () => !engine.closed && !engine.opening && engine.checkpoints.get(0) === ck) {
  if (!current()) return false;
  const names = new Set(engine.hfWatchContents?.trim().split('\n').filter(Boolean));
  let folio = engine.hfWatchFolio;
  for (const { hdeps, fdeps, hr, fr } of map.values()) {
    for (const name of hdeps ?? []) names.add(name);
    for (const name of fdeps ?? []) names.add(name);
    folio ||= !!((hr | fr) & (HF_FOLIO | HF_PARITY));
  }
  names.delete('$font');
  names.delete('$color');
  const contents = names.size ? [...names].sort().join('\n') + '\n' : '';
  engine.hfWatchFolio = folio;
  if (engine.canonical) engine.canonical.furnitureWatch = contents + (folio ? 'c@page\n' : '');
  if (engine.hfWatchContents === contents) return false;
  const version = engine.hfWatchSeq = (engine.hfWatchSeq ?? 0) + 1;
  const id = `__hfbase.${version}`;
  const body = Buffer.from(contents);
  // A watch containing only ambient font/color reads still has a baseline.
  const input = body.length ? body : Buffer.from('\n');
  const waiting = awaitGalley('galley:' + id, 2000);
  ck.send(`HFBASE ${version} ${id} ${input.length}${engine.hfParagraphRoot ? ' P' : ''}\n`);
  ck.sendRaw(input);
  const result = await waiting;
  if (result.error || !current()) return false;
  const target = path.join(engine.workDir, 'tdom-hf-watch');
  try {
    writeFileSync(target + '.tmp', contents);
    renameSync(target + '.tmp', target);
  } catch {
    // The versioned baseline is already available to resident jobs.
  }
  engine.hfWatchNames = [...names].sort();
  engine.hfWatchContents = contents;
  engine.hfWatchVersion = version;
  return true;
}

// A declaration that only installs fancyhdr cells can be sampled without
// running the surrounding body. The real trace still grows the watch if
// another template, argument or branch reads more controls.
function declaredFurnitureCells(engine) {
  const result = [];
  for (const { name, body } of scanPreamble(engine.bootPreamble)?.decls ?? []) {
    if (!/^[A-Za-z]+$/.test(name)) continue;
    let source = stripComments(body).trim();
    if (!source.startsWith('\\fancy')) continue;
    const cells = [];
    while (source) {
      const opening = /^\\fancy(head|foot|hf)\s*(\[[^\]\n]*\])?\s*(?=\{)/.exec(source);
      if (!opening) break;
      const value = extractBraced(source, opening[0].length);
      const end = opening[0].length + value.length + 1;
      if (source[end] !== '}') break;
      cells.push([opening[1], `${opening[2] ?? ''}{${value}}`]);
      source = source.slice(end + 1).trim();
    }
    if (source || !cells.length) continue;
    const argCount = Math.max(0, ...[...body.matchAll(/#([1-9])/g)].map((m) => Number(m[1])));
    const invocation = new RegExp(`\\\\${name}(?![A-Za-z@])`);
    const example = engine.blocks.find((block) => invocation.test(block.text));
    if (!example) continue;
    let tail = example.text.slice(example.text.search(invocation) + name.length + 1).trimStart();
    const args = [];
    while (args.length < argCount && tail[0] === '{') {
      const value = extractBraced(tail, 0);
      if (tail[value.length + 1] !== '}' || /[\\{}%#$]/.test(value)) break;
      args.push(value);
      tail = tail.slice(value.length + 2).trimStart();
    }
    if (args.length !== argCount) continue;
    result.push(cells.map(([kind, value]) => [kind, value.replace(/#([1-9])/g, (_, n) => args[n - 1])]));
    if (result.length === 8) break;
  }
  return result;
}

/** A small trace from the new root, before its body continuations fork.
 * The laid-out pages can later extend this set with body-selected branches. */
export async function discoverFurnitureReads(engine, { hfJobBody, awaitGalley }) {
  const ck = engine.checkpoints.get(0);
  if (!ck || engine.closed || engine.geometry?.writingDirection === 'tate') return;
  const styles = new Set([engine.initialStyle]);
  engine.hfLiteralRoot = literalFurnitureSource(engine, engine.bootPreamble);
  engine.hfParagraphRoot = standardFurniturePreamble(engine, engine.bootPreamble, true);
  if (!engine.hfLiteralRoot) {
    styles.add('plain').add('empty');
    for (const block of engine.blocks) {
      for (const [, style] of block.text.matchAll(/\\(?:this)?pagestyle\s*\{(\w+)\}/g)) styles.add(style);
      if (styles.size >= 8) break;
    }
  }
  const specs = [];
  const sides = engine.geometry?.twoside ? [1, 2] : [1];
  const add = (style, fancy = null) => {
    for (const folio of sides) {
      specs.push({ page: specs.length + 1, style, folio, fmt: 'arabic', lmark: '', rmark: '', lp: '1', fancy });
    }
  };
  for (const style of [...styles].slice(0, 8)) {
    add(style);
  }
  for (const cells of declaredFurnitureCells(engine)) add(engine.initialStyle, cells);
  const id = `__hfdiscover.${engine.rootBoots}`;
  const jobdir = path.join(engine.workDir, 'hf-discover');
  mkdirSync(jobdir, { recursive: true });
  const body = Buffer.from(hfJobBody(specs, { discover: true }));
  (engine.renderPids ??= new Map()).set(id, 0);
  try {
    const waiting = awaitGalley('galley:' + id, 2000);
    ck.send(`RENDER __hf ${encodeURIComponent(jobdir)} ${body.length} ${id}\n`);
    ck.sendRaw(body);
    const payload = await unlessChildGone(engine, id, waiting, ck);
    const { map } = normalizeHeaderFooterPayload(payload, () => {});
    return await rememberFurnitureReads(engine, map, awaitGalley, ck);
  } catch (err) {
    const pid = engine.renderPids.get(id);
    if (pid > 0) {
      try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
    }
    if (!engine.closed) engine.diagnostics.push(`furniture trace deferred: ${err.message}`);
  } finally {
    engine.renderPids.delete(id);
  }
}

/**
 * Standard one-sided styles with literal fancyhdr cells can format the
 * folio, but their cells cannot use it to select another macro. The body
 * may contain ordinary prose and built-in page breaks. Other documents
 * take a real trace for each page and slot.
 */
export function literalFurnitureBlock(source) {
  const text = stripComments(source).replace(/\\(?:clearpage|newpage)(?![A-Za-z@])/g, '');
  return !/[\\{}#$^&~_]/.test(text);
}

function standardFurniturePreamble(engine, text, storedCells = false) {
  if (engine.geometry?.twoside || engine.defsPatch) return false;
  const preamble = stripComments(text ?? '');
  const cls = /^\s*\\documentclass(?:\[oneside\])?\{(article|book|report)\}/.exec(preamble);
  if (!cls) return false;
  let rest = preamble.slice(cls[0].length)
    .replace(/\\usepackage\{fancyhdr\}|\\pagestyle\{(?:plain|empty|headings|fancy)\}/g, '')
    .replace(/\\fancy(?:head|foot|hf)(?:\[[LCR]*\])?\{(?:[^\\{}#$%^&~_]|\\thepage(?![A-Za-z]))*\}/g, '');
  if (storedCells) {
    // These forms store tokens and cannot replace a kernel paragraph hook.
    rest = rest.replace(/\\newcommand\{\\[A-Za-z]+\}\{[^\\{}#$%^&~_]*\}/g, '')
      .replace(/\\fancy(?:head|foot|hf)(?:\[[LCR]*\])?\{\\[A-Za-z]+\}/g, '');
  }
  if (rest.trim()) return false;
  for (const dir of [engine.docDir, engine.overlayDir]) {
    if (dir && (existsSync(path.join(dir, cls[1] + '.cls')) || existsSync(path.join(dir, 'fancyhdr.sty')))) return false;
  }
  return true;
}

function literalFurnitureSource(engine, text) {
  return standardFurniturePreamble(engine, text) && engine.blocks.every((block) => !block.includeStart && !block.includeEnd &&
    !block.subfileStart && !block.subfileEnd && literalFurnitureBlock(block.text));
}

function literalFurnitureTraces(engine, specs) {
  if (!literalFurnitureSource(engine, engine.lastPreamble ?? engine.bootPreamble) ||
      specs.some((s) => s.fmt !== 'arabic' || s.fancy?.length || s.ctr ||
        s.state?.guarded || s.state?.uncertain?.length)) return null;
  const byInputs = new Map(), copies = new Map();
  for (const spec of specs) {
    const key = JSON.stringify([spec.style, spec.lmark, spec.rmark, spec.fl, spec.flCarry, spec.lp, furnitureStateKey(spec.state)]);
    const representative = byInputs.get(key);
    if (representative === undefined) byInputs.set(key, spec.page);
    else copies.set(spec.page, representative);
  }
  return copies;
}

function reusablePrefix(engine, specs, root) {
  const previous = engine.hfSpecs;
  if (!previous || engine.hfIdentity?.root !== root) return new Map();
  const kept = new Map();
  for (const [index, spec] of specs.entries()) {
    const entry = engine.hf.get(spec.page);
    const old = previous[index];
    // A changed page can change the TeX state left by the measuring pass.
    // Only reuse a contiguous prefix from that pass.
    if (!entry || !old) break;
    if (!isDeepStrictEqual(old, spec)) {
      const sens = engine.hfSens?.byTpl.get(probeContext(old));
      const lastPageIndependent = old.lp !== spec.lp && sens?.h?.lp === false && sens.f?.lp === false &&
        [entry.hr, entry.fr].every((bits) => Number.isInteger(bits) && !(bits & (2 | HF_UNESTABLISHED)));
      if (!lastPageIndependent || !isDeepStrictEqual({ ...old, lp: spec.lp }, spec)) break;
    }
    kept.set(spec.page, entry);
  }
  return kept;
}

function runHeaderJob(engine, helpers) {
  const { hfJobBody, awaitGalley, registerFont, asyncRepaginate, noteSpecs, landed = () => {},
    prepare = () => {}, refreshWatch = () => {}, waitForIdle = async () => true, firstMap = () => false } = helpers;
  if (!engine.checkpoints.get(0)) return;
  const job = { seq: (engine.hfJobSeq = (engine.hfJobSeq ?? 0) + 1), sig: null };
  engine.hfJob = job;
  engine.hfQueued = false;
  engine.hfTask = (async () => {
    // The open reply owns the first paint. Register the job now so that a
    // reopen behind a Build lease replaces its input, then yield the turn.
    await new Promise((resolve) => setImmediate(resolve));
    const current = () => !engine.opening && engine.hfJob === job;
    if (!(await waitForIdle(current))) return;
    const preparedRoot = engine.checkpoints.get(0);
    await prepare();
    // A complete root replay already contains the authoritative headers.
    // Let it reach the atomic preview switch before this replaceable
    // resident render is allowed to consume a core. Not the first map of a
    // root: until it lands no head or foot of the runs is shown, and a
    // typing that goes on never gives the shipping window its quiet (round
    // 21: the article's heads came 3.6 s after the last of 100 keys).
    for (;;) {
      if (engine.closed) return;
      if (firstMap()) break;
      const remaining = shippingPriorityQuietMs(engine, 0) - (Date.now() - (engine.lastEditAt ?? 0));
      if (remaining <= 0) break;
      await new Promise((resolve) => setTimeout(resolve, remaining));
    }
    await withReplaceablePreviewJob(engine, 'header-render', async () => {
      if (!(await waitForIdle(current))) return;
      // (for the pages as they are now, after the waits)
      const noted = noteSpecs(engine.pages);
      const ck = engine.checkpoints.get(0);
      if (ck && ck !== preparedRoot && helpers.prepare) {
        engine.hfQueued = true;
        return;
      }
      if (!ck || engine.hfJob !== job || mapCurrent(engine, noted)) return;
      job.sig = noted.sig;
      engine.hfQueued = false;
      // what the job is made from, checked before its map is published: the
      // root's checkpoint it forks (a root reboot replaces it), the preamble,
      // and that the job is still the engine's (a superseded job's map is
      // never used, docs/10 §10.7a F4)
      // (`rev`: the source the pages are of now; the layout is noted inside an
      // update before its revision advances, update-finalize.js)
      const identity = { ck, root: rootKey(engine), sig: noted.sig, rev: engine.srcRev };
      const same = () => !engine.closed && current() && engine.checkpoints.get(0) === identity.ck &&
        rootKey(engine) === identity.root;
      const compareSides = !!engine.geometry?.twoside;
      const traceCopies = literalFurnitureTraces(engine, noted.specs);
      const kept = reusablePrefix(engine, noted.specs, identity.root);
      const body = Buffer.from(hfJobBody(noted.specs, { compareSides, traceCopies, kept }), 'utf8');
      engine.hfRenderSeq = (engine.hfRenderSeq ?? 0) + 1;
      const id = `__hf.${engine.hfRenderSeq}`;
      const jobdir = path.join(engine.workDir, 'hf-render', String(engine.hfRenderSeq));
      // (the earlier jobs' directories: no other job runs now, this one owns them)
      for (const old of readdirSafe(path.dirname(jobdir))) {
        if (Number(old) < engine.hfRenderSeq) rmSync(path.join(path.dirname(jobdir), old), { recursive: true, force: true });
      }
      mkdirSync(jobdir, { recursive: true });
      engine.renderPids ??= new Map();
      engine.renderPids.set(id, 0);
      const done = awaitGalley('galley:' + id, 60_000);
      let payload;
      try {
        // jobdir percent-encoded (spaces in macOS paths shear the line)
        ck.send(`RENDER __hf ${encodeURIComponent(jobdir)} ${body.length} ${id}\n`);
        ck.sendRaw(body);
        payload = await unlessChildGone(engine, id, done, ck);
      } catch (err) {
        const pid = engine.renderPids.get(id);
        if (pid > 0) {
          try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
        } else {
          (engine.cancelledRenderIds ??= new Set()).add(id);
          setTimeout(() => engine.cancelledRenderIds?.delete(id), 30_000).unref?.();
        }
        throw err;
      } finally {
        engine.renderPids.delete(id);
      }
      const { map, probes } = normalizeHeaderFooterPayload(payload, registerFont);
      for (const [page, before] of kept) {
        const entry = map.get(page);
        if (!entry) continue;
        for (const key of ['hr', 'fr', 'hdeps', 'fdeps']) entry[key] = before[key];
      }
      for (const [page, representative] of traceCopies ?? []) {
        const entry = map.get(page), traced = map.get(representative);
        if (!entry || !traced) continue;
        for (const key of ['hr', 'fr', 'hdeps', 'fdeps']) entry[key] = traced[key];
      }
      if (compareSides) {
        for (const [page, entry] of map) {
          if (kept.has(page)) continue;
          const other = probes.get(`side.${page}`);
          for (const slot of ['h', 'f']) {
            const mask = slot + 'r';
            if (Number.isInteger(entry[mask]) && (!other || slotFingerprint(other, slot) !== slotFingerprint(entry, slot))) {
              entry[mask] |= HF_PARITY;
            }
          }
        }
      }
      // An edit still owes its offscreen page lists to the quiet-time pump.
      // Publishing a different furniture map here would repaginate those
      // pages immediately and bypass that pump's typing pause. Not the first
      // map of a root: no page shows a head or foot of it yet, and its
      // repagination builds the pages nearest the edit and owes the others
      // to the same pump (async-repaginate.js).
      const waitForOwed = !firstMap();
      if (!(await betweenUpdates(engine, same, { waitForOwed }))) return;
      const grewWatch = usesCustomFurniture(engine) && await rememberFurnitureReads(engine, map, awaitGalley, ck, same);
      if (!(await betweenUpdates(engine, same, { waitForOwed }))) return;
      const landedAt = TRACE_HF ? performance.now() : 0;
      engine.hf = map;
      engine.hfSig = noted.sig;
      // what the map is of (its layout, source revision and root) and the
      // spec of each of its entries (docs/10 §10.7a F3)
      engine.hfIdentity = { sig: identity.sig, rev: identity.rev, root: identity.root };
      engine.hfSpecs = noted.specs;
      engine.hfFailedSig = null;
      // what each template's head and foot change with (F2): this root's
      const measured = measureSensitivity(noted.specs, map, probes);
      if (engine.hfSens?.root !== identity.root || engine.hfSens.byTpl.size + measured.size > 512) {
        engine.hfSens = { root: identity.root, byTpl: new Map() };
      }
      for (const [tpl, sens] of measured) engine.hfSens.byTpl.set(tpl, sens);
      landed(noted, { map, identity: engine.hfIdentity });
      if (grewWatch) refreshWatch();
      const did = asyncRepaginate();
      if (TRACE_HF) {
        const ms = (value) => (value ?? 0).toFixed(1);
        console.error(`[hf] landed ${id}: ${map.size} entries, ${engine.pages.length} pages in ${ms(performance.now() - landedAt)} ms` +
          (did ? ` | paginate ${ms(did.paginateMs)}, ${did.built} display lists ${ms(did.buildMs)}` : ''));
      }
    });
  })()
    .catch((err) => {
      engine.diagnostics.push('header job failed: ' + (err?.message ?? err));
      // (no runs are coming for this layout: a retained entry or band is no
      // longer "pending", docs/10 §10.7a F4 iii)
      if (engine.hfJob === job && job.sig) engine.hfFailedSig = job.sig;
    })
    .finally(() => {
      // (only the owner clears what it set)
      if (engine.hfJob !== job) return;
      engine.hfJob = null;
      // the layout changed meanwhile: its job now
      const again = engine.hfQueued;
      engine.hfQueued = false;
      if (again && !engine.closed) scheduleHeaders(engine, helpers);
    });
}
