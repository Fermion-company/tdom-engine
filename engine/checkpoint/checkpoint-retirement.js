import { maybeHoldRenderCheckpoint } from './render-hold.js';

// A changing cost estimate may select boundaries the walk has already
// passed. Retain nearby existing snapshots until their replacements exist.
function availableKeepSet(checkpoints, desired, protectedIndices) {
  const kept = new Set([...desired].filter(index => checkpoints.has(index)));
  for (const target of desired) {
    if (kept.size >= desired.size) break;
    if (checkpoints.has(target)) continue;
    let nearest = null;
    const candidates = [...checkpoints.keys()].filter(index => !kept.has(index));
    const unpinned = candidates.filter(index => !protectedIndices.has(index));
    // Edit/render owners already survive outside the coverage budget. Using
    // them as substitutes can evict a distant frontier without saving a PID.
    for (const index of unpinned.length ? unpinned : candidates) {
      if (nearest === null || Math.abs(index - target) < Math.abs(nearest - target) ||
          (Math.abs(index - target) === Math.abs(nearest - target) && index < nearest)) nearest = index;
    }
    if (nearest !== null) kept.add(nearest);
  }
  return kept;
}

export function enforceCheckpointCap({ checkpoints, keep, editHold, coveragePins = editHold, renderHold, dyingPids }) {
  const available = availableKeepSet(checkpoints, keep, new Set([...coveragePins, ...renderHold.keys()]));
  for (const [idx, peer] of [...checkpoints]) {
    if (available.has(idx)) continue; // measured-cost skeleton
    if (editHold.includes(idx)) continue; // block being typed in
    if (renderHold.has(idx)) continue; // awaiting an exact chunk
    peer.send('DIE\n');
    if (peer.pid) dyingPids?.add(peer.pid);
    checkpoints.delete(idx);
  }
}

export function retireOffGrid({ idx, keep, checkpoints, editHold, renderHold, block, dyingPids }) {
  if (availableKeepSet(checkpoints, keep, new Set([...editHold, ...renderHold.keys()])).has(idx)) return;
  if (!checkpoints.has(idx + 1)) return; // successor must exist first
  // edit-locus pin: keep the boundaries around the block being typed in,
  // so a keystroke burst never pays a grid replay
  if (editHold.includes(idx)) return;
  // Render hold: the resident RENDER path needs the state AT the block,
  // so a block that will want a high-fidelity chunk (math/gfx — typically
  // the one being edited) keeps its checkpoint alive until the chunk
  // lands. Small budget: a boot-time flood must not hold half the
  // document's process tree — beyond it the isolated render path covers.
  if (renderHold.has(idx) || maybeHoldRenderCheckpoint(idx, block, renderHold)) return;
  const peer = checkpoints.get(idx);
  if (peer) {
    peer.send('DIE\n');
    if (peer.pid) dyingPids?.add(peer.pid);
    checkpoints.delete(idx);
  }
}
