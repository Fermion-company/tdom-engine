import path from 'node:path';
import { createHash } from 'node:crypto';
import { ShippingChain } from './shipping.js';
import { shippingLabelSeed } from './shipping-seeds.js';

const RETRY_LIMIT = 3;
const TRANSIENT_CODES = new Set(['EAGAIN', 'ENOMEM', 'EMFILE', 'ENFILE', 'ETIMEDOUT', 'ECONNRESET']);
const digest = (value) => createHash('sha256').update(String(value)).digest('hex');

function includeSnapshot(engine) {
  return [...(engine.includes ?? new Map())]
    .map(([name, value]) => [name, value?.mtime ?? null, digest(value?.text ?? '')])
    .sort(([a], [b]) => String(a).localeCompare(String(b)));
}

/** Immutable identity for the exact input universe available to this engine. */
export function shippingInputSnapshot(engine) {
  const source = engine.store.get(engine.file);
  const sourceHash = digest(source);
  const dependencyHash = digest(JSON.stringify(includeSnapshot(engine)));
  const executionProfileHash = digest(JSON.stringify({
    file: engine.file,
    docDir: engine.docDir,
    overlayDir: engine.overlayDir,
    workDir: engine.workDir,
    preHash: engine.preHash,
    path: process.env.PATH ?? '',
    texInputs: process.env.TEXINPUTS ?? '',
    luaInputs: process.env.LUAINPUTS ?? '',
    privatePdf: process.env.TDOM_SHIP_PRIVATE_PDF ?? '1',
  }));
  const identity = {
    sessionId: engine.shipSessionId,
    documentEpoch: engine.shipDocumentEpoch,
    sourceRevision: engine.srcRev,
    sourceHash,
    preHash: engine.preHash,
    dependencyHash,
    executionProfileHash,
    canonicalSeedId: engine.shipDesiredCanonicalId ?? null,
    canonicalSeedHash: engine.shipDesiredCanonicalHash ?? null,
  };
  return {
    ...identity,
    snapshotId: digest(JSON.stringify(identity)),
  };
}

function retryState(engine) {
  return engine.shipRetry;
}

function failureFingerprint(failureClass, snapshot) {
  const transient = failureClass === 'transient-resource';
  const scope = transient
    ? `${snapshot.documentEpoch}:${snapshot.executionProfileHash}`
    : snapshot.snapshotId;
  return `${failureClass}:${scope}`;
}

export function beginShippingAttempt(engine, chain, snapshot) {
  const retry = retryState(engine);
  const attempt = Object.freeze({
    bootAttemptId: retry.nextAttemptId++,
    chainId: chain.chainId,
    ...snapshot,
  });
  chain.bootAttempt = { ...attempt, settled: false };
  chain.retryState = retry;
  retry.state = 'booting';
  retry.activeAttemptId = attempt.bootAttemptId;
  retry.activeChainId = attempt.chainId;
  retry.desiredSnapshot = snapshot.snapshotId;
  retry.lastOutcome = 'boot-started';
  retry.recoveryReason = 'baseline-attempt-started';
  return attempt;
}

function snapshotsMatch(a, b) {
  return a.sessionId === b.sessionId &&
    a.documentEpoch === b.documentEpoch &&
    a.sourceRevision === b.sourceRevision &&
    a.sourceHash === b.sourceHash &&
    a.preHash === b.preHash &&
    a.dependencyHash === b.dependencyHash &&
    a.executionProfileHash === b.executionProfileHash &&
    a.canonicalSeedId === b.canonicalSeedId &&
    a.canonicalSeedHash === b.canonicalSeedHash &&
    a.snapshotId === b.snapshotId;
}

function clearActive(retry, attempt) {
  if (retry.activeAttemptId !== attempt.bootAttemptId || retry.activeChainId !== attempt.chainId) return false;
  retry.activeAttemptId = null;
  retry.activeChainId = null;
  return true;
}

function recordFailure(engine, attempt, failureClass, error = null) {
  const retry = retryState(engine);
  const fingerprint = failureFingerprint(failureClass, attempt);
  retry.consecutiveFailures = retry.lastFailureFingerprint === fingerprint
    ? retry.consecutiveFailures + 1
    : 1;
  retry.lastFailureClass = failureClass;
  retry.lastFailureFingerprint = fingerprint;
  retry.lastOutcome = 'failed';
  retry.recoveryReason = `baseline-failed-${failureClass}`;
  retry.state = retry.consecutiveFailures >= RETRY_LIMIT ? 'blocked-same-input' : 'idle';
  if (failureClass === 'transient-resource') {
    const backoff = [800, 2_000, 5_000][Math.min(2, retry.consecutiveFailures - 1)];
    retry.cooldownUntil = Date.now() + backoff;
    retry.state = 'cooldown';
  } else {
    retry.cooldownUntil = 0;
  }
  clearActive(retry, attempt);
  engine.shipBootTries = retry.consecutiveFailures;
  engine.diagnostics.push(
    `shipping baseline failed (${failureClass}, ${retry.consecutiveFailures}/${RETRY_LIMIT})` +
    (error ? `: ${error}` : '')
  );
}

function neutralAttempt(engine, attempt, reason) {
  const retry = retryState(engine);
  if (!clearActive(retry, attempt)) return;
  retry.state = 'idle';
  retry.lastOutcome = reason;
  retry.recoveryReason = reason;
  engine.shipBootTries = retry.consecutiveFailures;
}

/** Settle one gen-0 outcome exactly once, with no await inside the CAS. */
export function settleShippingBaseline(engine, chain, event, queueShipBoot = () => {}) {
  const attempt = chain.bootAttempt;
  if (!attempt || event.bootAttemptId !== attempt.bootAttemptId || event.chainId !== attempt.chainId) {
    engine.diagnostics.push('shipping: baseline callback identity mismatch');
    return { outcome: 'identity-mismatch' };
  }
  if (attempt.settled) {
    engine.diagnostics.push(`shipping: baseline callback duplicate (${attempt.bootAttemptId})`);
    return { outcome: 'duplicate' };
  }
  attempt.settled = true;

  const retry = retryState(engine);
  const isActive = retry.activeAttemptId === attempt.bootAttemptId &&
    retry.activeChainId === attempt.chainId;
  const current = shippingInputSnapshot(engine);
  const eventMatchesAttempt = snapshotsMatch(event, attempt) && event.baselineGeneration === 0;
  const currentMatchesAttempt = snapshotsMatch(current, attempt);
  const currentChain = chain === engine.shipping;

  if (!isActive || !currentChain || !eventMatchesAttempt) {
    engine.diagnostics.push(`shipping: stale baseline outcome ignored (${attempt.bootAttemptId})`);
    return { outcome: 'stale' };
  }

  if (event.outcome === 'CERTIFIED' && event.pdfCertificateId && currentMatchesAttempt && !engine.shipStale) {
    clearActive(retry, attempt);
    retry.state = 'ready';
    retry.consecutiveFailures = 0;
    retry.lastOutcome = 'certified-current';
    retry.lastFailureClass = null;
    retry.lastFailureFingerprint = null;
    retry.cooldownUntil = 0;
    retry.lastCertifiedSnapshot = attempt.snapshotId;
    retry.desiredSnapshot = attempt.snapshotId;
    retry.recoveryReason = 'baseline-certified-current-reset';
    engine.shipBootTries = 0;
    engine.diagnostics.push(`shipping: baseline certified current (${attempt.bootAttemptId})`);
    return { outcome: 'certified-current' };
  }

  if (event.outcome === 'CERTIFIED' && (!currentMatchesAttempt || !currentChain)) {
    neutralAttempt(engine, attempt, 'baseline-certified-superseded-neutral');
    queueShipBoot();
    return { outcome: 'certified-superseded' };
  }

  if (event.outcome === 'CERTIFIED' && engine.shipStale) {
    recordFailure(engine, attempt, 'label-divergence');
    queueShipBoot();
    return { outcome: 'failed-label-divergence' };
  }

  if (!currentMatchesAttempt) {
    neutralAttempt(engine, attempt, 'baseline-attempt-superseded-neutral');
    queueShipBoot();
    return { outcome: 'superseded' };
  }

  recordFailure(engine, attempt, event.failureClass ?? 'baseline-failure', event.error ?? null);
  return { outcome: 'failed' };
}

function classifyBootError(error) {
  return TRANSIENT_CODES.has(error?.code) ? 'transient-resource' : 'boot-exception';
}

export function shippingBootDelay(engine) {
  const retry = retryState(engine);
  const current = shippingInputSnapshot(engine);
  retry.desiredSnapshot = current.snapshotId;
  const currentFingerprint = retry.lastFailureClass
    ? failureFingerprint(retry.lastFailureClass, current)
    : null;
  if (retry.consecutiveFailures >= RETRY_LIMIT &&
      currentFingerprint === retry.lastFailureFingerprint &&
      retry.lastFailureClass !== 'transient-resource') {
    retry.state = 'blocked-same-input';
    retry.recoveryReason = 'boot-blocked-same-input-fingerprint';
    return null;
  }
  const remaining = retry.cooldownUntil - Date.now();
  if (retry.lastFailureClass === 'transient-resource' && remaining > 0) {
    retry.state = 'cooldown';
    retry.recoveryReason = 'boot-transient-cooldown';
    return Math.max(800, remaining);
  }
  if (retry.consecutiveFailures >= RETRY_LIMIT && currentFingerprint !== retry.lastFailureFingerprint) {
    retry.state = 'half-open';
    retry.recoveryReason = 'boot-half-open-input-changed';
  }
  return 800;
}

export function makeShippingChain(engine, queueShipBoot) {
  const chain = new ShippingChain({
    workDir: path.join(engine.workDir, 'ship'),
    docDir: engine.docDir,
    overlayDir: engine.overlayDir,
  });
  chain.onWave = (wave) => {
    if (engine.shipStale || chain !== engine.shipping) return;
    // The renderer's atomic batch gate needs the complete immutable-wave
    // envelope.  Dropping deadlineAt used to turn setTimeout(NaN) into an
    // immediate cancellation even though the native PDF had certified in
    // time, making the UI wait for the seven-second canonical audit.
    engine.onShipWave?.({ ...wave, srcRev: engine.shipGenRev.get(wave.gen) ?? 0 });
  };
  chain.onLabel = ({ key, val }) => {
    const known = engine.labelTable.get(key);
    const seeded = engine.shipLabelOverrides.get(key) ?? known;
    if (seeded !== undefined && String(seeded) !== String(val) && !engine.shipStale) {
      // backward effect: a label value the seeds promised has moved —
      // EARLIER pages may print stale numbers. Record the SHIP-observed
      // truth and reboot with corrected seeds (bounded: a divergence the
      // reseed cannot absorb must not loop). Until then the cold
      // canonical owns the display truth.
      engine.shipStale = true;
      engine.shipLabelOverrides.set(key, val);
      engine.diagnostics.push(`shipping: label ${key} diverged (${seeded} -> ${val}) — reseeding`);
      queueShipBoot();
    } else if (seeded === undefined) {
      engine.shipLabelOverrides.set(key, val);
    }
  };
  chain.retryState = engine.shipRetry;
  chain.onBaselineOutcome = (event) => {
    settleShippingBaseline(engine, chain, event, queueShipBoot);
  };
  return chain;
}

export async function bootShipping(engine, { makeShipping, paginateNow, computeToc, shipUpdate }) {
  if (!engine.shipping || engine.mode !== 'structured' || engine.shipBooting) return;
  engine.shipBooting = true;
  try {
    const text = engine.store.get(engine.file);
    const preHash = engine.preHash;
    const canonicalGeneration = engine.canonical.sourceMatches(text)
      ? engine.canonical.last
      : null;
    // Never certify a fast lineage from the resident paginator's inferred
    // TOC/labels.  Those are useful for provisional layout, but they are not
    // the production aux fixpoint: an untouched prefix page can otherwise
    // retain stale page numbers forever.  The cold canonical remains visible
    // until one converged generation supplies the exact aux family.
    if (!canonicalGeneration?.seedFiles) {
      const retry = retryState(engine);
      retry.state = 'waiting-canonical';
      retry.lastOutcome = 'waiting-canonical-seed';
      retry.recoveryReason = 'canonical-seed-required';
      engine.shipBootedFor = null;
      return;
    }
    engine.shipDesiredCanonicalId = canonicalGeneration.id;
    engine.shipDesiredCanonicalHash = canonicalGeneration.pdfHash ?? null;
    if (engine.shipBootedFor !== null || engine.shipping.rootPeer || engine.shipping.disposed) {
      // a previous run exists: replace the whole instance (its net server
      // and process tree die with it)
      await engine.shipping.close().catch(() => {});
      engine.shipping = makeShipping();
    }
    const prov = paginateNow();
    const labelSeed = shippingLabelSeed(
      engine.pages,
      engine.blockLabelIdx,
      engine.labelTable,
      engine.shipLabelOverrides
    );
    const toc = computeToc(prov);
    engine.shipStale = false;
    engine.shipGenRev.clear();
    engine.shipGenRev.set(0, engine.srcRev);
    const snapshot = shippingInputSnapshot(engine);
    const chain = engine.shipping;
    const attempt = beginShippingAttempt(engine, chain, snapshot);
    await engine.shipping.open(text, {
      labelSeed,
      contents: toc.contents,
      seedFiles: canonicalGeneration.seedFiles,
      baselineIdentity: attempt,
    });
    engine.shipBootedFor = preHash;
    // an edit landed while booting: converge the wave to it now
    const now = engine.store.get(engine.file);
    if (now !== text) shipUpdate(now);
  } catch (err) {
    engine.diagnostics.push('shipping boot failed: ' + err.message);
    const chain = engine.shipping;
    const attempt = chain?.bootAttempt;
    if (attempt && !attempt.settled) {
      settleShippingBaseline(engine, chain, {
        ...attempt,
        chainId: chain.chainId,
        baselineGeneration: 0,
        outcome: 'FAILED',
        failureClass: classifyBootError(err),
        error: err.message,
      }, () => {});
    }
    engine.shipBootedFor = null;
  } finally {
    engine.shipBooting = false;
  }
}

export function queueShipBoot(engine, bootShipping) {
  if (!engine.shipping || engine.shipBootTimer) return;
  const initialDelay = shippingBootDelay(engine);
  if (initialDelay === null) return;
  const arm = (delay = 800) => {
    engine.shipBootTimer = setTimeout(() => {
      engine.shipBootTimer = null;
      // a stale-but-running run is a TRUTH HARVESTER: every divergent
      // label it reports lands in shipLabelOverrides, so ONE reboot with
      // the complete truth converges. Killing it at the first divergence
      // would relearn one label per boot and exhaust the budget.
      if (engine.shipping && !engine.shipping.done && engine.shipping.rootPeer?.alive && !engine.shipping.err) {
        arm();
        return;
      }
      if (engine.shipRetry?.activeAttemptId !== null) {
        arm(50); // gen-0 PDF validation callback has not settled yet
        return;
      }
      const nextDelay = shippingBootDelay(engine);
      if (nextDelay === null) return;
      if (nextDelay > 800) {
        arm(nextDelay);
        return;
      }
      bootShipping().catch(() => {});
    }, delay);
    engine.shipBootTimer.unref?.();
  };
  arm(initialDelay);
}

/** Hot-path hook: cheap (a unit diff + one socket line). */
export function shipUpdate(engine, text, queueShipBoot) {
  if (!engine.shipping || engine.mode !== 'structured') return;
  if (engine.shipBooting) return; // boot-end convergence will catch up
  if (
    engine.shipping.err?.message?.startsWith('pdf-opened-at-root') &&
    engine.shipBootedFor === engine.preHash &&
    engine.shipDisabledFor !== engine.preHash
  ) {
    // hyperref-class document: the per-page lazy-open scheme cannot work;
    // the cold canonical owns the display. Disabled PER PREAMBLE — a
    // preamble edit (or another document) gets a fresh chance.
    engine.shipDisabledFor = engine.preHash;
    engine.diagnostics.push('shipping disabled for this preamble: ' + engine.shipping.err.message);
  }
  if (engine.shipDisabledFor === engine.preHash) return;
  if (engine.shipBootedFor !== engine.preHash || engine.shipStale || engine.shipping.err) {
    queueShipBoot();
    return;
  }
  const r = engine.shipping.resume(text);
  if (r.mode === 'resumed') {
    engine.shipGenRev.set(engine.shipping.gen, engine.srcRev);
  } else if (r.mode === 'unchanged') {
    engine.shipGenRev.set(engine.shipping.gen, engine.srcRev);
  } else if (r.mode === 'reboot-needed') {
    queueShipBoot();
  }
}
