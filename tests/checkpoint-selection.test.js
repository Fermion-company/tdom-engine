import test from 'node:test';
import assert from 'node:assert/strict';

import { checkpointKeepSet } from '../engine/checkpoint/checkpoint-selection.js';

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
