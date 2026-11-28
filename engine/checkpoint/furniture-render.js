import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { waitForPdf } from './util/fs.js';
import { cropSvgAt, pdfPageSvgArgs } from './util/svg.js';
import { runShipCommand } from './resident-render.js';
import { hfBandChunkKey, hfRenderChunkKey, hfSlotExtent } from './display-list.js';
import { HF_PARITY, hfRenderBody } from './page-metadata.js';
import { fnv1a } from '../hash.js';
import { betweenUpdates, mapCurrent, rootKey } from './header-scheduler.js';
import {
  bandInk, bandShown, bandsApart, cutWanted, folioUnknownFrom, furnitureBands, furnitureReadsEstablished, furnitureRenderKey, geometryKey, svgInkRows,
} from './canonical-arrival.js';

// Furniture rendered from the current source (docs/10 §10.7a, audit/scratch
// r12 item 5). A head or foot that draws is shown from the canonical page's
// own band while F4 holds for it; when its page's head changed, nothing of it
// is shown until the next exact PDF (a minute and more for a booklet). Where
// one picture in the head also paints the foot (the booklet's folio "―29―"
// under a `remember picture, overlay` head), the unchanged folio went with
// the changed head: v0.1.32 showed the folio, with the old, wrong head.
//
// Once the runs job of the current layout has landed, the pages whose head
// or foot draws and has no band shown are rendered: the job's state for each
// page (its spec, the chain of body definitions, LastPage, where floats
// landed), its head and foot shipped where \@outputpage puts them on the
// paper, pgf's remembered positions carried from pass to pass until they
// stand (as page art's, page-art.js), each page cut into its two bands. They
// are the page's while the runs stay its (F4 with `rec.render`: the slot's
// fingerprint, folio and geometry as rendered); the next exact PDF of the
// source replaces them. At most RENDER_PAGES pages a render, the reader's
// first, one at a time, once the typing has paused RENDER_QUIET_MS. It needs neither the runs of
// the layout (a page's spec is all it sets) nor the Build lease: a page or
// two of furniture is a fraction of a second of one core, and the exact
// pass that holds the lease right after the typing takes a minute on a
// booklet, while v0.1.32 showed the folio within seconds (audit/scratch r12
// item 5). A render overtaken by an edit or a new layout is dropped.
//
// Every target needs a control of its own template, folio parity and float
// state, plus a trace of the dependencies of the target boxes themselves.
// A successful control alone says nothing about state the body changed.
const RENDER_PAGES = Number(process.env.TDOM_HF_RENDER_PAGES || 8);
const RENDER_QUIET_MS = Number(process.env.TDOM_HF_RENDER_QUIET_MS || 300);
// The reader's pages go ahead of the rest.
const RENDER_REACH = Number(process.env.TDOM_HF_RENDER_REACH || 16);
const MAX_PASSES = 3;

function readMarks(dir) {
  const marks = new Map();
  const file = path.join(dir, 'tdompos.aux');
  if (!existsSync(file)) return marks;
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    const m = /^\\pgfsyspdfmark\{([^{}]*)\}\{(-?\d+)\}\{(-?\d+)\}$/.exec(line.trim());
    if (!m || !/^[A-Za-z0-9@:._ -]+$/.test(m[1])) throw new Error(`furniture render: position mark not carried: ${line.slice(0, 80)}`);
    marks.set(m[1], [Number(m[2]), Number(m[3])]);
  }
  return marks;
}
const sameMarks = (a, b) => a.size === b.size && [...a].every(([k, [x, y]]) => b.get(k)?.[0] === x && b.get(k)?.[1] === y);

// What a page SVG paints in a band of rows (bp from the top): each glyph by
// its outline and where it stands, each path, rect and image by its box, in
// reading order. Two renders of the same furniture give the same; a digit
// for another, a word for another, does not (the rows alone cannot tell).
// (definition containers: what is inside them paints only where it is referenced)
const SVG_DEFS = new Set(['defs', 'clipPath', 'mask', 'pattern', 'symbol', 'marker', 'linearGradient', 'radialGradient', 'filter']);
const SVG_TAG = /<(\/?)(defs|clipPath|mask|pattern|symbol|marker|linearGradient|radialGradient|filter|g|path|use|image|rect)\b([^>]*?)(\/?)>/g;
const SVG_NUM = /-?\d*\.?\d+(?:e[-+]?\d+)?/gi;
const svgAttrs = new Map();
function attr(attrs, name) {
  if (!svgAttrs.has(name)) svgAttrs.set(name, new RegExp(`\\s${name}="([^"]*)"`));
  return svgAttrs.get(name).exec(attrs)?.[1];
}
const appearance = (parent, attrs) => {
  const paint = { ...parent };
  for (const part of (attr(attrs, 'style') ?? '').split(';')) {
    const [key, value] = part.split(':');
    if (key && value) paint[key.trim()] = value.replace(/\s+/g, '');
  }
  for (const key of ['fill', 'fill-opacity', 'fill-rule', 'stroke', 'stroke-opacity', 'stroke-width', 'opacity', 'clip-path', 'mask', 'filter']) {
    const value = attr(attrs, key);
    if (value != null) paint[key] = value;
  }
  return paint;
};

// What a file-local reference (`url(#clip1)`, `xlink:href="#source-5"`)
// names: its definition's content, with the references inside it resolved
// the same way. Cairo numbers clip paths, masks, patterns and images per
// file, so two pages can give one id to different geometry and different
// ids to the same: the id is no evidence either way (M2). A reference whose
// definition is not found (or not of a kind compared here) resolves to null
// and proves nothing.
const SVG_REF_DEF = /<(clipPath|mask|pattern|symbol|marker|linearGradient|radialGradient|filter|image)\b([^>]*?)(?:\/>|>([\s\S]*?)<\/\1\s*>)/g;
const SVG_REF = /url\(\s*['"]?#([^'")\s]+)['"]?\s*\)|(?:xlink:)?href="#([^"]+)"/g;
function svgReferences(svg, outlines) {
  const raw = new Map();
  for (const match of svg.matchAll(SVG_REF_DEF)) {
    const id = attr(match[2], 'id');
    if (id != null && !raw.has(id)) raw.set(id, match[0]);
  }
  const resolved = new Map();
  const resolve = (id, depth = 0) => {
    if (outlines.has(id)) return 'o' + outlines.get(id);
    if (resolved.has(id)) return resolved.get(id);
    const text = raw.get(id);
    if (text === undefined || depth > 8) return null;
    resolved.set(id, null); // (a definition that refers to itself proves nothing)
    let known = true;
    const body = text.replace(/\sid="[^"]*"/, '').replace(SVG_REF, (whole, url, href) => {
      const value = resolve(url ?? href, depth + 1);
      if (value == null) known = false;
      return url != null ? `url(${value})` : `href="${value}"`;
    }).replace(/\s+/g, ' ').trim();
    const value = known ? 'd' + fnv1a(body) : null;
    resolved.set(id, value);
    return value;
  };
  return resolve;
}

/** `paint` with every reference replaced by its content, or null when one
 * cannot be resolved. */
function resolvedPaint(paint, resolve) {
  let out = paint;
  for (const [key, value] of Object.entries(paint)) {
    if (typeof value !== 'string' || !value.includes('url(')) continue;
    let known = true;
    const next = value.replace(SVG_REF, (whole, url) => {
      const content = url != null ? resolve(url) : null;
      if (content == null) known = false;
      return `url(${content})`;
    });
    if (!known) return null;
    if (out === paint) out = { ...paint };
    out[key] = next;
  }
  return out;
}
const paintKey = (paint) => JSON.stringify(Object.entries(paint).sort(([a], [b]) => a.localeCompare(b)));
function multiply([a, b, c, d, e, f], [A, B, C, D, E, F]) {
  return [a * A + c * B, b * A + d * B, a * C + c * D, b * C + d * D, a * E + c * F + e, b * E + d * F + f];
}
function parseTransform(text) {
  let m = [1, 0, 0, 1, 0, 0];
  for (const [, op, args] of String(text ?? '').matchAll(/(matrix|translate|scale)\s*\(([^)]*)\)/g)) {
    const v = (args.match(SVG_NUM) ?? []).map(Number);
    m = multiply(m, op === 'matrix' ? v : op === 'translate' ? [1, 0, 0, 1, v[0] ?? 0, v[1] ?? 0] : [v[0] ?? 1, 0, 0, v[1] ?? v[0] ?? 1, 0, 0]);
  }
  return m;
}
export function bandPaint(svg, top, bottom) {
  // A cropped canonical band retains the original SVG drawing commands.
  // Its root viewBox determines which rows of those commands are visible.
  const root = /^\s*(?:<\?xml[^>]*>\s*)?<svg\b([^>]*)>/.exec(String(svg ?? ''))?.[1];
  const view = root && attr(root, 'viewBox')?.trim().split(/[\s,]+/).map(Number);
  if (view?.length === 4 && view.every(Number.isFinite)) {
    top = Math.max(top, view[1]);
    bottom = Math.min(bottom, view[1] + view[3]);
  }
  if (bottom <= top) return [];
  const outlines = new Map();
  for (const [, id, shape] of String(svg ?? '').matchAll(/<g id="(glyph-[^"]+)">([\s\S]*?)<\/g>/g)) {
    // Cairo emits empty glyphs for spacing, including ideographic spaces.
    // They paint nothing. A missing definition, however, is unverified.
    outlines.set(id, shape.trim() ? fnv1a(shape.trim()) : '');
  }
  const resolve = svgReferences(String(svg ?? ''), outlines);
  const out = [];
  const stack = [{ matrix: [1, 0, 0, 1, 0, 0], paint: { fill: 'rgb(0%,0%,0%)', 'fill-opacity': '1', stroke: 'none' } }];
  let defs = 0;
  const at = (m, x, y) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
  for (const [, close, tag, attrs, selfClose] of String(svg ?? '').matchAll(SVG_TAG)) {
    if (SVG_DEFS.has(tag)) {
      if (close) defs = Math.max(0, defs - 1);
      else if (!selfClose) defs++;
      continue;
    }
    if (defs) continue;
    const parent = stack[stack.length - 1];
    const matrix = multiply(parent.matrix, parseTransform(attr(attrs, 'transform')));
    const paint = appearance(parent.paint, attrs);
    // (a clip or mask applies in the space of the element that names it)
    if (/\b(?:clip-path|mask)\b/.test(attrs)) {
      paint['ref-space'] = matrix.map((v, i) => (i < 4 ? Math.round(v * 1000) / 1000 : Math.round(v))).join(',');
    }
    if (tag === 'g') {
      if (close) { if (stack.length > 1) stack.pop(); } else if (!selfClose) stack.push({ matrix, paint });
      continue;
    }
    if (close) continue;
    const m = matrix;
    // (clip paths, masks, patterns by what they are: a reference that cannot
    // be resolved leaves the item unproven)
    const drawn = resolvedPaint(paint, resolve);
    if (tag === 'use') {
      const [X, Y] = at(m, Number(attr(attrs, 'x') ?? 0), Number(attr(attrs, 'y') ?? 0));
      const id = String(attr(attrs, 'xlink:href') ?? attr(attrs, 'href')).replace(/^#/, '');
      const outline = outlines.has(id) ? outlines.get(id) : resolve(id);
      if (outline === '') continue;
      if (Y >= top && Y <= bottom) out.push(['g', outline && drawn && JSON.stringify([outline, m.slice(0, 4), paintKey(drawn)]), X, Y, X, Y]);
      continue;
    }
    let points;
    if (tag === 'path') {
      const v = (attr(attrs, 'd')?.match(SVG_NUM) ?? []).map(Number);
      points = [];
      for (let i = 0; i + 1 < v.length; i += 2) points.push(at(m, v[i], v[i + 1]));
    } else {
      const x = Number(attr(attrs, 'x') ?? 0), y = Number(attr(attrs, 'y') ?? 0);
      points = [at(m, x, y), at(m, x + Number(attr(attrs, 'width') ?? 0), y + Number(attr(attrs, 'height') ?? 0))];
    }
    if (!points.length) continue;
    const xs = points.map((p) => p[0]), ys = points.map((p) => p[1]);
    const y0 = Math.max(Math.min(...ys), top), y1 = Math.min(Math.max(...ys), bottom);
    if (y0 <= y1) {
      const shape = tag === 'path' ? (attr(attrs, 'd') ?? '').replace(SVG_NUM, '') : attr(attrs, 'xlink:href');
      out.push([tag[0], drawn && JSON.stringify([shape, paintKey(drawn)]), Math.min(...xs), y0, Math.max(...xs), y1, ...points.flat()]);
    }
  }
  return out;
}
export const samePaint = (a, b) => a.length === b.length && a.every((p, i) => p.length === b[i].length &&
  p[0] === b[i][0] && p[1] && p[1] === b[i][1] && p.slice(2).every((v, k) => Math.abs(v - b[i][k + 2]) <= 1));

// Fully specified fancyhdr cells replace their prior contents. A wrapper
// around literal text is the same template when only that text changes.
// Leave other definitions (including arbitrary TeX or selectors) verbatim.
function renderContexts(specs) {
  const cells = new Map();
  let chain = '';
  return specs.map((spec) => {
    for (const [kind, args] of spec.fancy ?? []) {
      const cell = /^\[([LCR][EO]|[EO][LCR])\]\{(.*)\}$/s.exec(args);
      if (!cell || (kind !== 'head' && kind !== 'foot')) {
        chain = fnv1a(JSON.stringify([chain, [...cells], kind, args]));
        cells.clear();
        continue;
      }
      const key = kind + [...cell[1]].sort().join('');
      const content = cell[2].replace(/^(\\[\w@:_]+\s*\{(?:\\[\w@:_]+\s+)?)[\p{L}\p{N}\p{Zs}]+(\})$/u, '$1#$2');
      cells.delete(key);
      cells.set(key, content);
    }
    return JSON.stringify([spec.style, Math.abs(spec.folio % 2), spec.fl, spec.flCarry ?? '', chain, [...cells]]);
  });
}

function controlPages(engine, contexts, wanted, cut) {
  const controls = new Map();
  const excluded = new Set(wanted);
  for (const page of engine.pages) {
    const n = page.number;
    if (n >= cut || excluded.has(n)) continue;
    const metas = ['h', 'f'].map((w) => engine.chunks.get(hfBandChunkKey(n, w)));
    if (metas.every((meta) => meta && Array.isArray(meta.ink) && bandShown(engine, page, meta))) {
      controls.set(contexts[n - 1], { id: n, metas });
    }
  }
  return controls;
}

// A short worksheet may have no other page of the target's parity. Its
// previous exact band is also a control: typeset it with its own timeline,
// compare its pixels, then independently trace the new target.
function priorControl(engine, n, context, noted) {
  const metas = ['h', 'f'].map((w) => engine.chunks.get(hfBandChunkKey(n, w)));
  if (!metas.every((meta) => meta && Array.isArray(meta.ink))) return null;
  const rec = metas[0].rec;
  if (!rec?.spec || metas[1].rec !== rec || rec.gen.root !== rootKey(engine) ||
      rec.geometry !== geometryKey(engine.geometry) || rec.n >= rec.gen.folioCut) return null;
  const binding = engine.hfBindings?.get(rec.gen.id);
  if (!binding) return null;
  const specs = [...binding.pages.values()].map((page) => page.spec);
  if (specs.some((s) => !s) || renderContexts(specs)[n - 1] !== context) return null;
  // (`page`: the control's own sheet in its timeline; its id is given with
  // the render, renderFurniture)
  return { page: rec.n, specs, metas };
}

function historicalControls(engine, noted) {
  const binding = engine.hfCanon?.binding;
  if (!binding) return new Map();
  const specs = [...binding.pages.values()].map((page) => page.spec);
  const contexts = renderContexts(specs);
  const controls = new Map();
  for (const page of binding.pages.values()) {
    if (page.verified !== true || page.gen.root !== rootKey(engine) ||
        page.geometry !== geometryKey(engine.geometry) || page.n >= page.gen.folioCut) continue;
    const metas = ['h', 'f'].map((slot) => engine.chunks.get(hfBandChunkKey(page.n, slot)));
    if (metas.every((meta) => meta?.rec === page && Array.isArray(meta.ink))) {
      controls.set(contexts[page.n - 1], { page: page.n, specs, metas });
    }
  }
  return controls;
}

function readSlotTrace(pdf) {
  const reads = new Map();
  const file = path.join(path.dirname(pdf), 'tdom-hf-reads');
  if (!existsSync(file)) return reads;
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const m = /^(\d+) (h|f) (\d+) ([\w@:_$,]*)$/.exec(line);
    if (m) reads.set(`${m[1]}:${m[2]}`, { bits: Number(m[3]), deps: m[4] ? m[4].split(',') : [] });
  }
  return reads;
}

function convertPage(engine, pdf, page, out) {
  return new Promise((resolve, reject) => {
    const child = execFile('nice', ['-n', '10', 'pdftocairo', ...pdfPageSvgArgs(page, pdf, out)], { timeout: 30_000 }, (err) => {
      engine.isoChildren?.delete(child);
      if (err) reject(err);
      else resolve();
    });
    engine.isoChildren?.add(child);
  });
}

const renderKey = furnitureRenderKey;

/** What one furniture render ships (hfRenderBody `timelines`) and in which
 * order its PDF has the pages (`order`, the id each page is shipped under):
 * the current timeline's targets and controls under their own page numbers,
 * then, before them, each earlier timeline's controls. A control of an
 * earlier timeline is shipped for its own sheet there (`control.page`), under
 * that sheet's folio, once however many targets share it, and under an id no
 * sheet of the current timeline has (A3). Sets `control.id`. */
export function renderTimelines(specs, pages, controlFor) {
  const active = new Map(pages.map((n) => [n, n]));
  const history = new Map();
  let synthetic = specs.length;
  for (const control of controlFor.values()) {
    if (control.specs) {
      const gen = control.metas[0].rec.gen;
      if (!history.has(gen)) history.set(gen, { specs: control.specs, wanted: new Map() });
      const wanted = history.get(gen).wanted;
      if (!wanted.has(control.page)) wanted.set(control.page, ++synthetic);
      control.id = wanted.get(control.page);
    } else active.set(control.id, control.id);
  }
  const timelines = [...history.values(), { specs, wanted: active }];
  const order = timelines.flatMap(({ specs: all, wanted }) => all.filter((s) => wanted.has(s.page)).map((s) => wanted.get(s.page)));
  return { timelines, order };
}

/** Each control's verdict, slot by slot ([head, foot]), keyed by its id: its
 * shipped page (`svgs`) paints in each band what the exact band it stands
 * for painted there. A slot is proven only against a control actually
 * shipped and an exact band actually cut: an absent one proves nothing,
 * though two blank slots that were both shipped agree (B4). */
export function controlProof(svgs, controlFor, rows) {
  const proven = new Map();
  for (const { id, metas } of controlFor.values()) {
    if (proven.has(id)) continue;
    const shipped = svgs.get(id);
    proven.set(id, ['h', 'f'].map((w, i) => typeof shipped === 'string' && typeof metas[i]?.svg === 'string' &&
      samePaint(bandPaint(shipped, ...rows[w]), bandPaint(metas[i].svg, ...rows[w]))));
  }
  return proven;
}

/** The pages of the current layout whose head or foot draws and shows no
 * band, not rendered for what they are now, near the reader's page: the
 * reader's first, then the last edited one's. Before any exact PDF is bound
 * (at open) none: the exact PDF gives them all. */
export function furnitureRenderWanted(engine) {
  const noted = engine.currentSpecs;
  if (!noted || engine.mode !== 'structured' || engine.previewPolicy !== 'structured' || engine.tateExact) return [];
  if (noted.pages !== engine.pages || engine.updating) return [];
  const runs = mapCurrent(engine, noted);
  if ((engine.geometry?.hoffset ?? 0) !== 0 || (engine.geometry?.voffset ?? 0) !== 0) return [];
  const cut = folioUnknownFrom(engine);
  const tries = engine.hfRenderTries ?? new Map();
  const wanted = [];
  let contexts, historical;
  for (const page of engine.pages) {
    const n = page.number;
    const entry = engine.hf?.get(n);
    if (n >= cut && (!runs || ![entry?.hr, entry?.fr].some((bits) => furnitureReadsEstablished(engine, bits, n)))) continue;
    const spec = noted.specs[n - 1];
    if (!spec || spec.style === 'empty') continue;
    const pair = (key) => {
      const meta = { h: engine.chunks.get(key(n, 'h')), f: engine.chunks.get(key(n, 'f')) };
      const shown = { h: !!meta.h && bandShown(engine, page, meta.h, 'h'), f: !!meta.f && bandShown(engine, page, meta.f, 'f') };
      const apart = meta.h?.rec?.apart || meta.f?.rec?.apart || (!!meta.h && !!meta.f && bandsApart(engine, meta.h, meta.f));
      return { any: !!(meta.h || meta.f), drawn: (w) => (shown.h && shown.f) || (shown[w] && apart) };
    };
    const exact = pair(hfBandChunkKey);
    // (whether its head or foot draws: the runs of this layout say; while
    // they are on their way, the page's entry before them or a band an exact
    // PDF gave it)
    if (runs && !(entry?.hg || entry?.fg)) continue;
    if (!runs && !(entry?.hg || entry?.fg || exact.any)) {
      // A shifted or newly inserted sheet may have no old entry of its
      // own. A verified picture of the same template can start the job.
      contexts ??= renderContexts(noted.specs);
      historical ??= historicalControls(engine, noted);
      if (!historical.get(contexts[n - 1])?.metas[0].rec.graphic) continue;
    }
    // (a page no exact PDF has given a band yet: not at open, before any is
    // bound, nor while the bound one's band of it is on its way)
    const rec = engine.hfCanon?.binding?.pages.get(n);
    if (!engine.hfBindings?.size ||
        (rec && (!exact.any || rec.gen.rev === engine.srcRev) && cutWanted(engine, rec, page))) continue;
    const rendered = pair(hfRenderChunkKey);
    const drawn = (w) => exact.drawn(w) || rendered.drawn(w);
    if (runs ? (!entry.hg || drawn('h')) && (!entry.fg || drawn('f')) : drawn('h') && drawn('f')) continue;
    const key = renderKey(engine, spec);
    if (tries.get(n) === key) continue;
    wanted.push(n);
  }
  const reader = Number.isInteger(engine.viewPage) ? engine.viewPage : null;
  const edit = Number.isInteger(engine.owedFocus) ? engine.owedFocus : null;
  const d = (focus, n) => (focus === null ? 0 : Math.abs(focus - n));
  return wanted.sort((a, b) => d(reader, a) - d(reader, b) || d(edit, a) - d(edit, b) || a - b);
}

/** Render the pages wanted (furnitureRenderWanted) and land their bands. */
export async function renderFurniture(engine, helpers) {
  const wanted = furnitureRenderWanted(engine);
  const awaitRender = helpers.awaitRender ?? engine.renderCallbacks?.awaitRender;
  const ck = engine.checkpoints.get(0);
  if (!wanted.length || !awaitRender || !ck) return 'skip';
  const noted = engine.currentSpecs;
  const cut = folioUnknownFrom(engine);
  const contexts = renderContexts(noted.specs);
  const controls = controlPages(engine, contexts, wanted, cut);
  const historical = historicalControls(engine, noted);
  const pages = [];
  const controlFor = new Map();
  const nearest = engine.viewPage ?? engine.owedFocus;
  const near = (n) => nearest == null || Math.abs(n - nearest) <= RENDER_REACH;
  const firstCohort = near(wanted[0]);
  for (const n of wanted) {
    if (firstCohort && !near(n) && pages.length) break;
    const context = contexts[n - 1];
    const control = priorControl(engine, n, context, noted) ?? controls.get(context) ?? historical.get(context);
    if (!control) continue;
    controlFor.set(n, control);
    pages.push(n);
    if (pages.length === RENDER_PAGES) break;
  }
  if (!pages.length) return 'skip';
  const { timelines, order } = renderTimelines(noted.specs, pages, controlFor);
  const rev = engine.srcRev;
  const root = rootKey(engine);
  const geometry = geometryKey(engine.geometry);
  const current = () => !engine.closed && !engine.opening && engine.srcRev === rev && engine.currentSpecs?.pages === engine.pages &&
    engine.currentSpecs.sig === noted.sig && engine.currentSpecs.blocks === noted.blocks &&
    folioUnknownFrom(engine) === cut && rootKey(engine) === root &&
    geometryKey(engine.geometry) === geometry && engine.checkpoints.get(0) === ck;
  const { waitForIdle = async (wanted) => wanted() } = helpers;
  if (!(await waitForIdle(current))) return 'superseded';
  const tries = (engine.hfRenderTries ??= new Map());
  const keys = pages.map((n) => renderKey(engine, noted.specs[n - 1]));
  let finished = false;
  engine.hfRenderSeq2 = (engine.hfRenderSeq2 ?? 0) + 1;
  const base = path.join(engine.workDir, 'hf-art', String(engine.hfRenderSeq2));
  const stats = (engine.hfRenderStats ??= { renders: 0, passes: 0, landed: 0, failed: 0, lastMs: 0, pages: 0 });
  const t0 = Date.now();
  stats.renders++;
  try {
    let marks = null;
    let final = null;
    for (let pass = 1; pass <= MAX_PASSES && !final; pass++) {
      if (!(await waitForIdle(current))) return 'superseded';
      const dir = path.join(base, String(pass));
      mkdirSync(dir, { recursive: true });
      const body = Buffer.from(hfRenderBody(timelines, marks, pass > 1), 'utf8');
      const requestId = `rr@${++engine.renderSeq}`;
      stats.passes++;
      await runShipCommand(engine, {
        block: { id: '__hfart' }, idx: 0, ck, requestId, checkpointIndex: 0, body,
        command: `RENDER __hfart ${encodeURIComponent(dir)} ${body.length} ${requestId}\n`,
        awaitRender,
        renderIsolated: () => {},
      });
      const pdf = path.join(dir, 'driver.pdf');
      await waitForPdf(pdf);
      if (!current()) return 'superseded';
      const found = readMarks(dir);
      if ((!marks && found.size === 0) || (marks && sameMarks(marks, found))) final = pdf;
      else marks = found;
    }
    if (!final) throw new Error(`furniture render of ${pages.join(',')}: positions still moving after ${MAX_PASSES} passes`);
    const geo = engine.geometry;
    const bands = furnitureBands(geo);
    // (the PDF has the pages in page order, the control among them)
    const svgs = new Map();
    for (const [k, n] of order.entries()) {
      if (!(await waitForIdle(current))) return 'superseded';
      const out = path.join(path.dirname(final), `hf-${n}.svg`);
      await convertPage(engine, final, k + 1, out);
      svgs.set(n, readFileSync(out, 'utf8'));
    }
    // (the band less the text area's edge, as bandInk reads it: what the
    // exact page has there of the body is not the furniture's)
    const rows = { h: [bands.h[0], bands.h[1] - 4], f: [bands.f[0] + 4, bands.f[1]] };
    const slots = ['h', 'f'];
    const proven = controlProof(svgs, controlFor, rows);
    for (const pass of proven.values()) if (!pass.every(Boolean)) stats.mismatched = (stats.mismatched ?? 0) + 1;
    const trace = readSlotTrace(final);
    if (!(await betweenUpdates(engine, current))) return 'superseded';
    finished = true;
    let staged = 0;
    for (const n of pages) {
      const svg = svgs.get(n);
      if (typeof svg !== 'string') continue;
      const entry = engine.hf.get(n);
      const ink = svgInkRows(svg, geo.paperwidth);
      const runs = mapCurrent(engine, noted);
      const rec = {
        render: true, n, spec: noted.specs[n - 1], key: renderKey(engine, noted.specs[n - 1]), geometry, root,
        extent: runs ? { h: hfSlotExtent(entry?.h, 'h', geo), f: hfSlotExtent(entry?.f, 'f', geo) } : null,
        gen: { render: true, rev, root },
      };
      const evidence = slots.map((slot) => trace.get(`${n}:${slot}`));
      rec.deps = { h: evidence[0]?.deps, f: evidence[1]?.deps };
      rec.reads = Object.fromEntries(slots.map((slot, i) => [slot, evidence[i] &&
        (evidence[i].bits | (geo.twoside ? (runs ? entry?.[slot + 'r'] & HF_PARITY : HF_PARITY) : 0))]));
      const bandsInk = slots.map((w) => ({ rec, ink: bandInk(ink, bands, w) }));
      const { id, metas } = controlFor.get(n);
      rec.apart = bandsApart(engine, ...bandsInk) && bandsApart(engine, ...metas);
      const pass = proven.get(id);
      const allowed = slots.map((slot, i) => pass[i] && furnitureReadsEstablished(engine, rec.reads[slot], n));
      if (!allowed.some(Boolean) || (!allowed.every(Boolean) && !rec.apart)) continue;
      for (const [i, which] of slots.entries()) {
        if (!allowed[i]) continue;
        const exact = engine.chunks.get(hfBandChunkKey(n, which));
        const rendered = engine.chunks.get(hfRenderChunkKey(n, which));
        if (rec.apart && [exact, rendered].some((meta) => bandShown(engine, engine.pages[n - 1], meta, which))) continue;
        const [top, bottom] = bands[which];
        engine.hfBandVersion = (engine.hfBandVersion ?? 0) + 1;
        engine.chunks.set(hfRenderChunkKey(n, which), {
          svg: cropSvgAt(svg, 0, top, geo.paperwidth, bottom - top), wBp: geo.paperwidth, hBp: bottom - top, which,
          ink: bandsInk[i].ink, v: engine.hfBandVersion, rec,
        });
      }
      engine.hfBandTop = Math.max(engine.hfBandTop ?? 0, n);
      staged++;
    }
    if (!staged) return 'mismatch';
    stats.landed++;
    stats.pages += staged;
    stats.lastMs = Date.now() - t0;
    helpers.asyncRepaginate?.();
    return 'landed';
  } catch (err) {
    if (!current()) return 'superseded';
    finished = true;
    stats.failed++;
    throw err;
  } finally {
    // Repagination can overtake a pass while body chunks are landing.
    // It has learned nothing about the furniture's ability to render.
    if (finished) {
      for (const [i, n] of pages.entries()) tries.set(n, keys[i]);
    }
    if (process.env.TDOM_HF_RENDER_KEEP) console.error('HF_RENDER_KEEP', base);
    else rmSync(base, { recursive: true, force: true });
  }
}

/** Render what is wanted, one render at a time, after the typing has
 * paused. Never on the caller's path: it only arms the loop. */
export function queueFurnitureRender(engine, helpers) {
  if (engine.closed || engine.opening) return;
  if (engine.hfRendering) {
    engine.hfRenderAgain = true;
    return;
  }
  engine.hfRendering = true;
  engine.hfRenderAgain = true;
  setTimeout(async () => {
    try {
      while (engine.hfRenderAgain && !engine.closed) {
        engine.hfRenderAgain = false;
        const due = (engine.lastEditAt ?? 0) + RENDER_QUIET_MS;
        if (due > Date.now()) await new Promise((resolve) => setTimeout(resolve, due - Date.now()));
        const wanted = () => !engine.opening;
        if (!(await (helpers.waitForIdle?.(wanted) ?? betweenUpdates(engine, wanted)))) return;
        if ((engine.lastEditAt ?? 0) + RENDER_QUIET_MS > Date.now()) {
          engine.hfRenderAgain = true;
          continue;
        }
        const [next] = furnitureRenderWanted(engine);
        if (next === undefined) continue;
        const focus = engine.viewPage ?? engine.owedFocus;
        if (focus != null && Math.abs(next - focus) > RENDER_REACH) {
          await engine.bgTask;
          await engine.canonical.waitForBuildLease();
          if (engine.closed) return;
        }
        const done = await renderFurniture(engine, helpers).catch((err) => {
          if (!engine.closed) engine.diagnostics.push(`furniture render: ${err?.message ?? err}`);
          return 'failed';
        });
        // A processed or superseded batch may leave another batch ready.
        if (done !== 'skip') engine.hfRenderAgain = true;
        if (engine.hfRenderAgain) await new Promise((resolve) => setImmediate(resolve));
      }
    } finally {
      engine.hfRendering = false;
    }
  }, 0).unref?.();
}
