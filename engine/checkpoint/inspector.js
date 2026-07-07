import { SAFE_GLYPH } from './fidelity.js';

export function buildDomSnapshot({
  rev,
  backendName,
  mode,
  modeReasons,
  canonicalInfo,
  pages,
  checkpoints,
  blocks,
  chunkTargets,
  file,
  position,
  labelTable,
}) {
  const blockPages = new Map();
  for (const page of pages) {
    for (const d of page.draw ?? []) {
      const bid = d.u?.blockId;
      if (!bid) continue;
      if (!blockPages.has(bid)) blockPages.set(bid, []);
      const arr = blockPages.get(bid);
      if (arr[arr.length - 1] !== page.number) arr.push(page.number);
    }
  }
  return {
    rev,
    backend: backendName,
    mode,
    modeReasons,
    canonical: canonicalInfo,
    pageCount: pages.length,
    checkpoints: [...checkpoints.keys()].sort((a, b) => a - b),
    blocks: blocks.map((b, i) => {
      const chunkKeys = chunkTargets(b).map((t) => t.key);
      return {
        id: b.id,
        index: i,
        type: b.kind ?? 'block',
        gfx: chunkKeys.length > 0,
        gfxChunks: chunkKeys,
        fidelity: b.fidelity?.level ?? null,
        exactLines: b.fidelity?.exactLines ?? 0,
        source: {
          file,
          start: position(file, b.start),
          end: position(file, b.end),
        },
        labels: (b.galley?.labels ?? []).map((l) => l.k),
        refs: b.galley?.refs ?? [],
        pages: blockPages.get(b.id) ?? [],
        // raw offsets into the main buffer for in-preview box editing;
        // blocks expanded from \input files are not editable in-place
        file: b.file ?? null,
        span: b.file ? null : { start: b.start, end: b.end },
      };
    }),
    labels: Object.fromEntries(labelTable),
  };
}

/** Inspector counters for the visual fidelity gate. */
export function buildFidelitySummary({ blocks, fidelityDemoted, demotedFamilies, renderWant }) {
  let safe = 0;
  let exact = 0;
  let canonicalOnly = 0;
  let exactLines = 0;
  for (const b of blocks) {
    const f = b.fidelity;
    if (!f || f.level === SAFE_GLYPH) safe++;
    else if (f.canonicalOnly) canonicalOnly++;
    else exact++;
    exactLines += f?.exactLines ?? 0;
  }
  return {
    safeBlocks: safe,
    exactBlocks: exact,
    canonicalOnlyBlocks: canonicalOnly,
    exactLines,
    demoted: fidelityDemoted.size,
    demotedFonts: [...demotedFamilies],
    pendingRenders: renderWant.size,
  };
}
