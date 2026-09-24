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
  const rekeyed = new Map();
  for (const [idx, peer] of checkpoints) {
    if (idx <= prefixLen) {
      rekeyed.set(idx, peer);
    } else if (idx >= oldSuffixStart) {
      peer.vstale = true;
      rekeyed.set(idx + delta, peer);
    } else {
      peer.send('DIE\n');
      if (peer.pid) dyingPids?.add(peer.pid);
    }
  }
  const holds = new Map();
  for (const [idx, id] of renderHold) {
    if (idx <= prefixLen) holds.set(idx, id);
    else if (idx >= oldSuffixStart) holds.set(idx + delta, id);
  }
  const nextEditHold = editHold
    .map((idx) => (idx <= prefixLen ? idx : idx >= oldSuffixStart ? idx + delta : -1))
    .filter((idx) => idx >= 0);
  const rekey = (f) => (f <= prefixLen ? f : f >= oldSuffixStart ? f + delta : prefixLen);
  if (pendingChain) {
    pendingChain.from = rekey(pendingChain.from);
    // the settle/rebuild a cold walk carries starts from a block index too
    if (pendingChain.carry) pendingChain.carry.from = rekey(pendingChain.carry.from);
  }
  return { checkpoints: rekeyed, renderHold: holds, editHold: nextEditHold };
}
