import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { cropSvg, pdfPageSvgArgs } from './util/svg.js';

const execFileP = promisify(execFile);

const GLYPH_USE = /<use xlink:href="#glyph-[^"]+" x="(-?[\d.]+)" y="(-?[\d.]+)"\/>/g;
const fixed = (value) => String(Math.round(value * 1e6) / 1e6);

/**
 * Check that the glyphs of a block's picture stand where the galley says
 * they do, and set each run's first glyph exactly there.
 *
 * The galley records where TeX's backend puts each run, and the picture
 * draws one <use> per glyph, in the galley's order. With the page converted
 * as it is (util/svg.js pdfPageSvgArgs) the two agree to a hundredth of a
 * point; a converter that fitted the page to a paper first had them 1 to
 * 19 bp apart. A run cut out of the picture by the galley's numbers
 * (exact-parts.js) is only its own ink while they agree, so the picture
 * says whether they do: `anchored`. Each run's first glyph is moved onto
 * the run's place and the glyphs after it keep their distance to it (a run
 * has no glue inside); rules and other paths are not text and stay.
 *
 * Fail closed: unless the picture has exactly the galley's glyphs, each
 * within a point of its place, nothing is changed and `anchored` is false.
 * Never for a galley with graphics: a transform in a PDF literal moves text
 * in ways the run positions do not record.
 */
// TDOM_TRACE_PARTS=1: why a picture's glyphs were left where the converter put them
const unanchored = (svg, why) => {
  if (process.env.TDOM_TRACE_PARTS) console.error('[anchor] left alone:', why);
  return { svg, anchored: false };
};

export function anchorGlyphs(svg, galley, padBp) {
  if (!galley || galley.gfx || galley.floats?.length) return unanchored(svg, !galley ? 'no galley' : galley.gfx ? 'graphics' : 'floats');
  const expected = [];
  let y = 0;
  for (const item of galley.items ?? []) {
    if (item.k === 'glue' || item.k === 'kern') y += item.a ?? 0;
    if (item.k !== 'box') {
      if (item.k === 'ins') return { svg, anchored: false };
      continue;
    }
    if (item.chunk) return { svg, anchored: false };
    const baseline = y + (item.h ?? 0);
    for (const run of item.runs ?? []) {
      if (run.rule || !run.t) continue;
      const count = [...run.t].length;
      const x = run.x + padBp;
      const top = baseline + (run.dy ?? 0);
      if (!Number.isFinite(x) || !Number.isFinite(top)) return { svg, anchored: false };
      for (let i = 0; i < count; i++) expected.push({ first: i === 0, x, y: top });
    }
    y += (item.h ?? 0) + (item.d ?? 0);
  }
  const uses = [...svg.matchAll(GLYPH_USE)];
  if (!expected.length || uses.length !== expected.length) {
    return unanchored(svg, `${uses.length} glyphs in the picture, ${expected.length} in the galley`);
  }
  const placed = new Array(uses.length);
  let runStart = 0;
  let furthest = 0;
  for (let k = 0; k < uses.length; k++) {
    const x = Number(uses[k][1]);
    const yy = Number(uses[k][2]);
    const want = expected[k];
    if (want.first) {
      if (Math.abs(x - want.x) > 1 || Math.abs(yy - want.y) > 1) {
        return unanchored(svg, `glyph ${k} is ${(x - want.x).toFixed(2)}, ${(yy - want.y).toFixed(2)} from its place`);
      }
      runStart = x;
      furthest = Math.max(furthest, Math.abs(x - want.x), Math.abs(yy - want.y));
    }
    placed[k] = [want.x + (x - runStart), want.y];
  }
  let k = 0;
  const moved = svg.replace(GLYPH_USE, (whole, x, yy) => {
    const [nx, ny] = placed[k++];
    return whole.replace(`x="${x}" y="${yy}"`, `x="${fixed(nx)}" y="${fixed(ny)}"`);
  });
  if (process.env.TDOM_TRACE_PARTS) console.error('[anchor]', uses.length, 'glyphs, furthest from its place', furthest.toFixed(4));
  return { svg: moved, anchored: true };
}

// `anchor`: { key, galley } names the target that shows the block's own
// lines (its main page) and the galley it was rendered for (anchorGlyphs).
export async function cropRenderTargets({ jobdir, pdf, targets, chunks, forGalley, prefix, anchor = null }) {
  const paddingPath = path.join(jobdir, 'render-padding.txt');
  const padding = existsSync(paddingPath) ? Number(readFileSync(paddingPath, 'utf8')) : 0;
  if (!Number.isFinite(padding) || padding < 0) throw new Error('invalid render padding');
  let editPdf;
  for (const tgt of targets) {
    const svgPath = path.join(jobdir, `${prefix}-${tgt.page}.svg`);
    await execFileP('pdftocairo', pdfPageSvgArgs(tgt.page, pdf, svgPath), { timeout: 30_000 });
    const width = tgt.w + 2 * padding;
    const cropped = cropSvg(readFileSync(svgPath, 'utf8'), width, tgt.h);
    const { svg, anchored } = anchor && anchor.key === tgt.key
      ? anchorGlyphs(cropped, anchor.galley, padding) : { svg: cropped, anchored: false };
    const prev = chunks.get(tgt.key);
    chunks.set(tgt.key, {
      svg,
      // its glyphs stand where the galley's runs do (exact-parts.js cuts runs out by them)
      anchored: anchored || undefined,
      wBp: width,
      logicalWBp: tgt.w,
      xBp: -padding,
      hBp: tgt.h,
      v: (prev?.v ?? 0) + 1,
      forGalley,
      editPdf: editPdf ??= readFileSync(pdf),
      editPage: tgt.page,
    });
  }
}
