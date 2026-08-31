import { fnv1a } from '../hash.js';
import { compareCanonicalText } from './canonical-verification.js';
import { canonicalCropMetrics, canonicalBlockBands, leadingGalleySkip } from './canonical-crop.js';
import { cropSvgAt } from './util/svg.js';

const PAPER_EPSILON_PT = 0.5;

/** A structured display has one document-wide viewport. Once the canonical
 * PDF proves that any page uses another displayed box or any `/Rotate`, its
 * pixels and the provisional source-hit SVG no longer share coordinates.
 * Return explicit reasons so the arrival path can fail closed to the exact
 * opaque renderer even when static source scanning missed an indirect macro,
 * class hook, included file, or package implementation. */
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
  if (!info.error && engine.mode === 'structured' && info.rev === engine.srcRev) {
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
  if (info.error || process.env.TDOM_NO_VERIFY) return;
  // verify only at convergence: the compile must be of the CURRENT source
  if (engine.mode !== 'structured' || info.rev !== engine.srcRev) return;
  // canonical-anchor deliberately does not claim that JS pagination maps
  // onto physical pages (two-column output is the motivating case). Its
  // resident tree is a TeX-native line-layout probe only; page text
  // comparison and coordinate cropping would therefore manufacture false
  // mismatches and wrong-page chunks.
  if (engine.previewPolicy !== 'structured') return;
  verifyAgainstCanonical(info)
    .catch((err) => {
      engine.diagnostics.push('verification failed to run: ' + err.message);
    })
    .then(() => cropCanonicalChunks(info))
    .catch((err) => {
      engine.diagnostics.push('canonical crop failed: ' + err.message);
    });
}

/**
 * Canonical-crop chunk source (the cheapest exact pixels in the system):
 * when a fresh canonical compile matches the current source, every block
 * whose exact preview chunk is missing/stale gets it cropped straight out
 * of the canonical page SVG. No compile at all: the pixels are the ones
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
  // pagination drift means provisional coordinates cannot address the
  // canonical pages — never crop pixels from the wrong page
  if (engine.pages.length !== info.pageCount) return;
  const geo = engine.geometry;
  if (!geo) return;
  const cropMetrics = canonicalCropMetrics(geo);
  const bands = canonicalBlockBands(engine.pages, cropMetrics.top);
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
    const lead = leadingGalleySkip(block.galley);
    const h = block.galley.h + block.galley.d;
    const w = block.galley.w;
    if (!(h > 0) || !(w > 0)) continue;
    const pageSvg = await engine.canonical.pageSVG(band.page, info.id).catch(() => null);
    if (!pageSvg) continue;
    if (engine.srcRev !== info.rev) return; // superseded mid-pass
    const prev = engine.chunks.get(block.id);
    engine.chunks.set(block.id, {
      svg: cropSvgAt(pageSvg, cropMetrics.left, band.top - lead, w, h),
      wBp: w,
      hBp: h,
      v: (prev?.v ?? 0) + 1,
      forGalley: block.galleyHash,
    });
    budget--;
    changed = true;
  }
  if (changed) asyncRepaginate();
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
  const { mismatches, demote } = compareCanonicalText(engine.pages, texts, info.pageCount);
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
      asyncRepaginate();
    }
    if (demoted) {
      engine.diagnostics.push(
        `verification demoted ${demoted} block(s) to exact rendering: ${mismatches.join('; ')}`
      );
    }
  }
}
