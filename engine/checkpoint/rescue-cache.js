import { fnv1a } from '../hash.js';

/**
 * The rescue cache key carries every input the isolated compile depends
 * on: the block text, the previous block's exit state, the preamble, the
 * CURRENT values of every label the block referenced in its last compile
 * (when a referenced label moves, the key misses and the block re-rescues
 * with fresh seeds), and the block's on-page start offset (splitting
 * environments — mdframed, breakable tcolorbox — break by page position).
 */
export function rescueCacheKey(block, idx, { blocks, labelTable, preHash }) {
  const refVals = (block.galley?.refs ?? []).map(
    (k) => k + '=' + (labelTable.get(k) ?? '')
  );
  // same 0.25bp quantum as the iso strut — see #isoCompile
  const pageOff = Math.round((block.pageOffset ?? 0) * 4) / 4;
  return fnv1a(
    JSON.stringify([block.text, blocks[idx - 1]?.stateVec ?? '', preHash, refVals, pageOff])
  );
}

export function isoCacheGet(isoCache, key) {
  const hit = isoCache.get(key);
  if (hit !== undefined) {
    isoCache.delete(key);
    isoCache.set(key, hit); // refresh recency
  }
  return hit;
}

/** LRU-bounded iso result cache: each entry carries the block's chunk
 * SVGs (MBs on package-heavy docs), so an unbounded map grows into the
 * gigabytes across offset-keyed re-rescues — enough to OOM a 7GB CI
 * runner during a boot drain. Evictions only cost a re-fork (~2-5s). */
export function isoCacheSet(isoCache, key, iso) {
  isoCache.set(key, iso);
  const cap = Math.max(8, Number(process.env.TDOM_ISO_CACHE || 48));
  while (isoCache.size > cap) {
    isoCache.delete(isoCache.keys().next().value);
  }
}
