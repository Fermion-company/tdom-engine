// A click on an inline formula of a canonical page is resolved through
// SyncTeX's source line. In some paragraphs SyncTeX answers the line that
// ended the paragraph instead of the formula's own (seen where a verbatim
// macro stands in the same paragraph), and the click opened nothing. The
// viewer then finds the formula by its ink (web/app.js inlineMathUnderPoint):
// the paragraph's formulas, each printed as often as the source has it,
// paired in reading order with the source's. This runs that function with
// stand-ins for the math field and the glyph matcher; SyncTeX's part is the
// answer it already gave for the click (the line, and the boxes that carry it).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const app = readFileSync(new URL('../web/app.js', import.meta.url), 'utf8');
const start = app.indexOf('function sourceNearLine(');
const SOURCE = app.slice(start, app.indexOf('\n}\n', app.indexOf('async function inlineMathBoundsByInk(')) + 3);

const FILE = '/doc/chapter.tex';
const glyph = (text, left, top) => ({ text, left, right: left + 5, top, bottom: top + 8 });
const math = (id, value, line, column) => ({ id, kind: 'math', value, source: { file: FILE,
  start: { line, column }, end: { line, column: column + value.length + 2 } } });
const text = (id, value, line) => ({ id, kind: 'text', value, source: { file: FILE, start: { line, column: 1 }, end: { line, column: 1 + value.length } } });
const block = (id, from, to, editRegions) => ({ id, source: { file: FILE, start: { line: from, column: 1 }, end: { line: to, column: 40 } }, editRegions });

// `printed`: formula value -> the copies of it printed on the page (each a list of glyphs)
function viewer({ printed, boxes = [] }) {
  const state = {
    window: { TdomDirectEditGeometry: {
      mathMaps: (field, glyphs, bounds) => (printed[field.value] ?? [])
        .filter((map) => map.every((g) => g.top >= bounds.top - 2 && g.bottom <= bounds.bottom + 2))
        .map((map) => ({ map, cost: 0 })),
      nearest: (map, point) => [...map].sort((a, b) =>
        Math.abs((a.left + a.right) / 2 - point.x) - Math.abs((b.left + b.right) / 2 - point.x))[0],
    } },
    customElements: { get: () => class { constructor() { this.style = {}; this.value = ''; } setAttribute() {} remove() {} } },
    document: { body: { appendChild() {} } },
    requestAnimationFrame: (run) => run(),
    shouldWrapAligned: () => false, wrapAligned: (value) => value,
    sameSourceFile: (a, b) => a === b,
    canonicalGlyphs: async () => Object.values(printed).flat(2),
    canonicalSourceEditBoxes: async (page, id, { source }) => source.end.line - source.start.line > 512 ? [] : boxes.filter(row => row.file === source.file &&
      row.page === page && row.line >= source.start.line && row.line <= source.end.line),
    // (a click brings SyncTeX's answer with it; following an open editor asks for one)
    reverse: null,
    fetch: async (url, options) => {
      assert.equal(url, '/synctex');
      state.asked = JSON.parse(options.body);
      return { ok: !!state.reverse, json: async () => state.reverse };
    },
  };
  vm.createContext(state);
  vm.runInContext(`${SOURCE}\nthis.find = inlineMathUnderPoint; this.follow = inlineMathBoundsByInk;`, state);
  return state;
}
// SyncTeX's answer for a click: the line, and the printed lines that carry it (on page 18 unless said otherwise)
const answer = (lineNumber, tops, extra = {}) => ({ file: FILE, line: lineNumber,
  anchors: tops.map((top) => ({ page: 18, box: line(top) })), ...extra });
const line = (top) => ({ left: 45, right: 453, top, bottom: top + 9 });
const still = () => true;

// The paragraph of the report: source lines 34-38 (its blank line included), printed on four lines; SyncTeX answers
// line 38 for a click on `$2$`, which is on line 36.
const paragraph = block('b112', 34, 38, [text('t1', 'グループを閉じるのは', 36), math('m1', '2', 36, 40), text('t2', 'のトークンです。', 36)]);
const four = [399, 412, 426, 440];
const two = [glyph('2', 214, 427)];

test('a formula SyncTeX names by the line that ended its paragraph is found by its ink', async () => {
  const v = viewer({ printed: { 2: [two] } });
  const blocks = [block('b111', 30, 32, []), paragraph, block('b113', 39, 41, [math('m9', '2', 40, 3)])];
  const found = await v.find({ blocks }, answer(38, four), 18, { x: 216, y: 431 }, 7, still);
  assert.equal(found.region.id, 'm1');
  assert.deepEqual(JSON.parse(JSON.stringify(found.printBounds)), { page: 18, left: 214, right: 219, top: 427, bottom: 435 });
  assert.deepEqual(JSON.parse(JSON.stringify(found.region.blockSource)), paragraph.source);
  // the paragraph's blank line outside the block (a block that ends on its last text line): the same
  const tight = block('b112', 34, 37, paragraph.editRegions);
  assert.equal((await v.find({ blocks: [tight] }, answer(38, four), 18, { x: 216, y: 431 }, 7, still)).region.id, 'm1');
  // a click beside the formula, on the same printed line: nothing
  assert.equal(await v.find({ blocks }, answer(38, four), 18, { x: 300, y: 431 }, 7, still), null);
  // a click outside the printed lines SyncTeX named: nothing
  assert.equal(await v.find({ blocks }, answer(38, four), 18, { x: 216, y: 520 }, 7, still), null);
  // no printed line named on this page, another file, a line far below the paragraph, a superseded page: nothing
  assert.equal(await v.find({ blocks }, { file: FILE, line: 38 }, 18, { x: 216, y: 431 }, 7, still), null);
  assert.equal(await v.find({ blocks }, { ...answer(38, four), anchors: four.map((top) => ({ page: 19, box: line(top) })) }, 18, { x: 216, y: 431 }, 7, still), null);
  assert.equal(await v.find({ blocks }, answer(38, four, { file: '/doc/other.tex' }), 18, { x: 216, y: 431 }, 7, still), null);
  assert.equal(await v.find({ blocks: [paragraph] }, answer(45, four), 18, { x: 216, y: 431 }, 7, still), null);
  assert.equal(await v.find({ blocks }, answer(38, four), 18, { x: 216, y: 431 }, 7, () => false), null);
});

test('something else printed like the formula leaves the click undecided', async () => {
  // a reference number that reads "2" on the paragraph's last printed line
  const v = viewer({ printed: { 2: [two, [glyph('2', 120, 441)]] } });
  for (const point of [{ x: 216, y: 431 }, { x: 122, y: 445 }]) {
    assert.equal(await v.find({ blocks: [paragraph] }, answer(38, four), 18, point, 7, still), null,
      'printed twice, in the source once: which copy is the formula is not known');
  }
  // the same glyph printed outside the lines SyncTeX named does not count
  const elsewhere = viewer({ printed: { 2: [two, [glyph('2', 120, 600)]] } });
  assert.equal((await elsewhere.find({ blocks: [paragraph] }, answer(38, four), 18, { x: 216, y: 431 }, 7, still)).region.id, 'm1');
});

test('the same formula twice in a paragraph: the copies are the source\'s formulas in reading order', async () => {
  const twice = block('b7', 10, 12, [math('first', 'x', 10, 5), math('second', 'x', 12, 9), math('other', 'x^2', 11, 3)]);
  const tops = [100, 114, 128];
  // printed: x on the first line, x^2 on the second, x on the third (given here out of order)
  const copies = { x: [[glyph('x', 300, 129)], [glyph('x', 80, 101)]], 'x^2': [[glyph('x', 200, 115), glyph('2', 205, 112)]] };
  const v = viewer({ printed: copies });
  const at = (point) => v.find({ blocks: [twice] }, answer(13, tops), 18, point, 7, still);
  assert.equal((await at({ x: 82, y: 105 })).region.id, 'first');
  assert.equal((await at({ x: 302, y: 133 })).region.id, 'second');
  assert.equal((await at({ x: 202, y: 119 })).region.id, 'other');
  // two on one printed line: from the left
  const sameLine = viewer({ printed: { x: [[glyph('x', 300, 101)], [glyph('x', 80, 101)]], 'x^2': copies['x^2'] } });
  assert.equal((await sameLine.find({ blocks: [twice] }, answer(13, tops), 18, { x: 302, y: 105 }, 7, still)).region.id, 'second');
});

test('a formula inside a larger one is not the formula clicked; display formulas are not looked at', async () => {
  const para = block('b3', 20, 21, [math('small', '2', 20, 5), math('big', 'x^2', 21, 5),
    { ...math('shown', 'E=mc^2', 21, 30), display: true }]);
  const tops = [200, 214];
  const big = [glyph('x', 150, 215), glyph('2', 155, 212)];
  const v = viewer({ printed: { 2: [[glyph('2', 90, 201)]], 'x^2': [big] } });
  const at = (point) => v.find({ blocks: [para] }, answer(22, tops), 18, point, 7, still);
  assert.equal((await at({ x: 92, y: 205 })).region.id, 'small');
  assert.equal((await at({ x: 157, y: 216 })).region.id, 'big');
  // a matcher that also finds `2` inside `x^2`: `2` is printed twice and in the source once, so only `x^2` can be told
  const nested = viewer({ printed: { 2: [[glyph('2', 90, 201)], [big[1]]], 'x^2': [big] } });
  assert.equal(await nested.find({ blocks: [para] }, answer(22, tops), 18, { x: 92, y: 205 }, 7, still), null);
  assert.equal((await nested.find({ blocks: [para] }, answer(22, tops), 18, { x: 157, y: 216 }, 7, still)).region.id, 'big');
  // a paragraph with no inline formula: nothing
  const plain = viewer({ printed: { a: [[glyph('a', 92, 201)]] } });
  assert.equal(await plain.find({ blocks: [block('b4', 20, 21, [text('t', 'words', 20), { ...math('shown', 'a', 21, 3), display: true }])] },
    answer(22, tops), 18, { x: 94, y: 205 }, 7, still), null);
});

test('equal formulas across an input follow expanded paragraph order', async () => {
  const parent = math('parent', 'y', 12, 20);
  const child = math('child', 'y', 1, 4);
  child.source.file = '/doc/study.tex';
  const para = { ...block('mixed', 12, 13, [parent, child]), type: 'paragraph', pages: [18],
    sourceRanges: [parent.source, child.source] };
  const v = viewer({ printed: { y: [[glyph('y', 80, 101)], [glyph('y', 300, 101)]] } });
  const location = { ...answer(1, [100]), file: child.source.file };
  const at = x => v.find({ blocks: [para] }, location, 18, { x, y: 105 }, 7, still);
  assert.equal((await at(82)).region.id, 'parent');
  assert.equal((await at(302)).region.id, 'child');
});

test('an editor opened by a formula\'s ink is followed into the next canonical pages by its ink', async () => {
  // the formula was `2`; the user typed, the source has `23` now and the new pages print it a little further right
  const typed = block('b112', 34, 38, [text('t1', 'グループを閉じるのは', 36), math('m1', '23', 36, 40), math('m2', 'x', 37, 5)]);
  const v = viewer({ printed: { 23: [[glyph('2', 220, 427), glyph('3', 225, 427)]], x: [[glyph('x', 100, 441)]] } });
  v.reverse = answer(38, four);
  const region = typed.editRegions[1];
  const bounds = await v.follow(region, { blocks: [typed] }, 9, { page: 18, x: 216, y: 431 });
  assert.deepEqual(JSON.parse(JSON.stringify(bounds)), { page: 18, left: 220, right: 230, top: 427, bottom: 435 });
  assert.deepEqual(JSON.parse(JSON.stringify(v.asked)), { page: 18, x: 216, y: 431, id: 9 }, 'asked of the new generation, where the formula stood');
  // the other formula of the paragraph, by its own place in the source
  assert.deepEqual(JSON.parse(JSON.stringify(await v.follow(typed.editRegions[2], { blocks: [typed] }, 9, { page: 18, x: 216, y: 431 }))),
    { page: 18, left: 100, right: 105, top: 441, bottom: 449 });
  // SyncTeX has no answer there, the formula is not printed where it names, a display formula, no place to ask at: null
  v.reverse = null;
  assert.equal(await v.follow(region, { blocks: [typed] }, 9, { page: 18, x: 216, y: 431 }), null);
  v.reverse = answer(38, [600, 613]);
  assert.equal(await v.follow(region, { blocks: [typed] }, 9, { page: 18, x: 216, y: 431 }), null);
  v.reverse = answer(38, four);
  assert.equal(await v.follow({ ...region, display: true }, { blocks: [typed] }, 9, { page: 18, x: 216, y: 431 }), null);
  assert.equal(await v.follow(region, { blocks: [typed] }, 9, { page: 18 }), null);
  assert.equal(await v.follow(text('t', 'words', 36), { blocks: [typed] }, 9, { page: 18, x: 216, y: 431 }), null);
});

test('a source-side formula preview requires the other files and bytes on the printed page to match', () => {
  const fn = name => {
    const first = app.indexOf('function ' + name + '(');
    return app.slice(first, app.indexOf('\n}', first) + 2);
  };
  const scope = { window: {} };
  vm.runInNewContext(readFileSync(new URL('../web/opaque-editor-coordinator.js', import.meta.url), 'utf8'), scope);
  const diff = vm.runInNewContext([fn('orderedSourceOffsets'), fn('sourceFormulaChangeState'), fn('changedSourceFormulas'),
    'changedSourceFormulas'].join('\n'), scope);
  function document(value, { prefix = '前', suffix = '後', otherFile = 'original' } = {}) {
    const start = prefix.length + 2;
    const region = { id: 'b1:m', kind: 'math', value, source: { file: FILE,
      start: { line: 1, column: start }, end: { line: 1, column: start + value.length } } };
    return { blocks: [{ id: 'b1', editRegions: [region] }], sources: [
      { file: FILE, text: prefix + '$' + value + '$' + suffix }, { file: 'master.tex', text: otherFile },
    ] };
  }
  const changed = (before, next) => diff(before, next, before.blocks)?.[0] ?? null;
  const before = document('x_{n}');
  const from = next => changed(before, next);
  assert.equal(from(document('x_{na}')).region.value, 'x_{na}');
  assert.equal(from(document('x_{na}', { prefix: '別' })), null);
  assert.equal(from(document('x_{na}', { suffix: '追記' })), null);
  assert.equal(from(document('x_{na}', { otherFile: 'changed' })), null);
  assert.equal(from(document('x_{n')).state, 'incomplete');
  assert.equal(from(document('x_{n\\sq}')).state, 'incomplete');
  assert.equal(from(document('x_{\\theta}')).region.value, 'x_{\\theta}');
  const equation = (letter, label) => document('H=\\frac{\\sqrt[3]{' + letter + '}}{z}\\label{' + label + '}');
  const printed = equation('q', 'eq:first');
  const edited = equation('qr', 'eq:first');
  assert.equal(changed(printed, edited).region.value, edited.blocks[0].editRegions[0].value);
  const renamed = equation('qr', 'eq:second');
  assert.equal(changed(printed, renamed), null);
  const unknown = document('\\fracwithsideeffects{x}{2}');
  assert.equal(changed(before, unknown), null);

  function pair(a, b, gap = ' と ') {
    const snapshot = document(a, { suffix: gap + '$' + b + '$' });
    const column = snapshot.sources[0].text.lastIndexOf('$' + b + '$') + 2;
    snapshot.blocks.push({ id: 'b2', editRegions: [{ id: 'b2:m', kind: 'math', value: b,
      source: { file: FILE, start: { line: 1, column }, end: { line: 1, column: column + b.length } } }] });
    return snapshot;
  }
  const base = pair('x', 'x'), both = pair('x_a', 'x_b');
  const changes = diff(base, both, base.blocks);
  assert.deepEqual(Array.from(changes, c => c.region.value), ['x_a', 'x_b']);
  assert.equal(diff(base, both, base.blocks.slice(1)), null, 'an unaccounted earlier edit');
  assert.equal(diff(base, pair('x_a', 'x_b', ' とも '), base.blocks), null, 'an edit between the formulas');
  assert.equal(diff(base, pair('x', 'x_b'), base.blocks).length, 1, 'one edit undone');
  const partial = diff(base, pair('x_a', 'x_{\\sq}'), base.blocks);
  assert.deepEqual(Array.from(partial, c => c.state), ['ready', 'incomplete']);
  const invalid = pair('x_a', 'x_b');
  invalid.blocks[1].editRegions[0].source.start.line = 2;
  assert.equal(diff(base, invalid, base.blocks), null, 'range points beyond the actual source line');

});

test('a macro degree attributed to the root resolves to its printed occurrence in the included file', async () => {
  const first = { ...block('b1', 5, 6, [math('first', '3', 5, 12)]), type: 'paragraph', pages: [18] };
  const second = { ...block('b2', 7, 8, [math('second', '3', 7, 12)]), type: 'paragraph', pages: [18] };
  const boxes = [5, 7].map((line, i) => ({ id: line, file: FILE, line, page: 18, empty: false,
    box: { left: 72, right: 300, top: 100 + i * 20, bottom: 111 + i * 20 } }));
  const v = viewer({ boxes, printed: { 3: [[glyph('3', 210, 101)], [glyph('3', 210, 121)]] } });
  const root = { file: '/doc/main.tex', line: 6, column: 1, anchors: [] };
  const at = y => v.find({ blocks: [first, second] }, root, 18, { x: 212, y }, 7, still);
  assert.equal((await at(104)).region.id, 'first');
  assert.equal((await at(124)).region.id, 'second');
  assert.equal(await at(115), null);
});

test('one formula in a long block of explicit paragraphs uses the printed source row', async () => {
  const count = 601, line = 540;
  const regions = Array.from({ length: count }, (_, n) => math('formula-' + (n + 1), 'q/z', n + 1, 6));
  const paragraph = { ...block('book', 1, count, regions), type: 'paragraph', pages: [] };
  const boxes = [{ id: 11, file: FILE, line, page: 18, box: { left: 150, right: 230, top: 212, bottom: 229 } }];
  const formula = [glyph('q', 200, 212), glyph('z', 200, 221)];
  const v = viewer({ boxes, printed: { 'q/z': [formula, [glyph('q', 200, 250), glyph('z', 200, 259)]] } });
  const res = await v.find({ blocks: [paragraph] }, answer(line, [212]), 18, { x: 202, y: 215 }, 7, still);
  assert.equal(res.region.id, 'formula-540');
  assert.equal(res.printBounds.bottom, 229);
});

test('a numerator hit wins over the padded hit area of the previous denominator', () => {
  const state = viewer({ printed: {} });
  vm.runInContext(readFileSync(new URL('../web/direct-edit-geometry.js', import.meta.url), 'utf8'), state);
  const extent = { left: 0, right: 100, top: 0, bottom: 40 };
  const copy = (id, top) => ({ region: { id }, extent,
    map: [glyph('q', 10, top), glyph('z', 10, top + 9)] });
  state.copies = [copy('first', 0), copy('second', 16)];
  const locate = vm.runInContext('y => inlineFormulaHit(copies, 18, { x: 12, y })?.region.id', state);
  assert.equal(locate(17.5), 'second');
  assert.equal(locate(16.5), undefined); // the two real glyph boxes overlap
});
