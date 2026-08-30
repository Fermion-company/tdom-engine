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

export const PDF_PAINT_INDEX_VERSION = 1;

/** Freeze the visible resident lines before the first edit against a
 * canonical generation. Spaces are TeX glue, not painted glyphs, so the
 * witness keeps the exact painted glyph sequence and its advance interval. */
export function galleyLineWitnesses(galley) {
  const boxes = (galley?.items ?? []).filter((item) => item?.k === 'box');
  if (!boxes.length) return null;
  const profileKey = residentBackendProfileKey(galley?.backend);
  const lines = [];
  for (let index = 0; index < boxes.length; index++) {
    const item = boxes[index];
    const runs = item.runs ?? [];
    if (!runs.length) return null;
    const glyphs = [];
    let contentLeft = Infinity;
    let contentRight = -Infinity;
    for (const run of runs) {
      const semantics = classifyResidentRun(run, galley?.backend);
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
      for (const char of Array.from(text)) {
        if (/\s/u.test(char)) return null; // a painted space is ambiguous with synthesized extraction space
        glyphs.push({ char, size, font: String(run.f ?? '') });
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
    lines.push({
      index,
      paintText: glyphs.map((glyph) => glyph.char).join(''),
      glyphCount: glyphs.length,
      glyphSizes: glyphs.map((glyph) => glyph.size),
      glyphFonts: glyphs.map((glyph) => glyph.font),
      lineWidth,
      height,
      depth,
      contentLeft,
      contentRight,
      contentWidth: contentRight - contentLeft,
      signature: stableLineSignature(item, profileKey),
    });
  }
  return lines;
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
 * glyph identity/safety; TextContent owns the final page-space geometry.
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
    extracted.item.safe &&= paint.safe;
  }
  if (items.some((item) => item.glyphSizes.length !== Array.from(item.paintText).length)) return null;
  return { page: pageNumber, items };
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
  const stack = [];
  const glyphs = [];
  for (let index = 0; index < operatorList.fnArray.length; index++) {
    const op = operatorList.fnArray[index];
    const args = operatorList.argsArray[index] ?? [];
    if (op === OPS.save) stack.push({ clipped, formDepth, markedDepth, textMode, fontSize });
    else if (op === OPS.restore) {
      const state = stack.pop();
      if (!state) return null;
      ({ clipped, formDepth, markedDepth, textMode, fontSize } = state);
    } else if (op === OPS.setFont) {
      fontSize = Number(args[1]);
    } else if (op === OPS.setTextRenderingMode) {
      textMode = Number(args[0]);
    } else if (op === OPS.clip || op === OPS.eoClip) {
      clipped = true;
    } else if (op === OPS.paintFormXObjectBegin) {
      formDepth++;
    } else if (op === OPS.paintFormXObjectEnd) {
      formDepth = Math.max(0, formDepth - 1);
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
            safe: simpleGlyph && textMode === 0 && formDepth === 0 && markedDepth === 0 && !clipped &&
              glyph.isInFont !== false && !glyph.accent && !glyph.operatorListId,
          });
        }
      }
    }
  }
  return stack.length || formDepth || markedDepth ? null : glyphs;
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
