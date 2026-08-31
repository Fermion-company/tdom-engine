import test from 'node:test';
import assert from 'node:assert/strict';

import { checkpointKeepSet } from '../engine/checkpoint/checkpoint-selection.js';

test('measured-cost checkpoint selection brackets unknown expensive blocks', () => {
  const blocks = Array.from({ length: 51 }, () => ({ typesetCostMs: 2 }));
  blocks[24].typesetCostMs = 650;
  blocks[36].typesetCostMs = 4300;
  const keep = checkpointKeepSet(blocks, 8);
  assert.equal(keep.size, 8);
  assert.equal(keep.has(24), true, 'input boundary for a heavy graphical block');
  assert.equal(keep.has(25), true, 'ordinary prose after the graphical block skips it');
  assert.equal(keep.has(36), true, 'input boundary for a repeated user macro');
  assert.equal(keep.has(37), true, 'ordinary prose after the repeated macro skips it');
});

test('small documents retain every available boundary', () => {
  assert.deepEqual(
    [...checkpointKeepSet([{ typesetCostMs: 10 }, { typesetCostMs: 20 }], 8)],
    [0, 1, 2]
  );
});
