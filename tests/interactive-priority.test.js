import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shippingPriorityQuietMs } from '../engine/checkpoint/interactive-priority.js';
import { CanonicalRenderer } from '../engine/checkpoint/canonical.js';
import { mkdtempSync, rmSync } from 'node:fs';
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
