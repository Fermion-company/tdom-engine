// A fail-closed bridge between an immutable canonical PDF and resident TeX
// line boxes.  This module deliberately does not infer columns, reading
// order, or page flow. SyncTeX's physical line hbox is the window; pdf.js's
// operator list proves which glyphs were actually painted inside it.

import {
  classifyResidentRun,
  residentBackendProfileKey,
  stableRunLayoutRecord,
} from './run-semantics.js';

const EPSILON = 1e-6;
const BASELINE_TOLERANCE_BP = 0.3;
const BOX_TOLERANCE_BP = 0.35;
const CONTENT_TOLERANCE_BP = 0.55;
const FONT_SIZE_TOLERANCE_BP = 0.035;
const UNSAFE_TEXT = /[\uFFFD\uE000-\uF8FF]/u;
const BLACK = '#000000';
// pdf.js converts DeviceCMYK through a polynomial that turns 0 0 0 1 k
// (black in xcolor's cmyk model) into this; the resident writes every
// model's black as #000000.
const PDFJS_CMYK_BLACK = '#2c2e35';

export const PDF_PAINT_INDEX_VERSION = 2;

/** Freeze the visible resident lines before the first edit against a
 * canonical generation. Spaces are TeX glue, not painted glyphs, so the
 * witness keeps the exact painted glyph sequence, its advance interval and
 * the color the provisional renderer paints each glyph in. */
export function galleyLineWitnesses(galley) {
  const lines = galleyBoxWitnesses(galley);
  return lines && lines.every(Boolean) ? lines : null;
}

/** The same witnesses for a block that mixes plain lines with opaque boxes
 * (a heading box, framed material, nested lines, graphics): one entry per
 * box item, null where the box is not a single plain glyph line. */
export function galleyMixedLineWitnesses(galley) {
  const lines = galleyBoxWitnesses(galley);
  return lines && lines.some(Boolean) ? lines : null;
}

function galleyBoxWitnesses(galley) {
  const boxes = (galley?.items ?? []).filter((item) => item?.k === 'box');
  if (!boxes.length) return null;
  const profileKey = residentBackendProfileKey(galley?.backend);
  return boxes.map((item, index) => boxLineWitness(item, index, galley?.backend, profileKey));
}

function boxLineWitness(item, index, backend, profileKey) {
  const runs = item.runs ?? [];
  if (!runs.length) return null;
  const glyphs = [];
  let contentLeft = Infinity;
  let contentRight = -Infinity;
  for (const run of runs) {
    const semantics = classifyResidentRun(run, backend);
    if (semantics.tag === 'LayoutOnly') continue;
    if (semantics.tag !== 'GlyphPaint') return null;
    const x = Number(run.x);
    const width = Number(run.w);
    const size = Number(run.s);
    const dy = Number(run.dy ?? 0);
    if (![x, width, size, dy].every(Number.isFinite) || width < 0 || size <= 0 || Math.abs(dy) > EPSILON) {
      return null;
    }
    const text = String(run.t).normalize('NFC');
    if (!text || UNSAFE_TEXT.test(text) || /[\r\n]/u.test(text)) return null;
    // the display list paints a run without a color black
    const color = String(run.c || BLACK).toLowerCase();
    for (const char of Array.from(text)) {
      if (/\s/u.test(char)) return null; // a painted space is ambiguous with synthesized extraction space
      glyphs.push({ char, size, font: String(run.f ?? ''), color });
    }
    contentLeft = Math.min(contentLeft, x);
    contentRight = Math.max(contentRight, x + width);
  }
  const lineWidth = Number(item.w);
  const height = Number(item.h);
  const depth = Number(item.d ?? 0);
  if (![lineWidth, height, depth, contentLeft, contentRight].every(Number.isFinite) ||
      lineWidth <= 0 || height <= 0 || depth < 0 || contentRight <= contentLeft || !glyphs.length) {
    return null;
  }
  return {
    index,
    paintText: glyphs.map((glyph) => glyph.char).join(''),
    glyphCount: glyphs.length,
    glyphSizes: glyphs.map((glyph) => glyph.size),
    glyphFonts: glyphs.map((glyph) => glyph.font),
    glyphColors: glyphs.map((glyph) => glyph.color),
    lineWidth,
    height,
    depth,
    contentLeft,
    contentRight,
    contentWidth: contentRight - contentLeft,
    signature: stableLineSignature(item, profileKey),
  };
}

/** Everything a mixed block lays out or declares except the glyph runs of
 * its plain lines: opaque boxes verbatim, every glue/penalty/marker item,
 * each plain line's box geometry and flags, the side-effect lists, and the
 * state trail. Equal frames mean an edit changed nothing but the paint
 * inside plain lines, and that the code after it ran from the same state. */
export function mixedGalleyFrame(galley, witnesses) {
  if (!galley || !Array.isArray(witnesses)) return null;
  let box = -1;
  const items = (galley.items ?? []).map((item) => {
    if (item?.k !== 'box') return item;
    box++;
    if (!witnesses[box]) return item;
    const { runs, ...frame } = item;
    return frame;
  });
  if (box + 1 !== witnesses.length) return null;
  return JSON.stringify([
    residentBackendProfileKey(galley.backend),
    Boolean(galley.gfx),
    galley.w ?? null,
    galley.h ?? null,
    items,
    galley.floats ?? [],
    galley.labels ?? [],
    galley.refs ?? [],
    galley.toclines ?? [],
    galley.events ?? [],
    galley.trail ?? null,
  ]);
}

/** The old-layout certificate for a provisional VisualCut. The exact mixed
 * frame above keeps its full trail and every line metric. This separate frame
 * omits only values the cut deliberately leaves to the old canonical layout:
 * aggregate height, the final trail, and h/d of plain witness boxes. */
export function mixedGalleyVisualFrame(galley, witnesses) {
  if (!galley || !Array.isArray(witnesses) || !Array.isArray(galley.epochs) ||
      galley.epochs.length !== (galley.items ?? []).length) return null;
  let box = -1;
  const items = (galley.items ?? []).map((item) => {
    if (item?.k !== 'box') return item;
    box++;
    if (!witnesses[box]) return item;
    const { runs, h, d, ...frame } = item;
    return frame;
  });
  if (box + 1 !== witnesses.length) return null;
  return JSON.stringify([
    residentBackendProfileKey(galley.backend),
    Boolean(galley.gfx),
    galley.w ?? null,
    items,
    galley.epochs,
    galley.floats ?? [],
    galley.labels ?? [],
    galley.refs ?? [],
    galley.toclines ?? [],
    galley.events ?? [],
  ]);
}

const VISUAL_FRAME_FIELDS = [
  'backend', 'gfx', 'width', 'items', 'epochs',
  'floats', 'labels', 'refs', 'toclines', 'events',
];
const VISUAL_COMPENSATION_PARSE_UNITS = 1024 * 1024;
const VISUAL_COMPENSATION_MAX_ITEMS = 8192;

function parsedVisualFrame(serialized) {
  if (typeof serialized !== 'string' || serialized.length > VISUAL_COMPENSATION_PARSE_UNITS) return null;
  try {
    const value = JSON.parse(serialized);
    if (!Array.isArray(value) || value.length !== VISUAL_FRAME_FIELDS.length) return null;
    return Object.fromEntries(VISUAL_FRAME_FIELDS.map((field, index) => [field, value[index]]));
  } catch {
    return null;
  }
}

/** Admit only TeX's metric-compensating baselineskip after one changed line.
 * The ordinary visual frame remains byte-identical for every other item. */
export function mixedVisualCutCompensatedFrame({
  baseVisualFrame,
  currentVisualFrame,
  baseLines,
  currentLines,
  changedLine,
  baseHeight,
  currentHeight,
}) {
  const base = parsedVisualFrame(baseVisualFrame);
  const current = parsedVisualFrame(currentVisualFrame);
  const beforeLine = baseLines?.[changedLine];
  const afterLine = currentLines?.[changedLine];
  if (!base || !current ||
      !Array.isArray(base.items) || !Array.isArray(current.items) ||
      base.items.length === 0 || base.items.length > VISUAL_COMPENSATION_MAX_ITEMS ||
      base.items.length !== current.items.length ||
      !Array.isArray(base.epochs) || !Array.isArray(current.epochs) ||
      base.epochs.length !== base.items.length || current.epochs.length !== current.items.length ||
      JSON.stringify(base.epochs) !== JSON.stringify(current.epochs) ||
      !Number.isInteger(changedLine) || !beforeLine || !afterLine ||
      ![baseHeight, currentHeight, beforeLine.height, beforeLine.depth,
        afterLine.height, afterLine.depth, beforeLine.lineWidth, afterLine.lineWidth].every(Number.isFinite) ||
      !sameNumber(baseHeight, currentHeight, EPSILON) ||
      !sameNumber(beforeLine.height, afterLine.height, EPSILON) ||
      !sameNumber(beforeLine.lineWidth, afterLine.lineWidth, EPSILON)) return false;

  for (const field of VISUAL_FRAME_FIELDS) {
    if (field === 'items' || field === 'epochs') continue;
    if (JSON.stringify(base[field]) !== JSON.stringify(current[field])) return false;
  }
  let box = -1;
  let changedItem = -1;
  let compensation = -1;
  for (let index = 0; index < base.items.length; index++) {
    const before = base.items[index];
    const after = current.items[index];
    if (before?.k !== after?.k) return false;
    if (before?.k === 'box' && ++box === changedLine) changedItem = index;
    if (JSON.stringify(before) === JSON.stringify(after)) continue;
    if (compensation >= 0 || before?.k !== 'glue' || after?.k !== 'glue' ||
        before.sub !== 2 || after.sub !== 2) return false;
    const { a: beforeAmount, ...beforeRest } = before;
    const { a: afterAmount, ...afterRest } = after;
    if (![beforeAmount, afterAmount].every(Number.isFinite) ||
        JSON.stringify(beforeRest) !== JSON.stringify(afterRest)) return false;
    compensation = index;
  }
  if (changedItem < 0 || compensation < 0 || compensation + 1 >= base.items.length) return false;

  const depthDelta = afterLine.depth - beforeLine.depth;
  const glueDelta = Number(current.items[compensation].a) - Number(base.items[compensation].a);
  if (Math.abs(depthDelta) <= EPSILON || !sameNumber(glueDelta, -depthDelta, EPSILON)) return false;

  const next = compensation + 1;
  if (base.items[next]?.k !== 'box' || current.items[next]?.k !== 'box' ||
      JSON.stringify(base.items[next]) !== JSON.stringify(current.items[next]) ||
      base.epochs[compensation] !== base.epochs[next]) return false;

  const between = base.items.slice(changedItem + 1, compensation);
  const zeroGlue = between[0];
  const zeroGlueFields = zeroGlue && Object.keys(zeroGlue);
  const emptyBox = base.items[next];
  const clearPage = compensation === changedItem + 4 && next === changedItem + 5 &&
    Number.isInteger(base.epochs[changedItem]) && Number.isInteger(base.epochs[compensation]) &&
    base.epochs[compensation] > base.epochs[changedItem] &&
    between.length === 3 &&
    zeroGlue?.k === 'glue' && zeroGlue.sub === 0 && zeroGlue.a === 0 &&
    zeroGlueFields.every((field) => ['k', 'sub', 'a', 'st', 'sh', 'sto', 'sho'].includes(field)) &&
    ['st', 'sh'].every((field) => zeroGlue[field] == null || Number.isFinite(zeroGlue[field])) &&
    ['sto', 'sho'].every((field) => zeroGlue[field] == null || Number.isInteger(zeroGlue[field])) &&
    between[1]?.k === 'eject' && between[1].v === -10000 &&
    between[2]?.k === 'pen' && between[2].v === 10000 &&
    Object.keys(emptyBox).length === 5 && emptyBox.k === 'box' &&
    emptyBox.h === 0 && emptyBox.d === 0 && emptyBox.w === 0 &&
    Array.isArray(emptyBox.runs) && emptyBox.runs.length === 0;
  return clearPage;
}

const MIXED_FRAME_FIELDS = [
  'backend', 'gfx', 'width', 'height', 'items', 'floats',
  'labels', 'refs', 'toclines', 'events', 'trail',
];
const MIXED_FRAME_DIFF_PATHS = 12;
const MIXED_FRAME_DIFF_VISITS = 4096;
const MIXED_FRAME_DIFF_DEPTH = 16;
const MIXED_FRAME_DIFF_PATH_LENGTH = 160;
const MIXED_FRAME_PARSE_UNITS = 16 * 1024 * 1024;
const MIXED_FRAME_GEOMETRY_ITEMS = 8192;
const MIXED_FRAME_EQUALITY_VISITS = 131_072;
const MIXED_FRAME_EQUALITY_LOCAL_VISITS = 16_384;
const MIXED_FRAME_EQUALITY_STRING_UNITS = 1024 * 1024;
const MIXED_FRAME_EQUALITY_MS = 25;

function parsedMixedFrame(serialized) {
  if (typeof serialized !== 'string' || serialized.length > MIXED_FRAME_PARSE_UNITS) return null;
  try {
    const value = JSON.parse(serialized);
    if (!Array.isArray(value) || value.length !== MIXED_FRAME_FIELDS.length) return null;
    return Object.fromEntries(MIXED_FRAME_FIELDS.map((field, index) => [field, value[index]]));
  } catch {
    return null;
  }
}

/** Bounded, value-free diagnostics for two serialized mixed frames. Paths
 * identify which structural fields changed without exposing source text or
 * retaining either potentially large frame in the report/SSE stream. */
export function mixedGalleyFrameDifference(beforeFrame, afterFrame) {
  const before = parsedMixedFrame(beforeFrame);
  const after = parsedMixedFrame(afterFrame);
  if (!before || !after) return null;
  const paths = [];
  let changedFieldCount = 0;
  let visits = 0;
  let truncated = false;
  let unexaminedFieldPath = null;
  const recorded = new Set();
  const equalityBudget = {
    visits: MIXED_FRAME_EQUALITY_VISITS,
    stringUnits: MIXED_FRAME_EQUALITY_STRING_UNITS,
    deadline: Date.now() + MIXED_FRAME_EQUALITY_MS,
  };
  const boundedPath = (fieldPath) => {
    if (fieldPath.length <= MIXED_FRAME_DIFF_PATH_LENGTH) return fieldPath;
    truncated = true;
    return `${fieldPath.slice(0, MIXED_FRAME_DIFF_PATH_LENGTH - 3)}...`;
  };
  const record = (fieldPath) => {
    if (recorded.has(fieldPath)) return;
    recorded.add(fieldPath);
    changedFieldCount++;
    if (paths.length < MIXED_FRAME_DIFF_PATHS) paths.push(boundedPath(fieldPath));
    else truncated = true;
  };
  const childPath = (fieldPath, key, array) => {
    if (array) return `${fieldPath}[${key}]`;
    const field = /^[A-Za-z_$][\w$-]*$/.test(key) ? key : '<field>';
    return fieldPath ? `${fieldPath}.${field}` : field;
  };
  // A large unchanged opaque box can contain thousands of run fields. Probe
  // equality with independent, deterministic work/string budgets so one such
  // subtree costs one diagnostic visit when it fits, but never makes the SSE
  // diagnostic itself unbounded.
  const boundedEqual = (left, right) => {
    let localVisits = MIXED_FRAME_EQUALITY_LOCAL_VISITS;
    const stack = [[left, right]];
    while (stack.length) {
      if (--localVisits < 0 || --equalityBudget.visits < 0 || Date.now() > equalityBudget.deadline) return null;
      const [a, b] = stack.pop();
      if (typeof a === 'string' || typeof b === 'string') {
        if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
        const units = a.length + b.length;
        if (units > equalityBudget.stringUnits) return null;
        equalityBudget.stringUnits -= units;
        if (a !== b) return false;
        continue;
      }
      if (Object.is(a, b)) continue;
      const aObject = a !== null && typeof a === 'object';
      const bObject = b !== null && typeof b === 'object';
      if (!aObject || !bObject || Array.isArray(a) !== Array.isArray(b)) return false;
      if (Array.isArray(a)) {
        if (a.length !== b.length) return false;
        if (a.length > localVisits || a.length > equalityBudget.visits) return null;
        for (let index = a.length - 1; index >= 0; index--) stack.push([a[index], b[index]]);
        continue;
      }
      const aKeys = Object.keys(a).sort();
      const bKeys = Object.keys(b).sort();
      if (aKeys.length !== bKeys.length) return false;
      if (aKeys.length > localVisits || aKeys.length > equalityBudget.visits) return null;
      for (let index = aKeys.length - 1; index >= 0; index--) {
        if (aKeys[index] !== bKeys[index]) return false;
        equalityBudget.stringUnits -= aKeys[index].length * 2;
        if (equalityBudget.stringUnits < 0) return null;
        stack.push([a[aKeys[index]], b[bKeys[index]]]);
      }
    }
    return true;
  };
  const visit = (left, right, fieldPath, depth) => {
    if (++visits > MIXED_FRAME_DIFF_VISITS) {
      truncated = true;
      unexaminedFieldPath ??= boundedPath(fieldPath);
      return;
    }
    if (typeof left === 'string' || typeof right === 'string') {
      const equal = boundedEqual(left, right);
      if (equal === true) return;
      if (equal === null) {
        truncated = true;
        unexaminedFieldPath ??= boundedPath(fieldPath);
        return;
      }
      record(fieldPath);
      return;
    }
    if (Object.is(left, right)) return;
    if (depth >= MIXED_FRAME_DIFF_DEPTH) {
      record(fieldPath);
      truncated = true;
      return;
    }
    const leftObject = left !== null && typeof left === 'object';
    const rightObject = right !== null && typeof right === 'object';
    if (!leftObject || !rightObject || Array.isArray(left) !== Array.isArray(right)) {
      record(fieldPath);
      return;
    }
    // Root/items ordering is diagnostically significant. Below an item,
    // bounded equality lets large unchanged opaque boxes/runs be skipped.
    if (depth >= 2 && boundedEqual(left, right) === true) return;
    if (Array.isArray(left)) {
      if (left.length !== right.length) record(`${fieldPath}.length`);
      const length = Math.min(left.length, right.length);
      for (let index = 0; index < length && visits <= MIXED_FRAME_DIFF_VISITS; index++) {
        visit(left[index], right[index], childPath(fieldPath, index, true), depth + 1);
      }
      return;
    }
    const keys = [...new Set([...Object.keys(left), ...Object.keys(right)])].sort();
    for (const key of keys) {
      if (visits > MIXED_FRAME_DIFF_VISITS) break;
      const path = childPath(fieldPath, key, false);
      if (!Object.hasOwn(left, key) || !Object.hasOwn(right, key)) record(path);
      else visit(left[key], right[key], path, depth + 1);
    }
  };
  // Reserve useful geometry before descending into arbitrary opaque payload.
  // In particular, a huge unchanged `runs` array must not hide a changed
  // plain-line height/depth later in `items`.
  for (const field of ['height', 'width', 'backend', 'gfx']) {
    visit(before[field], after[field], field, 1);
  }
  const beforeItems = before.items;
  const afterItems = after.items;
  if (Array.isArray(beforeItems) && Array.isArray(afterItems)) {
    const length = Math.min(beforeItems.length, afterItems.length, MIXED_FRAME_GEOMETRY_ITEMS);
    for (let index = 0; index < length; index++) {
      const left = beforeItems[index];
      const right = afterItems[index];
      if (left?.k !== 'box' || right?.k !== 'box') continue;
      for (const field of ['h', 'd']) {
        if (!Object.is(left[field], right[field])) {
          visit(left[field], right[field], `items[${index}].${field}`, 3);
        }
      }
    }
    if (Math.min(beforeItems.length, afterItems.length) > MIXED_FRAME_GEOMETRY_ITEMS) {
      truncated = true;
      unexaminedFieldPath ??= `items[${MIXED_FRAME_GEOMETRY_ITEMS}]`;
    }
  }
  for (const field of MIXED_FRAME_FIELDS) {
    if (['height', 'width', 'backend', 'gfx'].includes(field)) continue;
    visit(before[field], after[field], field, 1);
  }
  return {
    changedFieldCount,
    changedFieldPaths: paths,
    unexaminedFieldPath,
    serializationOnly: changedFieldCount === 0 && !truncated,
    truncated,
  };
}

/** Mixed counterpart of changedGalleyLines: opaque boxes stay opaque and
 * unchanged (the caller compares frames), and only plain lines may change. */
export function changedMixedGalleyLines(baseLines, currentLines) {
  if (!Array.isArray(baseLines) || !Array.isArray(currentLines) ||
      !baseLines.length || baseLines.length !== currentLines.length) return null;
  const changed = [];
  for (let index = 0; index < baseLines.length; index++) {
    const before = baseLines[index];
    const after = currentLines[index];
    if (!before !== !after) return null;
    if (!before) continue;
    if (!sameNumber(before.lineWidth, after.lineWidth, EPSILON) ||
        !sameNumber(before.height, after.height, EPSILON) ||
        !sameNumber(before.depth, after.depth, EPSILON)) return null;
    if (before.signature !== after.signature) changed.push(index);
  }
  return changed.length ? changed : null;
}

/** A VisualCut keeps the old line slots, so exactly one plain signature may
 * change its h/d. Every other plain line and every line width stays exact. */
export function changedMixedVisualCutLines(baseLines, currentLines) {
  if (!Array.isArray(baseLines) || !Array.isArray(currentLines) ||
      !baseLines.length || baseLines.length !== currentLines.length) return null;
  const changed = [];
  for (let index = 0; index < baseLines.length; index++) {
    const before = baseLines[index];
    const after = currentLines[index];
    if (!before !== !after) return null;
    if (!before) continue;
    if (!sameNumber(before.lineWidth, after.lineWidth, EPSILON)) return null;
    if (before.signature !== after.signature) changed.push(index);
    else if (!sameNumber(before.height, after.height, EPSILON) ||
        !sameNumber(before.depth, after.depth, EPSILON)) return null;
  }
  return changed.length === 1 ? changed : null;
}

export function mixedVisualCutHeightMatches(baseHeight, currentHeight, beforeLine, afterLine) {
  if (![baseHeight, currentHeight, beforeLine?.height, beforeLine?.depth,
    afterLine?.height, afterLine?.depth].every(Number.isFinite)) return false;
  const blockDelta = currentHeight - baseHeight;
  const lineDelta = afterLine.height + afterLine.depth - beforeLine.height - beforeLine.depth;
  return sameNumber(blockDelta, lineDelta, EPSILON);
}

/** A valid no-op is distinct from changed*GalleyLines' historical null
 * result, which also covers malformed/reflowed witnesses. This exact check
 * is used only to repaint the previous anchor's affected lines when a
 * cumulative edit returns them to the immutable canonical base. */
export function identicalGalleyLines(baseLines, currentLines) {
  if (!Array.isArray(baseLines) || !Array.isArray(currentLines) ||
      !baseLines.length || baseLines.length !== currentLines.length) return false;
  for (let index = 0; index < baseLines.length; index++) {
    const before = baseLines[index];
    const after = currentLines[index];
    if (!before !== !after) return false;
    if (!before) continue;
    if (before.signature !== after.signature ||
        !sameNumber(before.lineWidth, after.lineWidth, EPSILON) ||
        !sameNumber(before.height, after.height, EPSILON) ||
        !sameNumber(before.depth, after.depth, EPSILON)) return false;
  }
  return true;
}

/** Return the complete base→current effect set. Unchanged lines must retain
 * their exact display-list signature and every line box must retain geometry. */
export function changedGalleyLines(baseLines, currentLines) {
  if (!Array.isArray(baseLines) || !Array.isArray(currentLines) ||
      !baseLines.length || baseLines.length !== currentLines.length) return null;
  const changed = [];
  for (let index = 0; index < baseLines.length; index++) {
    const before = baseLines[index];
    const after = currentLines[index];
    if (!sameNumber(before.lineWidth, after.lineWidth, EPSILON)) return null;
    if (before.signature !== after.signature) changed.push(index);
    else if (!sameNumber(before.height, after.height, EPSILON) ||
        !sameNumber(before.depth, after.depth, EPSILON)) return null;
  }
  return changed.length ? changed : null;
}

/** Build one page of the immutable paint-run index. The operator list owns
 * glyph identity, fill color and safety; TextContent owns the final
 * page-space geometry.
 * They must agree glyph-for-glyph after excluding non-painted TeX glue. */
const REALIGN_WINDOW = 8;
const REALIGN_RUN = 4;

/** Smallest skip on either side after which REALIGN_RUN glyphs agree
 * again (or both sequences end together), or null. */
function realignGlyphs(painted, extracted, p, e) {
  let best = null;
  for (let dp = 0; dp <= REALIGN_WINDOW; dp++) {
    for (let de = 0; de <= REALIGN_WINDOW; de++) {
      if (dp + de === 0 || (best && dp + de >= best.painted + best.extracted)) continue;
      let run = 0;
      while (run < REALIGN_RUN && p + dp + run < painted.length && e + de + run < extracted.length &&
             painted[p + dp + run].char === extracted[e + de + run].char) run++;
      const bothEnd = p + dp + run === painted.length && e + de + run === extracted.length;
      if (run === REALIGN_RUN || bothEnd) best = { painted: dp, extracted: de };
    }
  }
  return best;
}

export function buildPdfPaintPage({ pageNumber, textContent, operatorList, viewport, OPS, Util }) {
  if (!Number.isInteger(pageNumber) || pageNumber < 1 || !OPS || !Util ||
      !Array.isArray(operatorList?.fnArray) || !Array.isArray(operatorList?.argsArray) ||
      !Array.isArray(textContent?.items) || !Array.isArray(viewport?.transform)) return null;
  if (Number(viewport.rotation ?? 0) !== 0) return null;

  const painted = operatorGlyphs(operatorList, OPS);
  if (!painted) return null;
  const items = [];
  const extractedGlyphs = [];
  for (const item of textContent.items) {
    if (typeof item?.str !== 'string' || !Array.isArray(item.transform)) continue;
    const normalized = item.str.normalize('NFC');
    const chars = Array.from(normalized).filter((char) => !/\s/u.test(char));
    if (!chars.length) continue;
    const matrix = Util.transform(viewport.transform, item.transform);
    const width = Number(item.width);
    const height = Number(item.height);
    if (![width, height].every(Number.isFinite) || width < 0 || height < 0) return null;
    const record = {
      page: pageNumber,
      left: Number(matrix[4]),
      right: Number(matrix[4]) + width,
      baseline: Number(matrix[5]),
      paintText: chars.join(''),
      glyphSizes: [],
      glyphColors: [],
      safe: width > 0 && item.dir === 'ltr' && !UNSAFE_TEXT.test(normalized) && simpleHorizontalMatrix(matrix),
    };
    if (![record.left, record.right, record.baseline].every(Number.isFinite) || record.right < record.left) return null;
    items.push(record);
    for (const char of chars) extractedGlyphs.push({ char, item: record });
  }
  // Pair painted glyphs with extracted text. A glyph that only one side
  // reports (a math font's extensible delimiter: extracted as `(`, painted
  // without a Unicode mapping) used to discard the whole page, so no line on
  // it could ever anchor (tex64-internal #66). Realign within a short window
  // instead; every item the disagreement touches is unsafe and carries no
  // size, so it can never certify.
  const unpaired = (extracted) => {
    extracted.item.glyphSizes.push(NaN);
    extracted.item.glyphColors.push(null);
    extracted.item.safe = false;
  };
  let p = 0;
  let e = 0;
  while (p < painted.length && e < extractedGlyphs.length) {
    const paint = painted[p];
    const extracted = extractedGlyphs[e];
    if (paint.char === extracted.char) {
      extracted.item.glyphSizes.push(paint.size);
      extracted.item.glyphColors.push(paint.color);
      extracted.item.safe &&= paint.safe;
      p++;
      e++;
      continue;
    }
    const skip = realignGlyphs(painted, extractedGlyphs, p, e);
    if (!skip) return null;
    if (e > 0) extractedGlyphs[e - 1].item.safe = false;
    extracted.item.safe = false;
    for (let k = 0; k < skip.extracted; k++) unpaired(extractedGlyphs[e + k]);
    if (e + skip.extracted < extractedGlyphs.length) extractedGlyphs[e + skip.extracted].item.safe = false;
    p += skip.painted;
    e += skip.extracted;
  }
  if (p < painted.length && extractedGlyphs.length) extractedGlyphs.at(-1).item.safe = false;
  while (e < extractedGlyphs.length) unpaired(extractedGlyphs[e++]);
  if (items.some((item) => item.glyphSizes.length !== Array.from(item.paintText).length)) return null;
  return {
    page: pageNumber,
    items,
    // A reusable SVG crop copies every kind of paint in its rectangle.
    // The line index proves text geometry only: a background path, image,
    // transparency group or clip can otherwise hitchhike with a paragraph
    // and move when that galley is reused. This additional whole-page gate
    // belongs only to the crop shortcut; canonical-anchor's line proof and
    // existing eligibility remain unchanged.
    cropSafe: items.every(item => item.safe) && cropPageHasOnlyTextPaint(operatorList, OPS),
  };
}

function cropPageHasOnlyTextPaint(operatorList, OPS) {
  const allowed = new Set([
    'dependency', 'save', 'restore', 'transform',
    'setLineWidth', 'setLineCap', 'setLineJoin', 'setMiterLimit', 'setDash',
    'setRenderingIntent', 'setFlatness',
    'beginText', 'endText', 'setCharSpacing', 'setWordSpacing', 'setHScale',
    'setLeading', 'setFont', 'setTextRise', 'moveText', 'setLeadingMoveText',
    'setTextMatrix', 'nextLine', 'showText', 'showSpacedText',
    'nextLineShowText', 'nextLineSetSpacingShowText',
    'setStrokeGray', 'setFillGray', 'setStrokeRGBColor', 'setFillRGBColor',
    'setStrokeCMYKColor', 'setFillCMYKColor',
  ].map(name => OPS[name]).filter(Number.isInteger));
  for (let index = 0; index < operatorList.fnArray.length; index++) {
    const op = operatorList.fnArray[index], args = operatorList.argsArray[index] ?? [];
    if (op === OPS.setTextRenderingMode) {
      if (Number(args[0]) !== 0) return false;
    } else if (op === OPS.setGState) {
      // Only explicit opaque/default compositing is understood. Unknown
      // extended state (including soft masks and transfer functions) is not
      // evidence that a crop contains only its witnessed glyphs.
      if (!Array.isArray(args[0]) || args[0].some(([key, value]) =>
        !((key === 'ca' || key === 'CA') && value === 1 ||
          key === 'BM' && (value === 'Normal' || value === 'source-over')))) return false;
    } else if (!allowed.has(op)) return false;
  }
  return true;
}

/** Certify a unique full matching from every base resident line to a
 * canonical SyncTeX line hbox. Candidate order and page order are irrelevant. */
export function certifyCanonicalBlock({ witnesses, candidates, paintPages }) {
  if (!Array.isArray(witnesses) || !witnesses.length || !Array.isArray(candidates) ||
      !Array.isArray(paintPages) || paintPages.some((page) => !page)) return null;
  const pageItems = new Map(paintPages.map((page) => [Number(page.page), page.items ?? []]));
  const physical = dedupeCandidates(candidates).map((candidate, candidateIndex) => ({
    candidateIndex,
    candidate,
    pageItems: pageItems.get(Number(candidate.page)) ?? [],
  }));
  const edges = witnesses.map((witness) => physical
    .filter((entry) => candidateMatchesWitness(entry.candidate, entry.pageItems, witness))
    .map((entry) => entry.candidateIndex));
  if (edges.some((options) => !options.length)) return null;
  // SyncTeX reports one line through several enclosing boxes that differ
  // only vertically; a matched line keeps its page, baseline and horizontal
  // extent and takes its height from the witness, so those are one slot.
  // Uniqueness is decided between slots, not between their reports.
  const slotIds = new Map();
  const slotOf = physical.map((entry) => {
    const key = lineSlotKey(entry.candidate);
    if (!slotIds.has(key)) slotIds.set(key, slotIds.size);
    return slotIds.get(key);
  });
  const slotEdges = edges.map((options) => [...new Set(options.map((index) => slotOf[index]))]);
  const matching = uniquePerfectMatching(slotEdges, slotIds.size);
  if (!matching) return null;
  return matching.map((slot, lineIndex) => ({
    lineIndex,
    candidate: canonicalLineCandidate(
      physical[edges[lineIndex].find((index) => slotOf[index] === slot)].candidate,
      witnesses[lineIndex]
    ),
  }));
}

function lineSlotKey(candidate) {
  return [candidate.page, candidate.y, candidate.box.left, candidate.box.right]
    .map((value) => Number(value).toFixed(3)).join(':');
}

export function candidateMatchesWitness(candidate, pageItems, witness) {
  const box = candidate?.box;
  const baseline = Number(candidate?.y);
  if (!validBox(box) || !Number.isFinite(baseline)) return false;
  const lineTop = baseline - witness.height;
  const lineBottom = baseline + witness.depth;
  // SyncTeX often reports the enclosing column vbox rather than the leaf
  // line hbox (H can span nearly the whole page), while its x/y point is the
  // exact source line baseline and h/W are the exact horizontal line box.
  // Accept only an enclosing vertical box, then normalize it to the resident
  // line envelope after the PDF paint witness proves the baseline contents.
  if (!sameNumber(box.right - box.left, witness.lineWidth, BOX_TOLERANCE_BP) ||
      box.top > lineTop + BOX_TOLERANCE_BP || box.bottom < lineBottom - BOX_TOLERANCE_BP) return false;
  const inside = pageItems.filter((item) =>
    item?.safe && Math.abs(Number(item.baseline) - baseline) <= BASELINE_TOLERANCE_BP &&
    Number(item.left) >= box.left - BOX_TOLERANCE_BP &&
    Number(item.right) <= box.right + BOX_TOLERANCE_BP
  ).sort((left, right) => left.left - right.left);
  if (!inside.length) return false;
  for (let index = 1; index < inside.length; index++) {
    if (inside[index].left < inside[index - 1].right - BOX_TOLERANCE_BP) return false;
  }
  const paintText = inside.map((item) => item.paintText).join('');
  const glyphSizes = inside.flatMap((item) => item.glyphSizes);
  if (paintText !== witness.paintText || glyphSizes.length !== witness.glyphCount) return false;
  if (glyphSizes.some((size, index) => !sameNumber(size, witness.glyphSizes[index], FONT_SIZE_TOLERANCE_BP))) {
    return false;
  }
  // The resident follows the color stack only inside hboxes: a push in
  // vertical mode (before a paragraph, or in an earlier block) fills the
  // canonical line but never reaches its runs, which a repaint would use.
  const glyphColors = inside.flatMap((item) => item.glyphColors ?? []);
  if (glyphColors.length !== witness.glyphCount ||
      glyphColors.some((color, index) => !color || color !== witness.glyphColors?.[index])) return false;
  const contentLeft = inside[0].left - box.left;
  const contentRight = inside.at(-1).right - box.left;
  return sameNumber(contentLeft, witness.contentLeft, CONTENT_TOLERANCE_BP) &&
    sameNumber(contentRight, witness.contentRight, CONTENT_TOLERANCE_BP);
}

function canonicalLineCandidate(candidate, witness) {
  const baseline = Number(candidate.y);
  return {
    ...candidate,
    box: {
      left: Number(candidate.box.left),
      top: baseline - witness.height,
      right: Number(candidate.box.right),
      bottom: baseline + witness.depth,
    },
  };
}

function operatorGlyphs(operatorList, OPS) {
  let fontSize = NaN;
  let textMode = 0;
  let formDepth = 0;
  let markedDepth = 0;
  let clipped = false;
  // The page starts black. pdf.js converts every fill color it can to
  // setFillRGBColor; any other fill op (a pattern, transparent) leaves the
  // color unknown, and an unknown color matches no witness.
  let fillColor = BLACK;
  const fillOps = new Set(['setFillColorSpace', 'setFillColor', 'setFillColorN', 'setFillGray',
    'setFillRGBColor', 'setFillCMYKColor', 'setFillTransparent'].map((name) => OPS[name]).filter(Number.isInteger));
  const stack = [];
  const formColors = []; // the canvas saves the graphics state around a form
  const glyphs = [];
  for (let index = 0; index < operatorList.fnArray.length; index++) {
    const op = operatorList.fnArray[index];
    const args = operatorList.argsArray[index] ?? [];
    if (op === OPS.save) stack.push({ clipped, formDepth, markedDepth, textMode, fontSize, fillColor });
    else if (op === OPS.restore) {
      const state = stack.pop();
      if (!state) return null;
      ({ clipped, formDepth, markedDepth, textMode, fontSize, fillColor } = state);
    } else if (op === OPS.setFont) {
      fontSize = Number(args[1]);
    } else if (op === OPS.setTextRenderingMode) {
      textMode = Number(args[0]);
    } else if (fillOps.has(op)) {
      fillColor = op === OPS.setFillRGBColor ? pdfFillColor(args[0]) : null;
    } else if (op === OPS.clip || op === OPS.eoClip) {
      clipped = true;
    } else if (op === OPS.paintFormXObjectBegin) {
      formDepth++;
      formColors.push(fillColor);
    } else if (op === OPS.paintFormXObjectEnd) {
      formDepth = Math.max(0, formDepth - 1);
      if (formColors.length) fillColor = formColors.pop();
    } else if (op === OPS.beginMarkedContent || op === OPS.beginMarkedContentProps) {
      markedDepth++;
    } else if (op === OPS.endMarkedContent) {
      markedDepth = Math.max(0, markedDepth - 1);
    } else if (op === OPS.showText) {
      const sequence = Array.isArray(args[0]) ? args[0] : [];
      if (!Number.isFinite(fontSize) || fontSize <= 0) return null;
      for (const glyph of sequence) {
        if (!glyph || typeof glyph !== 'object') continue; // kerning/glue has no paint
        const raw = String(glyph.unicode ?? '').normalize('NFC');
        if (!raw || glyph.isSpace || /^\s+$/u.test(raw)) continue;
        const chars = Array.from(raw);
        const simpleGlyph = chars.length === 1 && !UNSAFE_TEXT.test(raw);
        for (const char of chars) {
          glyphs.push({
            char,
            size: fontSize,
            color: fillColor,
            safe: simpleGlyph && textMode === 0 && formDepth === 0 && markedDepth === 0 && !clipped &&
              glyph.isInFont !== false && !glyph.accent && !glyph.operatorListId,
          });
        }
      }
    }
  }
  return stack.length || formDepth || markedDepth ? null : glyphs;
}

function pdfFillColor(value) {
  const color = typeof value === 'string' ? value.toLowerCase() : '';
  if (!/^#[0-9a-f]{6}$/u.test(color)) return null;
  return color === PDFJS_CMYK_BLACK ? BLACK : color;
}

function uniquePerfectMatching(edges, candidateCount) {
  const first = findPerfectMatching(edges, candidateCount, null);
  if (!first) return null;
  for (let line = 0; line < first.length; line++) {
    if (findPerfectMatching(edges, candidateCount, { line, candidate: first[line] })) return null;
  }
  return first;
}

function findPerfectMatching(edges, candidateCount, forbidden) {
  const owner = Array(candidateCount).fill(-1);
  const visit = (line, seen) => {
    for (const candidate of edges[line]) {
      if (forbidden?.line === line && forbidden.candidate === candidate || seen.has(candidate)) continue;
      seen.add(candidate);
      if (owner[candidate] < 0 || visit(owner[candidate], seen)) {
        owner[candidate] = line;
        return true;
      }
    }
    return false;
  };
  for (let line = 0; line < edges.length; line++) {
    if (!visit(line, new Set())) return null;
  }
  const result = Array(edges.length).fill(-1);
  owner.forEach((line, candidate) => {
    if (line >= 0) result[line] = candidate;
  });
  return result.every((candidate) => candidate >= 0) ? result : null;
}

function dedupeCandidates(candidates) {
  const seen = new Set();
  const out = [];
  for (const candidate of candidates) {
    if (!validBox(candidate?.box) || !Number.isInteger(Number(candidate?.page)) || !Number.isFinite(Number(candidate?.y))) {
      continue;
    }
    const key = [candidate.page, candidate.y, candidate.box.left, candidate.box.top,
      candidate.box.right, candidate.box.bottom].map((value) => Number(value).toFixed(3)).join(':');
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(candidate);
  }
  return out;
}

function stableLineSignature(item, profileKey) {
  return JSON.stringify([
    profileKey,
    item.w,
    item.h,
    item.d,
    (item.runs ?? []).map(stableRunLayoutRecord),
  ]);
}

function simpleHorizontalMatrix(matrix) {
  if (!Array.isArray(matrix) || matrix.length !== 6 || !matrix.every(Number.isFinite)) return false;
  const [a, b, c, d] = matrix;
  return a > 0 && d < 0 && Math.abs(b) <= EPSILON && Math.abs(c) <= EPSILON;
}

function validBox(box) {
  return box && [box.left, box.top, box.right, box.bottom].every(Number.isFinite) &&
    box.right > box.left && box.bottom > box.top;
}

function sameNumber(left, right, tolerance) {
  return Number.isFinite(Number(left)) && Number.isFinite(Number(right)) &&
    Math.abs(Number(left) - Number(right)) <= tolerance;
}
