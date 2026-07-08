import { renderResidentBlock } from './resident-render.js';

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
        const id = [...engine.renderWant.keys()].pop(); // newest first
        engine.renderWant.delete(id);
        const block = engine.blocks.find((b) => b.id === id);
        if (!block || !block.galley || !block.needsRender) continue;
        await renderBlock(engine, block, callbacks).catch((err) => {
          engine.diagnostics.push(`render ${id}: ${err.message}`);
        });
      }
    } finally {
      engine.renderPumping--;
    }
  })();
  // exposed so tools/tests can wait for the exact-render tier to settle
  engine.renderTask = Promise.all([engine.renderTask.catch(() => {}), drain]).then(() => {});
}

function renderBlock(engine, block, callbacks) {
  // per-block serialization: the RENDER protocol's reply key is the block
  // id, so two in-flight renders of the same block (different galleys, two
  // pump lanes) would collide in the waiter table
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
  if (!ck) {
    // checkpoint retired off the grid (long documents keep ~64): the
    // resident RENDER path needs the state AT this block, so fall back to
    // the isolated render. Fire-and-forget — its queue is idle-gated and
    // self-serialized, and it must never occupy a pump lane (the lane has
    // to stay free for the fast resident renders of just-edited blocks).
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
