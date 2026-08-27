import { SAFE_GLYPH } from './fidelity.js';

export function buildDomSnapshot({
  rev,
  srcRev,
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
  preambleEditRegions = [],
}) {
  const relativePosition = (base, text, offset) => {
    const prefix = String(text ?? '').slice(0, Math.max(0, offset));
    const lines = prefix.split('\n');
    return lines.length === 1
      ? { line: base.line, column: base.column + lines[0].length }
      : { line: base.line + lines.length - 1, column: lines.at(-1).length + 1 };
  };
  const editSource = (block, region) => {
    if (block.file && block.sourceStart) {
      return {
        file: block.file,
        start: relativePosition(block.sourceStart, block.text, region.contentStart),
        end: relativePosition(block.sourceStart, block.text, region.contentEnd),
      };
    }
    return {
      file,
      start: position(file, block.start + region.contentStart),
      end: position(file, block.start + region.contentEnd),
    };
  };
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
    srcRev,
    backend: backendName,
    mode,
    modeReasons,
    canonical: canonicalInfo,
    pageCount: pages.length,
    checkpoints: [...checkpoints.keys()].sort((a, b) => a - b),
    blocks: blocks.map((b, i) => {
      const chunkKeys = chunkTargets(b).map((t) => t.key);
      const blockRegions = [
        ...(b.editRegions ?? []).map((region) => ({
          id: `${b.id}:${region.id}`,
          kind: region.kind,
          value: region.value,
          sourceValue: region.sourceValue,
          display: region.display,
          source: editSource(b, region),
        })),
        ...preambleEditRegions
          .filter(() => /\\maketitle\b/.test(b.text))
          .map((region) => ({
            id: `${b.id}:${region.id}`,
            kind: region.kind,
            value: region.value,
            sourceValue: region.sourceValue,
            display: region.display,
            source: {
              file,
              start: position(file, region.contentStart),
              end: position(file, region.contentEnd),
            },
          })),
      ];
      return {
        id: b.id,
        index: i,
        type: b.kind ?? 'block',
        gfx: chunkKeys.length > 0,
        gfxChunks: chunkKeys,
        fidelity: b.fidelity?.level ?? null,
        exactLines: b.fidelity?.exactLines ?? 0,
        source: b.file && b.sourceStart && b.sourceEnd
          ? { file: b.file, start: b.sourceStart, end: b.sourceEnd }
          : {
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
        editRegions: blockRegions,
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
