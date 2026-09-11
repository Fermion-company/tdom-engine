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
  if (painted.length !== extractedGlyphs.length) return null;
  for (let index = 0; index < painted.length; index++) {
    const paint = painted[index];
    const extracted = extractedGlyphs[index];
    if (paint.char !== extracted.char) return null;
    extracted.item.glyphSizes.push(paint.size);
    extracted.item.glyphColors.push(paint.color);
    extracted.item.safe &&= paint.safe;
  }
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
  const matching = uniquePerfectMatching(edges, physical.length);
  if (!matching) return null;
  return matching.map((candidateIndex, lineIndex) => ({
    lineIndex,
    candidate: canonicalLineCandidate(physical[candidateIndex].candidate, witnesses[lineIndex]),
  }));
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
