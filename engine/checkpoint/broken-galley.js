export async function brokenBlockGalley(engine, idx, frozen, deferred, { jobBlock, stateJobBody }) {
  const block = engine.blocks[idx];
  if (block.galley?.state) {
    await jobBlock(idx, {
      id: block.id + '@state',
      body: stateJobBody({ state: block.galley.state, labels: block.galley.labels ?? [] }),
    });
    const kept = { ...block.galley, tdomStale: true };
    if (deferred) {
      delete kept.tdomFrozen;
      kept.tdomDeferred = true;
    } else {
      kept.tdomFrozen = true;
    }
    return kept;
  }
  const prevVec = idx > 0 ? JSON.parse(engine.blocks[idx - 1].stateVec ?? '[]') : [];
  const state = {};
  engine.counters.forEach((c, i) => {
    state[c] = prevVec[i] ?? 0;
  });
  const hasColumnState = prevVec.length >= engine.counters.length + 5;
  state['tdom@twocolumn'] = hasColumnState
    ? prevVec[engine.counters.length]
    : Number(engine.geometry?.twocolumn ?? 0);
  state['tdom@columnwidth'] = hasColumnState
    ? prevVec[engine.counters.length + 1]
    : Math.round(Number(engine.geometry?.columnwidth ?? engine.geometry?.textwidth ?? 0) * 65781.76);
  state['tdom@pd'] = prevVec.length >= 3 ? prevVec[prevVec.length - 3] : -65536000;
  state['tdom@nobreak'] = prevVec.length >= 2 ? prevVec[prevVec.length - 2] : 0;
  state['tdom@ls'] = prevVec.length >= 1 ? prevVec[prevVec.length - 1] : 0;
  await jobBlock(idx, {
    id: block.id + '@state',
    body: stateJobBody({ state, labels: [] }),
  });
  // frozen=false: a PENDING placeholder (first-ever rescue queued on the
  // pump), not a freeze — frozenBlockIds derives real freezes from
  // isoFailCache if that compile then fails
  const g = { items: [], floats: [], w: 0, h: 0, d: 0, state, labels: [], toclines: [], refs: block.galley?.refs ?? [], fonts: {} };
  if (frozen) g.tdomFrozen = true;
  if (deferred) g.tdomDeferred = true;
  return g;
}
