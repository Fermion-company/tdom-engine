import { reconcile } from './pagebuilder.js';
import { buildPagePatches, EAGER_PAGES } from './page-patches.js';
import { pageHfSig } from './header-footer.js';

export function asyncRepaginate(
  engine,
  { paginateNow, displayList, computeToc, queueChainWork, scheduleBackground, pumpOwedPages = () => {} }
) {
  // Demotion to opaque tears down the resident tree. Async render callbacks
  // that were already resolving must not resurrect provisional pages or hit
  // geometry after canonical-only mode has taken ownership.
  if (engine.mode !== 'structured') return;
  // rebuild display lists after async galley/chunk arrivals and push
  // patches through the async channel (SSE)
  // (what each part took, for a caller that traces it: header-scheduler.js TDOM_TRACE_HF)
  const startedAt = performance.now();
  const rawPages = paginateNow();
  const { pages } = reconcile(rawPages, engine.pages);
  const paginatedAt = performance.now();
  let built = 0;
  // (an arrival that moves every page after it, or headers that change on
  // all of them, is delivered like a keystroke's: the pages nearest the last
  // edit now, the others a few at a time: page-patches.js EAGER_PAGES)
  const { patches, later } = buildPagePatches(pages, engine.pages, (page) => pageHfSig(engine.hf, page.number), (page) => {
    built++;
    return displayList(page);
  }, { limit: EAGER_PAGES, focus: engine.owedFocus ?? null });
  const builtAt = performance.now();
  engine.pages = pages;
  if (later) pumpOwedPages();
  if (patches.length && engine.onAsyncPatches) {
    engine.rev++;
    // A late exact render or chain pass can be the first update that uses a
    // newly registered TeX face. Ship the manifest in the same event so the
    // client never paints the patch through a browser fallback font.
    engine.onAsyncPatches({ rev: engine.rev, fonts: engine.getFontManifest(), patches });
  }
  const sentAt = performance.now();
  // toc drift: an async landing (header job, rescue offsets, chunk
  // adoption) moved provisional page numbers AFTER the last toc pass —
  // the \tableofcontents blocks would keep printing the older numbers
  // (the one identity gap the farm's incremental-vs-scratch check kept
  // finding). Queue the settle pass; #chainAfterPass runs the toc
  // fixpoint once the stream is quiet.
  // (owed, not queued: the scheduler queues it once the typing is quiet,
  // background-scheduler.js; queued now, every keystroke until then would
  // verify the paragraph after it before showing it)
  if (engine.mode === 'structured' && !engine.pendingChain && !engine.tocOwed) {
    const consumer = engine.blocks.findIndex((b) => b.consumesToc);
    if (consumer >= 0 && computeToc(pages).hash !== engine.tocHash) {
      engine.tocOwed = true;
      scheduleBackground(consumer, []);
    }
  }
  return {
    pages: pages.length, built, patches: patches.length,
    paginateMs: paginatedAt - startedAt, buildMs: builtAt - paginatedAt, sendMs: sentAt - builtAt,
    tocMs: performance.now() - sentAt,
  };
}
