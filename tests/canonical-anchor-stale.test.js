import test from 'node:test';
import assert from 'node:assert/strict';
import { buildStaleBaseLineage, ringSet } from '../engine/checkpoint/canonical-anchor-stale.js';

const certificate = { id: 7, rev: 10, inputEpoch: 1 };
const ledger = new Map([
  ['bA', { hash: 'hA', galleyHash: 'gA', structuralStateVec: 'sA' }],
  ['bB', { hash: 'hB', galleyHash: 'gB', structuralStateVec: 'sB' }],
  ['bC', { hash: 'hC', galleyHash: 'gC', structuralStateVec: null }], // cold at R
]);
const witness = (srcRev, blockId, over = {}) => ({
  srcRev,
  blockId,
  documentEpoch: 3,
  snapshot: { blockId, blockHash: 'h' + blockId.slice(1), galleyHash: 'g' + blockId.slice(1), structuralStateVec: 's' + blockId.slice(1), lineWitnesses: [], ...over },
});

test('a stale generation becomes a lineage: untouched blocks via the ledger, edited blocks via their first pre-edit witness', () => {
  const lineage = buildStaleBaseLineage({
    certificate,
    ledger,
    witnesses: [witness(11, 'bA'), witness(12, 'bA', { galleyHash: 'g-later' }), witness(13, 'bB')],
    srcRev: 14,
    documentEpoch: 3,
  });
  assert.ok(lineage);
  assert.equal(lineage.baseGeneration, 7);
  assert.equal(lineage.baseRev, 10);
  assert.equal(lineage.lastSrcRev, 14, 'the next keystroke continues it');
  assert.equal(lineage.blockId, null);
  assert.equal(lineage.ledger, ledger);
  assert.deepEqual([...lineage.blocks.keys()], ['bA', 'bB']);
  assert.deepEqual(lineage.blocks.get('bA').baseSnapshot.certificate, certificate, 'the witness is re-certified for the landed generation');
  assert.deepEqual(lineage.blocks.get('bA').changedLines, []);
  assert.deepEqual(lineage.stale.prepared, ['bA', 'bB']);
});

test('witnesses that do not match what the base typeset, cold blocks, other epochs and revisions outside (R, now] are skipped', () => {
  const lineage = buildStaleBaseLineage({
    certificate,
    ledger,
    witnesses: [
      witness(11, 'bA', { galleyHash: 'g-drift' }), // A had already moved when first edited
      witness(12, 'bC'), // cold at R: no identity
      witness(13, 'bB', {}), // fine
      { ...witness(14, 'bB'), documentEpoch: 2 }, // ignored: B already seen
      witness(9, 'bB'), // before R
      witness(20, 'bB'), // after now
    ],
    srcRev: 15,
    documentEpoch: 3,
  });
  assert.deepEqual([...lineage.blocks.keys()], ['bB']);
  assert.deepEqual(lineage.stale.skipped.map((s) => s.reason), ['witness-mismatch', 'cold-at-base']);
});

test('no lineage without a ledger, or when the generation is current or ahead', () => {
  assert.equal(buildStaleBaseLineage({ certificate, ledger: null, witnesses: [], srcRev: 14, documentEpoch: 3 }), null);
  assert.equal(buildStaleBaseLineage({ certificate, ledger, witnesses: [], srcRev: 10, documentEpoch: 3 }), null);
  const bare = buildStaleBaseLineage({ certificate, ledger, witnesses: [], srcRev: 12, documentEpoch: 3 });
  assert.ok(bare, 'without witnesses the ledger alone still admits untouched blocks');
  assert.equal(bare.blocks.size, 0);
});

test('the ring keeps insertion order and a bounded size', () => {
  const ring = new Map();
  for (let i = 0; i < 70; i += 1) ringSet(ring, i, i, 64);
  assert.equal(ring.size, 64);
  assert.equal(ring.keys().next().value, 6);
  ringSet(ring, 6, 'again', 64);
  assert.equal([...ring.keys()].at(-1), 6, 're-inserting moves the key to the newest end');
});
