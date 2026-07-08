export function pumpRescues(engine, asyncRescueOne) {
  if (engine.rescuePumping) return;
  engine.rescuePumping = true;
  (async () => {
    try {
      while (engine.rescueQueue.size) {
        const [bid, key] = engine.rescueQueue.entries().next().value;
        engine.rescueQueue.delete(bid);
        try {
          await asyncRescueOne(bid, key);
        } catch (err) {
          // the exact compile failed for the block's CURRENT inputs — the
          // stale pixels the foreground kept are a freeze for as long as
          // those inputs persist. No sticky mark here: frozenBlockIds()
          // derives the state from isoFailCache, so a block that was only
          // collateral (a sane text re-rescued at a mid-breakage page
          // offset) un-freezes by itself when its inputs revert.
          engine.diagnostics.push(`async rescue ${bid}: ${err.message}`);
        }
      }
    } finally {
      engine.rescuePumping = false;
    }
  })();
}

export async function asyncRescueOne(engine, bid, key, callbacks) {
  const {
    rescueCacheKey,
    isoCacheGet,
    isoCompile,
    isoCacheSet,
    locked,
    nearestCheckpoint,
    retypesetChain,
    asyncRepaginate,
    queueMovedOffsets,
    enforceCheckpointCap,
  } = callbacks;
  if (engine.mode !== 'structured') return;
  // typing-burst quiescence: a keystroke inside/near a rescue block
  // supersedes the previous compile anyway — wait for a short pause so
  // bursts cost ONE compile instead of one per keystroke, and the
  // resident fork jobs keep the CPU while the user is typing
  while (Date.now() - (engine.lastEditAt ?? 0) < 800) {
    await new Promise((r) => setTimeout(r, 200));
  }
  let idx = engine.blocks.findIndex((b) => b.id === bid);
  if (idx < 0) return;
  let block = engine.blocks[idx];
  // Superseded = the key's inputs moved since queueing. An EDIT re-queues
  // the block itself (its fresh entry carries the fresh key), but inputs
  // also move without any edit — the first stale-first adoption of an
  // in-chain block flips it to rescued, which materializes pageOffset on
  // the next repagination. Dropping here would strand the block on its
  // stale pixels forever; re-queue with the current key instead.
  const nowKey = rescueCacheKey(block, idx);
  if (nowKey !== key) {
    engine.rescueQueue.set(bid, nowKey);
    return;
  }
  if (isoCacheGet(key) === undefined) {
    const iso = await isoCompile(block, idx, 'async exact rescue');
    isoCacheSet(key, iso);
  }
  const outcome = await locked(async () => {
    if (engine.mode !== 'structured') return 'done';
    idx = engine.blocks.findIndex((b) => b.id === bid);
    if (idx < 0) return 'done';
    block = engine.blocks[idx];
    const lockedKey = rescueCacheKey(block, idx);
    if (lockedKey !== key) {
      // same re-queue rationale as the pre-compile check above: inputs
      // moved without an edit — retry with the fresh key
      engine.rescueQueue.set(bid, lockedKey);
      return 'done';
    }
    const before = block.galleyHash + '|' + block.stateVec;
    // cache hit inside → the exact galley adopts in milliseconds; the
    // chain continues to convergence exactly like a foreground edit,
    // but YIELDS to an incoming edit and re-queues so the propagation
    // resumes afterwards. bgActive lets the edit KILL the in-flight
    // job instead of waiting out a deep-lineage spin (#update).
    engine.bgActive = true;
    let n;
    try {
      n = await retypesetChain(nearestCheckpoint(idx), idx, () => {}, () => engine.bgAbort);
    } catch (err) {
      if (engine.bgAbort) return 'aborted';
      throw err;
    } finally {
      engine.bgActive = false;
    }
    // retypesetChain swallows a killed job into an early break — treat
    // any abort-flagged pass as pre-empted so the queue entry retries
    if (n < 0 || engine.bgAbort) return 'aborted';
    for (const l of block.galley?.labels ?? []) {
      if (l.v !== undefined) {
        engine.labelTable.set(l.k, l.v);
        if (l.h != null) engine.hrefTable.set(l.k, l.h);
      }
    }
    if (before !== block.galleyHash + '|' + block.stateVec) asyncRepaginate();
    queueMovedOffsets();
    // the resume walk left checkpoints at the blocks it re-typeset — collapse
    // back to the grid so the boot rescue storm can't creep the live set
    enforceCheckpointCap();
    return 'done';
  });
  if (outcome === 'aborted') {
    // resume after the edit that pre-empted us (waiting OUTSIDE the lock
    // — the edit needs it); the queue entry revalidates on retry
    engine.rescueQueue.set(bid, key);
    while (engine.bgAbort) {
      await new Promise((r) => setTimeout(r, 25));
    }
  }
}

export function queueMovedOffsets(engine, { paginateNow, rescueCacheKey, pumpRescues }) {
  if (engine.mode !== 'structured') return;
  const prov = paginateNow();
  const entry = prov.blockEntry ?? new Map();
  let queued = false;
  for (let c = 0; c < engine.blocks.length; c++) {
    const block = engine.blocks[c];
    if (!block.rescued) continue;
    // 0.25bp quantum shared with the rescue key and the iso strut: a
    // want/have pair inside one quantum compiles to the same galley by
    // construction, so only a real grid step queues work
    const want = Math.round((entry.get(block.id) ?? 0) * 4) / 4;
    // "have" is the galley's compile PROVENANCE, not block.pageOffset —
    // the latter is set optimistically when a re-rescue is queued, so a
    // compile that never lands (failed, superseded) would otherwise lock
    // the stale galley in forever (found via stress seed-21 burst 2)
    const have = block.galley?.tdomPageOff ?? block.pageOffset ?? 0;
    if (Math.abs(want - have) <= 0.001) {
      block.pageOffset = want;
      continue;
    }
    const items = block.galley?.items ?? [];
    const th = engine.geometry?.textheight ?? 0;
    const boxH = (block.galley?.h ?? 0) + (block.galley?.d ?? 0);
    // offset-independence shortcuts: a leading eject counts only when the
    // galley was compiled at the page TOP — there the break is intrinsic
    // to the block (\clearpage & co). Compiled deep in the page, a leading
    // eject usually means "didn't fit at that offset" (split spill), which
    // is exactly the offset-DEPENDENT case.
    if (
      (items[0]?.k === 'eject' && have <= 0.26) ||
      (!items.some((it) => it.k === 'eject') && boxH <= th - want && boxH <= th - have)
    ) {
      block.pageOffset = want;
      continue;
    }
    block.pageOffset = want;
    engine.rescueQueue.set(block.id, rescueCacheKey(block, c));
    queued = true;
  }
  if (queued) pumpRescues();
}
