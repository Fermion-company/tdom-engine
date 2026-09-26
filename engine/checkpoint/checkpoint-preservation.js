export function preserveCheckpointSuffix({
  checkpoints,
  renderHold,
  editHold,
  pendingChain,
  bounds,
  dyingPids,
}) {
  const { prefixLen, oldSuffixStart, newSuffixStart } = bounds;
  const delta = newSuffixStart - oldSuffixStart;
  // Where a boundary goes: diffBlocks' boundaryMap (every boundary before a
  // kept block, including those between two changed regions, tex64-internal
  // #96), or the prefix/suffix rule when a caller has none.
  const move = bounds.boundaryMap
    ? (idx) => bounds.boundaryMap.get(idx) ?? null
    : (idx) => (idx <= prefixLen ? { to: idx, exact: true } : idx >= oldSuffixStart ? { to: idx + delta, exact: false } : null);
  const rekeyed = new Map();
  let kept = 0;
  let died = 0;
  for (const [idx, peer] of checkpoints) {
    const to = move(idx);
    if (to) {
      if (!to.exact) peer.vstale = true;
      rekeyed.set(to.to, peer);
      kept++;
    } else {
      peer.send('DIE\n');
      if (peer.pid) dyingPids?.add(peer.pid);
      died++;
    }
  }
  const holds = new Map();
  for (const [idx, id] of renderHold) {
    const to = move(idx);
    if (to) holds.set(to.to, id);
  }
  const nextEditHold = editHold
    .map((idx) => move(idx)?.to ?? -1)
    .filter((idx) => idx >= 0);
  const rekey = (f) => move(f)?.to ?? prefixLen;
  if (pendingChain) {
    pendingChain.from = rekey(pendingChain.from);
    // the settle/rebuild a cold walk carries starts from a block index too
    if (pendingChain.carry) pendingChain.carry.from = rekey(pendingChain.carry.from);
  }
  return { checkpoints: rekeyed, renderHold: holds, editHold: nextEditHold, kept, died };
}
