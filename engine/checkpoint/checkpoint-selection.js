import { stripComments } from './safety.js';

// This only chooses a replay frontier; every source token still executes.
// Trailing spacing/flush commands are poor anchors for editing visible ink.
function tailCheckpoint(blocks, limit) {
  const textAt = index => typeof blocks[index]?.text === 'string'
    ? stripComments(blocks[index].text).trim() : null;
  const spacing = /^(?:\s*\\(?:par|smallskip|medskip|bigskip|newpage|clearpage)\s*)*$/;
  let tail = blocks.length - 1;
  while (tail > 0 && textAt(tail) !== null && spacing.test(textAt(tail))) tail--;
  // Include the last page's heading and unchanged exact neighbors, when a
  // nearby explicit page boundary is available within the coverage interval.
  const lookback = Math.max(4, Math.ceil(blocks.length / Math.max(1, limit - 1)));
  for (let index = tail - 1; index >= Math.max(0, tail - lookback); index--) {
    if (/\\(?:newpage|clearpage)\s*$/.test(textAt(index) ?? '')) return index + 1;
  }
  return tail;
}

/**
 * Resident checkpoints scale with the document. Before the first canonical
 * compile, a small document keeps every block boundary. Once canonical has
 * proved the physical page count, at most one coverage checkpoint per page
 * plus the root is retained; keeping fifteen forks for a three-page note
 * spends memory without buying sub-page replay coverage. A long document
 * still keeps as many as the host's memory ceiling allows, spread by
 * measured cost (checkpointKeepSet). A fixed budget of 8 made a 316-page
 * book keep one boundary per ~80 blocks, so a caret placed far from the
 * skeleton replayed up to 80 blocks (tens of seconds) before its first
 * keystroke could be typeset. Each dormant fork costs only the pages the
 * active process has dirtied since, so the ceiling is the memory knob.
 */
export function checkpointBudgetFor(blockCount, { ceiling = 64, pageCount = null } = {}) {
  const count = Math.max(0, Math.floor(Number(blockCount) || 0));
  const top = Math.max(1, Math.floor(Number(ceiling) || 1));
  const pages = Math.floor(Number(pageCount));
  const pageBudget = Number.isFinite(pages) && pages > 0 ? pages + 1 : Infinity;
  return Math.max(1, Math.min(top, count + 1, pageBudget));
}

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
  if (limit === 1) return new Set([0]);

  const measured = blocks.map(block => Number(block.typesetCostMs))
    .filter(value => Number.isFinite(value) && value > 0).sort((a, b) => a - b);
  const median = measured[Math.floor(measured.length / 2)] ?? 1;
  const cost = blocks.map((block) => Math.max(0.1, Number(block.typesetCostMs) || median));
  const total = cost.reduce((sum, value) => sum + value, 0);
  // The replay a caret (or a cold keystroke) pays is the cost of the blocks
  // between its nearest kept boundary and itself. Cut the document into
  // segments of equal replay cost, and bracket a block that is expensive on
  // its own (a TikZ picture, a heavy user macro) with its input and output
  // boundary so neither editing it nor editing the prose after it replays
  // it. This is measured cost, not names such as tikzpicture or tcolorbox.
  const target = total / (limit - 1);
  const hotThreshold = Math.max(median * 8, target / 2);
  const keep = new Set([0]);
  let acc = 0;
  for (let i = 0; i < count; i++) {
    if (cost[i] >= hotThreshold) {
      if (i > 0) keep.add(i);
      keep.add(Math.min(count, i + 1));
      acc = 0;
      continue;
    }
    acc += cost[i];
    if (acc >= target) {
      keep.add(Math.min(count, i + 1));
      acc = 0;
    }
  }
  // The tail slot goes before the final visible material and its nearby
  // page context, not after it at a terminal page flush.
  const tail = count > 1 ? tailCheckpoint(blocks, limit) : count;
  keep.add(tail);

  const segmentCost = (from, to) => {
    let sum = 0;
    for (let i = from; i < to; i++) sum += cost[i];
    return sum;
  };
  // Over budget: merge the two cheapest adjacent segments by dropping the
  // boundary between them (root and tail stay). Ties drop the later one, so
  // an expensive block keeps its input boundary longest.
  while (keep.size > limit) {
    const sorted = [...keep].sort((a, b) => a - b);
    let victim = null;
    let victimCost = Infinity;
    for (let k = 1; k < sorted.length; k++) {
      const boundary = sorted[k];
      if (boundary === tail) continue;
      const before = sorted[k - 1];
      const after = k + 1 < sorted.length ? sorted[k + 1] : count;
      const merged = segmentCost(before, after);
      if (merged <= victimCost) {
        victim = boundary;
        victimCost = merged;
      }
    }
    if (victim == null) break;
    keep.delete(victim);
  }
  // Under budget: split the most expensive segment at its cost midpoint.
  while (keep.size < limit) {
    const sorted = [...keep].sort((a, b) => a - b);
    let bestFrom = -1;
    let bestTo = -1;
    let bestCost = -1;
    for (let k = 0; k < sorted.length; k++) {
      const from = sorted[k];
      const to = k + 1 < sorted.length ? sorted[k + 1] : count;
      if (to - from < 2) continue;
      const value = segmentCost(from, to);
      if (value > bestCost) {
        bestCost = value;
        bestFrom = from;
        bestTo = to;
      }
    }
    if (bestFrom < 0) break;
    let sum = 0;
    let split = bestFrom + 1;
    for (let i = bestFrom; i < bestTo; i++) {
      sum += cost[i];
      if (sum >= bestCost / 2) {
        split = Math.min(bestTo - 1, Math.max(bestFrom + 1, i + 1));
        break;
      }
    }
    if (keep.has(split)) break;
    keep.add(split);
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

/**
 * The cost a block contributes to the skeleton is its intrinsic replay
 * cost, estimated as the minimum measured so far: a sample inflated by a
 * fork stall, swapping or a warm reopening fonts must never turn an
 * ordinary paragraph into a "hot" block and move every boundary after it
 * (measured: one 6.7 s spike on a 200 ms paragraph re-cut the whole grid).
 * Returns the value to store, or null when the sample changes nothing.
 */
export function nextTypesetCost(previous, elapsedMs) {
  const sample = Number(elapsedMs);
  if (!Number.isFinite(sample) || sample < 0) return null;
  const prior = Number(previous) || 0;
  if (!prior) return sample;
  return sample < prior ? sample : null;
}

/**
 * Keep-set boundaries the grid pass should materialize (docs/03): those
 * whose replay from the nearest resident boundary below them costs more
 * than `tolerance` of one equal-cost segment, and that no resident
 * boundary shortly after them covers either. A boundary a block or two
 * away from a resident one is served well enough by it (the partition is
 * merely shifted by those blocks) — chasing every drift of the plan, which
 * moves whenever cost samples refine, would re-fork the document for
 * nothing. Returned in document order; root and the end never count.
 */
export function gridMissingBoundaries(blocks, keep, checkpoints, maxCheckpoints, { tolerance = 0.15 } = {}) {
  const count = blocks.length;
  if (!count) return [];
  const limit = Math.max(2, Math.floor(Number(maxCheckpoints) || 2));
  const measured = blocks.map(block => Number(block.typesetCostMs))
    .filter(value => Number.isFinite(value) && value > 0).sort((a, b) => a - b);
  const median = measured[Math.floor(measured.length / 2)] ?? 1;
  const cost = blocks.map((block) => Math.max(0.1, Number(block.typesetCostMs) || median));
  const total = cost.reduce((sum, value) => sum + value, 0);
  const allowance = (total / (limit - 1)) * tolerance;
  const held = [...checkpoints.keys()].sort((a, b) => a - b);
  const missing = [];
  for (const idx of [...keep].sort((a, b) => a - b)) {
    if (idx <= 0 || idx >= count || checkpoints.has(idx)) continue;
    const below = nearestCheckpoint(checkpoints, idx);
    let replay = 0;
    for (let i = below; i < idx && replay <= allowance; i++) replay += cost[i];
    if (replay <= allowance) continue;
    const above = held.find((k) => k > idx);
    if (above !== undefined) {
      let ahead = 0;
      for (let i = idx; i < above && ahead <= allowance; i++) ahead += cost[i];
      if (ahead <= allowance) continue;
    }
    missing.push(idx);
  }
  return missing;
}
