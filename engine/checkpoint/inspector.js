import { SAFE_GLYPH } from './fidelity.js';
import { instrumentEditRegions } from '../edit-regions.js';

// A snapshot covers every block, and a viewer asks for one per keystroke
// (a 389-page book: 26,000 regions). A block's own regions are a function
// of its text, its region list and where its source sits; they are kept on
// the block while those stay the same.
const blockRegionMemo = new WeakMap(); // block -> { text, editRegions, anchor, regions }

export function buildDomSnapshot({
  rev,
  srcRev,
  backendName,
  mode,
  modeReasons,
  previewPolicy,
  previewReasons,
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
    if (block.sourceParts) {
      const part = block.sourceParts.find(item => region.contentStart >= item.at && region.contentEnd <= item.to);
      if (!part) return null;
      const text = block.text.slice(part.at, part.to);
      return { file: part.file,
        start: relativePosition(part.sourceStart, text, region.contentStart - part.at),
        end: relativePosition(part.sourceStart, text, region.contentEnd - part.at) };
    }
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
  // Where the block's source sits, as far as a region's position depends on it.
  const regionAnchor = (b) => {
    if (b.sourceParts) {
      return b.sourceParts.map((part) =>
        `${part.file}|${part.at}|${part.to}|${part.sourceStart?.line}|${part.sourceStart?.column}`).join('\n');
    }
    if (b.file && b.sourceStart) return `${b.file}|${b.sourceStart.line}|${b.sourceStart.column}`;
    // a root block's text is the root's own slice; anything else is not kept
    if (b.end - b.start !== b.text.length) return null;
    const start = position(file, b.start);
    return `${file}|${b.start}|${start.line}|${start.column}`;
  };
  const ownRegions = (b) => {
    const anchor = regionAnchor(b);
    const kept = blockRegionMemo.get(b);
    if (kept && anchor !== null && kept.anchor === anchor && kept.editRegions === b.editRegions && kept.text === b.text) {
      return kept.regions;
    }
    // Canonical snapshots can arrive before an isolated rescue's
    // resident metadata. Source spans are lexical and already known;
    // never freeze a temporarily empty editing map into that PDF.
    const regions = (b.editRegions ?? instrumentEditRegions(b.text).regions).map((region) => ({
      id: `${b.id}:${region.id}`,
      kind: region.kind,
      value: region.value,
      sourceValue: region.sourceValue,
      display: region.display,
      source: editSource(b, region),
    })).filter(region => region.source);
    if (anchor !== null) blockRegionMemo.set(b, { text: b.text, editRegions: b.editRegions, anchor, regions });
    else blockRegionMemo.delete(b);
    return regions;
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
    previewPolicy,
    previewReasons,
    canonical: canonicalInfo,
    pageCount: pages.length,
    checkpoints: [...checkpoints.keys()].sort((a, b) => a - b),
    blocks: blocks.map((b, i) => {
      const chunkKeys = chunkTargets(b).map((t) => t.key);
      const own = ownRegions(b);
      // (asked once per block, not once per preamble region of every block)
      const titleRegions = (preambleEditRegions.length && /\\maketitle\b/.test(b.text) ? preambleEditRegions : [])
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
        }));
      const blockRegions = titleRegions.length ? [...own, ...titleRegions] : own;
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
        sourceRanges: b.sourceParts?.map(part => ({ file: part.file, start: part.sourceStart, end: part.sourceEnd })),
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

// A block's edit regions are most of its bytes, and buildDomSnapshot hands
// out the same array for as long as the block's regions are the same: their
// text is serialized once. `editRegions` is the block's last key, so the
// result is JSON.stringify(block) to the byte.
const regionJson = new WeakMap();
export function serializeDomBlock(block) {
  const regions = block.editRegions;
  const keys = Object.keys(block);
  if (!Array.isArray(regions) || !regions.length || keys.length < 2 || keys.at(-1) !== 'editRegions') return JSON.stringify(block);
  let text = regionJson.get(regions);
  if (text === undefined) regionJson.set(regions, text = JSON.stringify(regions));
  const { editRegions: _regions, ...rest } = block;
  return `${JSON.stringify(rest).slice(0, -1)},"editRegions":${text}}`;
}
