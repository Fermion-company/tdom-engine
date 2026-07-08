import { verifyTokens, tokenContainment } from './safety.js';

export function compareCanonicalText(pages, texts, pageCount) {
  const mismatches = [];
  // Pagination drift (different page count, or content landing a page
  // early/late) is NOT block-level wrongness: the canonical overlay
  // already owns those pages visually, and demoting their blocks to the
  // rescue path cannot fix an offset — it would only poison the editing
  // hot path with full compiles. Demote only for genuine content
  // divergence: same page count AND the page's text matches neither its
  // own canonical page nor a ±1 neighbor.
  const countsMatch = pages.length === pageCount;
  if (!countsMatch) {
    mismatches.push(`page count: provisional ${pages.length} vs LuaLaTeX ${pageCount}`);
  }
  const demote = new Set();
  for (const page of pages) {
    const provTokens = [];
    for (const d of page.draw ?? []) {
      for (const r of d.u?.ln?.runs ?? []) {
        if (r.t) provTokens.push(...verifyTokens(r.t));
      }
    }
    if (provTokens.length < 20) continue; // chunk/gfx pages carry exact pixels already
    const n = page.number;
    const c = tokenContainment(provTokens, verifyTokens(texts[n - 1] ?? ''));
    if (c >= 0.8) continue;
    const window = Math.max(
      c,
      tokenContainment(provTokens, verifyTokens(texts[n - 2] ?? '')),
      tokenContainment(provTokens, verifyTokens(texts[n] ?? ''))
    );
    if (window >= 0.8) {
      mismatches.push(`page ${n}: drifted (content found on a neighboring page)`);
      continue;
    }
    mismatches.push(`page ${n}: ${Math.round(window * 100)}% of preview text found`);
    // demote only on CONFIDENT divergence — the canonical overlay already
    // guarantees the final pixels page-granularly, so a demotion buys
    // exact provisional rendering at real hot-path cost; borderline
    // scores (kerning artifacts, extraction quirks) are report-only
    if (!countsMatch || window >= 0.5) continue;
    for (const d of page.draw ?? []) {
      const bid = d.u?.blockId;
      if (bid) demote.add(bid);
    }
  }
  return { mismatches, demote };
}
