import { reconcile } from './pagebuilder.js';
import { buildPagePatches, EAGER_PAGES } from './page-patches.js';
import { furniturePageKey } from './page-metadata.js';
import { displayListBodyChanged } from './display-list.js';

export function asyncRepaginate(
  engine,
  { paginateNow, displayList, computeToc, queueChainWork, scheduleBackground, pumpOwedPages = () => {},
    noteSpecs = () => {}, noteFurnitureInputs = () => {}, scheduleHeaders = () => {} }
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
  const { pages, furnitureUnchanged } = reconcile(rawPages, engine.pages,
    engine.opening ? undefined : (a, b) => furniturePageKey(a) === furniturePageKey(b));
  const noted = noteSpecs(pages, furnitureUnchanged);
  noteFurnitureInputs(pages);
  const prevPageCount = engine.pages.length;
  const paginatedAt = performance.now();
  let built = 0;
  // (an arrival that moves every page after it, or headers that change on
  // all of them, is delivered like a keystroke's: the pages nearest the last
  // edit now, the others a few at a time: page-patches.js EAGER_PAGES)
  const { patches, later } = buildPagePatches(pages, engine.pages, (page) => engine.furnitureSig(page.number, page), (page, bodyContext) => {
    built++;
    return displayList(page, bodyContext);
  }, { limit: EAGER_PAGES, focus: engine.owedFocus ?? null,
    bodyChanged: (page, stamp) => displayListBodyChanged(page, noted?.specs?.[page.number - 1], stamp),
    bodyContext: `${engine.closureDeferred?.residentSrcRev ?? engine.srcRev}/${pages.length}` });
  const builtAt = performance.now();
  engine.pages = pages;
  if (later) pumpOwedPages();
  // A landing that moves pages (a rescue, a chain pass) moves their heads
  // too: the header map used to keep the layout of the last keystroke until
  // the next one (scheduleHeaders runs only when the page specs changed).
  const changedFurniture = noted && noted.sig !== engine.hfSig && noted.sig !== engine.hfFailedSig;
  if (patches.length || pages.length !== prevPageCount || changedFurniture) scheduleHeaders();
  if (patches.length && engine.onAsyncPatches) {
    engine.rev++;
    // A late exact render or chain pass can be the first update that uses a
    // newly registered TeX face. Ship the manifest in the same event so the
    // client never paints the patch through a browser fallback font.
    // (the layout it stands for: the page count and source revision of this
    // engine revision, so a viewer orders it against reports published
    // later under older revisions, web/app.js pageSetEnd)
    engine.onAsyncPatches({ rev: engine.rev, pageCount: pages.length, srcRev: engine.srcRev, fonts: engine.getFontManifest(), patches });
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
  const gridOnly = engine.pendingChain?.kind === 'grid';
  if (engine.mode === 'structured' && (!engine.pendingChain || gridOnly) && !engine.tocOwed) {
    const consumer = engine.blocks.findIndex((b) => b.consumesToc);
    if (consumer >= 0 && computeToc(pages).hash !== engine.tocHash) {
      engine.tocOwed = true;
      // A grid pass has no contents phase. Its scheduler will pick up this
      // obligation when the active walk returns.
      if (!gridOnly) scheduleBackground(consumer, []);
    }
  }
  return {
    pages: pages.length, built, patches: patches.length,
    paginateMs: paginatedAt - startedAt, buildMs: builtAt - paginatedAt, sendMs: sentAt - builtAt,
    tocMs: performance.now() - sentAt,
  };
}
