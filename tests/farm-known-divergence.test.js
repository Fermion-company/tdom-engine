import test from 'node:test';
import assert from 'node:assert/strict';

import { matchesKnownDivergence } from '../tools/farm-known-divergence.mjs';

const expected = {
  issue: 9,
  kind: 'page-count-mismatch',
  enginePages: 1,
  realPages: 2,
  matched: 21,
  lines: 34,
};

test('known farm divergences require their registered failure signature', () => {
  assert.equal(matchesKnownDivergence(expected, expected), true);
  for (const [key, value] of [
    ['kind', 'referee-failure'],
    ['enginePages', 2],
    ['realPages', 3],
    ['matched', 20],
    ['lines', 35],
  ]) {
    assert.equal(matchesKnownDivergence(expected, { ...expected, [key]: value }), false, key);
  }
  assert.equal(matchesKnownDivergence({ ...expected, issue: null }, expected), false);
  assert.equal(matchesKnownDivergence(false, expected), false);
  assert.equal(matchesKnownDivergence(true, expected), true, 'legacy broad baselines remain supported');
});
