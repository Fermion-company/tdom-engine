import { fnv1a } from '../hash.js';
import { opensPackageBreakable } from './rescue-classifier.js';

export function queueMovedOffsets(engine, { paginateNow, rescueCacheKey, pumpRescues }) {
  if (engine.mode !== 'structured') return;
  const prov = paginateNow();
  const entry = prov.blockEntry ?? new Map();
  const th = engine.geometry?.textheight ?? 0;
  let queued = false;
  for (let c = 0; c < engine.blocks.length; c++) {
    const block = engine.blocks[c];
    if (!block.rescued) {
      // tex64-internal #88: the fast path typesets a breakable box on the
      // \vsize=\maxdimen page, where it never splits. That is exact while
      // the box fits below the offset it was given (blockEntry is the
      // position before the builder pushes it on); past that the real run
      // splits it, so only the real routine at that offset can show it.
      const items = block.galley?.items;
      if (!items || th <= 0 || !entry.has(block.id) || items.some((it) => it.k === 'eject')) continue;
      if (!opensPackageBreakable(block.text, engine._packageBreakableRe)) continue;
      const sig = fnv1a(block.text);
      if (block.contextRescue === sig) continue;
      const want = Math.round(entry.get(block.id) * 4) / 4;
      const boxH = (block.galley.h ?? 0) + (block.galley.d ?? 0);
      if (boxH <= th - want + 0.5) continue;
      block.contextRescue = sig;
      block.pageOffset = want;
      engine.rescueQueue.set(block.id, rescueCacheKey(block, c));
      engine.contextRescues = (engine.contextRescues ?? 0) + 1;
      queued = true;
      continue;
    }
    // 0.25bp quantum shared with the rescue key and the iso strut: a
    // want/have pair inside one quantum compiles to the same galley by
    // construction, so only a real grid step queues work
    const want = Math.round((entry.get(block.id) ?? 0) * 4) / 4;
    // "have" is the galley's compile PROVENANCE, not block.pageOffset —
    // the latter is set optimistically when a re-rescue is queued, so a
    // compile that never lands (failed, superseded) would otherwise lock
    // the stale galley in forever (found via stress seed-21 burst 2)
    const have = block.galley?.tdomPageOff ?? block.pageOffset ?? 0;
    if (Math.abs(want - have) <= 0.001) {
      block.pageOffset = want;
      continue;
    }
    const items = block.galley?.items ?? [];
    const boxH = (block.galley?.h ?? 0) + (block.galley?.d ?? 0);
    // offset-independence shortcuts: a leading eject counts only when the
    // galley was compiled at the page TOP — there the break is intrinsic
    // to the block (\clearpage & co). Compiled deep in the page, a leading
    // eject usually means "didn't fit at that offset" (split spill), which
    // is exactly the offset-DEPENDENT case.
    if (
      (items[0]?.k === 'eject' && have <= 0.26) ||
      (!items.some((it) => it.k === 'eject') && boxH <= th - want && boxH <= th - have)
    ) {
      block.pageOffset = want;
      continue;
    }
    block.pageOffset = want;
    engine.rescueQueue.set(block.id, rescueCacheKey(block, c));
    queued = true;
  }
  if (queued) pumpRescues();
}
