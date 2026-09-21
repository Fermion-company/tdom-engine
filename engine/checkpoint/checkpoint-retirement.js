import { maybeHoldRenderCheckpoint } from './render-hold.js';

export function distinctCheckpointPeerCount(checkpoints) {
  return new Set(checkpoints.values()).size;
}

export function checkpointIndicesForPeers(checkpoints, peers) {
  const wanted = new Set(peers);
  return [...checkpoints]
    .filter(([, peer]) => wanted.has(peer))
    .map(([index]) => index);
}

export function sharedCheckpointBudget({
  maxCheckpoints,
  checkpoints,
  shippingEnabled,
  currentJob = null,
  activeResidentRenders = new Map(),
}) {
  // The shared logical target is 2M. Mandatory roots/bases can exceed it
  // when the target is too small; correctness owners win and optional
  // coverage degrades first. Dying PIDs are observed by the reap queue.
  const base = Math.max(1, Math.floor(Number(maxCheckpoints) || 1));
  const total = base * 2;
  const shippingCheckpoints = shippingEnabled ? Math.min(3, base) : 0;
  const shippingFeeder = shippingEnabled ? 1 : 0;
  const materializedJob = currentJob?.pid &&
    [...checkpoints.values()].some(peer => peer.pid === currentJob.pid);
  const residentReservations = (currentJob && !materializedJob ? 1 : 0) +
    (activeResidentRenders?.size ?? 0);
  const residentLimit = shippingEnabled
    ? Math.max(1, total - shippingCheckpoints - shippingFeeder - residentReservations)
    : Infinity;
  const residentLogical = distinctCheckpointPeerCount(checkpoints) + residentReservations;
  const shippingLimit = shippingEnabled
    ? Math.max(1, Math.min(shippingCheckpoints, total - residentLogical - shippingFeeder))
    : 0;
  return { residentLimit, shippingLimit, residentReservations };
}

function availableKeepSet(
  checkpoints,
  desired,
  mandatoryIndices,
  coverageExcludedIndices = mandatoryIndices,
  maxPeers = Infinity
) {
  const mandatoryPeers = new Set([...mandatoryIndices]
    .map(index => checkpoints.get(index)).filter(Boolean));
  const coverageExcludedPeers = new Set([...coverageExcludedIndices]
    .map(index => checkpoints.get(index)).filter(Boolean));
  const kept = new Set();
  const retainedPeers = new Set(mandatoryPeers);
  for (const index of desired) {
    const peer = checkpoints.get(index);
    if (!peer || retainedPeers.has(peer)) continue;
    if (retainedPeers.size >= maxPeers) break;
    kept.add(index);
    retainedPeers.add(peer);
  }
  for (const target of desired) {
    if (retainedPeers.size >= maxPeers) break;
    if (checkpoints.has(target)) continue;
    let nearest = null;
    const candidates = [...checkpoints.keys()].filter(index =>
      !retainedPeers.has(checkpoints.get(index)));
    const unpinned = candidates.filter(index =>
      !coverageExcludedIndices.has(index) && !coverageExcludedPeers.has(checkpoints.get(index)));
    // Edit/render owners already survive outside the coverage budget. Using
    // them as substitutes can evict a distant frontier without saving a PID.
    for (const index of unpinned.length ? unpinned : candidates) {
      if (nearest === null || Math.abs(index - target) < Math.abs(nearest - target) ||
          (Math.abs(index - target) === Math.abs(nearest - target) && index < nearest)) nearest = index;
    }
    if (nearest !== null) {
      const peer = checkpoints.get(nearest);
      if (retainedPeers.has(peer)) continue;
      kept.add(nearest);
      retainedPeers.add(peer);
    }
  }
  return kept;
}

export function enforceCheckpointCap({
  checkpoints,
  keep,
  editHold,
  coveragePins = editHold,
  renderHold,
  activeHold = [],
  maxPeers = Infinity,
  dyingPids,
}) {
  const protectedIndices = new Set([...editHold, ...renderHold.keys(), ...activeHold]);
  const available = availableKeepSet(
    checkpoints,
    keep,
    protectedIndices,
    new Set([...coveragePins, ...renderHold.keys(), ...activeHold]),
    maxPeers
  );
  const retainedPeers = new Set([...protectedIndices, ...available]
    .map(index => checkpoints.get(index)).filter(Boolean));
  const retiredPeers = new Set();
  for (const [, peer] of [...checkpoints]) {
    if (retainedPeers.has(peer) || retiredPeers.has(peer)) continue;
    peer.send('DIE\n');
    if (peer.pid) dyingPids?.add(peer.pid);
    retiredPeers.add(peer);
  }
  for (const [idx, peer] of [...checkpoints]) {
    if (retiredPeers.has(peer)) checkpoints.delete(idx);
  }
}

export function retireOffGrid({ idx, keep, checkpoints, editHold, renderHold, block, dyingPids }) {
  const protectedIndices = new Set([...editHold, ...renderHold.keys()]);
  const available = availableKeepSet(checkpoints, keep, protectedIndices, protectedIndices);
  const peer = checkpoints.get(idx);
  const aliases = [...checkpoints].filter(([, candidate]) => candidate === peer).map(([index]) => index);
  if (aliases.some(index => available.has(index) || editHold.includes(index) || renderHold.has(index))) return;
  if (!checkpoints.has(idx + 1) || checkpoints.get(idx + 1) === peer) return; // successor must exist first
  // edit-locus pin: keep the boundaries around the block being typed in,
  // so a keystroke burst never pays a grid replay
  if (editHold.includes(idx)) return;
  // Render hold: the resident RENDER path needs the state AT the block,
  // so a block that will want a high-fidelity chunk (math/gfx — typically
  // the one being edited) keeps its checkpoint alive until the chunk
  // lands. Small budget: a boot-time flood must not hold half the
  // document's process tree — beyond it the isolated render path covers.
  if (renderHold.has(idx) || maybeHoldRenderCheckpoint(idx, block, renderHold)) return;
  if (peer) {
    peer.send('DIE\n');
    if (peer.pid) dyingPids?.add(peer.pid);
    for (const index of aliases) checkpoints.delete(index);
  }
}
