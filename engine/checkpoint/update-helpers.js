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
  // Only the blocks that changed: an unchanged definition between two
  // edited regions is the same definition (tex64-internal #96).
  const { prefixLen, oldSuffixStart, newSuffixStart } = bounds;
  const range = (from, to) => Array.from({ length: Math.max(0, to - from) }, (_, k) => from + k);
  const oldIdx = bounds.changedOld ?? range(prefixLen, oldSuffixStart);
  const newIdx = bounds.changedNew ?? range(prefixLen, newSuffixStart);
  for (const k of oldIdx) {
    if (defRe.test(stripComments(oldBlocks[k]?.text ?? ''))) return true;
  }
  for (const k of newIdx) {
    if (defRe.test(stripComments(blocks[k]?.text ?? ''))) return true;
  }
  return false;
}

export function editPageRenderIds(blocks, pages, dirtySource) {
  // Only the document's own blocks tie pages together. A draw can also name
  // something every page carries (the running head's source): counted as a
  // block it tied the whole chapter to the edited page, and each keystroke
  // replayed from the chapter's first picture.
  const real = new Set(blocks.map(block => block.id));
  const idsOf = page => (page.draw ?? []).map(draw => draw.u?.blockId).filter(id => real.has(id));
  const nearby = new Set();
  for (const page of pages) {
    const ids = idsOf(page);
    if (!ids.some(id => dirtySource.has(id))) continue;
    for (const id of ids) nearby.add(id);
  }
  // A block that runs over the page boundary ties the next page to this one:
  // the viewer shows both or neither. In a long document the boot leaves far
  // blocks without exact pixels (background-scheduler.js), so a code box on
  // that neighbour held the page being typed on until the next canonical.
  const tied = new Set(nearby);
  for (const page of pages) {
    const ids = idsOf(page);
    if (!ids.some(id => nearby.has(id))) continue;
    for (const id of ids) tied.add(id);
  }
  return blocks.filter(block => tied.has(block.id) && block.needsRender).map(block => block.id);
}

/**
 * Queued exact rescues that keep a page in front of the user unpaintable:
 * the pages holding any of `focusIds` (the edited block, the caret's block)
 * and their blocks, or page-wide pending markers, still in the rescue queue.
 * The pump serves these before the rest of the boot backlog, which runs in
 * document order (31 multicols on the 316-page book, about four minutes).
 */
export function focusRescueIds(pages, focusIds, rescueQueue) {
  const ids = new Set();
  if (!rescueQueue?.size || !focusIds?.size) return ids;
  for (const page of pages) {
    const pending = page.pendingExact ?? [];
    if (!page.draw?.some(draw => focusIds.has(draw.u?.blockId)) && !pending.some(id => focusIds.has(id))) continue;
    for (const id of pending) if (rescueQueue.has(id)) ids.add(id);
    for (const draw of page.draw ?? []) if (rescueQueue.has(draw.u?.blockId)) ids.add(draw.u.blockId);
  }
  for (const id of focusIds) if (rescueQueue.has(id)) ids.add(id);
  return ids;
}

export function nextEditHold(fgStop, dirtyBlocks, blocks, editHold) {
  const locusPins = [fgStop];
  for (const id of dirtyBlocks) {
    const idx = blocks.findIndex((b) => b.id === id);
    if (idx >= 0) locusPins.push(idx, idx + 1);
  }
  return [...new Set([...locusPins, ...editHold])].slice(0, 8);
}
