import { EMPTY_UNITS } from './units.js';

export function indexBlock(blockId, labels, refs, context) {
  const oldLabels = context.blockLabelIdx.get(blockId) ?? EMPTY_UNITS;
  for (const k of oldLabels) {
    const n = (context.labelCount.get(k) ?? 1) - 1;
    if (n <= 0) {
      context.labelCount.delete(k);
      context.vanishedLabels.add(k);
    } else {
      context.labelCount.set(k, n);
    }
  }
  for (const k of labels) {
    context.labelCount.set(k, (context.labelCount.get(k) ?? 0) + 1);
    context.vanishedLabels.delete(k);
  }
  if (labels.length) context.blockLabelIdx.set(blockId, labels);
  else context.blockLabelIdx.delete(blockId);

  const oldRefs = context.blockRefIdx.get(blockId) ?? EMPTY_UNITS;
  for (const k of oldRefs) {
    const set = context.refIndex.get(k);
    if (set) {
      set.delete(blockId);
      if (!set.size) context.refIndex.delete(k);
    }
  }
  for (const k of refs) {
    let set = context.refIndex.get(k);
    if (!set) context.refIndex.set(k, (set = new Set()));
    set.add(blockId);
  }
  if (refs.length) context.blockRefIdx.set(blockId, refs);
  else context.blockRefIdx.delete(blockId);
}

export function unindexBlock(blockId, context) {
  indexBlock(blockId, EMPTY_UNITS, EMPTY_UNITS, context);
}
