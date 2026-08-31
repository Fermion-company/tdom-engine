import { maybeHoldRenderCheckpoint } from './render-hold.js';

export function enforceCheckpointCap({ checkpoints, keep, editHold, renderHold, dyingPids }) {
  for (const [idx, peer] of [...checkpoints]) {
    if (keep.has(idx)) continue; // measured-cost skeleton
    if (editHold.includes(idx)) continue; // block being typed in
    if (renderHold.has(idx)) continue; // awaiting an exact chunk
    peer.send('DIE\n');
    if (peer.pid) dyingPids?.add(peer.pid);
    checkpoints.delete(idx);
  }
}

export function retireOffGrid({ idx, keep, checkpoints, editHold, renderHold, block, dyingPids }) {
  if (keep.has(idx)) return;
  if (!checkpoints.has(idx + 1)) return; // successor must exist first
  // edit-locus pin: keep the boundaries around the block being typed in,
  // so a keystroke burst never pays a grid replay
  if (editHold.includes(idx)) return;
  // Render hold: the resident RENDER path needs the state AT the block,
  // so a block that will want a high-fidelity chunk (math/gfx — typically
  // the one being edited) keeps its checkpoint alive until the chunk
  // lands. Small budget: a boot-time flood must not hold half the
  // document's process tree — beyond it the isolated render path covers.
  if (maybeHoldRenderCheckpoint(idx, block, renderHold)) return;
  const peer = checkpoints.get(idx);
  if (peer) {
    peer.send('DIE\n');
    if (peer.pid) dyingPids?.add(peer.pid);
    checkpoints.delete(idx);
  }
}
