export function scheduleBackground(engine, dirtyBlocks, callbacks) {
  const { locked, runChainPass, chunkTargets, queueRender, retireOffGrid } = callbacks;
  // Deferred chain work is the ONLY background chain activity (docs/10
  // §I3): nothing runs while the user is typing. The pass starts after a
  // short idle gate, aborts between blocks on the next edit (#update sets
  // bgAbort and SIGKILLs the in-flight job) and resumes where it left
  // off. With no pending work the engine is completely idle between
  // keystrokes. Graphics renders stay fire-and-forget — an edit never
  // waits on pdftocairo.
  engine.bgTask = (async () => {
    if (!engine.pendingChain) return;
    while (!engine.bgAbort && Date.now() - (engine.lastEditAt ?? 0) < 300) {
      await new Promise((r) => setTimeout(r, 25));
    }
    if (engine.bgAbort || !engine.pendingChain) return;
    await locked(() => runChainPass());
  })().catch((err) => {
    engine.diagnostics.push('chain pass failed: ' + err.message);
  });
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
  for (const id of hot) {
    const block = engine.blocks.find((b) => b.id === id);
    if (!block?.needsRender) continue;
    const stale = chunkTargets(block).some(
      (t) => engine.chunks.get(t.key)?.forGalley !== block.galleyHash
    );
    if (stale) queueRender(id);
  }
  // stale render holds: the held block moved/changed under its index, or
  // its chunks are already fresh — resume normal grid retirement
  for (const [idx, id] of [...engine.renderHold]) {
    const b = engine.blocks[idx];
    const freshAll =
      b && !chunkTargets(b).some((t) => engine.chunks.get(t.key)?.forGalley !== b.galleyHash);
    if (!b || b.id !== id || freshAll) {
      engine.renderHold.delete(idx);
      retireOffGrid(idx);
    }
  }
}
