import mathMacros from '../../web/math-macro-projection.cjs';
import { SAFE_GLYPH } from './fidelity.js';
import { instrumentEditRegions } from '../edit-regions.js';

// A snapshot covers every block, and a viewer asks for one per keystroke
// (a 389-page book: 26,000 regions). A block's own regions are a function
// of its text, its region list and where its source sits; they are kept on
// the block while those stay the same.
const blockRegionMemo = new WeakMap(); // block -> { text, editRegions, anchor, regions }
// block -> what its entry was last made of, and the entry: handed out again
// while everything it is made of is the same. The snapshot is rebuilt after
// every keystroke (the update carries it to the viewer) and a book has
// hundreds of blocks of which one changed: built and serialized anew each
// time, they were 2 to 5 ms of every keystroke on a 72-page book.
// serializeDomBlock keeps the text of an entry it has seen.
//
// An entry is its block's CORE (what the block is: its kind, its pictures,
// its lines and columns in the source, its labels, its edit regions) and its
// PLACE (its index in the list, its pages, its offsets in the root file). A
// character typed into a single-file document moves the offsets of every
// block after it and the core of none: such a block gets a new entry that
// shares every part of the old one but the place, and domEntriesDifferInPlaceOnly
// tells the two apart without looking into them. Whether the core still
// holds is read off the block (the objects it was made from, and the line
// starts of the root file for its line and column) without asking for any
// of it again: on a 191-page single file, 2,600 blocks, the snapshot of a
// keystroke took 4.5 ms to build and 6 ms more to tell apart and send.
const blockEntryMemo = new WeakMap();
const NO_PAGES = Object.freeze([]);

const samePages = (a, b) => {
  if (a === b) return true;
  if (!a || !b || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
};
// whether `offset` is line `line`, column `column` of the text with these line starts
const standsAt = (starts, line, column, offset) =>
  starts[line - 1] + column - 1 === offset && (line >= starts.length || starts[line] > offset);

/**
 * Whether two entries of a snapshot differ in nothing but the block's place
 * (index, pages, span): every other part is the same object or the same
 * value. Entries made from one core are; anything else is not, whatever it
 * holds.
 */
// The files a block's edit regions point into, kept with the regions (the
// same array for as long as the block's regions are the same).
const regionFiles = new WeakMap();
export function filesOfRegions(regions) {
  let files = regionFiles.get(regions);
  if (!files) {
    files = [...new Set(regions.map((region) => region.source?.file).filter(Boolean))];
    regionFiles.set(regions, files);
  }
  return files;
}

// Whether two lists of a block's edit regions (as the typesetting job
// records them) say the same: the same regions with the same plain values.
const sameRegionSpecs = (a, b) => {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const one = a[i];
    const other = b[i];
    if (one === other) continue;
    if (!one || !other) return false;
    const keys = Object.keys(one);
    if (keys.length !== Object.keys(other).length) return false;
    // (anything that is not a plain value counts only as the very same thing)
    for (const key of keys) if (one[key] !== other[key]) return false;
  }
  return true;
};
// Whether a core's labels and references are those of this galley.
const sameGalleyParts = (core, galley) => {
  const labels = galley?.labels ?? [];
  if (labels.length !== core.labels.length) return false;
  for (let i = 0; i < labels.length; i++) if (labels[i].k !== core.labels[i]) return false;
  const refs = galley?.refs ?? [];
  if (refs === core.refs) return true;
  if (refs.length !== core.refs.length) return false;
  for (let i = 0; i < refs.length; i++) if (refs[i] !== core.refs[i]) return false;
  return true;
};
const sameButSourceAndRegions = (was, now) =>
  was.gfxChunks === now.gfxChunks && was.labels === now.labels && was.refs === now.refs &&
  was.sourceRanges === now.sourceRanges && was.id === now.id && was.type === now.type && was.gfx === now.gfx &&
  was.fidelity === now.fidelity && was.exactLines === now.exactLines && was.file === now.file;
export function domEntriesDifferInPlaceOnly(was, now) {
  return !!was && !!now && was.editRegions === now.editRegions && was.source === now.source && sameButSourceAndRegions(was, now);
}

// A line added or removed above a block changes the line of the block and
// of every edit region in it, and nothing else of it: the block's core is
// then made from the one before (the same parts, the lines moved), and the
// two are linked here. A line break typed in the middle of a 191-page file
// rebuilt and sent 1,300 blocks whole: 0.9 MB, 10 ms in the server and 3.5
// in the viewer for that one key.
const linesMovedFrom = new WeakMap(); // a core's `source` -> { from: the `source` it was made from, by: lines }
/**
 * By how many lines `now` stands below `was` when the two entries differ in
 * nothing else but their place (0: on the same lines); null when they are
 * not such a pair.
 */
export function domEntryLinesMovedBy(was, now) {
  if (!was || !now || !sameButSourceAndRegions(was, now)) return null;
  if (was.editRegions?.some(region => region.mathMacros) || now.editRegions?.some(region => region.mathMacros)) return null;
  let by = 0;
  let source = now.source;
  // (a viewer is at most a few snapshots behind)
  for (let step = 0; step < 16 && source !== was.source; step++) {
    const link = linesMovedFrom.get(source);
    if (!link) return null;
    by += link.by;
    source = link.from;
  }
  return source === was.source ? by : null;
}

// The pages every block stands on. Read off every line of every page with
// each snapshot (7,800 lines on a 191-page file, of which a keystroke
// replaces one page), it was a third of what was left of the snapshot. With
// a `memo` of the caller's to keep it in, only the pages whose list of lines
// is another object are read again, and only the blocks on them get another
// list. The lists themselves are never changed once handed out (entries of
// earlier snapshots hold them).
const idsOnPage = (page) => {
  const ids = [];
  let last = null;
  let seen = null;
  for (const d of page.draw ?? []) {
    const id = d.u?.blockId;
    if (!id || id === last) continue;
    last = id;
    if (!seen) seen = new Set();
    if (seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }
  return ids;
};
function pagesOfBlocks(pages, memo) {
  const kept = memo?.blockPages;
  if (kept && kept.rising && kept.draws.length === pages.length) {
    let fits = true;
    let changed = null;
    for (let k = 0; k < pages.length; k++) {
      if (pages[k].number !== kept.numbers[k]) { fits = false; break; }
      if (pages[k].draw !== kept.draws[k]) (changed ??= []).push(k);
    }
    if (fits) {
      for (const k of changed ?? []) {
        const number = kept.numbers[k];
        const before = kept.ids[k];
        const now = idsOnPage(pages[k]);
        const nowSet = new Set(now);
        const beforeSet = new Set(before);
        for (const id of before) {
          if (nowSet.has(id)) continue;
          const list = kept.map.get(id).filter((n) => n !== number);
          if (list.length) kept.map.set(id, list);
          else kept.map.delete(id);
        }
        for (const id of now) {
          if (beforeSet.has(id)) continue;
          const list = kept.map.get(id) ?? [];
          let at = list.length;
          while (at > 0 && list[at - 1] > number) at--;
          kept.map.set(id, [...list.slice(0, at), number, ...list.slice(at)]);
        }
        kept.draws[k] = pages[k].draw;
        kept.ids[k] = now;
      }
      return kept.map;
    }
  }
  const map = new Map();
  const draws = [];
  const numbers = [];
  const ids = [];
  let rising = true;
  for (let k = 0; k < pages.length; k++) {
    const page = pages[k];
    const number = page.number;
    if (k > 0 && !(number > numbers[k - 1])) rising = false;
    draws.push(page.draw);
    numbers.push(number);
    const here = memo ? idsOnPage(page) : null;
    ids.push(here);
    for (const d of page.draw ?? []) {
      const bid = d.u?.blockId;
      if (!bid) continue;
      let arr = map.get(bid);
      if (!arr) map.set(bid, arr = []);
      if (arr[arr.length - 1] !== number) arr.push(number);
    }
  }
  // (kept only where page numbers rise from page to page: a block's list is then its pages in order)
  if (memo) memo.blockPages = rising && numbers.every(Number.isFinite) ? { rising, draws, numbers, ids, map } : null;
  return map;
}

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
  lineStarts = null,
  memo = null,
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
    // (by line and column, not by offset: a character typed above moves the
    // offset of every block after it and the position of none. Keyed by the
    // offset, one keystroke in a single-file document of 400 paragraphs
    // rebuilt the regions of the 394 blocks after it.)
    const start = position(file, b.start);
    return `${file}|${start.line}|${start.column}`;
  };
  const ownRegions = (b) => {
    const anchor = regionAnchor(b);
    const kept = blockRegionMemo.get(b);
    // (a block typeset again gets its region list anew, the same regions in
    // another array: told by what they say, so the regions handed out, and
    // with them the block's entry, stay the ones they were)
    if (kept && anchor !== null && kept.anchor === anchor && kept.text === b.text &&
        (kept.editRegions === b.editRegions || sameRegionSpecs(kept.editRegions, b.editRegions))) {
      kept.editRegions = b.editRegions;
      return kept.regions;
    }
    // Canonical snapshots can arrive before an isolated rescue's
    // resident metadata. Source spans are lexical and already known;
    // never freeze a temporarily empty editing map into that PDF.
    const regions = [];
    for (const region of b.editRegions ?? instrumentEditRegions(b.text).regions) {
      const source = editSource(b, region);
      const id = `${b.id}:${region.id}`;
      if (source) {
        regions.push({ id, kind: region.kind, value: region.value, sourceValue: region.sourceValue,
          display: region.display, source, ...(region.tableRow != null && {
            tableRow: region.tableRow, tableColumn: region.tableColumn, tableColumns: region.tableColumns,
            ...(region.tableSpan && { tableSpan: region.tableSpan }),
            ...(region.tableLiteralBefore && { tableLiteralBefore: region.tableLiteralBefore }),
            ...(region.tableLiteralAfter && { tableLiteralAfter: region.tableLiteralAfter }),
          }) });
        continue;
      }
      // One printed paragraph may join literal text from several inputs.
      // Expose each file's editable words without making the inclusion itself editable.
      if (!b.sourceParts || region.kind !== 'text' || region.value !== region.sourceValue ||
          region.sourceValue !== b.text.slice(region.contentStart, region.contentEnd)) continue;
      for (const [index, part] of b.sourceParts.entries()) {
        const from = Math.max(region.contentStart, part.at);
        const to = Math.min(region.contentEnd, part.to, part.at + part.end - part.start);
        if (from >= to) continue;
        const raw = b.text.slice(from, to);
        const value = raw.trim();
        if (!value) continue;
        const start = from + raw.length - raw.trimStart().length;
        const source = editSource(b, { contentStart: start, contentEnd: start + value.length });
        if (source) regions.push({ id: `${id}.${index}`, kind: 'text', value, sourceValue: value, source });
      }
    }
    if (anchor !== null) blockRegionMemo.set(b, { text: b.text, editRegions: b.editRegions, anchor, regions });
    else blockRegionMemo.delete(b);
    return regions;
  };
  const blockPages = pagesOfBlocks(pages, memo);
  // the root file's line starts, when the caller has them: a block's line
  // and column are then checked against them instead of being looked up
  const rootLines = lineStarts?.(file) ?? null;
  const hasTitle = preambleEditRegions.length > 0;
  // Whether everything the kept core was made of is what the block holds now.
  // Whether the kept core was made of the very things the block holds now (wherever the block stands).
  const madeOfTheSame = (kept, b) =>
    kept.rootFile === file && kept.galley === b.galley && kept.fidelity === b.fidelity && kept.gfx === b.gfx &&
    kept.kind === b.kind && kept.editRegions === b.editRegions && kept.text === b.text && kept.blockFile === b.file &&
    !b.sourceParts && !(hasTitle && kept.maketitle) && (kept.mode === 'root'
      ? !!rootLines && !b.file && b.end - b.start === b.text.length
      : kept.mode === 'file' && !!b.file && !!b.sourceStart && !!b.sourceEnd);
  // …and stands on the lines and columns it stood on.
  const onItsLines = (kept, b) => (kept.mode === 'root'
    ? standsAt(rootLines, kept.startLine, kept.startColumn, b.start) && standsAt(rootLines, kept.endLine, kept.endColumn, b.end)
    : b.sourceStart.line === kept.startLine && b.sourceStart.column === kept.startColumn &&
      b.sourceEnd.line === kept.endLine && b.sourceEnd.column === kept.endColumn);
  // By how many lines the block stands below where its core says, at the
  // same columns; 0 when it is not simply that.
  let lastMove = 0; // (the blocks after an added line all moved by the same amount)
  const linesMoved = (kept, b) => {
    if (kept.mode !== 'root') {
      const by = b.sourceStart.line - kept.startLine;
      return by && b.sourceStart.column === kept.startColumn && b.sourceEnd.line - kept.endLine === by &&
        b.sourceEnd.column === kept.endColumn && Number.isSafeInteger(by) ? by : 0;
    }
    let line = kept.startLine + lastMove;
    if (!lastMove || line < 1 || !standsAt(rootLines, line, kept.startColumn, b.start)) {
      const here = position(file, b.start);
      if (here.column !== kept.startColumn) return 0;
      line = here.line;
    }
    const by = line - kept.startLine;
    if (!by || kept.endLine + by < 1 || !standsAt(rootLines, kept.endLine + by, kept.endColumn, b.end)) return 0;
    lastMove = by;
    return by;
  };
  // The kept core, `by` lines further down: the same parts, a source and edit regions of their own.
  const moveCore = (kept, b, by) => {
    const core = kept.core;
    const moved = (source) => ({
      file: source.file,
      start: { line: source.start.line + by, column: source.start.column },
      end: { line: source.end.line + by, column: source.end.column },
    });
    const source = kept.mode === 'root' ? moved(core.source) : { file: b.file, start: b.sourceStart, end: b.sourceEnd };
    const editRegions = core.editRegions.map((region) => ({ ...region, source: moved(region.source) }));
    linesMovedFrom.set(source, { from: core.source, by });
    // (the same files, on other lines)
    const files = regionFiles.get(core.editRegions);
    if (files) regionFiles.set(editRegions, files);
    kept.core = { ...core, source, editRegions };
    kept.regions = editRegions;
    kept.startLine += by;
    kept.endLine += by;
    kept.key = `${kept.keyHead}${kept.startLine}:${kept.startColumn}-${kept.endLine}:${kept.endColumn}`;
    kept.entry = null;
    // (ownRegions hands these out for the block where it stands now)
    blockRegionMemo.set(b, { text: b.text, editRegions: b.editRegions,
      anchor: `${kept.mode === 'root' ? file : b.file}|${kept.startLine}|${kept.startColumn}`, regions: editRegions });
  };
  const entryOf = (b, i) => {
    const pages = blockPages.get(b.id) ?? NO_PAGES;
    let kept = blockEntryMemo.get(b);
    let holds = false;
    if (kept && madeOfTheSame(kept, b)) {
      holds = onItsLines(kept, b);
      if (!holds) {
        const by = linesMoved(kept, b);
        if (by) {
          moveCore(kept, b, by);
          holds = true;
        }
      }
    }
    if (!holds) {
      // (chunkTargets is a function of the block's galley, fidelity and gfx: coreHolds reads those)
      const chunkKeys = chunkTargets(b).map((t) => t.key);
      const own = ownRegions(b);
      // (asked once per block, not once per preamble region of every block)
      const maketitle = /\\maketitle\b/.test(b.text);
      const titleRegions = (hasTitle && maketitle ? preambleEditRegions : [])
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
      const inFile = !!(b.file && b.sourceStart && b.sourceEnd);
      const at = inFile ? null : [position(file, b.start), position(file, b.end)];
      const from = at ? at[0] : b.sourceStart;
      const to = at ? at[1] : b.sourceEnd;
      const keyHead = `${b.kind ?? ''}|${chunkKeys.join(',')}|${b.fidelity?.level ?? ''}|${b.fidelity?.exactLines ?? 0}|` +
        `${b.file ?? ''}|${at ? 'root' : 'file'}|`;
      const key = `${keyHead}${from.line}:${from.column}-${to.line}:${to.column}`;
      const reads = {
        rootFile: file, fidelity: b.fidelity, gfx: b.gfx, kind: b.kind, editRegions: b.editRegions, text: b.text,
        blockFile: b.file, maketitle,
        // (a block cut from several files, or one whose text is not its own slice of the root, is asked again each time)
        mode: b.sourceParts ? null : inFile ? 'file' : !b.file && b.end - b.start === b.text.length ? 'root' : null,
        startLine: from.line, startColumn: from.column, endLine: to.line, endColumn: to.column,
      };
      // (a galley adopted again with what the core took from it unchanged, its
      // labels and its references, is the same core: a walk that typesets a
      // block again hands it another galley object with the same boxes)
      if (kept && kept.key === key && kept.sourceParts === b.sourceParts && kept.regions === blockRegions &&
          (kept.galley === b.galley || sameGalleyParts(kept.core, b.galley))) {
        Object.assign(kept, reads);
        kept.galley = b.galley;
      } else {
        kept = {
          key, keyHead, galley: b.galley, sourceParts: b.sourceParts, regions: blockRegions, ...reads,
          core: {
            id: b.id,
            type: b.kind ?? 'block',
            gfx: chunkKeys.length > 0,
            gfxChunks: chunkKeys,
            fidelity: b.fidelity?.level ?? null,
            exactLines: b.fidelity?.exactLines ?? 0,
            source: at ? { file, start: at[0], end: at[1] } : { file: b.file, start: b.sourceStart, end: b.sourceEnd },
            sourceRanges: b.sourceParts?.map(part => ({ file: part.file, start: part.sourceStart, end: part.sourceEnd })),
            labels: (b.galley?.labels ?? []).map((l) => l.k),
            refs: b.galley?.refs ?? [],
            // raw offsets into the main buffer for in-preview box editing;
            // blocks expanded from \input files are not editable in-place
            file: b.file ?? null,
            editRegions: blockRegions,
          },
          entry: null, index: -1, start: -1, end: -1, pages: null,
        };
        // (a block with title regions gets a new list each time: not kept)
        if (blockRegions === own) blockEntryMemo.set(b, kept);
      }
    }
    if (kept.entry && kept.macroDefinitions === b.galley?.tdomMathMacros && kept.index === i && kept.start === b.start && kept.end === b.end && samePages(kept.pages, pages)) return kept.entry;
    const core = kept.core;
    const macroDefinitions = b.galley?.tdomMathMacros;
    const editRegions = macroDefinitions ? core.editRegions.map(region => {
      const projected = region.kind === 'math' && mathMacros.project(region.value, macroDefinitions);
      return projected ? { ...region, value: projected.text, sourceValue: region.sourceValue ?? region.value,
        mathMacros: projected.definitions } : region;
    }) : core.editRegions;
    kept.macroDefinitions = macroDefinitions;
    const entry = {
      id: core.id,
      index: i,
      type: core.type,
      gfx: core.gfx,
      gfxChunks: core.gfxChunks,
      fidelity: core.fidelity,
      exactLines: core.exactLines,
      source: core.source,
      sourceRanges: core.sourceRanges,
      labels: core.labels,
      refs: core.refs,
      pages: kept.pages && samePages(kept.pages, pages) ? kept.pages : pages,
      file: core.file,
      span: b.file ? null : { start: b.start, end: b.end },
      editRegions,
    };
    kept.entry = entry;
    kept.index = i;
    kept.start = b.start;
    kept.end = b.end;
    kept.pages = entry.pages;
    return entry;
  };
  const rejectedBlocks = [];
  const entries = blocks.map((block, i) => {
    if (block.galley?.tdomDeferred && block.closure?.reason === 'native-error') rejectedBlocks.push(block.id);
    return entryOf(block, i);
  });
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
    blocks: entries,
    ...(rejectedBlocks.length ? { rejectedBlocks } : {}),
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
const entryJson = new WeakMap(); // an entry buildDomSnapshot handed out again -> its text
export function serializeDomBlock(block) {
  const held = entryJson.get(block);
  if (held !== undefined) return held;
  const text = serializeDomEntry(block);
  entryJson.set(block, text);
  return text;
}
function serializeDomEntry(block) {
  const regions = block.editRegions;
  const keys = Object.keys(block);
  if (!Array.isArray(regions) || !regions.length || keys.length < 2 || keys.at(-1) !== 'editRegions') return JSON.stringify(block);
  let text = regionJson.get(regions);
  if (text === undefined) regionJson.set(regions, text = JSON.stringify(regions));
  const { editRegions: _regions, ...rest } = block;
  return `${JSON.stringify(rest).slice(0, -1)},"editRegions":${text}}`;
}
