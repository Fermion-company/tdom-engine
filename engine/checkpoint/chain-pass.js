import { performance } from 'node:perf_hooks';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { resolvedInGalley } from './util/galley.js';
import { endWalkRetain } from './walk-preemption.js';

/**
 * The deferred chain pass. 'settle': re-typeset forward from the stop
 * point until a clean block reproduces its galley AND exit state exactly
 * (the moving counters have been chased to convergence). 'rebuild': same
 * walk but to the end of the document — after a definition edit or an
 * untracked-state leak no early convergence can be trusted. Both are
 * resumable: bgAbort (set by the next edit) exits between blocks with
 * work.from advanced, and the pass re-runs after that edit's own
 * foreground. Changed galleys stream to the client through the async
 * patch channel; stale galleys stay on screen meanwhile (old-but-clean
 * beats fast-but-wrong, and canonical owns the final pixels regardless).
 */
export async function runChainPass(engine, callbacks) {
  const {
    nearestCheckpoint,
    typesetBlock,
    adoptGalley,
    queueRender,
    asyncRepaginate,
    chainAfterPass,
    enforceCheckpointCap,
    retypesetChain,
    pinBoundary,
    gridMissing,
  } = callbacks;
  const work = engine.pendingChain;
  if (!work) return;
  engine.bgActive = true;
  try {
    if (work.kind === 'grid') {
      // Materialize keep-set boundaries that have no resident continuation
      // (docs/03). Each target is reached by the same consuming STEP replay
      // as the cold walk, from the nearest boundary below it; the fork at
      // the target stays because the keep set holds it, and the cap then
      // retires the near-miss neighbour the boot walk left instead. Lowest
      // priority: any other chain work replaces it, an edit or a caret warm
      // stops it at the next block boundary, and it resumes on the next
      // idle gate. Bounded per pass so a keep set that keeps moving with
      // fresh cost samples cannot spin.
      // A queued rescue waiting to adopt (engine #asyncRescueOne) fixes a
      // page on screen now; a grid boundary only speeds up a later cold
      // edit. Yield to it at the next block boundary as to an edit.
      const yieldGrid = () => engine.bgAbort || engine.editPending > 0 || engine.rescueAdoptWaiting > 0;
      let budget = work.budget ?? Infinity;
      while (budget-- > 0) {
        if (yieldGrid()) return;
        const missing = gridMissing();
        if (!missing.length) break;
        // A boundary this plan already materialized is missing again: the
        // resident cap (shared with shipping) retired it, so filling would
        // only churn forks. Stall until the plan changes.
        if (missing.some((idx) => engine.gridFill.given.has(idx))) {
          engine.gridFill.stalled = true;
          break;
        }
        const target = missing[0];
        const from = nearestCheckpoint(target);
        if (from >= target) break;
        const startedAt = performance.now();
        if (process.env.TDOM_TRACE_GRID) console.error('[grid] walk', JSON.stringify({ from, target, missing: missing.length, t: Math.round(performance.now()) }));
        engine.progress = { phase: 'grid', at: from + 1, total: target };
        engine.coldWalking = true; // killed mid-block only by an edit elsewhere (see #update)
        engine.bgWalkTarget = target;
        let n;
        try {
          n = await retypesetChain(
            from,
            target - 1,
            (j) => { engine.progress = { phase: 'grid', at: j + 2, total: target }; },
            yieldGrid
          );
        } finally {
          engine.coldWalking = false;
          engine.bgWalkTarget = null;
        }
        const reached = from + (n < 0 ? -n - 1 : n);
        if (process.env.TDOM_TRACE_GRID) console.error('[grid] done', JSON.stringify({ from, target, reached, n, abort: engine.bgAbort, has: engine.checkpoints.has(target), t: Math.round(performance.now()) }));
        engine.gridFill.passes++;
        engine.gridFill.ms += Math.round(performance.now() - startedAt);
        engine.gridFill.last = { from, target, reached, at: Date.now() };
        if (n < 0 || yieldGrid()) {
          pinBoundary(reached);
          return; // resumes from the pinned boundary on the next idle gate
        }
        if (!engine.checkpoints.has(target)) break; // refused or retired at once: stop the churn
        engine.gridFill.materialized++;
        engine.gridFill.given.add(target);
        enforceCheckpointCap();
      }
      if (engine.pendingChain === work) engine.pendingChain = null;
      return;
    }
    if (work.kind === 'cold') {
      if (engine.coldTrace) engine.coldTrace.passLockAt = performance.now();
      // Cold resume (docs/10 §10.4a): finish the sparse replay a budgeted
      // keystroke stopped, up to the first block whose galley predates its
      // text. The replay consumes its own continuations (STEP) exactly like
      // the foreground prefix walk; an edit aborts it between blocks and the
      // boundary it reached is pinned so the next pass resumes there. When
      // the input boundary of that block is live, the scheduler re-runs the
      // update outside this lock ('resume'); a pending settle/rebuild that
      // was queued before is carried through and re-queued by that update.
      if (work.phase === 'blocks') {
        // Every block is typeset already when another walk (a caret warm)
        // passed over it: nothing to replay, but the keystroke still owes
        // its report and anchor — go straight to the resume.
        const target = engine.blocks.findIndex((block) => engine.coldDirty?.has(block.id));
        const from = target < 0 ? -1 : nearestCheckpoint(target);
        if (target >= 0 && from < target) {
          engine.progress = { phase: 'cold', at: from + 1, total: target };
          // Not killed mid-block by an edit of the same file (see #update):
          // it sets bgAbort and the walk returns at its next boundary, which
          // stays live.
          engine.coldWalking = true;
          engine.bgWalkTarget = target;
          engine.walkRetains = true;
          engine.walkRetainedAt = performance.now();
          engine.walkRetainedIdx = null;
          // walk telemetry for the deferred report (docs/10 §10.4a): where
          // the replay started, how far it got, and each block's cost
          const walkStartedAt = performance.now();
          let lastAt = walkStartedAt;
          engine.coldWalkTrace = []; // report timing only
          const perBlockMs = [];
          let n;
          try {
            n = await retypesetChain(
              from,
              target - 1,
              (j) => {
                engine.progress = { phase: 'cold', at: j + 2, total: target };
                const now = performance.now();
                perBlockMs.push(Math.round(now - lastAt));
                engine.coldWalkTrace?.push([j, Math.round(now - lastAt), engine.blocks[j]?.rescued ? 'r' : '']);
                lastAt = now;
              },
              () => engine.bgAbort || engine.editPending > 0
            );
          } finally {
            engine.coldWalking = false;
            engine.bgWalkTarget = null;
            endWalkRetain(engine);
          }
          const reached = from + (n < 0 ? -n - 1 : n);
          const prev = engine.coldWalk?.target === target ? engine.coldWalk : null;
          engine.coldWalk = {
            from: prev?.from ?? from,
            target,
            walked: (prev?.walked ?? 0) + perBlockMs.length,
            ms: (prev?.ms ?? 0) + Math.round(performance.now() - walkStartedAt),
            passes: (prev?.passes ?? 0) + 1,
            perBlockMs: [...(prev?.perBlockMs ?? []), ...perBlockMs].slice(-128),
          };
          pinBoundary(reached);
          if (engine.coldTrace) engine.coldTrace.walkDoneAt = performance.now();
          if (n < 0 || engine.bgAbort) return;
        }
        work.phase = 'resume';
      }
      return;
    }
    if (work.phase === 'blocks') {
      let sinceRepaint = 0;
      // highest galley-less index at pass start — the walk fills galleys at
      // its own index only, so "holes at >= j" is j <= lastNoGalley (the
      // old per-block suffix scan was O(blocks²) over a long settle)
      let lastNoGalley = -1;
      for (let k = engine.blocks.length - 1; k >= 0; k--) {
        if (!engine.blocks[k].galley) {
          lastNoGalley = k;
          break;
        }
      }
      let j = nearestCheckpoint(Math.min(work.from, engine.blocks.length));
      // Blocks below `from` only replay up to the first stale entry state
      // (its boundary can have retired): reproducing one proves nothing.
      const staleFrom = work.from;
      while (j < engine.blocks.length) {
        if (engine.bgAbort) {
          work.from = Math.min(work.from, j);
          return;
        }
        engine.progress = { phase: 'chain', at: j + 1, total: engine.blocks.length };
        const block = engine.blocks[j];
        // a cold preview is no witness of the block's own typeset (docs/10 §10.4b)
        const before = { hash: block.galley?.tdomColdPreview ? null : block.galleyHash, state: block.stateVec, hadGalley: !!block.galley };
        let galley;
        try {
          galley = await typesetBlock(j);
        } catch {
          work.from = Math.min(work.from, j);
          return; // killed by an incoming edit — resume afterwards
        }
        adoptGalley(block, galley);
        for (const l of galley.labels ?? []) {
          if (engine.labelTable.get(l.k) !== l.v) {
            work.labels.add(l.k);
            engine.labelTable.set(l.k, l.v);
          }
          if (l.h != null) engine.hrefTable.set(l.k, l.h);
        }
        const changed = block.galleyHash !== before.hash || block.stateVec !== before.state;
        if (changed) {
          delete work.plainBlockId;
          if (block.needsRender) queueRender(block.id);
          if (++sinceRepaint >= 8) {
            asyncRepaginate();
            sinceRepaint = 0;
          }
        }
        j++;
        work.from = Math.max(work.from, j);
        if (work.kind === 'settle' && before.hadGalley && !changed && j > lastNoGalley && j > staleFrom) {
          break; // exit state converged — the untouched suffix is exact
        }
      }
      if (sinceRepaint) asyncRepaginate();
      work.phase = 'after';
    }
    if (engine.bgAbort) return;
    await chainAfterPass(work);
    if (engine.bgAbort) return;
    if (engine.pendingChain === work) engine.pendingChain = null;
  } finally {
    engine.bgActive = false;
    engine.progress = null;
    // the settle/rebuild/after walks left checkpoints at every block they
    // re-typeset — collapse back to the grid
    enforceCheckpointCap();
  }
}

/**
 * Post-settle dependency passes — the async twins of the foreground's
 * inline backward-reference and toc sections, run once the suffix state
 * has stopped moving. Abortable and re-entrant (work.phase = 'after').
 */
export async function chainAfterPass(engine, work, callbacks) {
  const { nearestCheckpoint, retypesetChain, paginateNow, computeToc, queueMovedOffsets, asyncRepaginate } =
    callbacks;
  const changedLabels = work.labels;
  if (changedLabels.size) {
    const candidates = new Set();
    for (const k of changedLabels) {
      for (const bid of engine.refIndex.get(k) ?? []) candidates.add(bid);
    }
    for (let c = 0; c < engine.blocks.length && candidates.size; c++) {
      if (engine.bgAbort) return;
      const block = engine.blocks[c];
      if (!candidates.has(block.id)) continue;
      candidates.delete(block.id);
      const hit = (block.galley?.refs ?? []).some(
        (k) => changedLabels.has(k) && !resolvedInGalley(block, k, engine.labelTable)
      );
      if (!hit) continue;
      const n = await retypesetChain(nearestCheckpoint(c), c, () => {}, () => engine.bgAbort);
      if (n < 0) return;
    }
  }
  for (let pass = 0; pass < 3; pass++) {
    if (engine.bgAbort) return;
    const prov = paginateNow();
    const toc = computeToc(prov);
    if (toc.hash === engine.tocHash) break;
    engine.tocHash = toc.hash;
    for (const [ext, content] of Object.entries(toc.contents)) {
      writeFileSync(path.join(engine.workDir, `driver.${ext}`), content);
    }
    let anyConsumer = false;
    for (let c = 0; c < engine.blocks.length; c++) {
      if (engine.bgAbort) return;
      const block = engine.blocks[c];
      if (!block.consumesToc) continue;
      anyConsumer = true;
      const n = await retypesetChain(nearestCheckpoint(c), c, () => {}, () => engine.bgAbort);
      if (n < 0) return;
    }
    if (!anyConsumer) break;
  }
  queueMovedOffsets();
  asyncRepaginate();
}
