import { test } from 'node:test';
import assert from 'node:assert/strict';
import { observePublication, observeCanonicalPublication } from '../tools/publication.mjs';

function fixture(commands) {
  const dl = { hash: 'new-page', commands };
  const sample = { srcRev: 2, started: 100, targets: [{ id: 'b1', oldHash: 'old', publishedMs: null }] };
  const engine = { srcRev: 2, blocks: [{ id: 'b1', hash: 'new', galley: {} }],
    coldDirty: new Set(), chunks: new Map(), pages: [{ number: 1, dl }] };
  const report = { patches: [{ type: 'replace-page', page: 1, displayList: dl }] };
  return { sample, engine, report };
}

test('publication observes a current paintable page, not an old revision', () => {
  const { sample, engine, report } = fixture([{ op: 'glyphs', src: 'b1', text: 'new' }]);
  engine.srcRev = 1;
  observePublication(engine, sample, report, 120);
  assert.equal(sample.targets[0].publishedMs, null);
  engine.srcRev = 2;
  observePublication(engine, sample, report, 140);
  assert.equal(sample.targets[0].publishedMs, 40);
  assert.equal(sample.targets[0].channel, 'resident');
});

test('blocked pages wait for the current canonical publication', () => {
  for (const neighbour of [{ op: 'pending-exact' }, { op: 'glyphs', math: 1 }, { op: 'chunk', chunk: 'absent' }]) {
    const { sample, engine, report } = fixture([{ op: 'glyphs', src: 'b1' }, neighbour]);
    observePublication(engine, sample, report, 120);
    assert.equal(sample.targets[0].publishedMs, 20);
    assert.equal(sample.targets[0].pagePublishedMs, undefined);
    observeCanonicalPublication(sample, { rev: 1, id: 'old' }, 130);
    observeCanonicalPublication(sample, { rev: 2, id: 'failed', error: 'compile failed' }, 135);
    assert.equal(sample.targets[0].pagePublishedMs, undefined);
    observeCanonicalPublication(sample, { rev: 2, id: 'current' }, 150);
    assert.equal(sample.targets[0].publishedMs, 20);
    assert.equal(sample.targets[0].pagePublishedMs, 50);
    assert.equal(sample.targets[0].pageChannel, 'canonical');
  }
});

test('a stale or held target chunk is not a fresh block publication', () => {
  const { sample, engine, report } = fixture([{ op: 'chunk', src: 'b1', chunk: 'b1', cv: 2 }]);
  Object.assign(engine.blocks[0], { needsRender: true, galleyHash: 'new-galley', fidelity: { blockExact: true } });
  engine.chunks.set('b1', { v: 2, forGalley: 'old-galley' });
  observePublication(engine, sample, report, 120);
  assert.equal(sample.targets[0].publishedMs, null);
  engine.chunks.set('b1', { v: 2, forGalley: 'new-galley' });
  report.patches[0].displayList.commands[0].held = 1;
  observePublication(engine, sample, report, 130);
  assert.equal(sample.targets[0].publishedMs, null);
  delete report.patches[0].displayList.commands[0].held;
  observePublication(engine, sample, report, 140);
  assert.equal(sample.targets[0].publishedMs, 40);
});
