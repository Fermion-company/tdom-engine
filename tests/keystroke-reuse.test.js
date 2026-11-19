// What a keystroke re-reads for every block of a long document is kept per
// block; these results must stay what a fresh computation gives.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { segmentBody, diffBlocks } from '../engine/segmenter.js';
import { expandIncludes } from '../engine/checkpoint/include-expander.js';
import { buildDomSnapshot, serializeDomBlock } from '../engine/checkpoint/inspector.js';
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
const snapshot = (blocks, text) => buildDomSnapshot({
  rev: 1, srcRev: 1, backendName: 'test', mode: 'structured', modeReasons: [], previewPolicy: 'structured',
  previewReasons: [], canonicalInfo: {}, pages: [], checkpoints: new Map(), blocks, chunkTargets: () => [],
  file: '/doc/main.tex', position: positionIn(text), labelTable: new Map(), preambleEditRegions: [],
});
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
    assert.deepEqual(kept, snapshot(unseen(blocks), text));
    assert.equal(kept.blocks.map(serializeDomBlock).join(), kept.blocks.map((block) => JSON.stringify(block)).join());
    return kept;
  };
  const first = update(text);
  const again = update(text);
  assert.equal(again.blocks[1].editRegions, first.blocks[1].editRegions, 'an untouched block hands out the same regions');
  assert.equal(again.blocks[1], first.blocks[1], 'and the same entry, whose text is kept');
  // a line added above: every later region moves down, no text changed
  const moved = update(`Zeroth.\n\n${text}`);
  assert.notEqual(moved.blocks[2].editRegions, first.blocks[1].editRegions);
  // same offsets, another line structure before the block
  update(text.replace('Zeroth.\n\n', 'Zero\nth.\n'));
  // a character typed above: the offsets of the later blocks move, their
  // lines and columns do not, and neither do their regions
  const second = (dom) => dom.blocks.find((block) => block.editRegions.some((region) => String(region.value).includes('Second')));
  const settled = update(text);
  const typed = update(text.replace('First paragraph', 'First paragraphs'));
  assert.equal(second(typed).editRegions, second(settled).editRegions, 'a later block hands out the same regions');
  assert.equal(second(typed).span.start, second(settled).span.start + 1);
  assert.notEqual(second(typed), second(settled), 'a block whose offsets moved gets a new entry');
  // the block itself edited
  update(text.replace('Second', 'Seconds'));
  // a region list replaced for the same text (a rescue's metadata arriving)
  blocks[1].editRegions = blocks[1].editRegions.slice(0, 1);
  blocks[1].regionsFor = blocks[1].text;
  const replaced = snapshot(blocks, text);
  assert.deepEqual(replaced, snapshot(unseen(blocks), text));
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
