import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shippingPriorityQuietMs } from '../engine/checkpoint/interactive-priority.js';
import { CanonicalRenderer } from '../engine/checkpoint/canonical.js';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

function engine(overrides = {}) {
  return {
    mode: 'structured',
    preHash: 'preamble',
    shipDisabledFor: null,
    shipping: { baselineReady: true, disposed: false },
    ...overrides,
  };
}

test('complete replay receives a guard beyond the visible publish cutoff', () => {
  const previousCutoff = process.env.TDOM_SHIP_WAVE_CUTOFF;
  const previousQuiet = process.env.TDOM_SHIP_PRIORITY_QUIET_MS;
  try {
    delete process.env.TDOM_SHIP_PRIORITY_QUIET_MS;
    process.env.TDOM_SHIP_WAVE_CUTOFF = '850';
    assert.equal(shippingPriorityQuietMs(engine(), 120), 900);
    assert.equal(shippingPriorityQuietMs(engine(), 1200), 1200);
  } finally {
    if (previousCutoff == null) delete process.env.TDOM_SHIP_WAVE_CUTOFF;
    else process.env.TDOM_SHIP_WAVE_CUTOFF = previousCutoff;
    if (previousQuiet == null) delete process.env.TDOM_SHIP_PRIORITY_QUIET_MS;
    else process.env.TDOM_SHIP_PRIORITY_QUIET_MS = previousQuiet;
  }
});

test('fallback cadence is unchanged without an eligible shipping baseline', () => {
  assert.equal(shippingPriorityQuietMs(engine({ shipping: null }), 300), 300);
  assert.equal(
    shippingPriorityQuietMs(engine({ shipping: { baselineReady: false, disposed: false } }), 120),
    120
  );
  assert.equal(shippingPriorityQuietMs(engine({ mode: 'opaque' }), 350), 350);
  assert.equal(shippingPriorityQuietMs(engine({ shipDisabledFor: 'preamble' }), 300), 300);
});

test('priority window remains configurable for timing stress tests', () => {
  const previous = process.env.TDOM_SHIP_PRIORITY_QUIET_MS;
  try {
    process.env.TDOM_SHIP_PRIORITY_QUIET_MS = '975';
    assert.equal(shippingPriorityQuietMs(engine(), 120), 975);
  } finally {
    if (previous == null) delete process.env.TDOM_SHIP_PRIORITY_QUIET_MS;
    else process.env.TDOM_SHIP_PRIORITY_QUIET_MS = previous;
  }
});

test('authority foreground lease is bounded and never applies to opaque display work', async () => {
  const workDir = mkdtempSync(path.join(os.tmpdir(), 'tdom-authority-lease-'));
  const renderer = new CanonicalRenderer({ workDir });
  try {
    assert.equal(renderer.deferAuthority(20), true);
    assert.equal(renderer.info().authorityPaused, false, 'no child means no stopped process');
    await new Promise((resolve) => setTimeout(resolve, 35));
    assert.equal(renderer.info().authorityPaused, false);
    renderer.pressure = 'display';
    assert.equal(renderer.deferAuthority(20), false, 'opaque display compile remains foreground');
  } finally {
    renderer.dispose();
    rmSync(workDir, { recursive: true, force: true });
  }
});

test('manual Build lease holds the newest canonical job and releases it idempotently', async () => {
  const workDir = mkdtempSync(path.join(os.tmpdir(), 'tdom-build-lease-'));
  const renderer = new CanonicalRenderer({ workDir, debounceMs: 60_000 });
  try {
    renderer.schedule('first source', 1);
    const acquired = renderer.acquireBuildLease('build:1', 10_000);
    assert.equal(acquired.acquired, true);
    assert.equal(renderer.info().scheduledInMs, null);
    assert.equal(renderer.info().buildLease.requestId, 'build:1');

    renderer.schedule('newest source', 2);
    assert.equal(renderer.info().scheduledRev, 2);
    assert.equal(renderer.info().scheduledInMs, null, 'no canonical child starts while Build owns heavy TeX');
    assert.deepEqual(renderer.acquireBuildLease('build:1', 10_000), { ...acquired, idempotent: true });
    assert.equal(renderer.acquireBuildLease('build:2', 10_000).reason, 'lease-busy');
    assert.equal(renderer.releaseBuildLease('build:1', 'wrong').reason, 'lease-mismatch');

    const released = renderer.releaseBuildLease('build:1', acquired.token);
    assert.equal(released.released, true);
    assert.ok(renderer.info().scheduledInMs >= 0, 'the retained newest job is rearmed');
    assert.deepEqual(renderer.releaseBuildLease('build:1', acquired.token), {
      released: true,
      alreadyReleased: true,
      reason: 'released',
    });
  } finally {
    renderer.dispose();
    rmSync(workDir, { recursive: true, force: true });
  }
});

test('an interrupted canonical compile discards partial aux without deleting its source', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'tdom-canonical-partial-'));
  const bin = path.join(root, 'bin');
  const workDir = path.join(root, 'work');
  mkdirSync(bin);
  mkdirSync(workDir);
  const fake = path.join(bin, 'lualatex');
  writeFileSync(fake, `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const i = process.argv.indexOf('-output-directory');
const out = process.argv[i + 1];
fs.mkdirSync(path.join(out, 'chapter'), { recursive: true });
fs.writeFileSync(path.join(out, 'canon.aux'), 'partial');
fs.writeFileSync(path.join(out, 'chapter', 'one.aux'), 'partial');
process.stderr.write('interrupted fake compiler');
process.exit(1);
`);
  chmodSync(fake, 0o755);
  const priorPath = process.env.PATH;
  process.env.PATH = `${bin}${path.delimiter}${priorPath || ''}`;
  const renderer = new CanonicalRenderer({ workDir, docDir: workDir });
  try {
    await assert.rejects(renderer.ensure('source retained for diagnosis', 1), /interrupted fake compiler/);
    assert.equal(existsSync(path.join(workDir, 'canon.aux')), false);
    assert.equal(existsSync(path.join(workDir, 'chapter', 'one.aux')), false);
    assert.equal(existsSync(path.join(workDir, 'canon.tex')), true);
  } finally {
    renderer.dispose();
    process.env.PATH = priorPath;
    rmSync(root, { recursive: true, force: true });
  }
});

test('manual Build lease pauses a real canonical child and converges to an edit after release', {
  timeout: 30_000,
}, async () => {
  const workDir = mkdtempSync(path.join(os.tmpdir(), 'tdom-build-lease-real-'));
  const renderer = new CanonicalRenderer({ workDir, docDir: workDir, debounceMs: 0, idleMs: 0 });
  const document = (marker) => [
    '\\documentclass{article}',
    '\\directlua{local until_time=os.clock()+0.5; while os.clock()<until_time do end}',
    '\\begin{document}',
    marker,
    '\\end{document}',
    '',
  ].join('\n');
  try {
    renderer.schedule(document('before lease'), 1);
    const deadline = Date.now() + 5_000;
    while (renderer.info().authorityChildren === 0) {
      assert.ok(Date.now() < deadline, 'canonical child did not start');
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const lease = renderer.acquireBuildLease('build:real', 10_000);
    assert.equal(lease.acquired, true);
    assert.equal(renderer.info().authorityPaused, true);
    renderer.schedule(document('edited while leased'), 2);
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(renderer.info().id, 0, 'paused child cannot publish during Build');
    assert.equal(renderer.info().scheduledRev, 2, 'the live edit remains queued');

    assert.equal(renderer.releaseBuildLease('build:real', lease.token).released, true);
    await renderer.settle();
    assert.equal(renderer.info().rev, 2);
    assert.match((await renderer.pageTexts()).join('\n'), /edited while leased/);
  } finally {
    renderer.dispose();
    rmSync(workDir, { recursive: true, force: true });
  }
});
