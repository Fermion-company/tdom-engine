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
const start = app.indexOf('async function inlineMathCopies(');
const SOURCE = app.slice(start, app.indexOf('\n}\n', app.indexOf('async function inlineMathBoundsByInk(')) + 3);

const FILE = '/doc/chapter.tex';
const glyph = (text, left, top) => ({ text, left, right: left + 5, top, bottom: top + 8 });
const math = (id, value, line, column) => ({ id, kind: 'math', value, source: { file: FILE,
  start: { line, column }, end: { line, column: column + value.length + 2 } } });
const text = (id, value, line) => ({ id, kind: 'text', value, source: { file: FILE, start: { line, column: 1 }, end: { line, column: 1 + value.length } } });
const block = (id, from, to, editRegions) => ({ id, source: { file: FILE, start: { line: from, column: 1 }, end: { line: to, column: 40 } }, editRegions });

// `printed`: formula value -> the copies of it printed on the page (each a list of glyphs)
function viewer({ printed }) {
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
