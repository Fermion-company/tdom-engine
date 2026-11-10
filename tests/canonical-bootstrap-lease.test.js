import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { CanonicalRenderer } from '../engine/checkpoint/canonical.js';
import { CheckpointEngine } from '../engine/checkpoint/engine-v3.js';
import { acquirePreviewBuildLease, withReplaceablePreviewJob } from '../engine/checkpoint/build-lease-preview.js';

for (const phase of ['document-reset', 'shipping-boot', 'warming']) {
  test(`Build during ${phase} refuses promptly without stopping bootstrap, then grants`, async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'tdom-bootstrap-lease-'));
    const canonical = new CanonicalRenderer({ workDir: dir });
    let reset = phase === 'document-reset';
    const engine = { canonical, buildLeasePreviewJobs: new Set(),
      shipBooting: phase === 'shipping-boot', warming: phase === 'warming',
      async yieldWarmForBuild({ timeoutMs }) { assert.equal(timeoutMs, 250); } };
    const acquire = () => acquirePreviewBuildLease(engine, {
      requestId: 'bootstrap-build', ttlMs: 5000, documentReset: () => reset,
    });
    try {
      assert.deepEqual(await acquire(), { ok: false, acquired: false,
        reason: 'resident-bootstrap-active', blockedBy: phase, retryAfterMs: 250 });
      assert.equal(canonical.buildLease, null);
      let completed = 0;
      await withReplaceablePreviewJob(engine, 'bootstrap', async () => completed++);
      assert.equal(completed, 1, 'fallback does not strand bootstrap behind a remote gate');
      reset = engine.shipBooting = engine.warming = false;
      const lease = await acquire();
      assert.equal(lease.acquired, true);
      let resumed = false;
      const pending = withReplaceablePreviewJob(engine, 'preview', async () => { resumed = true; });
      await Promise.resolve();
      assert.equal(resumed, false);
      canonical.releaseBuildLease(lease.requestId, lease.token);
      await pending;
      assert.equal(resumed, true);
      assert.equal(engine.buildLeasePreviewJobs.size, 0);
    } finally { canonical.dispose(); rmSync(dir, { recursive: true, force: true }); }
  });
}

test('a warm boundary yields directly to Build; a reset appearing during yield still refuses', async () => {
  let reset = false;
  let grants = 0;
  const engine = { warming: true,
    canonical: { acquireBuildLease() { grants++; return { acquired: true }; } },
    async yieldWarmForBuild() { this.warming = false; } };
  const acquire = () => acquirePreviewBuildLease(engine, { documentReset: () => reset });
  assert.equal((await acquire()).acquired, true);
  engine.warming = true;
  engine.yieldWarmForBuild = async () => { engine.warming = false; reset = true; };
  assert.equal((await acquire()).blockedBy, 'document-reset');
  assert.equal(grants, 1);
});

for (const superseded of [false, true]) {
  test(`a timed-out warm yield ${superseded ? 'leaves newer work alone' : 'resumes once after Build'}`, async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const dir = mkdtempSync(path.join(tmpdir(), 'tdom-warm-build-'));
    const engine = new CheckpointEngine({ workDir: dir });
    let finish;
    const task = new Promise(resolve => { finish = resolve; });
    Object.assign(engine, { warming: true, bgTask: task,
      warmInfo: { sourceRev: engine.srcRev, offset: 42, file: 'main.tex' } });
    let resumes = 0;
    engine.warmEditOffset = async (offset, file) => {
      assert.equal(offset, 42); assert.equal(file, 'main.tex'); resumes++;
    };
    try {
      const waiting = engine.yieldWarmForBuild({ timeoutMs: 250 });
      const repeated = engine.yieldWarmForBuild({ timeoutMs: 250 });
      t.mock.timers.tick(250);
      assert.equal((await waiting).yielded, false);
      await repeated;
      const lease = engine.canonical.acquireBuildLease('warm-build', 5000);
      engine.warming = false;
      if (superseded) engine.warmSeq++;
      finish();
      await new Promise(resolve => setImmediate(resolve));
      t.mock.timers.tick(0);
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(resumes, 0);
      engine.canonical.releaseBuildLease(lease.requestId, lease.token);
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(resumes, superseded ? 0 : 1);
      if (!superseded) assert.equal(engine.bgAbort, false);
    } finally { await engine.close(); rmSync(dir, { recursive: true, force: true }); }
  });
}
