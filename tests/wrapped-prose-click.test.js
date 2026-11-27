import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';

const app = readFileSync(new URL('../web/app.js', import.meta.url), 'utf8');
const geometry = readFileSync(new URL('../web/direct-edit-geometry.js', import.meta.url), 'utf8');
function declaration(name) {
  const start = app.indexOf('function ' + name + '(');
  assert.notEqual(start, -1);
  return app.slice(start, app.indexOf('\n}', start) + 2);
}
const viewer = vm.createContext({ window: {} });
vm.runInContext([geometry, ...['printedKey', 'textMatchesOnPage', 'textOnParagraphRows'].map(declaration)].join('\n'), viewer);

// The punctuation cell hangs halfway past the measure. In a two-column
// document Poppler can return the other column's identical words first.
const row = (left, y) => ({ y, box: { left, right: left + 25 } });
const word = (text, left, baseline) => ({
  text, left, right: left + [...text].length * 10, top: baseline - 8, bottom: baseline + 2,
});
const letters = (w) => [...w.text].map((text, index) => ({
  ...w, text, left: w.left + index * 10, right: w.left + (index + 1) * 10, baseline: w.bottom - 2,
}));
const region = { value: '原稿、\n編集' };
const rightWords = [word('原稿、', 100, 17), word('編集', 100, 32)];
const words = [word('原稿、', 10, 17), word('編集', 10, 32), ...rightWords];
const rows = [row(100, 17), row(100, 32)];
const glyphs = words.flatMap(letters);
const locate = (nativeRows = rows, ink = glyphs, boxes = words) =>
  viewer.textOnParagraphRows(region, nativeRows, 1, ink, boxes);

test('a wrapped run retains its exact column and source offsets across a TeX newline', () => {
  const hit = locate();
  assert.equal(hit.printBounds.words[0], rightWords[0]);
  assert.equal(hit.printBounds.words[1], rightWords[1]);
  assert.deepEqual(Array.from(hit.map, g => g.start), [0, 1, 2, 4, 5]);
});

test('a repeated print, missing continuation, or different native baseline cannot own the edit', () => {
  assert.equal(locate([row(10, 17), row(10, 32), ...rows]), null);
  assert.equal(locate(rows.slice(0, 1)), null);
  assert.equal(locate(rows, glyphs.map(g => g.text === '編' ? { ...g, baseline: g.baseline + 1 } : g)), null);
});

test('a foreign glyph inside the word box prevents a match even when both word strings agree', () => {
  const foreign = { ...glyphs.at(-1), text: '外' };
  assert.equal(locate(rows, [...glyphs, foreign]), null);
});

function editAfterRedraw({ duplicate = false, stale = false } = {}) {
  const edited = { id: 'paragraph:1', kind: 'text', value: '原稿、\n再編集',
    source: { file: 'chapter.tex', start: { line: 3, column: 1 }, end: { line: 4, column: 4 } } };
  const baseMap = rightWords.flatMap(letters);
  const block = { id: 'paragraph', editRegions: duplicate ? [edited, { ...edited, id: 'other' }] : [edited] };
  const session = { pageNumber: 1, printedTextMap: { id: 5, map: baseMap }, glyphMap: baseMap, geometryValue: region.value };
  const svg = { isConnected: !stale, querySelectorAll: () => [{ dataset: { src: block.id }, hasAttribute: () => false }] };
  const state = vm.createContext({
    window: viewer.window, pageDivs: new Map([[1, { dataset: { canonPresentedId: '5' }, querySelector: () => svg }]]),
    directEditor: session, appliedSrcRev: 12, documentReset: { adoptedEpoch: 7 },
    loadProvisionalSnapshot: async () => ({ srcRev: 12, documentEpoch: 7, blocks: [block] }),
    directEditorRegionInSnapshot: () => edited,
    directSvgGeometry: () => ({ glyphs: letters(word('再編集', 100, 32)) }),
    paintDirectSelection() {}, alignOpaqueNativeCaretAnchor() {},
  });
  vm.runInContext([declaration('directSourceRangeKey'), declaration('printedKey'),
    'async ' + declaration('followTextAnchor')].join('\n'), state);
  return { session, follow: () => state.followTextAnchor(session, { baseGeneration: 5, srcRev: 12, blockId: block.id },
    { masks: [{ left: 98, top: 23, right: 132, bottom: 35 }] }) };
}

test('a current partial redraw joins the untouched first row to the new second row', async () => {
  const { session, follow } = editAfterRedraw();
  assert.equal(await follow(), true);
  assert.equal(session.geometryValue, '原稿、\n再編集');
  assert.deepEqual(Array.from(session.glyphMap, g => g.start), [0, 1, 2, 4, 5, 6]);
  assert.equal(session.printedTextMap.map.at(-1).left, 110);
  assert.equal(session.glyphMap.at(-1).left, 120);
});

test('a removed redraw or duplicate literal never overwrites the focused text map', async () => {
  for (const options of [{ stale: true }, { duplicate: true }]) {
    const { session, follow } = editAfterRedraw(options);
    assert.equal(await follow(), false);
    assert.equal(session.glyphMap, session.printedTextMap.map);
  }
});
