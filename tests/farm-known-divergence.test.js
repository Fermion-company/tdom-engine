import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { matchesKnownDivergence } from '../tools/farm-known-divergence.mjs';

const manifest = JSON.parse(
  readFileSync(new URL('../corpus/manifest.json', import.meta.url), 'utf8')
);
const issue9Entry = manifest.docs.find(
  (entry) => entry.file === '11-simple-live-preview.tex'
);
const expected = {
  issue: 9,
  kind: 'page-count-mismatch',
  enginePages: 1,
  realPages: 2,
  matched: [18, 21],
  lines: 34,
};

test('Issue #9 fixture no longer carries a known-divergence exception', () => {
  assert.ok(issue9Entry, 'Issue #9 fixture remains in the corpus manifest');
  assert.equal(issue9Entry.knownDiverged, undefined);
});

test('known farm divergences require their registered failure signature', () => {
  assert.equal(matchesKnownDivergence(expected, { ...expected, matched: 18 }), true);
  assert.equal(matchesKnownDivergence(expected, { ...expected, matched: 21 }), true);
  for (const [key, value] of [
    ['kind', 'referee-failure'],
    ['enginePages', 2],
    ['realPages', 3],
    ['matched', 19],
    ['lines', 35],
  ]) {
    assert.equal(
      matchesKnownDivergence(expected, { ...expected, matched: 18, [key]: value }),
      false,
      key
    );
  }
  assert.equal(matchesKnownDivergence({ ...expected, matched: [] }, { ...expected, matched: 18 }), false);
  assert.equal(matchesKnownDivergence({ ...expected, matched: [18, '21'] }, { ...expected, matched: 18 }), false);
  assert.equal(matchesKnownDivergence({ ...expected, issue: null }, { ...expected, matched: 18 }), false);
  assert.equal(matchesKnownDivergence(false, { ...expected, matched: 18 }), false);
  assert.equal(
    matchesKnownDivergence(true, { ...expected, matched: 18 }),
    true,
    'legacy broad baselines remain supported'
  );
});
