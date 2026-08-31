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
export function queueRender(engine, blockId, callbacks) {
  // audits compare block identity (galleyHash + stateVec) — the exact
  // preview chunks the RENDER tier produces never enter the equation,
  // while its fork holds cost ~500MB each on Linux (the Lua GC dirties
  // every COW page, materializing the full heap per resident)
  if (process.env.TDOM_NO_RENDER === '1') return;
  engine.renderWant.delete(blockId); // re-insertion moves it to the back = newest
  engine.renderWant.set(blockId, true);
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
        // Exact chunks (math/TikZ/tcolorbox) are valuable only after the
        // command burst settles. Plain glyph output has already reached the
        // browser through the foreground JOB; a short latest-wins quiet gate
        // prevents valid intermediate command states from spawning a PDF
        // render per keystroke without adding latency to prose.
        const quietMs = shippingPriorityQuietMs(
          engine,
          Math.max(0, Number(process.env.TDOM_RENDER_QUIET_MS ?? 120))
        );
        const remaining = quietMs - (Date.now() - (engine.lastEditAt ?? 0));
        if (remaining > 0) {
          await new Promise((r) => setTimeout(r, Math.min(25, remaining)));
          continue;
        }
        const id = [...engine.renderWant.keys()].pop(); // newest first
        engine.renderWant.delete(id);
        const block = engine.blocks.find((b) => b.id === id);
        if (!block || !block.galley || !block.needsRender) continue;
        await renderBlock(engine, block, callbacks).catch((err) => {
          if (!err?.tdomSuperseded) engine.diagnostics.push(`render ${id}: ${err?.message ?? err}`);
        });
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
  if (idx < 0 || !block.galley) return; // superseded (reboot nulls galleys)
  // one render per (block, content); stale results are discarded so a
  // fast typist never sees an outdated exact image over live glyphs
  const forGalley = block.galleyHash;
  // only the pages whose chunks are missing/stale — a fresh set is free
  const targets = chunkTargets(block).filter(
    (t) => engine.chunks.get(t.key)?.forGalley !== forGalley
  );
  if (!targets.length) {
    releaseRenderHold(idx);
    return;
  }
  if (engine.pdfOpenedAtRoot) {
    // resident children share hyperref's open PDF fd and cannot ship.
    // Fire-and-forget into the idle-gated isolated queue — it must NOT
    // occupy a pump lane (its gate can stay closed for minutes while
    // rescues/canonical churn, and each compile is minutes on
    // package-heavy documents). Meanwhile the canonical-crop pass
    // supplies exact pixels for these blocks.
    renderIsolated(block, idx);
    return;
  }
  const ck = engine.checkpoints.get(idx);
  const captureCk = block.galley?.capture ? engine.checkpoints.get(idx + 1) : null;
  if (!ck && !captureCk) {
    // checkpoint retired off the grid (long documents keep ~64): the
    // Neither exact path has a resident owner: RENDER needs the state AT the
    // block, CAPTURE needs the state just AFTER it. Fall back to isolated.
    renderIsolated(block, idx);
    return;
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
}
