import { test } from 'node:test';
import assert from 'node:assert/strict';
import '../web/direct-edit-geometry.js';

const { isolatedFormulaSlot } = globalThis.TdomDirectEditGeometry;
const paper = { width: 600, height: 800 };
const map = [{ left: 100, right: 107, top: 41, bottom: 52, baseline: 50 }];
const glyph = { x: 100, y: 50, left: 100.5, right: 105.2, top: 44, bottom: 50, color: '#111', editable: true };
const rule = { left: 90, right: 116, top: 58, bottom: 59 };
const slot = (shapes, viewport = paper) => isolatedFormulaSlot({ ...viewport, shapes }, map, paper);

test('pending formula stops before the actual outline of adjacent punctuation', () => {
  const punctuation = { x: 106, y: 50, left: 109.8, right: 112, top: 47, bottom: 50 };
  const result = slot([glyph, rule, punctuation]);
  assert.equal(result.foreground, glyph.color);
  assert.equal(result.rect.right, punctuation.left - 0.25);
  assert.ok(result.rect.left < glyph.left && result.rect.top < glyph.top && result.rect.bottom > glyph.bottom);
});

test('a crossing rule or another copy at the same origin prevents repainting', () => {
  assert.equal(slot([glyph, { ...rule, top: 46, bottom: 47 }]), null);
  assert.equal(slot([glyph, { ...glyph }]), null);
});

test('only glyphs from the matching viewport with editable paint are used', () => {
  assert.equal(slot([{ ...glyph, editable: false }]), null);
  assert.equal(slot([glyph], { ...paper, height: 802 }), null);
  assert.equal(slot([{ ...glyph, x: 102 }]), null);
});

test('a centered fraction bar belongs to its two mapped branches only', () => {
  const upper = { ...map[0], start: 1, end: 2 };
  const lower = { ...upper, top: 52, bottom: 60, baseline: 58, start: 3, end: 4 };
  const model = [{ type: 'first' }, { type: 'first' },
    { type: 'mord', parentOffset: 5, parentBranch: 'above' }, { type: 'first' },
    { type: 'mord', parentOffset: 5, parentBranch: 'below' }, { type: 'genfrac', command: '\\frac' }];
  const field = { lastOffset: 5, getModelMetadata: () => model };
  const mapped = [upper, lower];
  const fractions = globalThis.TdomDirectEditGeometry.printedMathStructures(field, mapped);
  assert.equal(fractions.length, 1);
  const denominator = { ...glyph, y: 58, top: 53, bottom: 58 };
  const bar = { left: 100, right: 107, top: 51, bottom: 51.4, rule: true, color: glyph.color };
  const underTest = (lines, expected = fractions) => isolatedFormulaSlot(
    { ...paper, shapes: [glyph, denominator, ...lines] }, mapped, paper, expected);
  assert.ok(underTest([bar]));
  assert.equal(underTest([bar], []), null);
  assert.equal(underTest([bar, { ...bar, top: 53, bottom: 53.4 }]), null);
  assert.equal(underTest([{ ...bar, right: 140 }]), null);
  assert.equal(underTest([{ ...bar, color: 'red' }]), null);
  model[5] = { type: 'genfrac', command: '\\atop' };
  assert.deepEqual(globalThis.TdomDirectEditGeometry.printedMathStructures(field, mapped), []);
});

test('tightly spaced rows can share font metrics but not printed outlines', () => {
  const previous = { left: 100, right: 106, top: 38, bottom: 41.2 };
  const next = { left: 100, right: 106, top: 52, bottom: 56 };
  const result = slot([glyph, previous, next]);
  assert.equal(result.rect.top, previous.bottom + 0.25);
  assert.equal(result.rect.bottom, next.top - 0.25);
  assert.equal(slot([glyph, { ...previous, bottom: 44.1 }]), null);
});

test('a displayed expression keeps its measured alignment clear of the equation number', () => {
  const row = { left: 100, right: 107, top: 40, bottom: 53 };
  const centered = { ...row, left: 74, right: 133 };
  const number = { left: 125, right: 132, top: 43, bottom: 51 };
  const get = (rows, extra = []) => isolatedFormulaSlot(
    { ...paper, shapes: [glyph, number, ...extra] }, map, paper, [], rows);
  const result = get([centered, row]);
  assert.equal(result.centered, true);
  assert.equal(result.rect.right, number.left - 0.25);
  assert.equal(result.center, (row.left + row.right) / 2);
  const flush = get([row, { ...centered, left: 96 }]);
  assert.equal(flush.centered, false);
  assert.ok(flush.rect.left >= row.left && flush.rect.left < glyph.left);
  assert.equal(get([centered]), null);
  assert.equal(get([]), null);
  assert.equal(get([row, centered], [{ left: 106, right: 106.6, top: 45, bottom: 47 }]), null);
});

test('column-only SyncTeX needs every visible atom and excludes label and tag payloads', () => {
  const atoms = [{ type: 'first' }, { type: 'mord', symbol: 'q' },
    { type: 'mord', symbol: 'q', parentOffset: 3 }, { type: 'mord', command: '\\label' },
    { type: 'mord', symbol: 'A', parentOffset: 5 }, { type: 'mord', command: '\\tag' }];
  const field = { lastOffset: atoms.length - 1, getModelMetadata: () => atoms };
  const mapped = [{ ...map[0], end: 1 }];
  const complete = globalThis.TdomDirectEditGeometry.completeDisplayMap;
  assert.ok(complete(field, mapped));
  assert.equal(complete(field, [{ ...map[0], end: 2 }]), false);
  assert.equal(complete(field, [...mapped, { ...map[0], end: 4 }]), false);
  const column = { left: 80, right: 180, top: 35, bottom: 55 };
  const index = { ...paper, shapes: [glyph] };
  assert.equal(isolatedFormulaSlot(index, mapped, paper, [], [column]), null);
  assert.equal(isolatedFormulaSlot(index, mapped, paper, [], [column], complete(field, mapped)).centered, false);
  atoms.push({ type: 'accent' });
  assert.equal(complete(field, mapped), false);
});

test('a hanging tag can identify the left edge of a centered TeX column', () => {
  const row = { left: 100, right: 107, top: 40, bottom: 53 };
  const number = { left: 74.4, right: 81, top: 43, bottom: 51 };
  const rows = [row, { ...row, left: 74, right: 81.5 }, { ...row, left: 50, right: 133 }];
  const index = { ...paper, shapes: [glyph, number] };
  const result = isolatedFormulaSlot(index, map, paper, [], rows);
  assert.equal(result.centered, true);
  assert.equal(result.rect.left, number.right + 0.25);
  assert.equal(result.rect.right, 133);
  assert.equal(result.center, (row.left + row.right) / 2);
});

test('repainting a radical requires its PDF sign and a single bar touching the sign and covering its body', () => {
  const body = { text: 'x', left: 100, right: 107, top: 41, bottom: 52, baseline: 50, start: 1, end: 2 };
  const sign = { text: '√', left: 92, right: 100, top: 35, bottom: 45, baseline: 40.4 };
  const head = { left: 92.7, right: 100.2, top: 40, bottom: 51, x: 92, y: 40.4, color: glyph.color, editable: true };
  const bar = { left: 100, right: 107.2, top: 40, bottom: 40.4, color: glyph.color, rule: true };
  const model = [{ type: 'first' }, { type: 'first' }, { type: 'mord', parentOffset: 3, parentBranch: 'body' },
    { type: 'surd', command: '\\sqrt' }];
  const field = { lastOffset: 3, getModelMetadata: () => model }, map = [body];
  const get = (shapes, signs = [sign]) => isolatedFormulaSlot({ ...paper, shapes: [glyph, ...shapes] }, map, paper,
    globalThis.TdomDirectEditGeometry.printedMathStructures(field, map, signs));
  assert.ok(get([head, bar]).rect.left < head.left);
  assert.equal(get([head, bar], []), null);
  const previousSign = { ...sign, baseline: sign.baseline - 16 };
  const previousHead = { ...head, y: head.y - 16, top: head.top - 16, bottom: head.bottom - 16 };
  const previousBar = { ...bar, top: bar.top - 16, bottom: bar.bottom - 16 };
  assert.ok(get([head, bar, previousHead, previousBar], [previousSign, sign]));
  assert.equal(get([previousHead, previousBar], [previousSign]), null);
  assert.equal(get([head, bar, { ...bar }]), null);
  assert.equal(get([head, { ...bar, right: 103 }]), null);
  assert.equal(get([head, { ...bar, top: 42, bottom: 42.4 }]), null);
  assert.equal(get([{ ...head, color: 'red' }, bar]), null);
});

test('an inline radical does not borrow its index from Japanese prose before another radical', () => {
  const box = (text, left, top) => ({ text, left, right: left + 4, top, bottom: top + 5, width: 4 });
  const atoms = [box('3', 2, 0), box('q', 8, 2), box('z', 5, 10)];
  const field = { lastOffset: atoms.length, getElementInfo(offset) {
    const g = atoms[offset - 1];
    return { symbol: g.text, beforeOffset: offset - 1, glyphBounds: g };
  } };
  const printed = [box('3', 15, 7), box('で', 22, 7), box('5', 40, 0), box('√', 40, 1),
    box('q', 46, 2), box('z', 43, 10), box('と', 54, 6), box('3', 70, 0),
    box('√', 70, 1), box('q', 76, 2), box('z', 73, 10)];
  const result = globalThis.TdomDirectEditGeometry.mathMaps(field, printed,
    { left: 0, right: 100, top: 0, bottom: 20 }, { contiguous: true });
  assert.deepEqual(result.map(copy => copy.map.map(g => g.left)), [[70, 76, 73]]);
});

test('a table click and a source edit select the same printed cell by its contents', () => {
  const region = (column, line) => ({ tableColumn: column, tableColumns: 2,
    source: { start: { line }, end: { line } } });
  const a = region(0, 21), b = region(1, 22);
  const rows = new Map([[1, [a, b]], [2, [region(0, 23), region(1, 23)]]]);
  const box = (left, right) => ({ left, right, top: 100, bottom: 112 });
  const boxes = [
    { id: 1, line: 23, parentKind: 'vbox', box: box(10, 110) },
    { id: 2, line: 21, parentId: 1, ancestors: [1], parentKind: 'hbox', parentChildCount: 2, box: box(10, 50) },
    { id: 3, line: 23, parentId: 1, ancestors: [1], parentKind: 'hbox', parentChildCount: 2, box: box(50, 110) },
    { id: 4, line: 22, parentId: 3, ancestors: [1, 3], parentKind: 'hbox', parentChildCount: 1, box: box(80, 90) },
  ];
  const locate = globalThis.TdomDirectEditGeometry.locateTableCell;
  const click = { point: { x: 85, y: 105 } };
  const expected = { regions: [b], box: boxes[2].box };
  assert.deepEqual(locate(rows, boxes, click), expected);
  assert.deepEqual(locate(rows, boxes, { region: b }), expected);
  assert.equal(locate(rows, boxes, { point: { x: 85, y: 113 } }), null);
  assert.equal(locate(rows, boxes.slice(0, 2), { region: a }), null);
  rows.set(3, [region(0, 21), region(1, 22)]);
  assert.equal(locate(rows, boxes, click), null);
  assert.equal(locate(rows, boxes, { region: b }), null);
});

test('a multicolumn region includes its empty alignment box and stops at the next cell', () => {
  const region = (column, span) => ({ tableColumn: column, tableColumns: 3, tableSpan: span,
    source: { start: { line: 8 }, end: { line: 8 } } });
  const merged = region(0, 2), next = region(2, 1), rows = new Map([[1, [merged, next]]]);
  const box = (left, right) => ({ left, right, top: 100, bottom: 112 });
  const boxes = [{ id: 1, line: 9, parentKind: 'vbox', box: box(10, 90) },
    ...[box(10, 30), box(30, 50), box(50, 90)].map((b, i) => ({
      id: i + 2, parentId: 1, ancestors: [1], parentKind: 'hbox', parentChildCount: 3,
      empty: i === 1, line: 8, box: b,
    }))];
  const locate = globalThis.TdomDirectEditGeometry.locateTableCell;
  assert.deepEqual(locate(rows, boxes, { point: { x: 45, y: 106 } }), { regions: [merged], box: box(10, 50) });
  assert.deepEqual(locate(rows, boxes, { region: next }), { regions: [next], box: box(50, 90) });
  boxes[2].empty = false;
  assert.equal(locate(rows, boxes, { region: merged }), null);
});

test('a live table maps a raised inner formula in PDF paint order, with every glyph accounted for', () => {
  const { tablePaintRuns, tablePaintHit } = globalThis.TdomDirectEditGeometry;
  const box = (text, x, y) => ({ text, left: x, right: x + 6, top: y, bottom: y + 6, baseline: y + 5 });
  const ink = [box('A', 10, 30), box('x', 30, 30), box('n', 36, 33),
    box('B', 55, 18), box('x', 70, 18), box('n', 76, 21)];
  const field = { lastOffset: 2, getElementInfo: i => ({ symbol: i === 1 ? 'x' : 'n', beforeOffset: i - 1,
    bounds: { ...ink[i], width: 6 } }) };
  const regions = ['A', 'xn', 'B', 'xn'].map(value => ({ value }));
  const ranges = new Map(regions.map(r => [r, new Map(tablePaintRuns(r.value, r.value === 'xn' ? field : null, ink)
    .map(run => [run.start, run]))]));
  const point = { x: 79, y: 24 };
  assert.equal(tablePaintHit(regions, ink, ranges, point)?.region, regions[3]);
  assert.equal(tablePaintHit(regions, [...ink, box('!', 100, 50)], ranges, point), undefined);
  assert.equal(tablePaintHit([regions[2], ...regions.slice(0, 2), regions[3]], ink, ranges, point), undefined);
  const separated = [ink[1], box('+', 34, 30), ink[2]];
  assert.deepEqual(tablePaintRuns('xn', field, separated), []);
});

test('literal code adjacent to a cell identifies the table but cannot receive its edit', () => {
  const { tablePaintRuns, tablePaintHit } = globalThis.TdomDirectEditGeometry;
  const ink = ['A', 'B', 'A'].map((text, index) => ({ text, left: index * 6, right: (index + 1) * 6, top: 10, bottom: 16 }));
  const region = { value: 'B', tableLiteralBefore: 'A', tableLiteralAfter: 'A' };
  const runs = new Map([[region, new Map(tablePaintRuns('B', null, ink).map(run => [run.start, run]))]]);
  assert.equal(tablePaintHit([region], ink, runs, { x: 8, y: 13 })?.region, region);
  assert.equal(tablePaintHit([region], ink, runs, { x: 12.5, y: 13 }), null);
  assert.equal(tablePaintHit([region], ink, runs, { x: 5.5, y: 13 }), null);
  region.tableLiteralAfter = 'C';
  assert.equal(tablePaintHit([region], ink, runs, { x: 8, y: 13 }), undefined);
});
