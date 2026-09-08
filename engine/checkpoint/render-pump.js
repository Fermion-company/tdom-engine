import { renderResidentBlock } from './resident-render.js';
import { shippingPriorityQuietMs } from './interactive-priority.js';

/** Exact pixels are replaceable latency work. A new edit must not wait behind
 * boot/backlog renders that already occupy every pump lane. Cancel resident
 * render children while the update lock is held. Queued block ids stay in
 * the latest-wins map: the edit will reinsert its own block at the newest
 * position, then unchanged boot/backlog work can resume after the quiet gate
 * instead of being lost forever. Isolated `iso@` compiles are cache-producing
 * work and continue separately. */
export function preemptResidentRenders(engine) {
  for (const [requestId, pid] of [...(engine.renderPids ?? [])]) {
    if (!requestId.startsWith('rr@')) continue;
    if (pid > 0) {
      try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
    } else {
      engine.cancelledRenderIds.add(requestId);
    }
    const err = new Error(`resident render superseded by edit: ${requestId}`);
    err.tdomSuperseded = true;
    engine._reject('render:' + requestId, err);
    engine.renderPids.delete(requestId);
  }
}

/**
 * High-fidelity chunk scheduler. Latest-wins per block (a superseded
 * galley is never rendered — renderBlock reads the block's CURRENT hash),
 * newest-queued block first (the one being edited), bounded concurrency
 * (an edit burst or a math-heavy boot must not fork a lualatex/pdftocairo
 * storm — CPU saturation slows the resident fork jobs by orders of
 * magnitude), paused while a foreground update runs.
 */
export function queueRender(engine, blockId, callbacks, { interactiveRev = null } = {}) {
  // audits compare block identity (galleyHash + stateVec) — the exact
  // preview chunks the RENDER tier produces never enter the equation,
  // while its fork holds cost ~500MB each on Linux (the Lua GC dirties
  // every COW page, materializing the full heap per resident)
  if (process.env.TDOM_NO_RENDER === '1') return;
  const previous = engine.renderWant.get(blockId);
  const currentRev = Number.isSafeInteger(engine.srcRev) && engine.srcRev > 0 ? engine.srcRev : null;
  // A later chain/backlog enqueue must not demote this edit's foreground
  // cohort. The revision tag expires at the next source update by itself.
  const currentInteractive = currentRev !== null &&
    (interactiveRev === currentRev || previous?.interactiveRev === currentRev) ? currentRev : null;
  engine.renderWant.delete(blockId); // re-insertion moves it to the back = newest
  engine.renderWant.set(blockId, { interactiveRev: currentInteractive });
  if (currentInteractive !== null) {
    if (engine.interactiveRenderCohort?.rev !== currentInteractive) {
      engine.interactiveRenderCohort = {
        rev: currentInteractive, queued: new Set(), active: new Set(), settledAt: null, unavailable: false,
      };
    }
    engine.interactiveRenderCohort.queued.add(blockId);
    engine.interactiveRenderCohort.settledAt = null;
  }
  pumpRenders(engine, callbacks);
}

function pumpRenders(engine, callbacks) {
  const MAX = Number(process.env.TDOM_RENDER_CONCURRENCY || 2);
  if (engine.renderPumping >= MAX) return;
  engine.renderPumping++;
  const drain = (async () => {
    try {
      while (engine.renderWant.size) {
        if (engine.updating) {
          await new Promise((r) => setTimeout(r, 25));
          continue;
        }
        // The foreground's complete cohort supplies the next editable ink.
        // Prioritize it over newer cold work, including changed neighbors
        // needed by the viewer's atomic page commit. Backlog retains the
        // shipping priority window; an edit only waits for its own debounce.
        let id, interactive = false;
        for (const [candidate, queued] of engine.renderWant) {
          const current = Number.isSafeInteger(queued?.interactiveRev) && queued.interactiveRev > 0 &&
            queued.interactiveRev === engine.srcRev;
          if (current || !interactive) {
            id = candidate;
            interactive = current;
          }
        }
        const configuredQuiet = Number(process.env.TDOM_RENDER_QUIET_MS ?? 120);
        const renderQuiet = Number.isFinite(configuredQuiet) ? Math.max(0, configuredQuiet) : 120;
        const quietMs = interactive ? renderQuiet : shippingPriorityQuietMs(engine, renderQuiet);
        const remaining = quietMs - (Date.now() - (engine.lastEditAt ?? 0));
        if (remaining > 0) {
          await new Promise((r) => setTimeout(r, Math.min(25, remaining)));
          continue;
        }
        engine.renderWant.delete(id);
        const cohort = interactive && engine.interactiveRenderCohort?.rev === engine.srcRev
          ? engine.interactiveRenderCohort : null;
        const activity = cohort ? {} : null;
        if (cohort) {
          cohort.queued.delete(id);
          cohort.active.add(activity);
        }
        const block = engine.blocks.find((b) => b.id === id);
        try {
          if (!block || !block.galley) {
            if (cohort) cohort.unavailable = true;
            continue;
          }
          if (!block.needsRender) continue;
          const ready = await renderBlock(engine, block, callbacks).catch((err) => {
            if (!err?.tdomSuperseded) engine.diagnostics.push(`render ${id}: ${err?.message ?? err}`);
            return false;
          });
          if (cohort && !ready) cohort.unavailable = true;
        } finally {
          if (cohort) {
            // Keep ownership through PDF conversion/cropping, not only the
            // resident TeX DONE reply. The viewer still needs the chunk bytes.
            cohort.active.delete(activity);
            if (!cohort.queued.size && !cohort.active.size) cohort.settledAt = Date.now();
          }
        }
      }
    } finally {
      engine.renderPumping--;
      // A queue item can arrive after this drain observed size=0 but before
      // the counter drops. queueRender then sees every lane as occupied and
      // cannot start a replacement. Re-check after releasing the lane so the
      // newest edit never remains stranded until the next keystroke.
      if (engine.renderWant.size) pumpRenders(engine, callbacks);
    }
  })();
  // exposed so tools/tests can wait for the exact-render tier to settle
  engine.renderTask = Promise.all([engine.renderTask.catch(() => {}), drain]).then(() => {});
}

function renderBlock(engine, block, callbacks) {
  // Per-block serialization keeps two generations from sharing the same
  // job directory. Protocol replies themselves carry unique request ids.
  engine.renderLocks ??= new Map();
  const prev = engine.renderLocks.get(block.id) ?? Promise.resolve();
  const run = prev.then(() => renderBlockInner(engine, block, callbacks));
  engine.renderLocks.set(
    block.id,
    run.catch(() => {})
  );
  return run;
}

async function renderBlockInner(engine, block, callbacks) {
  const { awaitRender, renderIsolated, asyncRepaginate, chunkTargets, releaseRenderHold } = callbacks;
  const idx = engine.blocks.indexOf(block);
  if (idx < 0 || !block.galley) return false; // superseded (reboot nulls galleys)
  // one render per (block, content); stale results are discarded so a
  // fast typist never sees an outdated exact image over live glyphs
  const forGalley = block.galleyHash;
  // only the pages whose chunks are missing/stale — a fresh set is free
  const targets = chunkTargets(block).filter(
    (t) => engine.chunks.get(t.key)?.forGalley !== forGalley
  );
  if (!targets.length) {
    releaseRenderHold(idx);
    return true;
  }
  if (engine.pdfOpenedAtRoot) {
    // resident children share hyperref's open PDF fd and cannot ship.
    // Fire-and-forget into the idle-gated isolated queue — it must NOT
    // occupy a pump lane (its gate can stay closed for minutes while
    // rescues/canonical churn, and each compile is minutes on
    // package-heavy documents). Meanwhile the canonical-crop pass
    // supplies exact pixels for these blocks.
    renderIsolated(block, idx);
    return false;
  }
  const ck = engine.checkpoints.get(idx);
  const captureCk = block.galley?.capture ? engine.checkpoints.get(idx + 1) : null;
  if (!ck && !captureCk) {
    // checkpoint retired off the grid (long documents keep ~64): the
    // Neither exact path has a resident owner: RENDER needs the state AT the
    // block, CAPTURE needs the state just AFTER it. Fall back to isolated.
    renderIsolated(block, idx);
    return false;
  }
  await renderResidentBlock(engine, {
    block,
    idx,
    ck,
    targets,
    forGalley,
    awaitRender,
    renderIsolated,
    asyncRepaginate,
    chunkTargets,
    releaseRenderHold,
  });
  return targets.every(target => engine.chunks.get(target.key)?.forGalley === forGalley);
}
