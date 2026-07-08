import { reconcile } from './pagebuilder.js';
import { buildPagePatches } from './page-patches.js';

export function asyncRepaginate(
  engine,
  { paginateNow, displayList, computeToc, queueChainWork, scheduleBackground }
) {
  // rebuild display lists after async galley/chunk arrivals and push
  // patches through the async channel (SSE)
  const rawPages = paginateNow();
  const { pages } = reconcile(rawPages, engine.pages);
  const { patches } = buildPagePatches(pages, engine.pages, engine.hfSig, displayList);
  engine.pages = pages;
  if (patches.length && engine.onAsyncPatches) {
    engine.rev++;
    engine.onAsyncPatches({ rev: engine.rev, patches });
  }
  // toc drift: an async landing (header job, rescue offsets, chunk
  // adoption) moved provisional page numbers AFTER the last toc pass —
  // the \tableofcontents blocks would keep printing the older numbers
  // (the one identity gap the farm's incremental-vs-scratch check kept
  // finding). Queue the settle pass; #chainAfterPass runs the toc
  // fixpoint once the stream is quiet.
  if (engine.mode === 'structured' && !engine.pendingChain) {
    const consumer = engine.blocks.findIndex((b) => b.consumesToc);
    if (consumer >= 0 && computeToc(pages).hash !== engine.tocHash) {
      queueChainWork('settle', consumer, []);
      scheduleBackground(consumer, []);
    }
  }
}
