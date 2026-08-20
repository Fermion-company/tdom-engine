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
  // The abort flag is a BACKGROUND yield signal (the next edit sets it to
  // pre-empt chain/rescue passes). A foreground update must never see it:
  // a second #update pre-arms the flag before taking the chain lock, and an
  // aborted foreground walk used to escalate into a full reboot retry that
  // failed the same way and pinned the document in opaque (reprobe racing a
  // keystroke, or two concurrent edit() calls in an editor embedding).
  const aborted = () => engine.bgAbort && engine.bgActive;
  const isInfra = (e) => e?.tdomInfra === true;
  const isTimeoutErr = (e) => e?.tdomTimeout === true;
  // Freeze vs escalate: the freeze ladder exists to contain CONTENT failures
  // (mid-typing broken TeX) to one block. An explicit fork failure — or a
  // timeout where no child was ever announced — is INFRASTRUCTURE: nothing
  // in the resident tree is serving, and freezing would mask it per block
  // while every later edit of the block pays the same silent double timeout
  // (observed live: \maketitle-block edits stuck at canonical latency for a
  // whole session). Those escalate instead: the update-level safety net in
  // #updateInner tears the tree down, reboots the root, and retries once.
  // A timeout whose child DID announce stays on the freeze ladder — that
  // pattern is also what a genuine TeX infinite loop in the user's text
  // produces, and rebooting cannot fix content.
  const rescueSafely = async (why, inChainSilent = false) => {
    try {
      return await rescueBlock(idx, why);
    } catch (err) {
      if (aborted()) throw err; // an edit is waiting — no freeze jobs now
      if (isInfra(err) || (isTimeoutErr(err) && (inChainSilent || err.tdomNoChild === true))) {
        engine.poisoned.delete(block.id);
        engine.diagnostics.push(
          `${block.id}: rescue got no answer (${err.message}) — escalating to a full rebuild`
        );
        throw err;
      }
      engine.diagnostics.push(`${block.id}: rescue failed (${err.message}) — freezing the block`);
      if (isTimeoutErr(err)) {
        // A timeout-shaped double failure (in-chain AND rescue unanswered)
        // marks the PARENT lineage as suspect — a wedged checkpoint would
        // otherwise eat every future edit of this region the same silent
        // way (observed live: the block froze and every keystroke re-paid
        // the double timeout for the rest of the session). Retire it: the
        // next edit forks the region from an earlier snapshot, or — with
        // no snapshot left — fails fast into the full-rebuild retry.
        const ck = engine.checkpoints.get(idx);
        if (ck) {
          try { ck.send('DIE\n'); } catch { /* peer gone */ }
          if (ck.pid) {
            engine.dyingPids ??= new Set();
            engine.dyingPids.add(ck.pid);
          }
          engine.checkpoints.delete(idx);
          engine.diagnostics.push(`${block.id}: retired checkpoint ${idx} after unanswered jobs`);
        }
      }
      return brokenBlockGalley(idx);
    }
  };
  if (aborted()) throw new Error('background pass aborted (edit waiting)');
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
    if (aborted()) throw err;
    if (isInfra(err)) {
      // the daemon reported the fork failure outright — the rescue fork
      // would hit the same exhausted system; escalate to the full rebuild
      engine.diagnostics.push(`${block.id}: in-chain fork failed — escalating to a full rebuild`);
      throw err;
    }
    engine.poisoned.set(block.id, sig);
    const isTimeout = isTimeoutErr(err) || /timeout/.test(err.message);
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
    return rescueSafely(err.message, err.tdomNoChild === true);
  }
}
