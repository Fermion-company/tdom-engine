import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  beginShippingAttempt,
  bootShipping,
  makeShippingChain,
  settleShippingBaseline,
  shippingBootDelay,
  shippingInputSnapshot,
} from '../engine/checkpoint/shipping-manager.js';

function retryState() {
  return {
    state: 'idle',
    nextAttemptId: 1,
    activeAttemptId: null,
    activeChainId: null,
    consecutiveFailures: 0,
    lastOutcome: 'none',
    lastFailureClass: null,
    lastFailureFingerprint: null,
    cooldownUntil: 0,
    lastCertifiedSnapshot: null,
    desiredSnapshot: null,
    recoveryReason: null,
  };
}

function fakeEngine(initial = 'alpha prose') {
  let source = initial;
  const workDir = mkdtempSync(path.join(tmpdir(), 'tdom-ship-retry-'));
  const engine = {
    workDir,
    docDir: workDir,
    overlayDir: null,
    file: 'main.tex',
    preHash: 'pre-1',
    srcRev: 1,
    shipSessionId: 'session-1',
    shipDocumentEpoch: 1,
    shipRetry: retryState(),
    shipBootTries: 0,
    shipStale: false,
    diagnostics: [],
    includes: new Map(),
    store: { get: () => source },
    setSource(next) {
      source = next;
      this.srcRev++;
    },
  };
  return engine;
}

function attachChain(engine) {
  const chain = makeShippingChain(engine, () => {});
  engine.shipping = chain;
  return chain;
}

function begin(engine, chain) {
  return beginShippingAttempt(engine, chain, shippingInputSnapshot(engine));
}

function event(attempt, extra = {}) {
  return {
    ...attempt,
    chainId: attempt.chainId,
    baselineGeneration: 0,
    outcome: 'CERTIFIED',
    pdfCertificateId: `cert-${attempt.bootAttemptId}`,
    ...extra,
  };
}

async function cleanup(engine, ...chains) {
  for (const chain of chains) await chain.close().catch(() => {});
  rmSync(engine.workDir, { recursive: true, force: true });
}

test('boot start is neutral and a current certified baseline resets prior failures', async () => {
  const engine = fakeEngine();
  const chain = attachChain(engine);
  try {
    engine.shipRetry.consecutiveFailures = 2;
    engine.shipBootTries = 2;
    const attempt = begin(engine, chain);
    assert.equal(engine.shipRetry.consecutiveFailures, 2, 'starting is not a failure');
    assert.equal(settleShippingBaseline(engine, chain, event(attempt)).outcome, 'certified-current');
    assert.equal(engine.shipRetry.consecutiveFailures, 0);
    assert.equal(engine.shipBootTries, 0);
    assert.equal(engine.shipRetry.lastCertifiedSnapshot, attempt.snapshotId);
  } finally {
    await cleanup(engine, chain);
  }
});

test('duplicate certification is one-shot and cannot mutate later retry state', async () => {
  const engine = fakeEngine();
  const chain = attachChain(engine);
  try {
    const attempt = begin(engine, chain);
    assert.equal(settleShippingBaseline(engine, chain, event(attempt)).outcome, 'certified-current');
    engine.shipRetry.consecutiveFailures = 1;
    engine.shipBootTries = 1;
    assert.equal(settleShippingBaseline(engine, chain, event(attempt)).outcome, 'duplicate');
    assert.equal(engine.shipRetry.consecutiveFailures, 1);
    assert.match(engine.diagnostics.at(-1), /duplicate/);
  } finally {
    await cleanup(engine, chain);
  }
});

test('a stale success cannot erase a newer chain failure', async () => {
  const engine = fakeEngine();
  const oldChain = attachChain(engine);
  const oldAttempt = begin(engine, oldChain);
  engine.setSource('beta prose');
  const currentChain = attachChain(engine);
  const currentAttempt = begin(engine, currentChain);
  try {
    assert.equal(settleShippingBaseline(engine, currentChain, event(currentAttempt, {
      outcome: 'FAILED_DETERMINISTIC',
      failureClass: 'root-exit',
      pdfCertificateId: undefined,
    })).outcome, 'failed');
    assert.equal(engine.shipRetry.consecutiveFailures, 1);
    assert.equal(settleShippingBaseline(engine, oldChain, event(oldAttempt)).outcome, 'stale');
    assert.equal(engine.shipRetry.consecutiveFailures, 1);
    assert.equal(engine.shipRetry.lastFailureClass, 'root-exit');
  } finally {
    await cleanup(engine, oldChain, currentChain);
  }
});

test('source ABA is rejected by monotonic source revision even when bytes match', async () => {
  const engine = fakeEngine('source A');
  const chain = attachChain(engine);
  const attempt = begin(engine, chain);
  try {
    engine.shipRetry.consecutiveFailures = 2;
    engine.shipBootTries = 2;
    engine.setSource('source B');
    engine.setSource('source A');
    assert.equal(settleShippingBaseline(engine, chain, event(attempt)).outcome, 'certified-superseded');
    assert.equal(engine.shipRetry.consecutiveFailures, 2, 'stale success is neutral');
    assert.equal(engine.shipBootTries, 2);
  } finally {
    await cleanup(engine, chain);
  }
});

test('a newer production canonical seed makes an older baseline certificate stale', async () => {
  const engine = fakeEngine('source with stable bytes');
  engine.shipDesiredCanonicalId = 7;
  engine.shipDesiredCanonicalHash = 'canonical-7';
  const chain = attachChain(engine);
  const attempt = begin(engine, chain);
  try {
    engine.shipDesiredCanonicalId = 8;
    engine.shipDesiredCanonicalHash = 'canonical-8';
    assert.equal(settleShippingBaseline(engine, chain, event(attempt)).outcome, 'certified-superseded');
    assert.equal(engine.shipRetry.lastCertifiedSnapshot, null);
  } finally {
    await cleanup(engine, chain);
  }
});

test('shipping waits for a converged production seed instead of certifying inferred aux state', async () => {
  const engine = fakeEngine('source awaiting canonical');
  engine.mode = 'structured';
  engine.shipping = {};
  engine.shipBooting = false;
  engine.shipBootedFor = null;
  engine.canonical = { sourceMatches: () => false, last: null };
  try {
    await bootShipping(engine, {
      makeShipping: () => { throw new Error('must not create an unseeded lineage'); },
      paginateNow: () => { throw new Error('must not infer a production seed'); },
      computeToc: () => { throw new Error('must not infer a production seed'); },
      shipUpdate: () => {},
    });
    assert.equal(engine.shipRetry.state, 'waiting-canonical');
    assert.equal(engine.shipRetry.consecutiveFailures, 0, 'waiting is not a failed boot');
    assert.equal(engine.shipBootedFor, null);
  } finally {
    await cleanup(engine);
  }
});

test('three attributable failures block only the same snapshot and a new snapshot can recover', async () => {
  const engine = fakeEngine('broken snapshot A');
  const chains = [];
  try {
    for (let index = 0; index < 3; index++) {
      const chain = attachChain(engine);
      chains.push(chain);
      const attempt = begin(engine, chain);
      assert.equal(settleShippingBaseline(engine, chain, event(attempt, {
        outcome: 'FAILED_DETERMINISTIC',
        failureClass: 'root-exit',
        pdfCertificateId: undefined,
      })).outcome, 'failed');
    }
    assert.equal(engine.shipRetry.consecutiveFailures, 3);
    assert.equal(shippingBootDelay(engine), null, 'same broken input is circuit-broken');

    engine.setSource('valid snapshot B');
    assert.equal(shippingBootDelay(engine), 800, 'a changed immutable snapshot gets a half-open attempt');
    const recovered = attachChain(engine);
    chains.push(recovered);
    const attempt = begin(engine, recovered);
    assert.equal(settleShippingBaseline(engine, recovered, event(attempt)).outcome, 'certified-current');
    assert.equal(engine.shipRetry.consecutiveFailures, 0);
    assert.equal(engine.shipRetry.state, 'ready');
  } finally {
    await cleanup(engine, ...chains);
  }
});

test('invalid generation and mismatched identity never reset retry accounting', async () => {
  const engine = fakeEngine();
  const chain = attachChain(engine);
  const attempt = begin(engine, chain);
  try {
    engine.shipRetry.consecutiveFailures = 2;
    engine.shipBootTries = 2;
    assert.equal(settleShippingBaseline(engine, chain, event(attempt, {
      baselineGeneration: 1,
    })).outcome, 'stale');
    assert.equal(engine.shipRetry.consecutiveFailures, 2);
  } finally {
    await cleanup(engine, chain);
  }
});
