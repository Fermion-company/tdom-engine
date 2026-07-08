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
  const { pages, reused, rebuilt } = reconcile(pagesRaw, engine.pages);
  const { patches, dirtyPages } = buildPagePatches(pages, engine.pages, engine.hfSig, displayList);
  engine.pages = pages;
  scheduleHeaders();
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
