import { reconcile } from './pagebuilder.js';
import { nextEditHold } from './update-helpers.js';
import { buildPagePatches } from './page-patches.js';
import { buildUpdateResponse } from './update-response.js';

export function finalizeUpdate(engine, {
  text,
  editLabel,
  dirtySource,
  typesetResult,
  rebooted,
  diagnostics,
  timer,
  callbacks,
}) {
  const { paginateNow, displayList, scheduleHeaders, enforceCheckpointCap, scheduleBackground, shipUpdate, fidelitySummary } =
    callbacks;
  const { dirtyBlocks, depDirty, changedLabels, typesetCount, forkMs, fgStop, verdict } = typesetResult;
  // pin the edit locus so the next keystroke is fork-once, typeset-once
  engine.editHold = nextEditHold(fgStop, dirtyBlocks, engine.blocks, engine.editHold);

  // ---- pages, display lists, patches ---------------------------------
  const pagesRaw = paginateNow();
  const prevPageCount = engine.pages.length;
  const { pages, reused, rebuilt } = reconcile(pagesRaw, engine.pages);
  const { patches, dirtyPages } = buildPagePatches(pages, engine.pages, engine.hfSig, displayList);
  engine.pages = pages;
  // header/footer respecification walks every page and hashes the result —
  // only worth it when the page composition actually moved (folio values,
  // marks and styles all ride on galley changes, which show up as rebuilt
  // pages or a page-count change)
  if (rebuilt > 0 || pages.length !== prevPageCount || !engine.hfSig) scheduleHeaders();
  timer.lap('paginate');

  // ---- async work: rebuild remaining checkpoint chain + gfx renders --
  // the boot/edit walk left a checkpoint at every block it typeset —
  // collapse to the grid before scheduling background work (a full boot
  // walk of a large document is the worst offender)
  enforceCheckpointCap();
  scheduleBackground(fgStop, dirtyBlocks);
  timer.lap('schedule');

  engine.rev++;
  engine.srcRev++;
  // converge to exact: the canonical compile of THIS source is scheduled
  // off the hot path; when it lands the client swaps every clean page to
  // LuaLaTeX's own pixels
  engine.canonical.schedule(text, engine.srcRev);
  shipUpdate(text);
  return buildUpdateResponse({
    rev: engine.rev,
    srcRev: engine.srcRev,
    editLabel,
    backendName: engine.backendName,
    mode: engine.mode,
    modeReasons: engine.modeReasons,
    canonical: engine.canonical.info(),
    dirtySource,
    dirtyBlocks,
    depDirty,
    dirtyPages,
    patches,
    timerStats: timer.done(),
    blocks: engine.blocks,
    typesetCount,
    forkMs,
    rebooted,
    checkpoints: engine.checkpoints,
    verdict,
    pendingChain: engine.pendingChain,
    reused,
    rebuilt,
    pages,
    changedLabels,
    verifyState: engine.verifyState,
    fidelity: fidelitySummary(),
    diagnostics,
    engineDiagnostics: engine.diagnostics,
  });
}
