import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { waitForPdf } from './util/fs.js';
import { pdfPageSvgArgs, r2 } from './util/svg.js';
import { buildLastskipPrimer } from './job-body.js';
import { shippingPriorityQuietMs } from './interactive-priority.js';
import { withReplaceablePreviewJob } from './build-lease-preview.js';
import { runShipCommand } from './resident-render.js';

// Page art (docs/08 §8.5a, docs/10 §10.4q): a block whose picture is drawn
// against `current page` (a cover, a page-anchored mark).
//
// A block's exact render ships it on a tight page: the block's height, and
// the text width with a paper width on each side. `current page` is then
// that tight page, so art anchored to it lands far outside the picture, and
// the display list shows a block's picture only through the bands of its own
// lines: of a cover (`\null` and a zero-height overlay line) a strip of the
// wrong part of the art, the rest of the page white.
//
//  A  A picture with ink far outside its tight page, or whose pictures read
//     positions on the page (farInkOf), is never shown through the lines that
//     hold no text of their own (picture-only lines): they are blank and owed
//     (`pending-exact`, as for an exact render on its way) until something
//     correct exists. Lines with text are drawn as before.
//  B  Such a block is rendered again, from its own checkpoint, on the
//     document's paper: its lines where the page builder put them, each page
//     of the block a PDF page, \c@page the folio of the page each part is on,
//     pgf's remembered positions carried from one pass to the next until they
//     no longer move. Each page's picture (`<block>@art<k>`) is the whole
//     paper; a page that holds nothing but such blocks shows them whole, any
//     other page through the bands of the block's lines. The pictures are
//     the block's: made for its galley and the places of its lines, used
//     only while both are what they were, made again (after the typing has
//     paused, behind Build, one at a time) when either changes. Art that
//     reads what this render cannot know (another block's picture, a running
//     mark, a page reference) stays A.
//
// TDOM_COVER_ART=0: neither (the tight picture through every line, as
// before); TDOM_COVER_ART=a: A only.
const MODE = process.env.TDOM_COVER_ART ?? '';
export const PAGE_ART_OFF = MODE === '0';
const B_OFF = PAGE_ART_OFF || MODE === 'a';
const envNum = (name, fallback) => {
  const n = Number(process.env[name]);
  return process.env[name] != null && Number.isFinite(n) && n >= 0 ? n : fallback;
};
// ink this far outside the tight page (bp) is not the block's own overhang
export const FAR_INK_BP = envNum('TDOM_COVER_FAR_BP', 36);
const MAX_PASSES = 3;
// a place whose render failed is tried this many times in all, a second
// time after RETRY_MS; one an edit pre-empted is tried again after the next
// pause, up to MAX_SUPERSEDED times
const MAX_FAILURES = 2;
const RETRY_MS = 1000;
const MAX_SUPERSEDED = 20;
// the pause after the last update (or exact render) before a page-art render
// starts: render-pump.js BURST_PAUSE_MS, the pause a deferred render waits for
const QUIET_MS = envNum('TDOM_COVER_QUIET_MS', 450);
const BLEED = 2; // display-list.js EXACT_CHUNK_BLEED_BP
const SP_PER_BP = 65781.76;

const IDENTITY = [1, 0, 0, 1, 0, 0];
const mul = (m, n) => [
  m[0] * n[0] + m[2] * n[1], m[1] * n[0] + m[3] * n[1],
  m[0] * n[2] + m[2] * n[3], m[1] * n[2] + m[3] * n[3],
  m[0] * n[4] + m[2] * n[5] + m[4], m[1] * n[4] + m[3] * n[5] + m[5],
];
const NUM = /-?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?/g;
function transformOf(attrs) {
  const t = /\btransform="([^"]*)"/.exec(attrs);
  if (!t) return IDENTITY;
  let m = IDENTITY;
  for (const [, op, args] of t[1].matchAll(/(\w+)\s*\(([^)]*)\)/g)) {
    const v = (args.match(NUM) ?? []).map(Number);
    if (op === 'matrix' && v.length === 6) m = mul(m, v);
    else if (op === 'translate') m = mul(m, [1, 0, 0, 1, v[0] ?? 0, v[1] ?? 0]);
    else if (op === 'scale') m = mul(m, [v[0] ?? 1, 0, 0, v[1] ?? v[0] ?? 1, 0, 0]);
  }
  return m;
}
const attr = (attrs, name) => {
  const v = new RegExp(`\\b${name}="([^"]*)"`).exec(attrs);
  return v ? Number(v[1]) : NaN;
};
// containers whose content is not drawn where it stands
const UNDRAWN = new Set(['defs', 'clipPath', 'mask', 'pattern', 'symbol', 'marker', 'linearGradient', 'radialGradient']);

/**
 * Where a pdftocairo page SVG puts ink, unclipped: the bounding box of its
 * paths' points, glyph origins, images and rectangles, in the SVG's own
 * units (bp from the page's top-left). Paths are cairo's (M, L, C, Z, all
 * absolute), so their numbers are point pairs; curve control points count,
 * which makes the box an upper bound. Null when nothing is drawn.
 */
export function inkBounds(svg) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  const add = (m, x, y) => {
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    const X = m[0] * x + m[2] * y + m[4];
    const Y = m[1] * x + m[3] * y + m[5];
    if (X < x0) x0 = X;
    if (X > x1) x1 = X;
    if (Y < y0) y0 = Y;
    if (Y > y1) y1 = Y;
  };
  const stack = [{ m: IDENTITY, hidden: false }];
  const body = svg.indexOf('>', svg.indexOf('<svg'));
  const TAG = /<(\/?)([A-Za-z][\w:-]*)\b([^>]*?)(\/?)>/g;
  TAG.lastIndex = body > 0 ? body + 1 : 0;
  for (let t; (t = TAG.exec(svg));) {
    const [, closing, name, attrs, selfClosing] = t;
    if (closing) {
      if (stack.length > 1) stack.pop();
      continue;
    }
    const top = stack[stack.length - 1];
    const hidden = top.hidden || UNDRAWN.has(name);
    const m = mul(top.m, transformOf(attrs));
    if (!hidden) {
      if (name === 'path') {
        const d = /\bd="([^"]*)"/.exec(attrs);
        const v = d ? (d[1].match(NUM) ?? []).map(Number) : [];
        for (let i = 0; i + 1 < v.length; i += 2) add(m, v[i], v[i + 1]);
      } else if (name === 'use') {
        add(m, attr(attrs, 'x') || 0, attr(attrs, 'y') || 0);
      } else if (name === 'image' || name === 'rect') {
        const x = attr(attrs, 'x') || 0, y = attr(attrs, 'y') || 0;
        const w = attr(attrs, 'width') || 0, h = attr(attrs, 'height') || 0;
        add(m, x, y); add(m, x + w, y); add(m, x, y + h); add(m, x + w, y + h);
      }
    }
    if (!selfClosing) stack.push({ m, hidden });
  }
  return Number.isFinite(x0) ? { x0, y0, x1, y1 } : null;
}

/** Whether a block's tight picture (`wBp` x `hBp`, unpadded at 0) cannot be
 * right where it stands: its ink reaches FAR_INK_BP or more outside the
 * page, or its pictures read positions on the page (`queried`, the names
 * the RENDER child recorded: tdomart-q.txt). The second catches art the
 * converter left out because it lies wholly outside the tight page (poppler
 * draws nothing of it). Null when neither, else what was seen. */
export function farInkOf(svg, wBp, hBp, queried = []) {
  if (PAGE_ART_OFF) return null;
  const ink = inkBounds(svg);
  const far = !!ink && (ink.y0 < -FAR_INK_BP || ink.y1 > hBp + FAR_INK_BP || ink.x0 < -FAR_INK_BP || ink.x1 > wBp + FAR_INK_BP);
  if (!far && !queried.length) return null;
  return {
    ...(far ? { x0: r2(ink.x0), y0: r2(ink.y0), x1: r2(ink.x1), y1: r2(ink.y1) } : {}),
    ...(queried.length ? { reads: queried.length } : {}),
  };
}

const textTop = (geo) => 72 + (geo.topmargin ?? 0) + (geo.headheight ?? 0) + (geo.headsep ?? 0);

/**
 * Where the page builder put the block's lines now: one segment a page, the
 * page's folio, and each line's index and top below the text area's top
 * (bp). `empty`: the page carries a \thispagestyle{empty} (it prints no head
 * or foot). `key` names the plan with the galley it is for.
 */
export function artPlan(engine, block) {
  const segs = [];
  let byId = null;
  for (const page of engine.pages ?? []) {
    let seg = null;
    for (const entry of page.draw ?? []) {
      const u = entry.u;
      if (u?.blockId !== block.id || u.li == null) continue;
      seg ??= { page: page.number, folio: page.folio ?? page.number, lines: [] };
      seg.lines.push([u.li, entry.y - (u.ln?.boxH ?? u.h ?? 0)]);
    }
    if (!seg) continue;
    for (const ref of page.evs ?? []) {
      byId ??= new Map(engine.blocks.map((b) => [b.id, b]));
      const ev = ref.bid ? byId.get(ref.bid)?.galley?.events?.[ref.i] : ref;
      if (ev?.k === 'thisstyle') seg.empty = ev.a === 'empty';
    }
    segs.push(seg);
  }
  if (!segs.length) return null;
  const key = `${block.galleyHash}|` + segs.map((s) =>
    `${s.folio}:${s.empty ? 1 : 0}:${s.lines.map(([li, top]) => `${li}@${r2(top)}`).join(',')}`).join(';');
  return { key, segs };
}

/** The TeX that goes before the block's own prelude and text in a page-art
 * RENDER (daemon.lua ship_page_art): the plan, the document's offsets, pgf's
 * position marks rerouted to the daemon (the positions read are recorded by
 * the root's wrapper, daemon.lua tdom_page_art_query), what art cannot read
 * here, the positions of the pass before, and the folio of the block's first
 * page. No node is made: all of it is definitions and Lua. */
export function artPrelude(plan, marks = null) {
  const sp = (bp) => Math.round(bp * SP_PER_BP);
  const segs = plan.segs.map((s) => `{f=${s.folio},lines={${s.lines.map(([li, top]) => `{${li},${sp(top)}}`).join(',')}}}`);
  const L = [
    `\\directlua{TDOM_PAGE_ART={segs={${segs.join(',')}}}}`,
    // the document's offsets (zero: renderPageArt), where the driver has
    // -1in for tight pages: pgf's page origin is (\hoffset, \voffset)
    '\\hoffset=0pt\\voffset=0pt',
    '\\expandafter\\def\\csname pgfsys@markposition\\endcsname#1{\\edef\\TDOMartid{#1}' +
      '\\expandafter\\TDOMartmark\\expandafter{\\TDOMartid}}',
    "\\def\\TDOMartmark#1{\\latelua{tdom_page_art_mark('\\luaescapestring{#1}')}}",
    // the running marks are the output routine's: art that prints them reads
    // what this render cannot know (renderPageArt fails, A stays)
    "\\ifdefined\\leftmark\\let\\TDOMartleft\\leftmark\\def\\leftmark{\\directlua{tdom_page_art_query('mark:left')}\\TDOMartleft}\\fi",
    "\\ifdefined\\rightmark\\let\\TDOMartright\\rightmark\\def\\rightmark{\\directlua{tdom_page_art_query('mark:right')}\\TDOMartright}\\fi",
    // so is a page number of a label: the resident's is the provisional
    // layout's, which the full compile need not agree with
    "\\ifdefined\\pageref\\let\\TDOMartpageref\\pageref\\def\\pageref{\\directlua{tdom_page_art_query('ref:page')}\\TDOMartpageref}\\fi",
  ];
  if (marks?.size) {
    // what \pgfsyspdfmark defines when the .aux is read (pgfsys-luatex.def);
    // not \pgfsyspdfmark itself: its rerun check is \@newl@bel, preamble-only
    L.push([...marks].map(([name, [x, y]]) =>
      `\\expandafter\\gdef\\csname pgf@sys@pdf@mark@pos@${name}\\endcsname{\\pgfqpoint{${x}sp}{${y}sp}}`).join(''));
  }
  L.push(`\\expandafter\\ifx\\csname c@page\\endcsname\\relax\\else\\global\\csname c@page\\endcsname=${plan.segs[0].folio}\\relax\\fi`);
  return L.join('\n') + '\n';
}

function readMarks(dir) {
  const marks = new Map();
  const file = path.join(dir, 'tdompos.aux');
  if (!existsSync(file)) return marks;
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    const m = /^\\pgfsyspdfmark\{([^{}]*)\}\{(-?\d+)\}\{(-?\d+)\}$/.exec(line.trim());
    // (carried into the next pass inside \csname: a name TeX would read as
    // anything but characters cannot be)
    if (!m || !/^[A-Za-z0-9@:._ -]+$/.test(m[1])) throw fail(`page-art position mark not carried: ${line.slice(0, 80)}`);
    marks.set(m[1], [Number(m[2]), Number(m[3])]);
  }
  return marks;
}
export function readQueries(dir) {
  const file = path.join(dir, 'tdomart-q.txt');
  return existsSync(file) ? [...new Set(readFileSync(file, 'utf8').split('\n').filter(Boolean))] : [];
}
const sameMarks = (a, b) => a.size === b.size && [...a].every(([k, [x, y]]) => b.get(k)?.[0] === x && b.get(k)?.[1] === y);

function fail(message) {
  const err = new Error(message);
  err.tdomPageArt = true;
  return err;
}
function superseded(message) {
  const err = new Error(message);
  err.tdomSuperseded = true;
  return err;
}

/** The lines the daemon shipped are the galley's: as many boxes, each placed
 * one as tall and deep as the galley's line (a different typesetting would
 * draw something else under the galley's name). */
function checkReport(dir, block, plan) {
  const file = path.join(dir, 'tdomart.txt');
  if (!existsSync(file)) throw fail('page-art render wrote no report');
  const boxes = (block.galley?.items ?? []).filter((it) => it.k === 'box');
  const placed = new Set(plan.segs.flatMap((s) => s.lines.map(([li]) => li)));
  let lines = -1;
  const seen = new Set();
  for (const row of readFileSync(file, 'utf8').split('\n')) {
    const [kind, ...v] = row.split(' ');
    if (kind === 'offsets' && (Number(v[0]) !== 0 || Number(v[1]) !== 0)) throw fail('\\hoffset or \\voffset is not zero');
    if (kind === 'lines') lines = Number(v[0]);
    if (kind === 'line') {
      const [li, h, d] = v.map(Number);
      const item = boxes[li];
      if (!item || Math.abs(h / SP_PER_BP - (item.h ?? 0)) > 0.01 || Math.abs(d / SP_PER_BP - (item.d ?? 0)) > 0.01) {
        throw fail(`page-art line ${li} is ${r2(h / SP_PER_BP)}+${r2(d / SP_PER_BP)} bp, the galley's ` +
          `${item ? `${r2(item.h ?? 0)}+${r2(item.d ?? 0)}` : 'none'}`);
      }
      seen.add(li);
    }
  }
  if (lines !== boxes.length || seen.size !== placed.size) throw fail(`page-art render has ${lines} lines, the galley ${boxes.length}`);
}

function convertPage(engine, pdf, page, out) {
  return new Promise((resolve, reject) => {
    const child = execFile('pdftocairo', pdfPageSvgArgs(page, pdf, out), { timeout: 30_000 }, (err) => {
      engine.isoChildren?.delete(child);
      if (err) reject(err);
      else resolve();
    });
    // (closeEngine kills what is left in isoChildren)
    engine.isoChildren?.add(child);
  });
}

/**
 * Render `block` on the paper for the places its lines have now and land the
 * pictures. Resolves to what happened: 'landed', 'fresh' (its pictures are
 * for these places already), 'skip' (nothing to do: not page art, galley not
 * settled, no place), 'gave-up' or 'no-checkpoint' (A stays); throws a
 * superseded error when an edit or a new layout overtook it, a page-art
 * error when it cannot be right (A stays).
 */
export async function renderPageArt(engine, block, callbacks) {
  const stats = (engine.artStats ??= {
    renders: 0, passes: 0, landed: 0, failed: 0, superseded: 0, gaveUp: 0, noCheckpoint: 0, lastMs: 0, svgBytes: 0,
  });
  const idx = engine.blocks.indexOf(block);
  if (idx < 0 || !block.galley || block.sourceChanged || block.galley.tdomColdPreview || engine.mode !== 'structured') return 'skip';
  const forGalley = block.galleyHash;
  const main = engine.chunks.get(block.id);
  if (!main?.farInk || main.forGalley !== forGalley) return 'skip';
  const plan = artPlan(engine, block);
  if (!plan) return 'skip';
  if (main.art?.key === plan.key) return 'fresh';
  // (a document that moves its pages with \hoffset or \voffset is laid out by
  // the preview without them: no picture on the paper would match it)
  if ((engine.geometry?.hoffset ?? 0) !== 0 || (engine.geometry?.voffset ?? 0) !== 0) return 'skip';
  const tries = (engine.artTries ??= new Map());
  const tried = tries.get(plan.key) ?? { failed: 0, superseded: 0 };
  if (tried.failed >= MAX_FAILURES || tried.superseded >= MAX_SUPERSEDED) {
    stats.gaveUp++;
    return 'gave-up';
  }
  const ck = engine.checkpoints.get(idx);
  if (!ck) {
    stats.noCheckpoint++;
    return 'no-checkpoint';
  }
  const prelude = block.galley?.tdomRenderPrelude ??
    ((engine.defsPatch?.touches(block.text) ? engine.defsPatch.prelude : '') + buildLastskipPrimer(block, idx, engine.blocks));
  engine.artSeq = (engine.artSeq ?? 0) + 1;
  const base = path.join(engine.workDir, `art-${block.id}-${engine.artSeq}`);
  const t0 = Date.now();
  stats.renders++;
  const current = () => engine.blocks[idx] === block && block.galleyHash === forGalley && !engine.closed;
  try {
    // (the positions the block's last picture on the paper settled at: a
    // cover moved to another page lands where it stood, and one pass then
    // confirms them; the ids are the galley's, so only for the same galley)
    let marks = main.art?.forGalley === forGalley && main.art.marks?.length ? new Map(main.art.marks) : null;
    let final = null;
    for (let pass = 1; pass <= MAX_PASSES && !final; pass++) {
      const dir = path.join(base, String(pass));
      mkdirSync(dir, { recursive: true });
      const body = Buffer.from(artPrelude(plan, marks) + prelude + block.text, 'utf8');
      const requestId = `rr@${++engine.renderSeq}`;
      stats.passes++;
      await runShipCommand(engine, {
        block, idx, ck, requestId, checkpointIndex: idx, body,
        command: `RENDER ${block.id} ${encodeURIComponent(dir)} ${body.length} ${requestId}\n`,
        awaitRender: callbacks.awaitRender,
        renderIsolated: () => {},
      });
      const pdf = path.join(dir, 'driver.pdf');
      await waitForPdf(pdf);
      if (!current()) throw superseded(`page art of ${block.id} superseded`);
      checkReport(dir, block, plan);
      const found = readMarks(dir);
      // a position the block's pictures read that none of them recorded is
      // another block's picture's: this render cannot know it
      const foreign = readQueries(dir).filter((q) => q !== 'pgfpageorigin' && !found.has(q));
      if (foreign.length) throw fail(`page art of ${block.id} reads what the page around it holds (a position outside the block, a running mark, a page reference) (${foreign[0]})`);
      if (!found.size) {
        final = pdf;
        marks = null;
      } else if (marks && sameMarks(marks, found)) final = pdf;
      else marks = found;
    }
    if (!final) throw fail(`page art of ${block.id}: positions still moving after ${MAX_PASSES} passes`);
    const geo = engine.geometry ?? {};
    const footTop = textTop(geo) + (geo.textheight ?? 0);
    const pictures = [];
    for (let k = 1; k <= plan.segs.length; k++) {
      const out = path.join(path.dirname(final), `art-${k}.svg`);
      await convertPage(engine, final, k, out);
      const svg = readFileSync(out, 'utf8');
      const ink = inkBounds(svg);
      pictures.push({ svg, foot: !!ink && ink.y1 > footTop + 0.5 });
    }
    // land only while the galley, its picture and the places are still these
    if (!current()) throw superseded(`page art of ${block.id} superseded`);
    const live = engine.chunks.get(block.id);
    if (!live?.farInk || live.forGalley !== forGalley || artPlan(engine, block)?.key !== plan.key) {
      throw superseded(`page art of ${block.id}: its places changed while it rendered`);
    }
    const editPdf = readFileSync(final);
    const W = geo.paperwidth, H = geo.paperheight;
    const L = 72 + (geo.oddsidemargin ?? 0);
    const segs = plan.segs.map((s, i) => ({ ...s, chunk: `${block.id}@art${i + 1}`, foot: pictures[i].foot }));
    for (const [i, seg] of segs.entries()) {
      const prev = engine.chunks.get(seg.chunk);
      engine.chunks.set(seg.chunk, {
        svg: pictures[i].svg, wBp: W, logicalWBp: W, hBp: H, xBp: -L, v: (prev?.v ?? 0) + 1, forGalley,
        editPdf, editPage: i + 1, editX: 0, editY: 0, pageArt: 1,
      });
    }
    dropPageArt(engine, block.id, segs.length);
    // (the block's own record carries them: its new version rebuilds the
    // block's units and with them the display lists of its pages)
    engine.chunks.set(block.id, {
      ...live, v: (live.v ?? 0) + 1, art: { key: plan.key, forGalley, segs, marks: marks ? [...marks] : [] },
    });
    stats.landed++;
    stats.lastMs = Date.now() - t0;
    stats.svgBytes = pictures.reduce((sum, p) => sum + p.svg.length, 0);
    callbacks.asyncRepaginate?.();
    return 'landed';
  } catch (err) {
    if (err?.tdomSuperseded) {
      tried.superseded++;
      stats.superseded++;
    } else {
      tried.failed++;
      stats.failed++;
    }
    if (tries.size > 200) tries.clear();
    tries.set(plan.key, tried);
    throw err;
  } finally {
    // (TDOM_PAGE_ART_KEEP=1: leave the passes' directories for a diagnosis)
    if (process.env.TDOM_PAGE_ART_KEEP) console.error('PAGE_ART_KEEP', block.id, base);
    else rmSync(base, { recursive: true, force: true });
  }
}

/** Remove a block's page-art pictures after the first `keep`. */
export function dropPageArt(engine, blockId, keep = 0) {
  for (let k = keep + 1; engine.chunks.has(`${blockId}@art${k}`); k++) engine.chunks.delete(`${blockId}@art${k}`);
}

/** A block's exact picture landed (resident-render.js, isolated-render.js):
 * page art is wanted for one with far ink, and dropped for one without. */
export function notePageArtLanding(engine, blockId) {
  const main = engine.chunks.get(blockId);
  if (!main) return;
  if (!main.farInk) {
    if (engine.chunks.has(`${blockId}@art1`)) dropPageArt(engine, blockId);
    return;
  }
  wantPageArt(engine, blockId);
}

/** Ask for the block's page art (display-list.js asks through the chunk
 * map, for a page whose place has none). Idempotent; runs after a timer. */
export function wantPageArt(engine, blockId, notBefore = 0) {
  if (B_OFF || engine.closed || engine.opening) return;
  // (asked for while an update lays out its pages: its end is the start of
  // the pause, whether or not the pump sees the update run, waitMs)
  if (engine.updating) engine.artBusyAt = Date.now();
  engine.chunks.pageArtWanted ??= (id) => wantPageArt(engine, id);
  engine.artWant ??= new Map();
  const had = engine.artWant.get(blockId);
  if (!had || had.chunks !== engine.chunks) engine.artWant.set(blockId, { chunks: engine.chunks, notBefore });
  else had.notBefore = Math.max(had.notBefore, notBefore);
  armPageArt(engine, 25);
}

function armPageArt(engine, ms) {
  if (engine.artTimer || engine.artPumping || engine.closed) return;
  engine.artTimer = setTimeout(() => {
    engine.artTimer = null;
    pumpPageArt(engine).catch((err) => engine.diagnostics?.push(`page art: ${err?.message ?? err}`));
  }, ms);
  engine.artTimer.unref?.();
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms).unref?.());

// How long the next page-art render waits: for the update, for the edit's
// own exact renders (its cohort, render-pump.js), then for QUIET_MS after
// the last of them (at least the backlog renders' shipping window), and for
// its retry time. Measured from the end of the last update, not its start
// (lastEditAt): keystrokes 150 ms apart that take 50 ms each leave gaps of
// 100 ms, and a render forked in one would only be killed by the next key.
// Not behind the backlog of other blocks' renders: one that cannot finish
// (a block whose RENDER keeps failing) would hold the cover back with it.
function waitMs(engine, entry) {
  const cohort = engine.interactiveRenderCohort;
  const edits = cohort?.rev === engine.srcRev &&
    (cohort.active.size > 0 || [...cohort.queued].some((id) => engine.renderWant?.has(id)));
  if (engine.updating || edits) {
    engine.artBusyAt = Date.now();
    return 50;
  }
  // While a block without a measured galley holds a place (a first rescue on
  // its way, pagebuilder.js buildPages) no page can be shown and every later
  // page may still move: on the 30-page booklet the back cover was rendered
  // again for each of some 50 rescues landing in the 11 minutes after /open.
  if (engine.pages?.[0]?.pendingExact?.length) return 200;
  const since = Math.max(engine.lastEditAt ?? 0, engine.artBusyAt ?? 0);
  const quiet = Math.max(QUIET_MS, shippingPriorityQuietMs(engine, 0)) - (Date.now() - since);
  return Math.max(quiet, entry.notBefore - Date.now(), 0);
}

// One page-art render at a time. Every turn of the loop that does not run a
// render waits on a timer first; a render is a lualatex child and a
// pdftocairo per page. Retries are counted per place (renderPageArt).
async function pumpPageArt(engine) {
  if (engine.artPumping || engine.closed) return;
  engine.artPumping = true;
  try {
    while (engine.artWant?.size && !engine.closed) {
      if (engine.mode !== 'structured') {
        engine.artWant.clear();
        break;
      }
      let next = null;
      let wait = Infinity;
      for (const [id, entry] of engine.artWant) {
        const ms = waitMs(engine, entry);
        if (ms < wait) { wait = ms; next = id; }
      }
      if (wait > 0) {
        await sleep(Math.min(wait, 100));
        continue;
      }
      const entry = engine.artWant.get(next);
      engine.artWant.delete(next);
      if (entry.chunks !== engine.chunks) continue; // another document's
      const block = engine.blocks.find((b) => b.id === next);
      if (!block) continue;
      const callbacks = engine.renderCallbacks;
      if (!callbacks?.awaitRender) continue;
      await withReplaceablePreviewJob(engine, 'page-art', () => renderPageArt(engine, block, callbacks)).catch((err) => {
        if (engine.closed) return;
        if (err?.tdomSuperseded) {
          // the typing goes on, or the block moved: after the next pause
          wantPageArt(engine, next);
        } else {
          engine.diagnostics.push(`page art ${next}: ${err?.message ?? err}`);
          wantPageArt(engine, next, Date.now() + RETRY_MS);
        }
      });
      await sleep(0);
    }
  } finally {
    engine.artPumping = false;
    if (engine.artWant?.size && !engine.closed) armPageArt(engine, 100);
  }
}

// The segment of `meta`'s pictures on the paper made for these lines at
// these places on `page`, if it has one.
function segFor(meta, page, lines, T) {
  const art = meta?.art;
  if (!art || art.forGalley !== meta.forGalley) return null;
  return art.segs.find((s) => s.folio === (page.folio ?? page.number) && lines.every((u) =>
    s.lines.some(([li, top]) => li === u.li && Math.abs(T + top - u.top) < 0.05))) ?? null;
}

// Whether the page holds nothing but lines of blocks whose pictures on the
// paper are made for their places here (so each is shown whole, in the
// order of the page: a picture covers the ones before it as on the paper),
// and its foot prints nothing or is not under any of that art (LaTeX sets the
// foot after the body: it would stand over the art, here under it).
function wholePage(page, chunks, T) {
  if (page.feet?.length || page.topFloats?.length || page.botFloats?.length || page.floatPage) return false;
  for (const entry of page.draw ?? []) {
    const u = entry.u;
    if (u?.li == null || u.ln?.gfxChunk?.blockId !== u.blockId || u.ln.gfxChunk.stale || u.ln.gfxChunk.held) return false;
    const meta = chunks.get(u.blockId);
    if (!meta?.farInk) return false;
    const seg = segFor(meta, page, [{ li: u.li, top: T + entry.y - (u.ln.boxH ?? u.h ?? 0) }], T);
    if (!seg || !chunks.get(seg.chunk) || (seg.foot && !seg.empty)) return false;
  }
  return true;
}

/**
 * The display list's windows for one run of a page-art block's lines on
 * `page` (display-list.js flushGfx). `group.list` holds the lines, each
 * { li, top, h, d, ink, yOff } (top: the line box's top on the page). The
 * block's picture on the paper for this page is shown whole on a page that
 * holds nothing else (wholePage), else through the band of the lines. With
 * no picture for these places, the lines with no text are owed (A) and the
 * others go to `emitTight` as before. `shownWhole` (one per display list)
 * remembers the page's verdict and the pictures already shown whole.
 */
export function pageArtCommands(commands, { page, group, meta, chunks, geo, L, T, shownWhole, emitTight }) {
  const list = group.list ?? [];
  const seg = !group.stale && !group.held ? segFor(meta, page, list, T) : null;
  const picture = seg ? chunks.get(seg.chunk) : null;
  if (seg && picture) {
    if (shownWhole.has(seg.chunk)) return;
    if (!shownWhole.has(page)) shownWhole.set(page, wholePage(page, chunks, T));
    const H = picture.hBp, W = picture.wBp;
    if (shownWhole.get(page)) {
      shownWhole.set(seg.chunk, true);
      commands.push({ op: 'chunk', chunk: seg.chunk, x: 0, y: 0, w: r2(W), h: r2(H), sy: 0, ch: r2(H), cv: picture.v ?? 0, src: group.blockId });
      return;
    }
    const y0 = Math.max(0, Math.min(...list.map((u) => u.top)) - BLEED);
    const y1 = Math.min(H, Math.max(...list.map((u) => u.top + u.h + u.d)) + BLEED);
    if (y1 > y0) {
      commands.push({
        op: 'chunk', chunk: seg.chunk, x: 0, y: r2(y0), w: r2(W), h: r2(y1 - y0), sy: r2(y0), ch: r2(H),
        cv: picture.v ?? 0, line: list.length === 1 ? list[0].li : undefined, src: group.blockId,
      });
    }
    return;
  }
  // A: nothing correct for these places yet
  chunks.pageArtWanted?.(group.blockId);
  let run = [];
  const flushRun = () => {
    if (run.length) emitTight(run);
    run = [];
  };
  for (const u of list) {
    // The retained tight render may end before a line's new position. A
    // window with no source pixels must stay owed until the page art lands.
    if (u.ink && u.h + u.d > 0.01 && u.yOff < meta.hBp) {
      run.push(u);
      continue;
    }
    flushRun();
    commands.push({ op: 'pending-exact', x: r2(L), y: r2(u.top), w: r2(geo.textwidth), h: r2(u.h + u.d), src: group.blockId });
  }
  flushRun();
}
