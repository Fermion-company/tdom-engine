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
