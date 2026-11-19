// What a keystroke re-reads for every block of a long document is kept per
// block; these results must stay what a fresh computation gives.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { segmentBody, diffBlocks } from '../engine/segmenter.js';
import { expandIncludes } from '../engine/checkpoint/include-expander.js';
import {
  buildDomSnapshot, domEntriesDifferInPlaceOnly, domEntryLinesMovedBy, filesOfRegions, serializeDomBlock,
} from '../engine/checkpoint/inspector.js';
import { instrumentEditRegions } from '../engine/edit-regions.js';

const lineStarts = (text) => {
  const starts = [0];
  for (let at = text.indexOf('\n'); at >= 0; at = text.indexOf('\n', at + 1)) starts.push(at + 1);
  return starts;
};
const positionIn = (text) => {
  const starts = lineStarts(text);
  return (_file, offset) => {
    let line = 0;
    while (line + 1 < starts.length && starts[line + 1] <= offset) line++;
    return { line: line + 1, column: offset - starts[line] + 1 };
  };
};
// A snapshot that keeps nothing between two calls…
const fresh = (blocks, text, pages = []) => buildDomSnapshot({
  rev: 1, srcRev: 1, backendName: 'test', mode: 'structured', modeReasons: [], previewPolicy: 'structured',
  previewReasons: [], canonicalInfo: {}, pages, checkpoints: new Map(), blocks, chunkTargets: () => [],
  file: '/doc/main.tex', position: positionIn(text), labelTable: new Map(), preambleEditRegions: [],
});
// …and one that keeps what the engine keeps: the line starts of the root
// file to check a block's place against, and a memo of its own.
const keeping = () => {
  const memo = {};
  return (blocks, text, pages = []) => buildDomSnapshot({
    rev: 1, srcRev: 1, backendName: 'test', mode: 'structured', modeReasons: [], previewPolicy: 'structured',
    previewReasons: [], canonicalInfo: {}, pages, checkpoints: new Map(), blocks, chunkTargets: () => [],
    file: '/doc/main.tex', position: positionIn(text), labelTable: new Map(), preambleEditRegions: [],
    lineStarts: () => lineStarts(text), memo,
  });
};
const snapshot = keeping();
// the same blocks as objects no snapshot has seen
const unseen = (blocks) => blocks.map((block) => ({ ...block }));

test('a block serializes to the bytes JSON.stringify gives', () => {
  const regions = [{ id: 'b1:0', kind: 'text', value: 'あ "quoted" \\ text', source: { file: 'a.tex', start: { line: 1, column: 1 } } }];
  const blocks = [
    { id: 'b1', index: 0, sourceRanges: undefined, file: null, span: { start: 0, end: 4 }, editRegions: regions },
    { id: 'b2', index: 1, file: 'a.tex', span: null, editRegions: regions },
    { id: 'b3', index: 2, editRegions: [] },
    { id: 'b4', editRegions: regions, file: 'moved-after-regions.tex' },
    { editRegions: regions },
    { id: 'b6' },
  ];
  for (const block of blocks) assert.equal(serializeDomBlock(block), JSON.stringify(block));
});

test('edit regions kept on a block follow its source as it moves', () => {
  let text = 'First paragraph with \\textbf{bold} words.\n\nSecond paragraph, $x+y$ and more text.\n\nThird one.\n';
  let blocks = [];
  let id = 0;
  const update = (next) => {
    text = next;
    blocks = diffBlocks(blocks, segmentBody(text, 0), () => `b${id++}`).blocks;
    for (const block of blocks) {
      if (block.regionsFor !== block.text) {
        block.editRegions = instrumentEditRegions(block.text).regions;
        block.regionsFor = block.text;
      }
    }
    const kept = snapshot(blocks, text);
    assert.deepEqual(kept, fresh(unseen(blocks), text));
    // (to the byte: the same keys in the same order)
    assert.equal(JSON.stringify(kept.blocks), JSON.stringify(fresh(unseen(blocks), text).blocks));
    assert.equal(kept.blocks.map(serializeDomBlock).join(), kept.blocks.map((block) => JSON.stringify(block)).join());
    return kept;
  };
  const first = update(text);
  const again = update(text);
  assert.equal(again.blocks[1].editRegions, first.blocks[1].editRegions, 'an untouched block hands out the same regions');
  assert.equal(again.blocks[1], first.blocks[1], 'and the same entry, whose text is kept');
  // a line added above: every later region moves down, no text changed
  const filesBefore = filesOfRegions(first.blocks[1].editRegions);
  const moved = update(`Zeroth.\n\n${text}`);
  assert.notEqual(moved.blocks[2].editRegions, first.blocks[1].editRegions);
  // …and the entry says so: the one before, two lines further down, the same otherwise
  assert.equal(domEntryLinesMovedBy(first.blocks[1], moved.blocks[2]), 2);
  assert.equal(domEntriesDifferInPlaceOnly(first.blocks[1], moved.blocks[2]), false);
  assert.equal(moved.blocks[2].labels, first.blocks[1].labels, 'the parts a line does not move are the same objects');
  assert.equal(filesOfRegions(moved.blocks[2].editRegions), filesBefore, 'the files its regions point into are not read off again');
  assert.equal(domEntryLinesMovedBy(moved.blocks[2], first.blocks[1]), null, 'not the other way round');
  assert.equal(domEntryLinesMovedBy(first.blocks[0], moved.blocks[2]), null, 'nor from another block');
  // same offsets, another line structure before the block
  const reshaped = update(text.replace('Zeroth.\n\n', 'Zero\nth.\n'));
  // (as many lines above as before: the block stands on its lines, at another place in the list)
  assert.equal(domEntryLinesMovedBy(moved.blocks[2], reshaped.blocks.at(-2)), 0);
  assert.equal(domEntriesDifferInPlaceOnly(moved.blocks[2], reshaped.blocks.at(-2)), true);
  assert.equal(domEntryLinesMovedBy(first.blocks[1], reshaped.blocks.at(-2)), 2);
  // two lines fewer above: back on the lines of the first snapshot, and the
  // entries of a block several snapshots apart add up to that
  const fewer = update(text.replace('Zero\nth.\n', 'Zeroth. '));
  assert.equal(domEntryLinesMovedBy(reshaped.blocks.at(-2), fewer.blocks.at(-2)), -2);
  assert.equal(domEntryLinesMovedBy(first.blocks[1], fewer.blocks.at(-2)), 0);
  assert.notEqual(fewer.blocks.at(-2).source, first.blocks[1].source);
  assert.deepEqual(fewer.blocks.at(-2).source, first.blocks[1].source);
  assert.deepEqual(fewer.blocks.at(-2).editRegions, first.blocks[1].editRegions);
  // a character typed above: the offsets of the later blocks move, their
  // lines and columns do not, and neither do their regions
  const second = (dom) => dom.blocks.find((block) => block.editRegions.some((region) => String(region.value).includes('Second')));
  const settled = update(text);
  const typed = update(text.replace('First paragraph', 'First paragraphs'));
  assert.equal(second(typed).editRegions, second(settled).editRegions, 'a later block hands out the same regions');
  assert.equal(second(typed).span.start, second(settled).span.start + 1);
  assert.notEqual(second(typed), second(settled), 'a block whose offsets moved gets a new entry');
  assert.equal(domEntriesDifferInPlaceOnly(second(settled), second(typed)), true, 'that differs in its place only');
  assert.equal(domEntryLinesMovedBy(second(settled), second(typed)), 0);
  assert.equal(second(typed).source, second(settled).source, 'made of the same parts');
  const third = (dom) => dom.blocks.at(-1);
  assert.equal(third(typed).span.start, third(settled).span.start + 1);
  assert.equal(domEntriesDifferInPlaceOnly(third(settled), third(typed)), true);
  // a character typed above on the block's own line would move its column: not a block that merely moved
  const first0 = (dom) => dom.blocks[0];
  assert.equal(domEntriesDifferInPlaceOnly(first0(settled), first0(typed)), false, 'the block typed in is another block');
  assert.equal(domEntryLinesMovedBy(first0(settled), first0(typed)), null);
  // the block itself edited
  update(text.replace('Second', 'Seconds'));
  // a region list replaced for the same text (a rescue's metadata arriving)
  blocks[1].editRegions = blocks[1].editRegions.slice(0, 1);
  blocks[1].regionsFor = blocks[1].text;
  const replaced = snapshot(blocks, text);
  assert.deepEqual(replaced, fresh(unseen(blocks), text));
});

test('the pages a block stands on are kept from one snapshot to the next and follow the pages that were replaced', () => {
  const text = 'One.\n\nTwo.\n\nThree.\n\nFour.\n';
  const blocks = diffBlocks([], segmentBody(text, 0), (() => { let id = 0; return () => `b${id++}`; })()).blocks;
  const [a, b, c, d] = blocks.map((block) => block.id);
  const line = (blockId) => ({ u: { blockId }, y: 0 });
  const page = (number, ids) => ({ number, draw: ids.map(line) });
  const snap = keeping();
  const pagesOf = (dom) => dom.blocks.map((block) => block.pages);
  const check = (pages) => {
    const kept = snap(blocks, text, pages);
    assert.deepEqual(pagesOf(kept), pagesOf(fresh(unseen(blocks), text, pages)));
    return kept;
  };
  const p1 = page(1, [a, a, b]);
  const p2 = page(2, [b, c]);
  const p3 = page(3, [d]);
  const first = check([p1, p2, p3]);
  assert.deepEqual(pagesOf(first), [[1], [1, 2], [2], [3]]);
  // nothing replaced: the same entries
  const again = check([p1, p2, p3]);
  for (let i = 0; i < 4; i++) assert.equal(again.blocks[i], first.blocks[i]);
  // the second page built again with one block more and one less
  const next = check([p1, page(2, [c, d]), p3]);
  assert.deepEqual(pagesOf(next), [[1], [1], [2], [2, 3]]);
  assert.equal(next.blocks[0], first.blocks[0], 'a block on no replaced page keeps its entry');
  assert.equal(domEntriesDifferInPlaceOnly(first.blocks[1], next.blocks[1]), true);
  assert.deepEqual(first.blocks[1].pages, [1, 2], 'the list an earlier snapshot holds is not changed');
  // a block that leaves the paper altogether, and comes back on an earlier page
  check([page(1, [a]), page(2, [c, d]), p3]);
  check([page(1, [a, b]), page(2, [c, d]), page(3, [b, d])]);
  // a page more, a page less, pages numbered out of order: read anew
  check([p1, p2, p3, page(4, [d])]);
  check([p1, p2]);
  check([page(2, [a]), page(1, [a, b]), page(3, [c, d])]);
  check([p1, p2, p3]);
  // a block that sits twice on one page, apart
  check([page(1, [a, b, a]), p2, p3]);
});

test('a block that names no resource command is left as it is, one that does is tied to the file', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'tdom-reuse-'));
  try {
    mkdirSync(path.join(dir, 'figures'));
    writeFileSync(path.join(dir, 'figures', 'plot.png'), 'png-1');
    const body = 'Plain words, 50\\% of them.\n\nA figure:\n\\includegraphics[width=3cm]\n  {figures/plot}\n\n% \\includegraphics{figures/plot}\nCommented only.\n';
    const expand = () => {
      const segs = segmentBody(body, 0);
      return expandIncludes(segs, 0, {
        source: body, file: path.join(dir, 'main.tex'), docDir: dir, workDir: dir, includes: new Map(),
        resources: new Map(), diagnostics: [], watchInclude: () => {},
      });
    };
    const before = expand();
    assert.equal(before.length, 3);
    assert.equal(before[0].externalGraphics, undefined);
    assert.equal(before[1].externalGraphics, true);
    assert.equal(before[2].externalGraphics, undefined, 'a commented-out command reads nothing');
    writeFileSync(path.join(dir, 'figures', 'plot.png'), 'png-2 with other bytes');
    const after = expand();
    assert.equal(after[0].hash, before[0].hash);
    assert.notEqual(after[1].hash, before[1].hash, 'the replaced picture marks its block');
    assert.equal(after[2].hash, before[2].hash);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a page built again keeps the commands of the lines that did not move, and its hash is that of its content', async () => {
  const { buildDisplayList } = await import('../engine/checkpoint/display-list.js');
  const fonts = new Map([['text', { tier: 'native', family: 'f-text' }]]);
  const geometry = { oddsidemargin: 0, topmargin: 0, headheight: 12, headsep: 25, textwidth: 345, textheight: 550, footskip: 30 };
  const run = (t, x) => ({ t, f: 'text', s: 10, x, w: 10, dy: 0, gh: 7, gd: 2, c: '#000000' });
  const line = (blockId, li, text) => ({
    blockId, li, h: 8, d: 2,
    ln: { boxH: 8, backend: null, runs: [...text].map((char, i) => run(char, i * 10)).concat([{ rule: true, x: 0, dy: 1, w: 30, h: 0.4 }]) },
  });
  const options = { geometry, chunks: new Map(), hf: null, hfSig: '', fonts, twinMetrics: null };
  const first = line('b1', 0, 'あいう');
  const second = line('b2', 0, 'えお');
  const third = line('b3', 0, 'かき');
  const page = (lines) => ({ number: 1, draw: lines.map(([u, y]) => ({ u, y })) });
  // (a build that has seen none of these lines: the same lines as new objects)
  const unseen = (u) => ({ ...u, ln: { ...u.ln, runs: u.ln.runs.map((r) => ({ ...r })) } });

  const before = buildDisplayList(page([[first, 10], [second, 22], [third, 34]]), options);
  assert.equal(before.commands.length, 3 + 1 + 2 + 1 + 2 + 1 + 1, 'glyphs and a rule a line, and the folio');
  // the middle line changed and grew: the first stays, the third moves down
  const edited = line('b2', 0, 'えおん');
  const after = buildDisplayList(page([[first, 10], [edited, 22], [third, 46]]), options);
  for (let i = 0; i < 4; i++) assert.equal(after.commands[i], before.commands[i], 'the unmoved line is the same commands');
  assert.notEqual(after.commands.at(-2), before.commands.at(-2), 'a line at another place is built again');
  assert.equal(after.commands.at(-2).y, before.commands.at(-2).y + 12);
  assert.notEqual(after.hash, before.hash);

  // what a build that kept nothing gives: the same commands, the same hash
  const fresh = buildDisplayList(page([[unseen(first), 10], [unseen(edited), 22], [unseen(third), 46]]), options);
  assert.deepEqual(after.commands, fresh.commands);
  assert.equal(after.hash, fresh.hash, 'the hash is a function of the content alone');
  // and back where it was, the page has the hash it had
  const again = buildDisplayList(page([[first, 10], [second, 22], [third, 34]]), options);
  assert.deepEqual(again.commands, before.commands);
  assert.equal(again.hash, before.hash);
  // one character of one command is another page
  const other = buildDisplayList(page([[unseen(first), 10], [unseen(second), 22], [line('b3', 0, 'かく'), 34]]), options);
  assert.notEqual(other.hash, before.hash);
  // another font table is another build of every line
  const otherFonts = buildDisplayList(page([[first, 10], [second, 22], [third, 34]]),
    { ...options, fonts: new Map([['text', { tier: 'native', family: 'f-other' }]]) });
  assert.equal(otherFonts.commands[0].fam, 'f-other');
  assert.equal(before.commands[0].fam, 'f-text', 'the kept commands were not touched');
});

test('the viewer keeps the elements of the lines a keystroke did not change', async () => {
  const { readFileSync } = await import('node:fs');
  const vm = (await import('node:vm')).default;
  const app = readFileSync(new URL('../web/app.js', import.meta.url), 'utf8');
  const from = app.indexOf('const fontSettled');
  const viewer = {};
  vm.createContext(viewer);
  vm.runInContext(app.slice(from, app.indexOf('\n}\n', app.indexOf('function patchProvisionalSvg(')) + 3) +
    '\nthis.patch = patchProvisionalSvg; this.cut = svgPartsCut; this.splice = spliceSvgChildren;', viewer);

  // a stand-in for an SVG element and its children
  const svgOf = (names) => {
    const svg = { childNodes: [] };
    svg.insertBefore = (node, before) => {
      node.parent?.childNodes.splice(node.parent.childNodes.indexOf(node), 1);
      const at = before == null ? svg.childNodes.length : svg.childNodes.indexOf(before);
      svg.childNodes.splice(at, 0, node);
      node.parent = svg;
    };
    for (const name of names) {
      const node = { name, parent: svg, remove() { this.parent.childNodes.splice(this.parent.childNodes.indexOf(this), 1); this.parent = null; } };
      svg.childNodes.push(node);
    }
    return svg;
  };
  const parts = (names) => ['<svg viewBox="0 0 600 800">', ...names.map((name) => `<text>${name}</text>`), '</svg>'];
  const names = (svg) => svg.childNodes.map((node) => node.name);

  // a line in the middle changed and grew by one element
  const before = ['a', 'b', 'c', 'd', 'e'];
  const after = ['a', 'b', 'C1', 'C2', 'd', 'e'];
  const committed = svgOf(before);
  const kept = [...committed.childNodes];
  const staged = svgOf(after);
  assert.equal(viewer.patch(committed, parts(before), staged, parts(after)), true);
  assert.deepEqual(names(committed), after);
  for (const i of [0, 1]) assert.equal(committed.childNodes[i], kept[i], 'elements before the change stay');
  for (const i of [1, 2]) assert.equal(committed.childNodes.at(-i), kept.at(-i), 'elements after it stay');
  assert.deepEqual(names(staged), ['a', 'b', 'd', 'e'], 'only the changed elements were taken from the staged page');

  // the last line removed; the first one changed; nothing changed; everything changed
  for (const [from, to] of [[['a', 'b', 'c'], ['a', 'b']], [['a', 'b'], ['A', 'b']], [['a', 'b'], ['a', 'b']], [['a', 'b'], ['x', 'y', 'z']],
    [[], ['a']], [['a'], []], [['a', 'a', 'a'], ['a', 'a']]]) {
    const live = svgOf(from);
    assert.equal(viewer.patch(live, parts(from), svgOf(to), parts(to)), true, `${from} -> ${to}`);
    assert.deepEqual(names(live), to, `${from} -> ${to}`);
  }

  // a font that became ready since the committed page was built: the same element
  const pending = ['<svg viewBox="0 0 600 800">', '<text data-font-pending="1">a</text>', '<text>b</text>', '</svg>'];
  const settled = ['<svg viewBox="0 0 600 800">', '<text>a</text>', '<text>B</text>', '</svg>'];
  const live = svgOf(['a', 'b']);
  const first = live.childNodes[0];
  assert.equal(viewer.patch(live, pending, svgOf(['a', 'B']), settled), true);
  assert.equal(live.childNodes[0], first);
  assert.deepEqual(names(live), ['a', 'B']);

  // not this function's case: the page is replaced whole, and nothing was touched
  const untouched = svgOf(['a', 'b']);
  assert.equal(viewer.patch(untouched, parts(['a', 'b']), svgOf(['a']), ['<svg viewBox="0 0 500 700">', '<text>a</text>', '</svg>']), false, 'another paper');
  assert.equal(viewer.patch(untouched, parts(['a']), svgOf(['a']), parts(['a'])), false, 'the committed page is not what its pieces say');
  assert.equal(viewer.patch(untouched, parts(['a', 'b']), svgOf(['a', 'b']), parts(['a'])), false, 'the staged page is not what its pieces say');
  assert.equal(viewer.patch(null, parts(['a']), svgOf(['a']), parts(['a'])), false, 'no committed page');
  assert.equal(viewer.patch(untouched, undefined, svgOf(['a']), parts(['a'])), false, 'a page committed without its pieces');
  assert.deepEqual(names(untouched), ['a', 'b']);

  // the staged page is cut the same way before it is parsed: only the pieces
  // between the shared start and end become elements, and those go in
  for (const [from, to] of [[before, after], [['a', 'b', 'c'], ['a', 'b']], [['a', 'b'], ['a', 'b']], [['a'], ['x', 'y']], [[], ['a', 'b']]]) {
    const cut = viewer.cut(parts(from), parts(to));
    assert.ok(cut.head + cut.tail <= Math.min(from.length, to.length));
    const page = svgOf(from);
    const middle = svgOf(to.slice(cut.head, to.length - cut.tail)); // what the stage parsed
    viewer.splice(page, cut.head, from.length - cut.tail, [...middle.childNodes]);
    assert.deepEqual(names(page), to, `${from} -> ${to}`);
  }
  assert.deepEqual({ ...viewer.cut(parts(before), parts(after)) }, { head: 2, tail: 2 });
  assert.equal(viewer.cut(undefined, parts(['a'])), null, 'no committed pieces: the page is built whole');
  assert.equal(viewer.cut(['<svg viewBox="0 0 500 700">', '</svg>'], parts(['a'])), null, 'another paper');

  viewer.__tdomWholePageCommit = true;
  assert.equal(viewer.patch(svgOf(['a']), parts(['a']), svgOf(['b']), parts(['b'])), false, 'switched off');
  assert.equal(viewer.cut(parts(['a']), parts(['b'])), null);
});

test('a changed source file goes to the viewer as the stretch that came and went', async () => {
  const { textSplice } = await import('../engine/text-splice.js');
  const apply = (before, [at, gone, came]) => before.slice(0, at) + came + before.slice(at + gone);
  const long = 'あいうえお\n'.repeat(40_000); // longer than one comparison step
  const cases = [
    ['', ''], ['abc', 'abc'], ['', 'abc'], ['abc', ''], ['abc', 'abXc'], ['abXc', 'abc'], ['aaa', 'aa'], ['aa', 'aaa'],
    ['abcabc', 'abc'], ['xyz', 'abc'], ['head mid tail', 'head MID tail'],
    [long, long.slice(0, 123_457) + 'か' + long.slice(123_457)],
    [long, long.slice(0, 70_000) + long.slice(70_003)],
    [long + 'x', 'y' + long], [long, long + long],
  ];
  for (const [before, after] of cases) {
    const splice = textSplice(before, after);
    assert.equal(apply(before, splice), after);
    assert.ok(splice[0] >= 0 && splice[1] >= 0 && splice[0] + splice[1] <= before.length);
  }
  // one typed character: one character, wherever it is
  assert.deepEqual(textSplice(long, long.slice(0, 123_457) + 'か' + long.slice(123_457)), [123_457, 0, 'か']);
  assert.deepEqual(textSplice('abc', 'abc'), [3, 0, '']);

  // and the viewer puts it into the text it holds; a splice it cannot place asks for the whole snapshot
  const { readFileSync } = await import('node:fs');
  const vm = (await import('node:vm')).default;
  const app = readFileSync(new URL('../web/app.js', import.meta.url), 'utf8');
  const start = app.indexOf('function applySnapshotDelta(');
  const viewer = { snapshotBlockIndex: new WeakMap() };
  vm.createContext(viewer);
  vm.runInContext(app.slice(start, app.indexOf('\n}\n', start) + 3) + '\nthis.apply = applySnapshotDelta;', viewer);
  const base = { domStamp: 1, blocks: [{ id: 'b1', index: 0 }], sources: [{ file: '/d/a.tex', text: 'head mid tail' }, { file: '/d/b.tex', text: 'other' }] };
  const delta = (sources) => ({ domStamp: 2, delta: { base: 1 }, cut: [1, 0, []], files: ['/d/a.tex', '/d/b.tex'], blocks: [], at: [], moved: [], sources });
  const next = viewer.apply(base, delta([{ file: '/d/a.tex', splice: textSplice('head mid tail', 'head MID tail!') }]));
  assert.deepEqual(JSON.parse(JSON.stringify(next.sources)), [{ file: '/d/a.tex', text: 'head MID tail!' }, { file: '/d/b.tex', text: 'other' }]);
  assert.equal(next.sources[1], base.sources[1], 'a file that did not change is the object held');
  assert.equal(viewer.apply(base, delta([{ file: '/d/a.tex', splice: [5, 100, 'x'] }])), null, 'past the end of the text held');
  assert.equal(viewer.apply(base, delta([{ file: '/d/c.tex', splice: [0, 0, 'x'] }])), null, 'a file the viewer does not hold');
  const whole = viewer.apply(base, delta([{ file: '/d/a.tex', text: 'all new' }]));
  assert.equal(whole.sources[0].text, 'all new', 'a file sent whole is taken whole, as before');
  // (the list of files is not sent again when it is the one held)
  const sameFiles = viewer.apply(base, { ...delta([]), files: null });
  assert.deepEqual(JSON.parse(JSON.stringify(sameFiles.sources)), base.sources);
});

test('the viewer applies a change of the snapshot by place: blocks replaced, moved, shifted in runs, lowered by lines', async () => {
  const { readFileSync } = await import('node:fs');
  const vm = (await import('node:vm')).default;
  const app = readFileSync(new URL('../web/app.js', import.meta.url), 'utf8');
  const start = app.indexOf('function applySnapshotDelta(');
  const viewer = {};
  vm.createContext(viewer);
  vm.runInContext(app.slice(start, app.indexOf('\n}\n', start) + 3) + '\nthis.apply = applySnapshotDelta;', viewer);
  const plain = (value) => JSON.parse(JSON.stringify(value));
  const at = (line, column) => ({ line, column });
  const block = (id, index, line, start) => ({
    id, index, type: 'block', source: { file: '/d/a.tex', start: at(line, 1), end: at(line + 1, 4) }, pages: [1],
    file: null, span: { start, end: start + 10 },
    editRegions: [{ id: `${id}:0`, kind: 'text', value: id, source: { file: '/d/a.tex', start: at(line, 3), end: at(line, 9) } }],
  });
  const base = { domStamp: 7, srcRev: 3, blocks: [block('a', 0, 1, 0), block('b', 1, 4, 20), block('c', 2, 7, 40), block('d', 3, 10, 60)],
    sources: [{ file: '/d/a.tex', text: 'x' }] };
  const change = (extra) => ({ domStamp: 8, delta: { base: 7 }, srcRev: 4, cut: [4, 0, []], files: null, blocks: [], at: [], moved: [],
    shift: [], lines: [], sources: [], ...extra });

  // a character typed into `b`: `b` whole, the blocks after it one character further
  const typed = viewer.apply(base, change({ blocks: [{ ...block('b', 1, 4, 20), span: { start: 20, end: 31 } }], at: [1], shift: [[2, 4, 1, 0]] }));
  assert.equal(typed.blocks[0], base.blocks[0], 'a block that did not change is the object held');
  assert.deepEqual(plain(typed.blocks[1].span), { start: 20, end: 31 });
  assert.deepEqual(plain(typed.blocks.map((item) => item.span.start)), [0, 20, 41, 61]);
  assert.deepEqual(plain(typed.blocks[2]), { ...block('c', 2, 7, 41) });
  assert.equal(typed.blocks[2].editRegions, base.blocks[2].editRegions, 'its regions are the ones held');
  assert.deepEqual(plain(base.blocks[2].span), { start: 40, end: 50 }, 'the snapshot held is not changed');
  assert.equal(typed.srcRev, 4);
  assert.equal(typed.cut, undefined);
  assert.equal(typed.shift, undefined);

  // a line break typed after `a`: the blocks after it one line lower and one character further
  const lowered = viewer.apply(base, change({ shift: [[1, 4, 1, 0]], lines: [[1, 4, 1]] }));
  assert.deepEqual(plain(lowered.blocks[1]), block('b', 1, 5, 21));
  assert.deepEqual(plain(lowered.blocks[3]), block('d', 3, 11, 61));
  assert.deepEqual(plain(base.blocks[3]), block('d', 3, 10, 60));
  assert.equal(lowered.blocks[0], base.blocks[0]);

  // a new block `n` after `a`: named in the stretch, sent whole; the rest one place further
  const added = viewer.apply(base, change({ cut: [1, 3, ['n']], blocks: [block('n', 1, 3, 12)], at: [1], shift: [[2, 5, 8, 1]], lines: [[2, 5, 2]] }));
  assert.deepEqual(plain(added.blocks.map((item) => [item.id, item.index, item.span.start, item.source.start.line])),
    [['a', 0, 0, 1], ['n', 1, 12, 3], ['b', 2, 28, 6], ['c', 3, 48, 9], ['d', 4, 68, 12]]);
  // `b` and `c` merged into `b`: one block of the stretch stays (changed), one goes
  const merged = viewer.apply(base, change({ cut: [1, 1, ['b']], blocks: [{ ...block('b', 1, 4, 20), span: { start: 20, end: 50 } }], at: [1], shift: [[2, 3, 0, -1]] }));
  assert.deepEqual(plain(merged.blocks.map((item) => [item.id, item.index])), [['a', 0], ['b', 1], ['d', 2]]);
  // two blocks of the stretch change places, neither sent whole: found among the blocks replaced
  const swapped = viewer.apply(base, change({ cut: [1, 1, ['c', 'b']], moved: [[1, 1, [1], { start: 20, end: 30 }], [2, 2, [2], { start: 40, end: 50 }]] }));
  assert.deepEqual(plain(swapped.blocks.map((item) => [item.id, item.index, item.pages, item.span.start])),
    [['a', 0, [1], 0], ['c', 1, [1], 20], ['b', 2, [2], 40], ['d', 3, [1], 60]]);
  // a block that went to another page, by its place; one of an included file carries no offsets
  const paged = viewer.apply(base, change({ moved: [[3, 3, [2], null]] }));
  assert.deepEqual(plain(paged.blocks[3].pages), [2]);
  assert.equal('span' in paged.blocks[3], false);

  // what does not fit the snapshot held is refused, and the viewer asks for the whole
  const refused = [
    { cut: undefined }, { cut: [5, 0, []] }, { cut: [2, 3, []] }, { cut: [-1, 0, []] }, { cut: [4, 0, 'x'] },
    { blocks: [block('b', 1, 4, 20)], at: [] }, { blocks: [block('b', 1, 4, 20)], at: [2] }, { blocks: [block('b', 1, 4, 20)], at: [9] },
    { cut: [1, 3, ['n']] }, { cut: [1, 3, ['n']], blocks: [block('m', 1, 3, 12)], at: [1] },
    { moved: [[9, 0, [1], null]] }, { shift: [[2, 9, 1, 0]] }, { shift: [[3, 2, 1, 0]] }, { shift: [[0, 1, 1.5, 0]] },
    { lines: [[0, 9, 1]] }, { lines: [[0, 1, 'x']] },
  ];
  for (const extra of refused) assert.equal(viewer.apply(base, change(extra)), null, JSON.stringify(extra));
  const noSpan = { ...base, blocks: [{ ...block('a', 0, 1, 0), span: null }] };
  assert.equal(viewer.apply(noSpan, change({ cut: [1, 0, []], shift: [[0, 1, 1, 0]] })), null, 'offsets moved in a block that has none');
  assert.equal(viewer.apply(noSpan, change({ cut: [1, 0, []], shift: [[0, 1, 0, 1]] })).blocks[0].index, 1);
});

test('an overlay at rest is taken from the cache; one just written, or changed, is read', async () => {
  const { cacheIncludeRead, includeTextCurrent, overlayContentSig, OVERLAY_REST_MS } = await import('../engine/checkpoint/include-cache.js');
  const { statSync, utimesSync, readFileSync } = await import('node:fs');
  const { fnv1a } = await import('../engine/hash.js');
  const dir = mkdtempSync(path.join(tmpdir(), 'tdom-overlay-rest-'));
  try {
    const file = path.join(dir, 'chapter.tex');
    const logical = '/project/chapter.tex';
    const includes = new Map();
    const read = () => {
      const stat = statSync(file);
      const cached = includes.get(logical);
      const taken = includeTextCurrent(cached, stat, file, true);
      const text = taken ? cached.text : readFileSync(file, 'utf8');
      cacheIncludeRead(includes, logical, { mtime: stat.mtimeMs, size: stat.size, readPath: file, text });
      return { taken, text };
    };
    const rested = (seconds) => { const at = new Date(Date.now() - seconds * 1000); utimesSync(file, at, at); };

    // just written: read, and read again (a second write could carry the same time)
    writeFileSync(file, 'first');
    assert.deepEqual(read(), { taken: false, text: 'first' });
    assert.equal(includes.get(logical).settled, false);
    assert.deepEqual(read(), { taken: false, text: 'first' });

    // at rest for longer than a filesystem's timestamp step: read once more, then kept
    rested(OVERLAY_REST_MS / 1000 + 5);
    assert.deepEqual(read(), { taken: false, text: 'first' }, 'the bytes read while it was fresh are not trusted');
    assert.equal(includes.get(logical).settled, true);
    assert.deepEqual(read(), { taken: true, text: 'first' });
    assert.deepEqual(read(), { taken: true, text: 'first' });

    // written again: another time, read
    writeFileSync(file, 'second text');
    assert.deepEqual(read(), { taken: false, text: 'second text' });
    // another size under the same time is not the file that was read
    rested(60);
    read();
    assert.equal(read().taken, true);
    const kept = includes.get(logical);
    assert.equal(includeTextCurrent({ ...kept, size: kept.size + 1 }, statSync(file), file, true), false);
    assert.equal(includeTextCurrent(kept, statSync(file), path.join(dir, 'other.tex'), true), false, 'read through another path');
    // a file of the project itself keeps its rule: the time it was written
    assert.equal(includeTextCurrent({ ...kept, settled: false, size: null }, statSync(file), file, false), true);
    assert.equal(includeTextCurrent(undefined, statSync(file), file, false), false);

    // the identity of the bytes: from the text held, once; from the file when the file is another
    assert.equal(overlayContentSig(includes, logical, file, statSync(file)), fnv1a('second text'));
    assert.equal(includes.get(logical).sig, fnv1a('second text'));
    read();
    assert.equal(includes.get(logical).sig, fnv1a('second text'), 'carried while the text is the same');
    writeFileSync(file, 'third');
    assert.equal(overlayContentSig(includes, logical, file, statSync(file)), fnv1a('third'), 'a file written since is read');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
