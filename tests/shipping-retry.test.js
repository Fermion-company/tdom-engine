import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  beginShippingAttempt,
  bootShipping,
  makeShippingChain,
  settleShippingBaseline,
  shippingBootDelay,
  shippingInputState,
  shippingInputSnapshot,
  shipUpdate,
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
    shippingIncludeTrace: [],
    checkpoints: new Map(),
    maxCheckpoints: 8,
    shipGenRev: new Map(),
    shipGenSnapshot: new Map(),
    shipDesiredInputSnapshot: null,
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

test('shipping boot rejects a canonical seed from an older project-input epoch', async () => {
  const engine = fakeEngine('unchanged root with changed child');
  engine.mode = 'structured';
  engine.shipping = {};
  engine.shipBooting = false;
  engine.shipBootedFor = null;
  engine.canonical = {
    inputEpoch: 2,
    sourceMatches: () => true,
    last: { id: 1, inputEpoch: 1, seedFiles: { aux: '' } },
  };
  try {
    await bootShipping(engine, {
      makeShipping: () => { throw new Error('stale canonical seed must not boot shipping'); },
      paginateNow: () => { throw new Error('stale canonical seed must not paginate'); },
      computeToc: () => { throw new Error('stale canonical seed must not seed contents'); },
      shipUpdate: () => {},
    });
    assert.equal(engine.shipRetry.state, 'waiting-canonical');
    assert.equal(engine.shipBootedFor, null);
  } finally {
    await cleanup(engine);
  }
});

test('unsupported dependency refresh never retags the old shipping generation', async () => {
  const engine = fakeEngine('same root bytes');
  engine.mode = 'structured';
  engine.shipBootedFor = engine.preHash;
  engine.shipDisabledFor = null;
  engine.shipGenRev.set(0, 1);
  engine.shipping = {
    gen: 0,
    err: null,
    resume: () => ({ mode: 'reboot-needed', reason: 'dependency-change-unobserved' }),
  };
  engine.srcRev = 2;
  let queued = 0;
  try {
    shipUpdate(engine, engine.store.get(engine.file), {
      changed: [], removed: [], unknown: true,
    }, () => queued++);
    assert.equal(engine.shipGenRev.get(0), 1);
    assert.equal(queued, 1);
    assert.ok(engine.shipDesiredInputSnapshot, 'latest unsupported snapshot still blocks an older wave');
  } finally {
    await cleanup(engine);
  }
});

test('shipping boot keeps one immutable input epoch across deferred close and open', async () => {
  const source = String.raw`\documentclass{article}
\begin{document}
\input{child.tex}
\end{document}`;
  const engine = fakeEngine(source);
  const child = path.join(engine.docDir, 'child.tex');
  writeFileSync(child, 'B\n');
  engine.mode = 'structured';
  engine.shipBootedFor = engine.preHash;
  engine.shipDisabledFor = null;
  engine.pages = [];
  engine.blockLabelIdx = new Map();
  engine.labelTable = new Map();
  engine.shipLabelOverrides = new Map();
  engine.canonical = {
    inputEpoch: 1,
    sourceMatches: () => true,
    last: { id: 11, inputEpoch: 1, pdfHash: 'canonical-B', seedFiles: { aux: 'B' } },
  };
  const setChild = (text, mtime) => {
    writeFileSync(child, text);
    engine.includes.set(child, { mtime, readPath: child, text });
    engine.shippingIncludeTrace = [{
      actualPath: child,
      readPath: child,
      command: 'input',
      raw: 'child.tex',
      depth: 0,
      parentFile: path.join(engine.docDir, engine.file),
      rootUnit: 1,
    }];
  };
  setChild('B\n', 1);

  let releaseClose;
  let releaseOpen;
  const closeGate = new Promise((resolve) => { releaseClose = resolve; });
  const openGate = new Promise((resolve) => { releaseOpen = resolve; });
  engine.shipping = {
    rootPeer: { alive: true },
    disposed: false,
    close: () => closeGate,
  };
  const opened = [];
  const resumed = [];
  const replacement = {
    gen: 0,
    err: null,
    rootPeer: null,
    disposed: false,
    open: (text, options) => {
      opened.push({ text, options });
      return openGate;
    },
    resume: (text, inputState) => {
      replacement.gen++;
      resumed.push({ text, inputState });
      return { mode: 'resumed' };
    },
  };
  let queued = 0;
  let boot;
  try {
    boot = bootShipping(engine, {
      makeShipping: () => replacement,
      paginateNow: () => [],
      computeToc: () => ({ contents: {} }),
      shipUpdate: (text, changes) => shipUpdate(engine, text, changes, () => queued++),
    });
    await Promise.resolve();
    assert.equal(engine.shipBooting, true);

    setChild('C\n', 2);
    engine.srcRev = 2;
    engine.canonical.inputEpoch = 2;
    shipUpdate(engine, source, { changed: [child], removed: [] }, () => queued++);
    const pendingC = shippingInputState(engine, { changed: [child], removed: [] });
    assert.equal(engine.shipDesiredInputSnapshot, pendingC.identity.snapshotId,
      'the latest child universe blocks the boot snapshot during close');

    releaseClose();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(opened.length, 1);
    assert.equal(opened[0].text, source);
    assert.equal(opened[0].options.inputState.dependencies[0].bytes.toString('utf8'), 'B\n');
    const bootSnapshot = opened[0].options.inputState.identity.snapshotId;
    assert.notEqual(bootSnapshot, engine.shipDesiredInputSnapshot,
      'the B boot cannot be presented as the accepted C revision');
    assert.equal(engine.shipGenRev.get(0), 1, 'generation zero keeps its captured revision');

    releaseOpen();
    await boot;
    assert.equal(resumed.length, 1);
    assert.equal(resumed[0].inputState.dependencies[0].bytes.toString('utf8'), 'C\n');
    assert.equal(engine.shipGenRev.get(1), 2);
    assert.equal(engine.shipDesiredInputSnapshot, resumed[0].inputState.identity.snapshotId);
    assert.equal(queued, 0);
  } finally {
    releaseClose?.();
    releaseOpen?.();
    await boot?.catch(() => {});
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
