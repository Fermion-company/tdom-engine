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
  usefulShippingCutoffMs,
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

test('late shipping budget stays below the last canonical and has a hard cap', () => {
  assert.equal(usefulShippingCutoffMs(0), 700);
  assert.equal(usefulShippingCutoffMs(900), 700);
  assert.equal(usefulShippingCutoffMs(1500), 1000);
  assert.equal(usefulShippingCutoffMs(3000), 2500);
  assert.equal(usefulShippingCutoffMs(30_000), 3000);
});

test('a rejected current wave releases the canonical display fallback', async () => {
  const engine = fakeEngine();
  let released = 0;
  engine.canonical = {
    info: () => ({ ms: 3000 }),
    releaseAuthorityDeferral: () => { released++; },
  };
  const chain = attachChain(engine);
  engine.shipGenRev.set(chain.gen, engine.srcRev);
  try {
    chain.onWaveOutcome({ gen: chain.gen, outcome: 'rejected' });
    assert.equal(released, 1);
    chain.onWaveOutcome({ gen: chain.gen, outcome: 'published' });
    assert.equal(released, 1);
  } finally {
    await cleanup(engine, chain);
  }
});

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

// Since 4148b99 a baseline that certifies after the root source moved on is
// kept when everything else is the same (session, document epoch, preamble,
// dependencies, execution profile) and replayed forward to the current
// source, like a keystroke: under continuous typing every baseline used to
// be thrown away and the chain never became usable.
test('source ABA is not taken for the baseline\'s revision even when the bytes match: the baseline is replayed forward', async () => {
  const engine = fakeEngine('source A');
  const chain = attachChain(engine);
  const attempt = begin(engine, chain);
  try {
    engine.shipRetry.consecutiveFailures = 2;
    engine.shipBootTries = 2;
    engine.setSource('source B');
    engine.setSource('source A');
    let boots = 0;
    let replays = 0;
    const settled = settleShippingBaseline(engine, chain, event(attempt), () => boots++, () => replays++);
    assert.equal(settled.outcome, 'certified-behind', 'the same bytes at a later revision are not the certified revision');
    assert.equal(replays, 1, 'the baseline is carried forward to the current source');
    assert.equal(boots, 0, 'and not thrown away');
    assert.equal(engine.shipRetry.state, 'ready');
    assert.equal(engine.shipRetry.lastOutcome, 'certified-behind');
    assert.equal(engine.shipRetry.lastCertifiedSnapshot, attempt.snapshotId, 'what is certified is the snapshot it booted with');
    assert.notEqual(attempt.snapshotId, shippingInputSnapshot(engine).snapshotId);
    assert.equal(engine.shipRetry.consecutiveFailures, 0, 'a certified baseline of this lineage is a success');
    assert.equal(engine.shipBootTries, 0);
  } finally {
    await cleanup(engine, chain);
  }
});

test('a baseline built on an older production canonical seed is kept and replayed forward', async () => {
  const engine = fakeEngine('source with stable bytes');
  engine.shipDesiredCanonicalId = 7;
  engine.shipDesiredCanonicalHash = 'canonical-7';
  const chain = attachChain(engine);
  const attempt = begin(engine, chain);
  try {
    // (a canonical arrival during the build: it no longer restarts the baseline)
    engine.shipDesiredCanonicalId = 8;
    engine.shipDesiredCanonicalHash = 'canonical-8';
    let boots = 0;
    let replays = 0;
    assert.equal(settleShippingBaseline(engine, chain, event(attempt), () => boots++, () => replays++).outcome, 'certified-behind');
    assert.equal(replays, 1);
    assert.equal(boots, 0);
    assert.equal(engine.shipRetry.lastCertifiedSnapshot, attempt.snapshotId);
  } finally {
    await cleanup(engine, chain);
  }
});

test('a certified baseline of another lineage is neutral and a new baseline is asked for', async () => {
  const included = (engine, text) => {
    const file = path.join(engine.docDir, 'child.tex');
    engine.includes.set(file, { mtime: 1, readPath: file, text });
    engine.shippingIncludeTrace = [{ actualPath: file, readPath: file, command: 'input', raw: 'child.tex', depth: 0,
      parentFile: path.join(engine.docDir, engine.file), rootUnit: 1 }];
  };
  for (const [name, before, change] of [
    ['the preamble', () => {}, (engine) => { engine.preHash = 'pre-2'; }],
    ['the document epoch', () => {}, (engine) => { engine.shipDocumentEpoch = 2; }],
    ['the session', () => {}, (engine) => { engine.shipSessionId = 'session-2'; }],
    ['an included file', (engine) => included(engine, 'B\n'), (engine) => included(engine, 'C\n')],
  ]) {
    const engine = fakeEngine('source that stays');
    before(engine);
    const chain = attachChain(engine);
    const attempt = begin(engine, chain);
    try {
      engine.shipRetry.consecutiveFailures = 2;
      engine.shipBootTries = 2;
      change(engine);
      let boots = 0;
      const settled = settleShippingBaseline(engine, chain, event(attempt), () => boots++,
        () => assert.fail(`${name} changed: nothing is replayed across lineages`));
      assert.equal(settled.outcome, 'certified-superseded', name);
      assert.equal(boots, 1, name);
      assert.equal(engine.shipRetry.consecutiveFailures, 2, 'stale success is neutral');
      assert.equal(engine.shipBootTries, 2);
      assert.equal(engine.shipRetry.lastCertifiedSnapshot, null);
    } finally {
      await cleanup(engine, chain);
    }
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
  let released = 0;
  engine.canonical = { releaseAuthorityDeferral: () => { released++; } };
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
    assert.equal(released, 1);
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
    // The child edit made during the boot is held while the baseline is
    // built and validated (4148b99): nothing is replayed onto a baseline
    // that has not certified, and no reboot is asked for behind its back.
    assert.equal(resumed.length, 0);
    assert.deepEqual(engine.shipPendingInputChanges?.projectInputChanges, { changed: [child], removed: [] });
    assert.equal(engine.shipDesiredInputSnapshot, pendingC.identity.snapshotId, 'the newest input stays the one wanted');
    assert.equal(engine.shipGenRev.get(0), 1);
    assert.equal(queued, 0);
    // The baseline certifies for the B universe. Another included file is
    // another lineage: it is not replayed forward, a new baseline is asked for.
    const settled = settleShippingBaseline(engine, replacement, event(replacement.bootAttempt), () => queued++,
      () => assert.fail('a dependency changed: the baseline is not replayed'));
    assert.equal(settled.outcome, 'certified-superseded');
    assert.equal(queued, 1);
    assert.equal(resumed.length, 0, 'the B baseline is never presented as the C revision');
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
