import { shippingPriorityQuietMs } from './interactive-priority.js';

export function scheduleBackground(engine, dirtyBlocks, callbacks, { interactive = false, pageRenderIds = [] } = {}) {
  const { locked, runChainPass, chunkTargets, queueRender, enforceCheckpointCap, coldResume } = callbacks;
  // Deferred chain work is the ONLY background chain activity (docs/10
  // §I3): nothing runs while the user is typing. The pass starts after a
  // short idle gate, aborts between blocks on the next edit (#update sets
  // bgAbort and SIGKILLs the in-flight job) and resumes where it left
  // off. With no pending work the engine is completely idle between
  // keystrokes. Graphics renders stay fire-and-forget — an edit never
  // waits on pdftocairo.
  engine.bgTask = (async () => {
    if (!engine.pendingChain) return;
    while (
      !engine.bgAbort &&
      Date.now() - (engine.lastEditAt ?? 0) < shippingPriorityQuietMs(engine, 300)
    ) {
      await new Promise((r) => setTimeout(r, 25));
    }
    if (engine.bgAbort || !engine.pendingChain) return;
    await locked(() => runChainPass());
    // A cold walk that reached its block hands the rest to a full update.
    // That update takes the chain lock itself and waits for bgTask, so it
    // must not be part of this promise: return the work and let the
    // detached continuation below run it.
    const work = engine.pendingChain;
    if (work?.kind === 'cold' && work.phase === 'resume' && !engine.bgAbort) {
      engine.pendingChain = null;
      return work;
    }
    return null;
  })().catch((err) => {
    engine.diagnostics.push('chain pass failed: ' + (err?.message ?? err));
    return null;
  });
  if (coldResume) {
    void engine.bgTask.then((work) => (work ? coldResume(work) : undefined)).catch((err) => {
      engine.diagnostics.push('cold resume failed: ' + (err?.message ?? err));
    });
  }
  // High-fidelity chunk renders go to the pump ONLY for the blocks this
  // edit touched: their checkpoint is warm (render hold). COLD blocks
  // (boot backlog, far-away staleness)
  // are deliberately NOT queued — on deep-lineage luatexja documents a
  // resident RENDER there spins to its timeout, and a whole-document
  // sweep would storm the CPU that the fork jobs need. Their exact
  // pixels arrive for free from the canonical-crop pass instead (and,
  // for drifting documents, from the idle-gated isolated queue). A boot
  // or huge paste of a LONG document dirties everything — that is the
  // cold case: cap it. Small documents render their whole set at boot
  // (a few seconds, and the referee tools rely on it).
  const hot = dirtyBlocks.length <= Number(process.env.TDOM_RENDER_HOT_MAX || 64) ? dirtyBlocks : [];
  for (const id of new Set([...hot, ...pageRenderIds])) {
    const block = engine.blocks.find((b) => b.id === id);
    if (!block?.needsRender) continue;
    const stale = chunkTargets(block).some(
      (t) => engine.chunks.get(t.key)?.forGalley !== block.galleyHash
    );
    if (stale) queueRender(id, { interactiveRev: interactive ? engine.srcRev : null });
  }
  // stale render holds: the held block moved/changed under its index, or
  // its chunks are already fresh — resume normal grid retirement
  for (const [idx, id] of [...engine.renderHold]) {
    const b = engine.blocks[idx];
    const freshAll =
      b && !chunkTargets(b).some((t) => engine.chunks.get(t.key)?.forGalley !== b.galleyHash);
    const queued = engine.renderWant.has(id) || engine.rendering?.has(id + ':' + b?.galleyHash);
    if (!b || b.id !== id || freshAll || !queued) engine.renderHold.delete(idx);
  }
  enforceCheckpointCap();
}
