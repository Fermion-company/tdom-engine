import { fnv1a } from '../hash.js';
import { remapText } from './mathmap.js';
import { classifyResidentRun } from './run-semantics.js';
import { r2 } from './util/svg.js';
import { pageArtCommands, PAGE_ART_OFF } from './page-art.js';
import { extractBraced } from './util/tex.js';

const PAGE_FOLIO = 1;
const LAST_PAGE = 2;
const LEFT_MARK = 4;
const RIGHT_MARK = 8;
const UNRESOLVED_PAGE_STATE = 16;
const counterFormatters = new Set('value arabic roman Roman alph Alph fnsymbol'.split(' '));
const pageRefs = new Set('pageref autopageref vpageref cpageref Cpageref zpageref lastpageref'.split(' '));
const pageWords = new Set(['thepage', 'pagename']);
const primitiveMarks = new Set('topmark firstmark botmark topmarks firstmarks botmarks FirstMark LastMark TopMark'.split(' '));
const BODY_CONTEXTS = new WeakMap();

function bodyPageState(page, spec, reads, sourceStamp) {
  const unresolved = !spec || spec.ctr === 'unknown' || !!(reads & UNRESOLVED_PAGE_STATE);
  const state = JSON.stringify([page.number, spec?.folio ?? page.folio,
    reads & PAGE_FOLIO ? spec?.fmt : null,
    reads & LAST_PAGE ? spec?.lp : null,
    reads & LEFT_MARK ? spec?.lmark : null,
    reads & RIGHT_MARK ? spec?.rmark : null,
    unresolved ? sourceStamp : null]);
  return { state, unresolved, reads, spec };
}

export function displayListBodyChanged(page, spec, sourceStamp) {
  const list = page.dl;
  if (list?.bodyContext === undefined) return false;
  const kept = BODY_CONTEXTS.get(list);
  if (!kept) return list.bodyContext !== sourceStamp;
  if (kept.spec === spec && (!kept.unresolved || list.bodyContext === sourceStamp)) return false;
  return kept.state !== bodyPageState(page, spec, kept.reads, sourceStamp).state;
}

function pageStateSource(text) {
  const literals = /\\begin\s*\{(verbatim\*?|Verbatim|lstlisting|minted)\}[\s\S]*?\\end\s*\{\1\}|\\verb\*?([^\sA-Za-z@])[^\r\n]*?\2|\\[^A-Za-z@]|%[^\r\n]*/g;
  return text.replace(literals, (token, env, delimiter) => env || delimiter || token[0] === '%' ? '' : token);
}

function pageStateTokens(text, macros = null) {
  let reads = 0;
  for (const match of text.matchAll(/\\([A-Za-z@]+|[^\r\n])/g)) {
    const name = match[1];
    if (pageWords.has(name)) reads |= PAGE_FOLIO;
    if (name === 'leftmark') reads |= LEFT_MARK;
    if (name === 'rightmark') reads |= RIGHT_MARK;
    if (name === 'c@page') reads |= PAGE_FOLIO;
    if (primitiveMarks.has(name)) reads |= UNRESOLVED_PAGE_STATE;
    if (counterFormatters.has(name) || pageRefs.has(name) || name === 'ref') {
      const after = text.slice(match.index + match[0].length);
      if (counterFormatters.has(name) && /^\s*\{\s*page\s*\}/.test(after)) reads |= PAGE_FOLIO;
      if (pageRefs.has(name) || name === 'ref') {
        if (/^\*?\s*\{\s*LastPage\s*\}/.test(after)) reads |= LAST_PAGE;
        else if (pageRefs.has(name)) reads |= UNRESOLVED_PAGE_STATE;
      }
    }
    reads |= macros?.get(name) ?? 0;
  }
  return reads;
}

function preamblePageReaders(preamble) {
  const text = pageStateSource(preamble);
  const declarations = /\\([gex]?def|let|(?:new|renew|provide)command|DeclareRobustCommand|(?:New|Renew|Provide|Declare)DocumentCommand)(?![A-Za-z@])|\\[^A-Za-z@]/g;
  const primitive = /^\s*\\([A-Za-z@]+)[^{\\]*/;
  const alias = /^\s*\\([A-Za-z@]+)\s*=?\s*(\\[A-Za-z@]+)/;
  const command = /^\*?\s*(?:\{\s*\\([A-Za-z@]+)\s*\}|\\([A-Za-z@]+))\s*(?:\[[^\]\r\n]*\]\s*){0,2}/;
  const readers = new Map();
  for (let declaration; (declaration = declarations.exec(text));) {
    const kind = declaration[1];
    if (!kind) continue;
    const tail = text.slice(declarations.lastIndex);
    if (kind === 'let') {
      const match = alias.exec(tail);
      if (match) readers.set(match[1], pageStateTokens(match[2]));
      continue;
    }
    const match = (kind.endsWith('def') ? primitive : command).exec(tail);
    if (!match) continue;
    const name = match[1] ?? match[2];
    let open = declarations.lastIndex + match[0].length;
    if (text[open] !== '{') continue;
    if (kind.endsWith('DocumentCommand')) {
      open += extractBraced(text, open).length + 2;
      while (/\s/.test(text[open] ?? '')) open++;
    }
    if (text[open] !== '{') continue;
    const body = extractBraced(text, open);
    readers.set(name, pageStateTokens(body));
    declarations.lastIndex = open + body.length + 2;
  }
  return readers;
}

// A single expansion of ordinary declarations is enough to recognize a
// body macro that prints page state. Resolve once per preamble, and keep the
// result per block while its text and the preamble stay the same.
let pageReaderPreamble;
let pageReaderMacros = new Map();
const PAGE_STATE_READERS = new WeakMap();
export function blockReadsPageState(block, preamble = '') {
  if (!block) return 0;
  if (preamble !== pageReaderPreamble) {
    pageReaderPreamble = preamble;
    pageReaderMacros = preamblePageReaders(preamble);
  }
  let cached = PAGE_STATE_READERS.get(block);
  if (cached?.text !== block.text || cached?.macros !== pageReaderMacros) {
    cached = { text: block.text, macros: pageReaderMacros, reads: pageStateTokens(pageStateSource(block.text), pageReaderMacros) };
    PAGE_STATE_READERS.set(block, cached);
  }
  return cached.reads | (block.consumesToc ? UNRESOLVED_PAGE_STATE : 0);
}

// Half a bp is smaller than one device pixel at common preview zoom levels,
// so fractional CSS clipping could still shave antialiased math ink. Two bp
// remains well inside ordinary TeX line spacing while surviving that rounding.
const EXACT_CHUNK_BLEED_BP = 2;
// A run cut out of an earlier picture (exact-parts.js) takes less to its
// sides than above and below: what stands beside it in that picture is
// other ink of that line, which may not be beside it any more.
const EXACT_PART_SIDE_BLEED_BP = 0.75;

// A page is built again with every keystroke on it, and all but a line or
// two of it is what it was: the lines of the blocks that did not change, at
// the places they had. On a dense page of Japanese text (a run a character,
// 1,500 commands, 195 KB) making those commands again and hashing the whole
// page's JSON was a quarter of the engine's time for the keystroke.
//  - LINE_COMMANDS: the commands of a line that is glyphs and rules only,
//    kept with the line (stream.js keeps a block's lines while its galley
//    and pictures stay) and used again while it stands at the same place.
//    Fonts never change under a line: a demoted family rebuilds every
//    block's lines (fidelity-gate.js).
//  - COMMAND_HASH: the page's hash is made of one hash per command, kept
//    with the command, so only new commands are serialised for it. It is
//    still a function of the commands' content alone.
// TDOM_NO_LINE_REUSE=1: build every line and hash the page's JSON, as before.
const NO_LINE_REUSE = !!process.env.TDOM_NO_LINE_REUSE;
const LINE_COMMANDS = new WeakMap();
const COMMAND_HASH = new WeakMap();
function hashCommands(commands) {
  if (NO_LINE_REUSE) return fnv1a(JSON.stringify(commands));
  let joined = '';
  for (const command of commands) {
    let hash = COMMAND_HASH.get(command);
    if (hash === undefined) COMMAND_HASH.set(command, hash = fnv1a(JSON.stringify(command)));
    joined += hash + ',';
  }
  return fnv1a(joined);
}

/** The chunk holding page `page`'s head (`h`) or foot (`f`) band cut from a
 * canonical page: used when that band is drawn with graphics. */
export function hfBandChunkKey(page, which) {
  return `__hf-${page}-${which}`;
}

/** A band of the current source's furniture render (furniture-render.js):
 * beside the exact PDF's, which it stands in for while that is not shown. */
export function hfRenderChunkKey(page, which) {
  return `__hfr-${page}-${which}`;
}

export function buildDisplayList(page, { geometry, chunks, hf, hfSig, fonts, twinMetrics, hfEntryShown = () => true,
  hfBandShown = () => true, hfBandsApart = () => false, hfProvisional = () => true, galleyOf = null,
  readsPageState = null, bodyContext = '', pageSpec = null, furniture = null, opening = false,
  hfSince = 0, hfUnknown = '' }) {
  const geo = geometry;
  const L = 72 + (geo.oddsidemargin ?? 0);
  const T = 72 + (geo.topmargin ?? 0) + (geo.headheight ?? 0) + (geo.headsep ?? 0);
  const commands = [];
  const bodyOverhang = [];
  for (const src of page.pendingExact ?? []) {
    // The absent block has no geometry yet; the signal is deliberately
    // page-wide and contributes no fabricated coordinates or dimensions.
    commands.push({ op: 'pending-exact', src, wholePage: 1 });
  }
  let gfxOpen = null;
  // (whether this page shows page-art pictures whole, and which it shows: page-art.js)
  const shownWhole = new Map();
  const flushGfx = () => {
    if (!gfxOpen) return;
    const meta = chunks.get(gfxOpen.blockId);
    if (!opening && meta?.farInk && !PAGE_ART_OFF) {
      // A picture drawn against `current page` (page-art.js): the block's
      // picture on the paper for this page, or, until one is made for the
      // places its lines have now, nothing for its lines without text and
      // the tight picture for the others (each run of those its own window).
      const group = gfxOpen;
      gfxOpen = null;
      pageArtCommands(commands, {
        page, group, meta, chunks, geo, L, T, shownWhole,
        emitTight: (run) => emitWindow({
          ...group, clip0: run[0].yOff, clip1: Math.max(...run.map((u) => u.yOff + u.h + u.d)),
          units: run.length, line: run.length === 1 ? run[0].li : null,
          covered: run.reduce((sum, u) => sum + Math.max(0, u.h + u.d), 0), ink: run.some((u) => u.ink),
        }, meta),
      });
      return;
    }
    emitWindow(gfxOpen, meta);
    gfxOpen = null;
  };
  const emitWindow = (gfxOpen, meta) => {
    // PDF/SVG ink may overhang TeX's logical box (notably subscripts,
    // superscripts and large operators). Keep the chunk clipped, but give its
    // outer band a bounded bleed that also survives browser pixel rounding.
    const chunkHeight = Math.max(0, meta?.hBp ?? gfxOpen.clip1);
    const clip0 = Math.min(chunkHeight, Math.max(0, gfxOpen.clip0 - EXACT_CHUNK_BLEED_BP));
    const clip1 = Math.min(chunkHeight, gfxOpen.clip1 + EXACT_CHUNK_BLEED_BP);
    const visibleHeight = Math.max(0, clip1 - clip0);
    const logicalHeight = gfxOpen.clip1 - gfxOpen.clip0;
    if (gfxOpen.units === 1 && logicalHeight > Math.max(12, gfxOpen.covered * 2)) {
      commands.push({
        op: 'sourcebox',
        x: r2(L),
        y: r2(gfxOpen.top + gfxOpen.clip0),
        w: r2(gfxOpen.w),
        h: r2(logicalHeight),
        ink: gfxOpen.ink ? 1 : undefined,
        chunk: 1,
        complex: 1,
        src: gfxOpen.blockId,
      });
    }
    commands.push({
      op: 'chunk',
      chunk: gfxOpen.blockId,
      // The SVG already contains paragraph indentation. Anchor it at the
      // text block origin; adding run.x here would indent exact lines twice.
      x: r2(L + (meta?.xBp ?? 0)),
      y: r2(gfxOpen.top + clip0),
      w: r2(meta?.wBp ?? gfxOpen.w),
      h: r2(visibleHeight),
      sy: r2(clip0),
      ch: r2(chunkHeight),
      cv: meta?.v ?? 0,
      st: gfxOpen.stale ? 1 : undefined, // stale-exact: previous pixels held
      held: gfxOpen.held ? 1 : undefined, // an earlier galley's own pixels: display only (#103)
      // The picture is shown only through these openings, [x, y, w, h] on
      // the page: the runs that need exact pixels. The rest of each line is
      // drawn by the glyph layer (`ov` commands), under the picture's window.
      show: gfxOpen.show && !gfxOpen.whole ? gfxOpen.show : undefined,
      line: gfxOpen.units === 1 ? gfxOpen.line : undefined,
      src: gfxOpen.blockId,
    });
  };

  let ownsPage = false; // a real shipped page (iso `full` chunk) carries
  // its own page style — no provisional folio/header on top of it
  for (const entry of page.draw ?? []) {
    const u = entry.u;
    const baseline = T + entry.y;
    addBodyOverhang(bodyOverhang, u, L, baseline, T, T + geo.textheight);
    if (u.ln.gfxChunk) {
      const c = u.ln.gfxChunk;
      if (c.full) ownsPage = true;
      const unitTop = baseline - u.ln.boxH;
      const chunkTop = unitTop - c.yOff;
      const clip0 = c.yOff;
      const clip1 = c.yOff + u.h + (u.d ?? 0);
      const unitRuns = u.ln.editRuns ?? u.ln.runs ?? [];
      const unitInk = unitRuns.some((run) => runPaintsInk(run, u.ln.backend));
      const unitExtent = Math.max(0, (u.h ?? 0) + (u.d ?? 0));
      const reveal = u.ln.reveal ?? null;
      // (each line of the window, for a picture drawn against the page: page-art.js)
      const line = { li: u.li, top: unitTop, h: u.h ?? 0, d: u.d ?? 0, ink: unitInk, yOff: c.yOff };
      if (gfxOpen && gfxOpen.blockId === c.blockId && Math.abs(gfxOpen.top - chunkTop) < 0.05) {
        gfxOpen.clip1 = Math.max(gfxOpen.clip1, clip1);
        gfxOpen.stale ||= !!c.stale;
        gfxOpen.held ||= !!c.held;
        gfxOpen.units++;
        if (gfxOpen.line !== u.li) gfxOpen.line = null;
        gfxOpen.covered += unitExtent;
        gfxOpen.ink ||= unitInk;
        gfxOpen.list.push(line);
      } else {
        flushGfx();
        gfxOpen = {
          blockId: c.blockId,
          top: chunkTop,
          clip0,
          clip1,
          w: c.w,
          stale: !!c.stale,
          held: !!c.held,
          line: u.li,
          units: 1,
          covered: unitExtent,
          ink: unitInk,
          list: [line],
        };
      }
      if (reveal) {
        // the same boxes a cut-out of this run would have (partCommands)
        gfxOpen.show ??= [];
        for (const part of reveal.parts) {
          gfxOpen.show.push([
            r2(L + part.x - EXACT_PART_SIDE_BLEED_BP), r2(baseline + part.top - EXACT_CHUNK_BLEED_BP),
            r2(part.w + 2 * EXACT_PART_SIDE_BLEED_BP), r2(part.h + 2 * EXACT_CHUNK_BLEED_BP),
          ]);
        }
      } else gfxOpen.whole = true; // a line of this window that is shown whole
      // Exact pixels cover this line; the unchanged TeX run extents provide
      // one transparent source-line hit surface underneath the chunk.
      sourceHitCommand(commands, L, baseline, u, u.blockId, 1, fonts);
      if (reveal) {
        // (drawn over the hit surface and marked `ov`: the viewer shows them
        // and gives them no part in editing, which goes by the picture)
        runCommands(commands, reveal.runs, L, baseline, u.blockId, {
          fonts, twinMetrics, line: u.li, backend: u.ln.backend, over: true,
        });
      }
      continue;
    }
    flushGfx();
    if (u.cn || u.ln.pendingExact) {
      // canonical-only band (margin-bearing blocks): blank in the
      // provisional layer, the canonical page supplies the pixels —
      // advertised so the referee counts real lines here as covered
      commands.push({
        // Suppressed glyphs must retain a paint requirement. Without this
        // marker an atomic viewer could publish the otherwise complete page
        // while a formula, graphic, float or footnote was entirely absent.
        op: u.cn ? 'canon' : 'pending-exact',
        x: r2(L),
        y: r2(baseline - u.ln.boxH),
        w: r2(geo.textwidth),
        h: r2(u.ln.boxH + (u.d ?? 0)),
        src: u.blockId,
      });
      sourceHitCommand(commands, L, baseline, u, u.blockId, geo.textwidth, fonts);
      continue;
    }
    const kept = !NO_LINE_REUSE && !u.ln.parts ? LINE_COMMANDS.get(u) : null;
    if (kept && kept.L === L && kept.baseline === baseline && kept.fonts === fonts && kept.twinMetrics === twinMetrics &&
        kept.runs === u.ln.runs && kept.src === u.blockId && kept.line === u.li && kept.backend === u.ln.backend) {
      for (const command of kept.commands) commands.push(command);
      continue;
    }
    const first = commands.length;
    runCommands(commands, u.ln.runs, L, baseline, u.blockId, {
      fonts,
      twinMetrics,
      line: u.li,
      backend: u.ln.backend,
    });
    if (u.ln.parts) partCommands(commands, u, L, baseline, chunks.get(u.ln.partsChunk ?? u.blockId));
    else if (!NO_LINE_REUSE) {
      LINE_COMMANDS.set(u, {
        L, baseline, fonts, twinMetrics, runs: u.ln.runs, src: u.blockId, line: u.li, backend: u.ln.backend,
        commands: commands.slice(first),
      });
    }
  }
  flushGfx();
  // Header / footer: TeX-typeset boxes from the page-style job (the exact
  // \@oddhead/\@oddfoot with the page's real folio format, style and
  // marks). \@outputpage geometry: head box bottom at topmargin+headheight,
  // foot baseline \footskip below the text area. v0.1.32's presentation,
  // slot by slot (docs/10 §10.7a, furnitureChoice).
  // A page shipped whole (iso `full` chunk) is cropped to the text area, so
  // its own head and foot are not in the picture. The header job reads the
  // page's style events (a \thispagestyle{empty} in it included), so its
  // entry is still the page's furniture; only the provisional folio, which
  // knows no style, is withheld (tdom-engine #17: running heads and folios
  // vanished from every page a two-column block filled).
  const choice = furniture ?? furnitureChoice(page.number, geo, { chunks, hf, hfEntryShown, hfBandShown, hfBandsApart, hfProvisional });
  const anchors = hfAnchors(geo);
  const bandTop = { h: 0, f: T + geo.textheight };
  for (const which of ['h', 'f']) {
    const slot = choice[which];
    if (slot?.band) {
      const meta = slot.band;
      commands.push({
        op: 'chunk',
        chunk: meta.rec?.render ? hfRenderChunkKey(page.number, which) : hfBandChunkKey(page.number, which),
        x: 0,
        y: r2(bandTop[which]),
        w: r2(meta.wBp),
        h: r2(meta.hBp),
        sy: 0,
        ch: r2(meta.hBp),
        cv: meta.v ?? 0,
        hfSlot: which,
        hfGeneration: meta.canonicalId,
        src: '_hf',
      });
    } else if (slot?.entry && !slot.entry[`${which}g`]) {
      const from = commands.length;
      paintHfItems(commands, slot.entry[which], L, anchors[which], { fonts, twinMetrics });
      for (let i = from; i < commands.length; i++) commands[i].hfSlot = which;
    }
  }
  if (choice.folio && !ownsPage) {
    // header job hasn't landed yet: provisional plain folio (replaced by
    // the TeX-typeset footer as soon as the async job reports)
    commands.push({
      op: 'folio',
      x: r2(L + geo.textwidth / 2),
      y: r2(T + geo.textheight + (geo.footskip ?? 30)),
      text: typeof choice.folio === 'string' ? choice.folio : String(page.number),
    });
  }
  const dl = { page: page.number, commands };
  if (bodyOverhang.length) dl.bodyOverhang = bodyOverhang;
  dl.hfSig = hfSig; // this page's own head and foot: rebuilt when they change (header-footer.js pageHfSig)
  // (what the list is checked against: the head and foot with the revision
  // since which their inputs held, engine-v3.js furnitureSig; not sent)
  if (hfSince) Object.defineProperty(dl, 'hfKey', { value: `${hfSig}@${hfSince}`, enumerable: false });
  if (galleyOf) {
    let reads = 0;
    if (readsPageState) {
      for (const id of page.pendingExact ?? []) reads |= readsPageState(id);
      for (const { u } of page.draw ?? []) reads |= readsPageState(u.blockId);
      for (const float of page.topFloats ?? []) reads |= readsPageState(float.blockId);
      for (const float of page.botFloats ?? []) reads |= readsPageState(float.blockId);
    }
    let state = '';
    if (reads) {
      // bodyContext is the cache stamp. The signature records the state that
      // can affect the ink. Unresolved readers keep the conservative stamp.
      dl.bodyContext = bodyContext;
      const context = bodyPageState(page, pageSpec, reads, bodyContext);
      state = context.state;
      BODY_CONTEXTS.set(dl, context);
    }
    dl.body = bodySignature(page, galleyOf, state, [L, T, geo.textwidth, geo.textheight, geo.paperwidth, geo.paperheight]);
  }
  // What the viewer needs to decide on an exact page of an earlier source it
  // keeps for this body (web/app.js furnitureHolds): the source revision
  // since which what this page's head and foot print is unchanged (B1), and
  // the slots this list does not describe (opening, owed runs, a picture
  // still to come: an exact page mounted with it has unknown bands there).
  if (hfSince) dl.hfSince = hfSince;
  if (hfUnknown) dl.hfUnknown = hfUnknown;
  // A change in the canonical body's identity must be published even when
  // the resident renderer still produces the same commands.
  const inkHash = hashCommands(commands);
  dl.hash = (dl.body ? `${inkHash}/${dl.body}` : inkHash) + (hfSince ? `@${hfSince}` : '') + (hfUnknown ? `?${hfUnknown}` : '');
  return dl;
}

const SYNTHETIC_BODY_PAINT = new WeakMap();

/** What a page's body is, apart from how it is drawn now: its blocks, the
 * galley each is set from, and where each of their lines stands. Left out:
 * which of its pictures are in hand (a block that owes its picture and the
 * same block drawn are one body), their versions, and the head and foot. The
 * viewer keeps an exact page of an earlier source on the paper while the body
 * is what it was then (web/app.js canonicalShowsList): the booklet's writing
 * rules, drawn only in the exact page, went when a warm completed the page's
 * resident list (tex64-internal #121, round 11, sheet 25). */
export function bodySignature(page, galleyOf, context = '', geometry = '') {
  let text = `${context}|${geometry};`;
  const update = (prefix, entries) => {
    for (const f of entries ?? []) text += `${prefix}|${f.id}|${galleyOf(f.blockId) ?? ''}|${f.w}|${f.h}|${f.d};`;
  };
  update('top', page.topFloats);
  update('bottom', page.botFloats);
  if (page.floatPage) text += 'float-page;';
  for (const src of page.pendingExact ?? []) text += `p|${src}|${galleyOf(src) ?? ''};`;
  for (const entry of page.draw ?? []) {
    const u = entry.u;
    const position = u.li ?? `${u.bodyLine ?? ''}:${u.yRel ?? ''}`;
    let paint = galleyOf(u.blockId);
    if (u.blockId == null && u.ln?.runs) {
      paint = SYNTHETIC_BODY_PAINT.get(u);
      if (paint === undefined) SYNTHETIC_BODY_PAINT.set(u, paint = fnv1a(JSON.stringify(u.ln.runs)));
    }
    text += `${u.blockId}|${paint ?? ''}|${entry.float?.id ?? u.bodyInsert ?? ''}|${position}|` +
      `${r2(entry.y)}|${r2(u.h ?? 0)}|${r2(u.d ?? 0)};`;
  }
  return `${fnv1a(text)}:${text.length}`;
}

// Resident paint windows start at a line's logical box. Its harvested runs
// can reach above or below that box (e.g. a zero-height raised label). Give
// the viewer the body-owned ink there before the exact page is composited.
const BODY_RUN_BOUNDS = new WeakMap();
function addBodyOverhang(out, unit, x, baseline, bodyTop, bodyBottom) {
  const runs = unit.ln.editRuns ?? unit.ln.runs ?? [];
  let extent = BODY_RUN_BOUNDS.get(unit);
  if (!extent) {
    let top = Infinity, bottom = -Infinity;
    for (const run of runs) {
      if (!runPaintsInk(run, unit.ln.backend)) continue;
      const y = run.dy ?? 0;
      top = Math.min(top, run.rule ? y : y - (run.gh ?? (run.s ?? 0) * 0.8));
      bottom = Math.max(bottom, run.rule ? y + run.h : y + (run.gd ?? (run.s ?? 0) * 0.2));
    }
    extent = [top - 1, bottom + 1];
    BODY_RUN_BOUNDS.set(unit, extent);
  }
  if (baseline + extent[0] >= bodyTop && baseline + extent[1] <= bodyBottom) return;
  for (const run of runs) {
    if (!runPaintsInk(run, unit.ln.backend) || !(run.w > 0)) continue;
    const y = baseline + (run.dy ?? 0);
    const top = run.rule ? y : y - (run.gh ?? (run.s ?? 0) * 0.8);
    const bottom = run.rule ? y + run.h : y + (run.gd ?? (run.s ?? 0) * 0.2);
    if (top - 1 >= bodyTop && bottom + 1 <= bodyBottom) continue;
    out.push([r2(x + (run.x ?? 0) - 1), r2(top - 1), r2(run.w + 2), r2(bottom - top + 2)]);
  }
}

/** The exact runs of a composed line (stream.js `parts`): each a window on
 * the block's picture in hand, which was made for an earlier galley. `sx`
 * and `sy` say where in that picture the window looks, `cw` how wide the
 * whole picture is; `held` keeps every reader of exact pixels (editing
 * geometry, the publication referee) from taking them for the current
 * source's. Text between the windows is ordinary glyph commands. */
function partCommands(commands, unit, X, baseline, meta) {
  if (!meta) return;
  const pad = -(meta.xBp ?? 0);
  const width = meta.wBp ?? 0;
  const height = meta.hBp ?? 0;
  for (const part of unit.ln.parts) {
    let sx = part.sx + pad - EXACT_PART_SIDE_BLEED_BP;
    let x = X + part.x - EXACT_PART_SIDE_BLEED_BP;
    let w = part.w + 2 * EXACT_PART_SIDE_BLEED_BP;
    if (sx < 0) { x -= sx; w += sx; sx = 0; }
    w = Math.min(w, width - sx);
    let sy = part.sy - EXACT_CHUNK_BLEED_BP;
    let y = baseline + part.top - EXACT_CHUNK_BLEED_BP;
    let h = part.h + 2 * EXACT_CHUNK_BLEED_BP;
    if (sy < 0) { y -= sy; h += sy; sy = 0; }
    h = Math.min(h, height - sy);
    if (!(w > 0) || !(h > 0)) continue;
    commands.push({
      op: 'chunk',
      chunk: unit.ln.partsChunk ?? unit.blockId,
      x: r2(x),
      y: r2(y),
      w: r2(w),
      h: r2(h),
      sx: r2(sx),
      sy: r2(sy),
      cw: r2(width),
      ch: r2(height),
      cv: meta.v ?? 0,
      held: 1,
      part: 1,
      line: unit.li,
      src: unit.blockId,
    });
  }
}

/** Paint one run list (glyphs + rules) at a baseline — shared by body
 * units and the TeX-typeset header/footer boxes. */
function runCommands(commands, runs, X, baseline, src, { fonts, twinMetrics, line, backend = null, over = false }) {
  for (const r of runs ?? []) {
    if (r.rule) {
      // Geometry is not a paint oracle: a normal zero-area PDF rule may be a
      // visible device hairline. Only a backend-certified empty_rule is
      // omitted. Fidelity has already routed unknown or zero-area normal
      // rules to an exact TeX chunk, so this renderer remains fail-closed.
      if (classifyResidentRun(r, backend).tag === 'LayoutOnly') continue;
      if (!(r.w > 0) || !(r.h > 0)) continue;
      commands.push({
        op: 'rule',
        x: r2(X + r.x),
        y: r2(baseline + r.dy),
        w: r2(r.w),
        h: r2(r.h),
        color: r.c && r.c !== '#000000' ? r.c : undefined,
        src,
        line,
        ov: over ? 1 : undefined,
      });
    } else if (r.t) {
      const fmeta = fonts.get(r.f);
      const text = fmeta?.remap ? remapText(r.t, fmeta.remap) : r.t;
      // cmex (OMX) glyphs hang below their reference point in TeX's
      // metrics; the unicode twins sit on a normal baseline. Align the
      // ink tops exactly: TeX extents travel with the run, twin extents
      // were measured by the daemon from the actual twin font.
      let dy = r.dy;
      if (fmeta?.omx) {
        const gh = r.gh ?? 0;
        const gd = r.gd ?? 0;
        const cp = text.codePointAt(0);
        const tm = twinMetrics?.[cp];
        if (tm) {
          dy = r.dy - gh + tm[0] * (r.s / 10);
        } else {
          dy = r.dy - gh + 0.78 * (gh + gd);
        }
      }
      const command = {
        op: 'glyphs',
        fam: fmeta?.family ?? 'f-unknown',
        size: r.s,
        x: r2(X + r.x),
        y: r2(baseline + dy),
        text,
        w: r2(r.w ?? Math.max(1, text.length * r.s * 0.5)),
        gh: r2(r.gh ?? r.s * 0.8),
        gd: r2(r.gd ?? r.s * 0.2),
        color: r.c && r.c !== '#000000' ? r.c : undefined,
        src,
        line,
        math: r.m || fmeta?.mth ? 1 : undefined,
        ov: over ? 1 : undefined,
      };
      if (over) {
        // Ink only (the viewer gives it no part in editing): the runs of a
        // line that share font, size, baseline and colour go as one command,
        // each run's place and text in `runs`. A Japanese line is a run a
        // character; one command a run made the page's patch half as large
        // again, and the viewer build a node for every character of every
        // such line on the page with every keystroke.
        const last = commands[commands.length - 1];
        if (last && last.ov && last.op === 'glyphs' && last.runs && last.fam === command.fam && last.size === command.size &&
            last.y === command.y && last.color === command.color && last.math === command.math && last.src === src && last.line === line) {
          last.runs.push([command.x, text]);
          last.text += text;
          last.w = r2(command.x + command.w - last.x);
          last.gh = Math.max(last.gh, command.gh);
          last.gd = Math.max(last.gd, command.gd);
          continue;
        }
        command.runs = [[command.x, text]];
      }
      commands.push(command);
    }
  }
}

/** The commands a harvested line would paint at the position its source hit
 * box records (sourceHitCommand: x = origin + first ink run, y = baseline -
 * box height). A block whose exact chunk owns its pixels never emits them,
 * yet canonical-anchor may repaint one plain line of such a block over the
 * canonical page. Null when the line has no ink run to pin its origin. */
export function sourceBoxLineCommands(sourcebox, item, { src, line, fonts, twinMetrics, backend = null }) {
  const runs = item?.runs ?? [];
  let left = Infinity;
  for (const run of runs) {
    if (!run.rule && !run.t) continue;
    left = Math.min(left, run.x ?? 0);
  }
  const x = Number(sourcebox?.x);
  const y = Number(sourcebox?.y);
  const boxH = Number(item?.h ?? 0);
  if (!Number.isFinite(left) || ![x, y, boxH].every(Number.isFinite)) return null;
  const commands = [];
  runCommands(commands, runs, x - left, y + boxH, src, { fonts, twinMetrics, line, backend });
  return commands;
}

function runPaintsInk(run, backend) {
  if (!run?.rule) return !!run?.t;
  const semantics = classifyResidentRun(run, backend);
  return semantics.tag !== 'LayoutOnly' && Number(run.w) > 0 && Number(run.h) > 0;
}

function sourceHitCommand(commands, X, baseline, unit, src, fallbackWidth = 1, fonts = new Map()) {
  const runs = unit.ln.editRuns ?? unit.ln.runs ?? [];
  let left = Infinity;
  let right = -Infinity;
  for (const run of runs) {
    if (!run.rule && !run.t) continue;
    left = Math.min(left, run.x ?? 0);
    right = Math.max(right, (run.x ?? 0) + Math.max(run.w ?? 0, 0.5));
  }
  const hasRunBounds = Number.isFinite(left) && Number.isFinite(right) && right > left;
  const hasTextInk = runs.some((run) => !run.rule && !!run.t);
  commands.push({
    op: 'sourcebox',
    x: r2(X + (hasRunBounds ? left : 0)),
    y: r2(baseline - (unit.ln.boxH ?? unit.h ?? 0)),
    w: r2(Math.max(hasRunBounds ? right - left : (unit.ln.gfxChunk?.w ?? fallbackWidth), 1)),
    h: r2(Math.max((unit.ln.boxH ?? unit.h ?? 0) + (unit.d ?? 0), 1)),
    line: unit.li,
    ink: hasTextInk ? 1 : undefined,
    math: runs.some((run) =>
      !run.rule && !!run.t && (!!run.m || !!fonts.get(run.f)?.mth)
    ) ? 1 : undefined,
    stale: unit.ln.gfxChunk?.stale ? 1 : undefined,
    src,
  });
}

/** Paint a harvested header/footer box (vbox-wrapped hbox items) with its
 * first line's baseline at anchorY. */
/** Where a head's and a foot's first baseline stand on the page (bp from
 * its top): \@outputpage puts the head box's bottom at
 * topmargin+headheight and the foot's baseline \footskip below the text. */
export function hfAnchors(geo) {
  const top = 72 + (geo.topmargin ?? 0) + (geo.headheight ?? 0);
  return { h: top, f: top + (geo.headsep ?? 0) + (geo.textheight ?? 0) + (geo.footskip ?? 30) };
}

/** The vertical extent [top, bottom] on the page of a head's (`h`) or
 * foot's (`f`) items, where paintHfItems puts them: their boxes, and their
 * runs, which can stand outside them (fancyhdr's \headrule and \footrule
 * after a \headruleskip): a rule where it is, a glyph as svgInkRows reads
 * one (its baseline and 6 bp above it); an empty slot stands at its anchor. */
export function hfSlotExtent(items, which, geo) {
  let y = hfAnchors(geo)[which];
  let top = y;
  let bottom = y;
  let first = true;
  for (const it of items ?? []) {
    if (it.k === 'glue' || it.k === 'kern') {
      y += it.a ?? 0;
    } else if (it.k === 'box') {
      if (!first) y += it.h ?? 0;
      top = Math.min(top, y - (it.h ?? 0));
      bottom = Math.max(bottom, y + (it.d ?? 0));
      for (const r of it.runs ?? []) {
        const at = y + (Number(r?.dy) || 0);
        const [a, b] = r?.rule ? [at, at + (Number(r.h) || 0)] : [at - 6, at + 1];
        top = Math.min(top, a);
        bottom = Math.max(bottom, b);
      }
      y += it.d ?? 0;
      first = false;
    }
  }
  return [top, bottom];
}

/**
 * What page `n` draws of its head and of its foot (docs/10 §10.7a), slot by
 * slot: the slot's own canonical band while F4 holds for it
 * (`hfBandShown(meta, which)`), alone only where neither band holds art of
 * the other or from elsewhere (`hfBandsApart`: art that crosses the bands
 * takes both together); else the slot's runs while the page's entry is
 * shown for it (`hfEntryShown(which)`; a slot that draws takes nothing
 * without its band); else, for the foot, the provisional folio where the
 * page's style draws one (`hfProvisional`: true, or the folio as TeX numbers
 * the page). engine-v3.js furnitureSig reads
 * the same choice.
 */
export function furnitureChoice(n, geo, { chunks, hf, hfEntryShown = () => true, hfBandShown = () => true,
  hfBandsApart = () => false, hfProvisional = () => true }) {
  const T = 72 + (geo?.topmargin ?? 0) + (geo?.headheight ?? 0) + (geo?.headsep ?? 0);
  const room = geo ? { h: T > 0, f: geo.paperheight > T + geo.textheight } : { h: true, f: true };
  // (the exact PDF's two bands, then the furniture render's: each pair as one)
  const pair = (key) => {
    const meta = { h: chunks?.get(key(n, 'h')) ?? null, f: chunks?.get(key(n, 'f')) ?? null };
    const shown = {};
    for (const which of ['h', 'f']) shown[which] = !!meta[which] && room[which] && hfBandShown(meta[which], which);
    const visible = shown.h ? meta.h : meta.f;
    const alone = shown.h !== shown.f && (visible?.rec?.apart || (!!meta.h && !!meta.f && hfBandsApart(meta.h, meta.f)));
    return (which) => ((shown.h && shown.f) || (shown[which] && alone) ? meta[which] : null);
  };
  const exact = pair(hfBandChunkKey);
  const rendered = pair(hfRenderChunkKey);
  const entry = hf?.get(n) ?? null;
  const slot = (which) => {
    const band = exact(which) ?? rendered(which);
    if (band) return { band };
    return entry && hfEntryShown(which) ? { entry } : null;
  };
  const h = slot('h');
  const f = slot('f');
  return { h, f, folio: !f && hfProvisional() };
}

function paintHfItems(commands, items, X, anchorY, context) {
  let y = anchorY;
  let first = true;
  for (const it of items ?? []) {
    if (it.k === 'glue' || it.k === 'kern') {
      y += it.a ?? 0;
    } else if (it.k === 'box') {
      if (!first) y += it.h ?? 0;
      runCommands(commands, it.runs, X, y, '_hf', context);
      y += it.d ?? 0;
      first = false;
    }
  }
}
