export async function rescueBlock(engine, idx, why, callbacks) {
  const {
    rescueCacheKey, isoCacheGet, isoBaseGet, bootIsoCompile, jobBlock, stateJobBody, pumpRescues, brokenBlockGalley,
  } = callbacks;
  const block = engine.blocks[idx];
  const cacheKey = rescueCacheKey(block, idx);
  let iso = isoCacheGet(cacheKey);
  // A previous session's result for this block (docs/08 §8.5): adopt it now
  // rather than holding an empty placeholder until a cold compile lands.
  if (!iso && !block.galley?.state) iso = isoBaseGet?.(block, idx) ?? null;
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
      const kept = { ...block.galley, tdomStale: true };
      delete kept.tdomColdPreview; // the held copy is no longer a preview (docs/10 §10.4b)
      return kept;
    }
    // A boot walk with the fork runners up compiles a first-ever rescue
    // right here, within its compile-time budget (bootIsoCompile returns
    // null past it). A placeholder has no measured box, so every assembled
    // page holds until it lands (pagebuilder buildPages): on the 316-page
    // book the 31 multicols kept the whole paper unpaintable for ~4 min
    // after /open, while their fork-real compiles take ~1 s each here.
    if (!block.galley && bootIsoCompile) {
      try {
        iso = await bootIsoCompile(idx, cacheKey);
      } catch (err) {
        engine.diagnostics.push(`${block.id}: boot rescue failed (${err?.message ?? err}) — async rescue`);
        iso = null;
      }
    }
  }
  if (!iso) {
    // first-ever rescue (nothing older to display) outside a boot walk, or
    // past its budget: do NOT pay the compile on the walk — hold an empty
    // placeholder with entry-passthrough state and land the exact galley
    // through the async pump, exactly like a stale-first landing. Fork isos
    // arrive in ~1-3s; the walk stays bounded.
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
