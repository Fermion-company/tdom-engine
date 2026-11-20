import { chunkTargets } from '../engine/checkpoint/chunk-targets.js';

// A fresh block in a published patch and a paintable whole page are distinct
// observations. The viewer also has a canonical fallback for blocked pages.
export function observePublication(engine, sample, report, now) {
  if (!sample || engine.srcRev !== sample.srcRev) return;
  for (const patch of report.patches ?? []) {
    if (patch.type !== 'replace-page') continue;
    const commands = patch.displayList?.commands ?? [];
    const blocked = commands.some(c => c.op === 'pending-exact' || c.op === 'canon' ||
      (c.op === 'glyphs' && c.math) || (c.op === 'chunk' &&
        (c.st || !engine.chunks.has(c.chunk) || engine.chunks.get(c.chunk).v !== c.cv)));
    for (const target of sample.targets) {
      if (target.pagePublishedMs != null) continue;
      const block = engine.blocks.find(b => b.id === target.id);
      if (!block || block.hash === target.oldHash || block.sourceChanged || engine.coldDirty.has(block.id) ||
          block.galley?.tdomColdPreview || block.galley?.tdomFrozen) continue;
      const own = commands.filter(c => c.src === target.id);
      if (!own.some(c => c.op === 'glyphs' || c.op === 'chunk')) continue;
      if (own.some(c => c.op === 'pending-exact' || c.op === 'canon' || (c.op === 'glyphs' && c.math))) continue;
      if (own.some(c => c.op === 'chunk' && (c.held || c.st ||
          engine.chunks.get(c.chunk)?.v !== c.cv))) continue;
      if (block.needsRender && chunkTargets(block).some(c =>
        engine.chunks.get(c.key)?.forGalley !== block.galleyHash)) continue;
      if (target.publishedMs === null) {
        target.publishedMs = now - sample.started;
        target.channel = 'resident';
      }
      if (blocked) continue;
      target.pages ??= new Map();
      target.pages.set(patch.page, patch.displayList.hash);
      const pages = engine.pages.filter(p => p.dl?.commands.some(c => c.src === target.id));
      if (!pages.length || !pages.every(p => target.pages.get(p.number) === p.dl.hash)) continue;
      target.pagePublishedMs = now - sample.started;
      target.pageChannel = 'resident';
    }
  }
}

export function observeCanonicalPublication(sample, info, now) {
  if (!sample || info.error || info.rev !== sample.srcRev || !info.id) return;
  for (const target of sample.targets) {
    if (target.publishedMs === null) {
      target.publishedMs = now - sample.started;
      target.channel = 'canonical';
    }
    if (target.pagePublishedMs == null) {
      target.pagePublishedMs = now - sample.started;
      target.pageChannel = 'canonical';
    }
  }
}
