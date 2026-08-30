// Visual Fidelity Gate — decides what the browser GLYPH layer may draw.
//
// The safety gate (safety.js) answers a different question: "may the JS page
// builder assemble pages for this document at all?" (page mechanisms). This
// gate answers: "does drawing this line as browser SVG text look EXACTLY
// like the LuaLaTeX output?" — per line, per run, per font. Three verdicts,
// mirroring the display tiers:
//
//   safe-glyph               browser SVG <text> with the very font file TeX
//                            used reproduces the print output (positions are
//                            TeX's; only outline rasterization differs)
//   exact-preview-required   the line must be shown as a TeX-derived exact
//                            chunk (resident-checkpoint tight ship → SVG);
//                            glyphs are at best a sub-perceptual bridge
//   canonical-only           provisional rendering is not trusted at all;
//                            the block stays blank until the canonical
//                            LuaLaTeX page covers it
//
// Everything uncertain defaults DOWN to exact-preview-required. Fast but
// wrong displays are the one failure mode this layer exists to prevent:
// math (any math), legacy Type1/CM fonts, PUA/unencoded glyphs (OpenType
// math size variants, extensible pieces), unservable font files.
//
// Inputs:
//  - per-line flags harvested by daemon.lua from TeX's own node list:
//      it.x  = 1  line contains math (math nodes / math-font glyphs) or
//                 legacy CM glyphs — exact chunk required
//      it.xb = 1  line contains glyphs the browser cannot draw at all
//                 (unencoded/PUA slots, >Unicode chars) — no glyph bridge
//  - the orchestrator's font registry: every font carries a delivery tier
//      'native'  the actual TeX font file (otf/ttf) is served to the browser
//      'twin'    legacy font substituted by its Latin Modern OpenType twin
//                (mathmap.js) — close, but a substitution: not exact
//      'none'    no browser-drawable representation exists

import { classifyResidentRun } from './run-semantics.js';

export const SAFE_GLYPH = 'safe-glyph';
export const EXACT_PREVIEW = 'exact-preview-required';
export const CANONICAL_ONLY = 'canonical-only';

/**
 * Delivery tier of one registered font. `meta` is the orchestrator's font
 * record; the decision is deliberately conservative: only a real .otf/.ttf
 * file that exists on disk (checked at registration) is 'native'.
 */
export function fontTier(meta) {
  if (!meta) return 'none'; // unknown font id: never fake it
  return meta.tier ?? 'none';
}

/** Fidelity of one galley line (a harvested box item). */
export function lineFidelity(item, fonts, backend = null) {
  // daemon-side verdicts (math nodes, math/CM fonts, unencoded glyphs)
  let exact = !!item.x || !!item.xb;
  let noBridge = !!item.xb;
  let nativeText = false;
  let math = false;
  for (const run of item?.runs ?? []) {
    if (!run?.rule) continue;
    const semantics = classifyResidentRun(run, backend);
    if (semantics.tag === 'LayoutOnly') continue;
    // Positive-area ordinary rules are reproduced directly as SVG rects.
    // A zero-area normal rule is different: PDF backends may promote it to
    // a device hairline, so the browser layer must not infer "no paint" from
    // geometry. Unknown run/profile schemas fail closed for the same reason.
    if (semantics.tag === 'Reject' || !(Number(run.w) > 0 && Number(run.h) > 0)) {
      exact = true;
      noBridge = true;
    }
  }
  scanRuns(item.runs, fonts, (tier, meta, run) => {
    if (tier !== 'native') exact = true; // twin substitution or unservable
    if (tier === 'none') noBridge = true; // nothing presentable to bridge with
    if (run?.m || meta?.mth) {
      exact = true; // math-font glyphs are math, whatever the file
      math = true;
    } else if (tier === 'native') {
      nativeText = true;
    }
  });
  return { exact, noBridge, mixedTextMath: nativeText && math };
}

function scanRuns(runs, fonts, visit) {
  for (const r of runs ?? []) {
    if (r.rule || !r.t) continue; // rules are exact by construction
    const meta = fonts.get(r.f);
    visit(fontTier(meta), meta, r);
  }
}

/**
 * Classify a whole galley for the glyph layer. Returns a summary the page
 * stream builder consumes:
 *   level        gate verdict for the block as a whole
 *   exact        any part of the block needs an exact preview chunk
 *   itemFlags    per top-level item (index-aligned): bit1 = exact line,
 *                bit2 = no glyph bridge, bit4 = native text mixed with math
 *   floats       float n -> {exact, noBridge}
 *   ins          ins ordinal (k-th footnote item) -> {exact, noBridge}
 *   lines/exactLines  counts for the inspector
 *
 * The galley is NOT annotated in place: galley hashes must stay a pure
 * function of TeX's output, so fidelity flags live in this parallel
 * structure.
 */
export function classifyGalley(galley, fonts) {
  const items = galley?.items ?? [];
  const itemFlags = new Array(items.length).fill(0);
  let lines = 0;
  let exactLines = 0;
  let noBridge = false;
  const ins = new Map();
  let insOrdinal = 0;
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    if (it.k === 'box') {
      lines++;
      const f = lineFidelity(it, fonts, galley?.backend);
      if (f.exact) {
        exactLines++;
        itemFlags[i] |= 1;
      }
      if (f.noBridge) {
        noBridge = true;
        itemFlags[i] |= 2;
      }
      if (f.mixedTextMath) itemFlags[i] |= 4;
    } else if (it.k === 'ins') {
      const f = subFidelity(it.items, fonts, galley?.backend);
      if (f.exact || f.noBridge) ins.set(insOrdinal, f);
      insOrdinal++;
    }
  }
  const floats = new Map();
  for (const fl of galley?.floats ?? []) {
    const f = subFidelity(fl.items, fonts, galley?.backend);
    if (fl.gfx) f.exact = true;
    if (f.exact || f.noBridge) floats.set(fl.n, f);
  }
  const exact =
    !!galley?.gfx || exactLines > 0 || ins.size > 0 || floats.size > 0;
  return {
    level: exact ? EXACT_PREVIEW : SAFE_GLYPH,
    exact,
    blockExact: !!galley?.gfx, // whole block must map into one chunk
    canonicalOnly: false,
    noBridge,
    itemFlags,
    floats,
    ins,
    lines,
    exactLines,
  };
}

/** Aggregate fidelity of a mini-galley (float body, footnote text). */
function subFidelity(items, fonts, backend = null) {
  let exact = false;
  let noBridge = false;
  for (const it of items ?? []) {
    if (it.k !== 'box') continue;
    const f = lineFidelity(it, fonts, backend);
    exact ||= f.exact;
    noBridge ||= f.noBridge;
  }
  return { exact, noBridge };
}

/**
 * Verification demotion (sticky until the block's source changes): a region
 * whose glyph rendering was caught diverging from the canonical output loses
 * glyph privileges; one whose EXACT pixels were caught misplaced loses
 * provisional rendering entirely.
 */
export function demoteFidelity(fid, level) {
  const base = fid ?? classifyGalley(null, new Map());
  if (level === 'canonical') {
    return {
      ...base,
      level: CANONICAL_ONLY,
      exact: true,
      blockExact: true,
      canonicalOnly: true,
      noBridge: true,
    };
  }
  return {
    ...base,
    level: EXACT_PREVIEW,
    exact: true,
    blockExact: true,
    noBridge: true,
  };
}
