import { stripComments } from './safety.js';

export function firstDirtyIndex(oldBlocks, blocks, dirtySource, diff) {
  // First index whose checkpoint chain is invalid. A checkpoint at idx
  // holds the state after blocks[0..idx-1], so it survives exactly when
  // that prefix is unchanged — pure deletions/insertions invalidate from
  // the end of the common prefix even when no block is "dirty".
  let commonPrefix = 0;
  while (
    commonPrefix < oldBlocks.length &&
    commonPrefix < blocks.length &&
    oldBlocks[commonPrefix].hash === blocks[commonPrefix].hash
  ) {
    commonPrefix++;
  }
  let firstDirty = blocks.length;
  for (let i = 0; i < blocks.length; i++) {
    if (!blocks[i].galley || dirtySource.has(blocks[i].id)) {
      firstDirty = i;
      break;
    }
  }
  if (oldBlocks.length !== blocks.length || diff.removed.length) {
    firstDirty = Math.min(firstDirty, commonPrefix);
  }
  return firstDirty;
}

export function hasDefinitionEdit(oldBlocks, blocks, bounds, defRe) {
  // comment-stripped: a `% \newcommand` in the window must not forfeit
  // suffix trust (it costs a full async suffix rebuild)
  const { prefixLen, oldSuffixStart, newSuffixStart } = bounds;
  for (let k = prefixLen; k < oldSuffixStart; k++) {
    if (defRe.test(stripComments(oldBlocks[k]?.text ?? ''))) return true;
  }
  for (let k = prefixLen; k < newSuffixStart; k++) {
    if (defRe.test(stripComments(blocks[k]?.text ?? ''))) return true;
  }
  return false;
}

export function nextEditHold(fgStop, dirtyBlocks, blocks, editHold) {
  const locusPins = [fgStop];
  for (const id of dirtyBlocks) {
    const idx = blocks.findIndex((b) => b.id === id);
    if (idx >= 0) locusPins.push(idx, idx + 1);
  }
  return [...new Set([...locusPins, ...editHold])].slice(0, 8);
}
