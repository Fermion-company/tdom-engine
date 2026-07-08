export async function rescueBlock(engine, idx, why, callbacks) {
  const { rescueCacheKey, isoCacheGet, jobBlock, stateJobBody, pumpRescues, brokenBlockGalley } = callbacks;
  const block = engine.blocks[idx];
  const cacheKey = rescueCacheKey(block, idx);
  let iso = isoCacheGet(cacheKey);
  if (!iso) {
    if (block.galley?.state) {
      // STALE-FIRST: an isolated compile takes seconds and must never sit
      // on the editing hot path. Keep the previous galley on screen (the
      // provisional layer is allowed to be temporarily stale — canonical
      // guarantees the final pixels), seed the continuation checkpoint
      // from the stale exit state so the chain stays consistent, and let
      // the exact compile land asynchronously.
      await jobBlock(idx, {
        id: block.id + '@state',
        body: stateJobBody({ state: block.galley.state, labels: block.galley.labels ?? [] }),
      });
      engine.rescueQueue.set(block.id, cacheKey);
      pumpRescues();
      return { ...block.galley, tdomStale: true };
    }
    // first-ever rescue (nothing older to display): do NOT pay the
    // compile on the walk — hold an empty placeholder with
    // entry-passthrough state and land the exact galley through the
    // async pump, exactly like a stale-first landing. Fork isos arrive
    // in ~1-3s; the walk stays bounded, and a BOOT walk in particular
    // (which used to serialize EVERY rescue compile before first paint)
    // reaches the first page minutes earlier.
    engine.rescueQueue.set(block.id, cacheKey);
    pumpRescues();
    return brokenBlockGalley(idx, false);
  }
  // continuation checkpoint carrying the isolated run's exact exit state
  await jobBlock(idx, { id: block.id + '@state', body: stateJobBody(iso) });
  return {
    items: iso.items,
    floats: [],
    w: iso.w,
    h: iso.h,
    d: iso.d,
    gfx: true,
    state: iso.state,
    labels: iso.labels,
    toclines: iso.toclines,
    refs: iso.refs ?? [],
    fonts: {},
    tdomRefVals: iso.refVals ?? {},
    tdomPageOff: iso.compiledOff ?? 0,
    tdomIsoChunks: iso.chunks,
  };
}
