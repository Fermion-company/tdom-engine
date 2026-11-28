import { performance } from 'node:perf_hooks';
import { shippingPriorityQuietMs } from './interactive-priority.js';

const CHAIN_MAX_STALE_MS = Number(process.env.TDOM_CHAIN_MAX_STALE ?? 2000);

/** A block that needs exact pixels and whose every line is a box of no
 * height or depth: a picture drawn outside its lines (a cover). */
function pictureOnly(block) {
  if (!block?.needsRender || !block.gfx || block.rescued) return false;
  const boxes = (block.galley?.items ?? []).filter((it) => it.k === 'box');
  return boxes.length > 0 && boxes.every((it) => (it.h ?? 0) + (it.d ?? 0) < 0.01);
}

/** Whether queued body chain work has passed its gate (the typing's quiet,
 * or its staleness deadline): it runs now, and nothing goes ahead of it. */
export function chainWorkDue(engine) {
  const work = engine.pendingChain;
  if (!work || work.kind === 'grid') return false;
  const quiet = work.kind === 'cold' ? 300 : shippingPriorityQuietMs(engine, 300);
  return Date.now() - (engine.lastEditAt ?? 0) >= quiet ||
    (work.queuedAt != null && Date.now() - work.queuedAt >= CHAIN_MAX_STALE_MS);
}

export function scheduleBackground(engine, dirtyBlocks, callbacks, { interactive = false, pageRenderIds = [], idleRound = 0 } = {}) {
  const { locked, runChainPass, chunkTargets, queueRender, enforceCheckpointCap, coldResume, queueGrid, gridWanted, queueOwedToc,
    witnessOwed = () => null, runWitness = async () => null } = callbacks;
  // Deferred chain work is the ONLY background chain activity (docs/10
  // §I3): the pass starts after a short idle gate or its oldest work's
  // deadline, and aborts on the next edit (#update sets
  // bgAbort and SIGKILLs the in-flight job) and resumes where it left
  // off. With no pending work the engine is completely idle between
  // keystrokes. Graphics renders stay fire-and-forget — an edit never
  // waits on pdftocairo.
  // (the quiet a body pass waits for, and whether queued body work is due:
  // its gate has passed)
  const quietMs = () => (engine.pendingChain?.kind === 'cold' ? 300 : shippingPriorityQuietMs(engine, 300));
  const bodyDue = () => chainWorkDue(engine);
  // The furniture witness replay (chain-pass.js runWitnessPass) is not body
  // work: it runs with no body work due. It waits for the typing to be quiet
  // like a table of contents owed; once it has been owed CHAIN_MAX_STALE_MS
  // it also runs in the gaps of a typing that goes on, ahead of body work
  // that is still waiting for its own gate. It stops at the next block
  // boundary for a keystroke and for body work that has become due.
  const witnessNow = () => {
    const witness = witnessOwed();
    if (!witness || bodyDue()) return null;
    const bodyQueued = engine.pendingChain && engine.pendingChain.kind !== 'grid';
    const quiet = Date.now() - (engine.lastEditAt ?? 0) >= quietMs();
    // (`eager`: the replay the first header map of a root waits for, whose
    // heads and feet nothing shows until it lands)
    return (!bodyQueued && quiet) || witness.eager || Date.now() - witness.queuedAt >= CHAIN_MAX_STALE_MS ? witness : null;
  };
  engine.bgTask = (async () => {
    // Nothing queued and no grid boundary to fill: settle at once, so the
    // header pass and everything else that waits for this task is not
    // held behind the idle gate (the engine is completely idle then).
    if (!engine.pendingChain && !engine.tocOwed && !witnessOwed() && !gridWanted?.()) return null;
    // Two rounds at most: the queued work, then — once the queue drained
    // and behind the same idle gate — the grid pass (docs/03) that fills
    // keep-set boundaries lacking a continuation. A cold hand-off leaves
    // instead. An owed witness replay takes a round of its own (witnessNow).
    let rounds = 2;
    for (let round = 0; round < rounds; round++) {
      // The task is created inside the update that scheduled it: wait for
      // that update (and any caret warm) to leave before deciding anything.
      while (
        !engine.bgAbort && !engine.editPending &&
        (engine.updating || engine.warming ||
          // the cold resume is owed to the keystroke: it does not wait out
          // the shipping priority window like deferred settle work does
          (Date.now() - (engine.lastEditAt ?? 0) < quietMs() &&
            (engine.pendingChain?.queuedAt == null || engine.pendingChain.kind === 'grid' ||
              Date.now() - engine.pendingChain.queuedAt < CHAIN_MAX_STALE_MS) &&
            !witnessNow()))
      ) {
        // An edit or a warm that waits for this task ends the sleep at once
        // (engine #wakeBackgroundGate). Left to run out, it held the next
        // keystroke behind any pending chain work for the rest of the 25 ms:
        // 19 to 26 ms measured on every keystroke of a burst.
        await new Promise((resolve) => {
          const done = () => {
            clearTimeout(timer);
            if (engine.bgGateWake === done) engine.bgGateWake = null;
            resolve();
          };
          const timer = setTimeout(done, 25);
          engine.bgGateWake = done;
        });
      }
      if (engine.bgAbort || engine.editPending) return null;
      // a table of contents an edit left owed (update-typeset-phase.js), now that it is quiet
      if (engine.tocOwed && (!engine.pendingChain || engine.pendingChain.kind === 'grid')) queueOwedToc?.();
      if (witnessNow()) {
        await locked(() => engine.bgAbort || engine.editPending ? null : runWitness(bodyDue));
        if (engine.bgAbort || engine.editPending) return null;
        // (body work queued or due meanwhile: its own round; a replay that
        // yielded to it, the round after)
        if (engine.pendingChain && engine.pendingChain.kind !== 'grid') continue;
        if (witnessOwed()) return null;
      }
      if (!engine.pendingChain && !queueGrid?.()) return null;
      if (process.env.TDOM_TRACE_GRID) console.error('[grid] sched', JSON.stringify({ round, kind: engine.pendingChain?.kind, t: Math.round(performance.now()) }));
      if (engine.pendingChain.kind === 'cold' && engine.coldTrace) engine.coldTrace.gateAt = performance.now();
      await locked(() => engine.bgAbort || engine.editPending ? null : runChainPass());
      // A cold walk that reached its block hands the rest to a full update.
      // That update takes the chain lock itself and waits for bgTask, so it
      // must not be part of this promise: return the work and let the
      // detached continuation below run it.
      const work = engine.pendingChain;
      if (work?.kind === 'cold' && work.phase === 'resume' && !engine.bgAbort) {
        engine.pendingChain = null;
        return work;
      }
      if (engine.pendingChain || engine.bgAbort) return null;
      // (an owed witness replay next, behind the same gate: a keystroke every
      // 300 ms keeps body settle work queued, and the replay waited behind it
      // for as long as the typing went on)
      if (witnessOwed() && rounds === 2) {
        rounds++;
        continue;
      }
      if (!engine.tocOwed && !queueGrid?.()) return null;
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
    // A contents update takes precedence over remaining grid work, even
    // when the grid yielded without materializing a boundary.
    if ((engine.tocOwed || witnessOwed()) && (!left || left.kind === 'grid') && idleRound < 8) {
      scheduleBackground(engine, [], callbacks, { idleRound: idleRound + 1 });
      return;
    }
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
  // A cold walk (a boot, a huge paste) leaves a cover unrendered like every
  // other block: canonical shows its page. A page typed in before it moves
  // it to a page canonical does not have, and only its exact render can say
  // it is drawn against `current page` (page-art.js): render the few blocks
  // that are pictures and nothing else (every line of the galley a box of no
  // height, `\null` and an overlay) now, from the backlog, behind the edits.
  if (!engine.opening && dirtyBlocks.length > hot.length) {
    for (const block of engine.blocks) {
      if (!pictureOnly(block)) continue;
      if (chunkTargets(block).some((t) => engine.chunks.get(t.key)?.forGalley !== block.galleyHash)) queueRender(block.id);
    }
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
