import test from 'node:test';
import assert from 'node:assert/strict';
import { OpenRequestCache, openRequestIdentity } from '../engine/open-request-cache.js';

test('open request tokens join one in-flight operation and replay its completed result', async () => {
  const cache = new OpenRequestCache(2);
  let release;
  let runs = 0;
  const blocked = new Promise((resolve) => { release = resolve; });
  const operation = async () => {
    runs += 1;
    await blocked;
    return { documentEpoch: 7 };
  };

  const first = cache.run('request-1', 'document-a', operation);
  const retry = cache.run('request-1', 'document-a', operation);
  assert.strictEqual(first, retry);
  release();
  assert.deepEqual(await first, { documentEpoch: 7 });
  assert.deepEqual(await cache.run('request-1', 'document-a', operation), { documentEpoch: 7 });
  assert.equal(runs, 1);
});

test('open request tokens reject different payloads and new or absent tokens still run', async () => {
  const cache = new OpenRequestCache(2);
  let runs = 0;
  const operation = async () => ++runs;

  assert.equal(await cache.run('request-1', 'document-a', operation), 1);
  assert.throws(
    () => cache.run('request-1', 'document-b', operation),
    (error) => error?.code === 'OPEN_REQUEST_ID_CONFLICT'
  );
  assert.equal(await cache.run('request-2', 'document-b', operation), 2);
  assert.equal(await cache.run(null, 'document-b', operation), 3);
});

test('failed requests are retryable and completed entries are bounded', async () => {
  const cache = new OpenRequestCache(1);
  let runs = 0;
  await assert.rejects(cache.run('failed', 'document-a', async () => {
    runs += 1;
    throw new Error('failed');
  }));
  assert.equal(await cache.run('failed', 'document-a', async () => ++runs), 2);
  assert.equal(await cache.run('newer', 'document-b', async () => ++runs), 3);
  assert.equal(await cache.run('failed', 'document-a', async () => ++runs), 4);
});

test('open identity includes the effective overlay removals', () => {
  const docDir = '/project';
  const shared = {
    text: '\\documentclass{article}',
    filePath: '/project/main.tex',
    docDir,
    overlays: [
      { filePath: '/project/a.tex', text: 'A' },
      { filePath: '/project/b.tex', text: 'B' },
    ],
  };
  const full = openRequestIdentity(shared);
  const removed = openRequestIdentity({ ...shared, removeOverlays: ['/project/a.tex'] });
  const effective = openRequestIdentity({
    ...shared,
    overlays: [{ filePath: '/project/b.tex', text: 'B' }],
  });
  assert.notEqual(full, removed);
  assert.equal(removed, effective);
});

test('serialized completed responses do not follow later source mutation', async () => {
  const cache = new OpenRequestCache(1);
  const response = { documentEpoch: 7, report: { srcRev: 1 } };
  const first = await cache.run('request-1', 'document-a', async () => JSON.stringify(response));
  response.documentEpoch = 8;
  response.report.srcRev = 2;
  assert.equal(await cache.run('request-1', 'document-a', async () => 'wrong'), first);
  assert.deepEqual(JSON.parse(first), { documentEpoch: 7, report: { srcRev: 1 } });
});
