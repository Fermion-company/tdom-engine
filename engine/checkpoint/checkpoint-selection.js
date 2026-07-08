export function checkpointGrid(blockCount, maxCheckpoints) {
  return Math.max(1, Math.ceil((blockCount + 1) / maxCheckpoints));
}

export function nearestCheckpoint(checkpoints, idx) {
  let best = 0;
  for (const k of checkpoints.keys()) {
    if (k <= idx && k > best) best = k;
  }
  return best;
}
