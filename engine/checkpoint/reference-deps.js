import { push2 } from './util/galley.js';

export function flushVanishedLabels(vanishedLabels, labelCount, labelTable, changedLabels) {
  // labels whose defining blocks all disappeared — index-driven, no
  // labels × blocks scan on the hot path
  for (const key of [...vanishedLabels]) {
    vanishedLabels.delete(key);
    if (labelCount.has(key)) continue; // redefined meanwhile
    if (labelTable.has(key)) {
      labelTable.delete(key);
      changedLabels.add(key);
    }
  }
}

export function labelReferenceCandidates(changedLabels, refIndex) {
  const candidates = new Set();
  for (const k of changedLabels) {
    for (const bid of refIndex.get(k) ?? []) candidates.add(bid);
  }
  return candidates;
}

export function pushLabelDependencies(depDirty, changedLabels, refIndex) {
  for (const key of changedLabels) {
    for (const bid of refIndex.get(key) ?? []) push2(depDirty, 'label', key, bid);
  }
}
