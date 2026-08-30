export function checkpointGrid(blockCount, maxCheckpoints) {
  return Math.max(1, Math.ceil((blockCount + 1) / maxCheckpoints));
}

/**
 * Pick the resident boundaries by measured replay cost, not source-block
 * count. Equal spacing makes an edit after one giant TikZ/user-macro block
 * replay that block on every keystroke even when all surrounding prose is
 * cheap. Keeping both sides of the most expensive blocks bounds that replay
 * without teaching the engine names such as tikzpicture or tcolorbox.
 */
export function checkpointKeepSet(blocks, maxCheckpoints) {
  const count = blocks.length;
  const limit = Math.max(1, Math.floor(Number(maxCheckpoints) || 1));
  if (count + 1 <= limit) return new Set(Array.from({ length: count + 1 }, (_, i) => i));

  const keep = new Set([0]);
  const cost = blocks.map((block) => Math.max(0.1, Number(block.typesetCostMs) || 1));
  const ranked = cost
    .map((value, index) => ({ value, index }))
    .sort((a, b) => b.value - a.value || a.index - b.index);

  // Reserve at least one slot for broad document coverage. Each hot block
  // wants its input boundary (editing the block) and output boundary
  // (editing ordinary prose after it).
  const hotSlots = Math.max(0, limit - 2);
  for (const { index } of ranked) {
    if (keep.size >= 1 + hotSlots) break;
    for (const boundary of [index, index + 1]) {
      if (boundary > 0 && boundary <= count && keep.size < 1 + hotSlots) keep.add(boundary);
    }
  }

  // Fill the remaining budget at weighted quantiles. This preserves useful
  // reachability through long all-prose regions and naturally shifts the
  // skeleton toward moderately expensive areas.
  const total = cost.reduce((sum, value) => sum + value, 0);
  while (keep.size < limit) {
    const ordinal = keep.size;
    const target = total * ordinal / limit;
    let sum = 0;
    let boundary = count;
    for (let i = 0; i < cost.length; i++) {
      sum += cost[i];
      if (sum >= target) {
        boundary = Math.min(count, i + 1);
        break;
      }
    }
    if (!keep.has(boundary)) {
      keep.add(boundary);
      continue;
    }
    // Quantiles can collapse onto one dominant block. Choose the boundary
    // farthest from an existing checkpoint so the loop always progresses.
    let best = null;
    let bestDistance = -1;
    for (let candidate = 1; candidate <= count; candidate++) {
      if (keep.has(candidate)) continue;
      let distance = Infinity;
      for (const existing of keep) distance = Math.min(distance, Math.abs(candidate - existing));
      if (distance > bestDistance) {
        best = candidate;
        bestDistance = distance;
      }
    }
    if (best == null) break;
    keep.add(best);
  }
  return keep;
}

export function nearestCheckpoint(checkpoints, idx) {
  let best = 0;
  for (const k of checkpoints.keys()) {
    if (k <= idx && k > best) best = k;
  }
  return best;
}
