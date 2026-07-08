export function collectFrozenBlockIds(blocks, isoFailCache, rescueCacheKey) {
  return collectFrozenBlocks(blocks, isoFailCache, rescueCacheKey).map((f) => f.id);
}

export function collectFrozenBlocks(blocks, isoFailCache, rescueCacheKey) {
  const out = [];
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i];
    const failMsg = isoFailCache.get(rescueCacheKey(b, i));
    if (b.galley?.tdomFrozen || failMsg) {
      out.push({ id: b.id, text: b.text, reason: failMsg ?? 'hard-frozen galley' });
    }
  }
  return out;
}
