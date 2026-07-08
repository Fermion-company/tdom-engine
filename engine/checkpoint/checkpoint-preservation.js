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
  if (pendingChain) {
    const f = pendingChain.from;
    pendingChain.from = f <= prefixLen ? f : f >= oldSuffixStart ? f + delta : prefixLen;
  }
  return { checkpoints: rekeyed, renderHold: holds, editHold: nextEditHold };
}
