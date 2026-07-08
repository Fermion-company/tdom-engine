import { performance } from 'node:perf_hooks';
import { fnv1a } from '../hash.js';

/**
 * Rescue-aware typeset: the in-chain fork path for normal blocks, the
 * isolated exact-render path for blocks the dormant page cannot represent
 * (output-routine environments) or that failed/hung in-chain. The premise:
 * anything real lualatex compiles must render — worst case through a real
 * lualatex run whose pixels ARE the print output.
 */
export async function typesetBlock(engine, idx, callbacks) {
  const { needsRescue, rescueBlock, brokenBlockGalley, jobBlock, rescueCacheKey, pumpRescues } = callbacks;
  const block = engine.blocks[idx];
  const sig = fnv1a(block.text);
  const TRACE = process.env.TDOM_TRACE_JOB
    ? (label, t0) => console.error(`[job] ${block.id} ${label} ${(performance.now() - t0).toFixed(0)}ms`)
    : null;
  const T0 = performance.now();
  // Block-granular last resort: a block that fails BOTH the chain and the
  // isolated rescue (mid-typing broken TeX — an unfinished \frac, a bare
  // trailing backslash …) must never take the whole document down. It
  // freezes at its last good galley (or renders empty when it never had
  // one), the chain continues with a consistent state, and the block
  // heals automatically on the next edit that changes its text. The
  // canonical layer keeps showing LuaLaTeX's own error-recovery output.
  const rescueSafely = async (why) => {
    try {
      return await rescueBlock(idx, why);
    } catch (err) {
      if (engine.bgAbort) throw err; // an edit is waiting — no freeze jobs now
      engine.diagnostics.push(`${block.id}: rescue failed (${err.message}) — freezing the block`);
      return brokenBlockGalley(idx);
    }
  };
  if (engine.bgAbort) throw new Error('background pass aborted (edit waiting)');
  if (needsRescue(block.text)) {
    const g = await rescueSafely('output-routine environment needs a real page');
    TRACE?.('rescue(env)', T0);
    return g;
  }
  if (engine.poisoned.get(block.id) === sig) {
    return rescueSafely('previous in-chain failure');
  }
  // Established deep-lineage wall: don't even attempt the doomed in-chain
  // job (each attempt hangs to the timeout). A probe block every 25
  // still tries, so the chain recovers automatically if the wall lifts.
  if ((engine.chainTimeouts ?? 0) >= 3 && !block.galley && idx % 25 !== 0) {
    engine.poisoned.set(block.id, sig);
    engine.rescueQueue.set(block.id, rescueCacheKey(block, idx));
    pumpRescues();
    return brokenBlockGalley(idx);
  }
  try {
    const galley = await jobBlock(idx);
    engine.chainTimeouts = 0;
    TRACE?.('in-chain', T0);
    return galley;
  } catch (err) {
    // an edit is waiting on this background pass: fail the block WITHOUT
    // poisoning it (its job may have been killed mid-flight, not broken)
    // and without paying for rescue/state follow-up jobs — the next
    // rebuild retries from scratch
    if (engine.bgAbort) throw err;
    engine.poisoned.set(block.id, sig);
    const isTimeout = /timeout/.test(err.message);
    engine.chainTimeouts = isTimeout ? (engine.chainTimeouts ?? 0) + 1 : 0;
    engine.diagnostics.push(
      `${block.id}: in-chain typeset failed (${err.message}) — isolated exact-render rescue`
    );
    // Deep-lineage wall (long luatexja documents): past ~25 pages of
    // cumulative CJK content in one fork lineage, every in-chain job
    // spins in luahbtex until the timeout. Once that pattern is
    // established, stop paying a timeout plus a synchronous isolated
    // compile PER BLOCK: freeze the block empty, queue its exact rescue
    // on the async pump (fresh processes typeset it at normal speed off
    // the hot path) and let the canonical layer own the pixels until the
    // provisional tail self-repairs in the background.
    if (isTimeout && engine.chainTimeouts >= 3 && !block.galley) {
      engine.diagnostics.push(
        `${block.id}: consecutive in-chain timeouts — deferring the tail to the async rescue pump`
      );
      engine.rescueQueue.set(block.id, rescueCacheKey(block, idx));
      pumpRescues();
      return brokenBlockGalley(idx);
    }
    return rescueSafely(err.message);
  }
}
