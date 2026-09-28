import { performance } from 'node:perf_hooks';
import { shippingPriorityQuietMs } from './interactive-priority.js';

export function scheduleBackground(engine, dirtyBlocks, callbacks, { interactive = false, pageRenderIds = [], idleRound = 0 } = {}) {
  const { locked, runChainPass, chunkTargets, queueRender, enforceCheckpointCap, coldResume, queueGrid, gridWanted } = callbacks;
  // Deferred chain work is the ONLY background chain activity (docs/10
  // §I3): nothing runs while the user is typing. The pass starts after a
  // short idle gate, aborts between blocks on the next edit (#update sets
  // bgAbort and SIGKILLs the in-flight job) and resumes where it left
  // off. With no pending work the engine is completely idle between
  // keystrokes. Graphics renders stay fire-and-forget — an edit never
  // waits on pdftocairo.
  engine.bgTask = (async () => {
    // Nothing queued and no grid boundary to fill: settle at once, so the
    // header pass and everything else that waits for this task is not
    // held behind the idle gate (the engine is completely idle then).
    if (!engine.pendingChain && !gridWanted?.()) return null;
    // Two rounds at most: the queued work, then — once the queue drained
    // and behind the same idle gate — the grid pass (docs/03) that fills
    // keep-set boundaries lacking a continuation. A cold hand-off leaves
    // instead.
    for (let round = 0; round < 2; round++) {
      // The task is created inside the update that scheduled it: wait for
      // that update (and any caret warm) to leave before deciding anything.
      while (
        !engine.bgAbort && !engine.editPending &&
        (engine.updating || engine.warming ||
          // the cold resume is owed to the keystroke: it does not wait out
          // the shipping priority window like deferred settle work does
          Date.now() - (engine.lastEditAt ?? 0) <
            (engine.pendingChain?.kind === 'cold' ? 300 : shippingPriorityQuietMs(engine, 300)))
      ) {
        await new Promise((r) => setTimeout(r, 25));
      }
      if (engine.bgAbort || engine.editPending) return null;
      if (!engine.pendingChain && !queueGrid?.()) return null;
      if (process.env.TDOM_TRACE_GRID) console.error('[grid] sched', JSON.stringify({ round, kind: engine.pendingChain?.kind, t: Math.round(performance.now()) }));
      if (engine.pendingChain.kind === 'cold' && engine.coldTrace) engine.coldTrace.gateAt = performance.now();
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
      if (engine.pendingChain || engine.bgAbort || !queueGrid?.()) return null;
    }
    return null;
  })().catch((err) => {
    engine.diagnostics.push('chain pass failed: ' + (err?.message ?? err));
    return null;
  });
  // Work left after the last round (a grid pass stops at its step budget)
  // had nobody to run it until the next edit: the keep-set boundaries went
  // unfilled while the document sat idle, and a caller draining the chain
  // waited forever (tests/hot-path.test.js 'cold native prefix replay',
  // intermittent). Run the next task behind the same idle gate while the
  // passes make progress: a grid pass only by the boundaries it
  // materialized (the last round queues a fresh grid plan every time, and
  // a target the cap retires at once is no progress), other chain work by
  // moving on. Bounded like the passes themselves, in case a moving keep
  // set keeps offering boundaries the cap then retires.
  const before = engine.pendingChain;
  const beforeFrom = before?.from;
  const materializedBefore = engine.gridFill?.materialized ?? 0;
  const task = engine.bgTask;
  void task.then((work) => {
    if (work || engine.closed || engine.bgTask !== task || engine.bgAbort || engine.editPending) return;
    const left = engine.pendingChain;
    if (!left) return;
    if (idleRound >= 8) {
      if (left.kind === 'grid') engine.pendingChain = null;
      return;
    }
    const moved = left.kind === 'grid'
      ? (engine.gridFill?.materialized ?? 0) > materializedBefore
      : left !== before || left.from !== beforeFrom;
    if (moved) scheduleBackground(engine, [], callbacks, { idleRound: idleRound + 1 });
    // a grid plan nobody runs: the next task re-plans it from gridMissing
    // (a pinned reach stays), and a caller draining the chain is not held
    else if (left.kind === 'grid') engine.pendingChain = null;
  }, () => {});
  if (coldResume) {
    void engine.bgTask.then((work) => (work ? coldResume(work) : undefined)).catch((err) => {
      engine.diagnostics.push('cold resume failed: ' + (err?.message ?? err));
      // nothing resumes these any more: the next edit of each block typesets
      // it, and the rescue pump must not wait on them
      engine.coldDirty?.clear();
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
