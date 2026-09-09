import test from 'node:test';
import assert from 'node:assert/strict';

import { checkpointKeepSet } from '../engine/checkpoint/checkpoint-selection.js';
import { enforceCheckpointCap, retireOffGrid } from '../engine/checkpoint/checkpoint-retirement.js';

test('measured-cost checkpoint selection brackets unknown expensive blocks', () => {
  const blocks = Array.from({ length: 51 }, () => ({ typesetCostMs: 2 }));
  blocks[10].typesetCostMs = 500;
  blocks[24].typesetCostMs = 650;
  blocks[36].typesetCostMs = 4300;
  const keep = checkpointKeepSet(blocks, 8);
  assert.equal(keep.size, 8);
  assert.equal(keep.has(24), true, 'input boundary for a heavy graphical block');
  assert.equal(keep.has(25), true, 'ordinary prose after the graphical block skips it');
  assert.equal(keep.has(36), true, 'input boundary for a repeated user macro');
  assert.equal(keep.has(37), true, 'ordinary prose after the repeated macro skips it');
  assert.equal(keep.has(10), true, 'the third expensive block retains its input boundary');
  assert.equal(keep.has(11), true, 'the third expensive block retains its output boundary');
  assert.equal(keep.has(50), true, 'the final block keeps its own input boundary');
});

test('tail coverage is stable while measured costs are still arriving', () => {
  const blocks = Array.from({ length: 25 }, () => ({}));
  const early = checkpointKeepSet(blocks, 8);
  for (let i = 0; i < blocks.length; i++) blocks[i].typesetCostMs = i < 4 ? 20 - i : 2;
  const measured = checkpointKeepSet(blocks, 8);

  assert.equal(early.size, 8);
  assert.equal(measured.size, 8);
  assert.equal(early.has(24), true);
  assert.equal(measured.has(24), true);
  for (const limit of [1, 2, 3]) {
    const keep = checkpointKeepSet(blocks, limit);
    assert.equal(keep.size, limit, `budget ${limit} remains hard`);
    if (limit > 1) assert.equal(keep.has(24), true);
  }
});

test('tail coverage has explicit priority when the budget cannot keep every hot bracket', () => {
  const constrained = Array.from({ length: 10 }, () => ({ typesetCostMs: 1 }));
  constrained[4].typesetCostMs = 100;
  assert.deepEqual([...checkpointKeepSet(constrained, 2)].sort((a, b) => a - b), [0, 9]);
  assert.deepEqual([...checkpointKeepSet(constrained, 3)].sort((a, b) => a - b), [0, 4, 9]);

  const rootHeavy = Array.from({ length: 30 }, () => ({ typesetCostMs: 1 }));
  rootHeavy[0].typesetCostMs = 5000;
  rootHeavy[5].typesetCostMs = 4000;
  rootHeavy[10].typesetCostMs = 3000;
  rootHeavy[20].typesetCostMs = 2000;
  assert.deepEqual(
    [...checkpointKeepSet(rootHeavy, 8)].sort((a, b) => a - b),
    [0, 1, 5, 6, 10, 11, 20, 29]
  );
});

test('small documents retain every available boundary', () => {
  assert.deepEqual(
    [...checkpointKeepSet([{ typesetCostMs: 10 }, { typesetCostMs: 20 }], 8)],
    [0, 1, 2]
  );
});

test('terminal page flushes retain the last visible page and its exact neighbors', () => {
  const blocks = [
    ...Array.from({ length: 210 }, () => ({ text: 'Ordinary text.', typesetCostMs: 2 })),
    { text: 'Earlier page.\\newpage % page boundary', typesetCostMs: 2 },
    { text: '\\section{Last page}', typesetCostMs: 2 },
    { text: '\\par\\medskip', typesetCostMs: 2 },
    { text: '\\begin{tcolorbox}Editable body.\\end{tcolorbox}', typesetCostMs: 2 },
    { text: '\\par\\medskip % input boundary', typesetCostMs: 2 },
    { text: '\\clearpage', typesetCostMs: 2 },
  ];
  const keep = checkpointKeepSet(blocks, 8);
  assert.equal(keep.size, 8);
  assert.ok(keep.has(211), 'the final heading and box share a nearby replay frontier');
  assert.ok(!keep.has(215), 'a flush after all visible ink does not consume the tail slot');
});

test('ordinary blocks retain coverage instead of spending every slot on similar early costs', () => {
  for (const measuredCount of [8, 224]) {
    const blocks = Array.from({ length: 224 }, (_, index) =>
      index < measuredCount ? { typesetCostMs: index < 3 ? 30 : 20 } : {});
    const keep = [...checkpointKeepSet(blocks, 8)].sort((a, b) => a - b);
    assert.equal(keep.length, 8);
    const gaps = keep.slice(1).map((boundary, index) => boundary - keep[index]);
    assert.ok(Math.max(...gaps) <= 50, `measured ${measuredCount}: coverage ${keep.join(',')}`);
  }
});


test('unmaterialized cost boundaries retain available checkpoints until replacements arrive', () => {
  const checkpoints = new Map();
  const retired = [];
  const peer = index => ({ send: message => {
    assert.equal(message, 'DIE\n');
    retired.push(index);
  } });
  for (let index = 0; index <= 8; index++) checkpoints.set(index, peer(index));
  const state = { checkpoints, keep: new Set([0, 25, 50, 75, 100, 125, 150, 175]),
    editHold: [], renderHold: new Map(), dyingPids: new Set() };
  retireOffGrid({ ...state, idx: 7 });
  assert.ok(checkpoints.has(7), 'an available fallback survives a desired frontier that does not exist');
  enforceCheckpointCap(state);
  assert.equal(checkpoints.size, 8);
  checkpoints.set(25, peer(25));
  enforceCheckpointCap(state);
  assert.equal(checkpoints.size, 8);
  assert.ok(checkpoints.has(0));
  assert.ok(checkpoints.has(25));
  assert.equal(retired.length, 2);
});

test('temporary edit and render owners do not displace distant coverage frontiers', () => {
  for (const owner of ['edit', 'render']) {
    const retired = [];
    const checkpoints = new Map([0, 1, 26, 54, 90, 124, 155, 188, 219, 221, 222]
      .map(index => [index, { send: () => retired.push(index) }]));
    const pins = [1, 221, 222];
    const state = { checkpoints, keep: new Set([0, 12, 44, 78, 113, 149, 185, 219]),
      editHold: owner === 'edit' ? pins : [],
      renderHold: new Map(owner === 'render' ? pins.map(index => [index, `b${index}`]) : []),
      dyingPids: new Set() };
    retireOffGrid({ ...state, idx: 26 });
    enforceCheckpointCap(state);
    assert.ok(checkpoints.has(26), `${owner} pins must not force the next cold edit back to root`);
    assert.equal(checkpoints.size, state.keep.size + pins.length);
    assert.deepEqual(retired, []);
  }
});
