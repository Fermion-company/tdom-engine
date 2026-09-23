import { performance } from 'node:perf_hooks';
import { reconcile } from './pagebuilder.js';
import { nextEditHold, editPageRenderIds } from './update-helpers.js';
import { buildPagePatches } from './page-patches.js';
import { buildUpdateResponse } from './update-response.js';
import { residentPaintable } from './ship-pacing.js';

export function finalizeUpdate(engine, {
  text,
  editLabel,
  dirtySource,
  typesetResult,
  rebooted,
  diagnostics,
  projectInputChanges = null,
  residentEditCandidate = false,
  advanceSrcRev = true,
  timer,
  callbacks,
}) {
  const {
    paginateNow, displayList, scheduleHeaders, enforceCheckpointCap, scheduleBackground,
    shipUpdate, deferShipUpdate = shipUpdate, fidelitySummary,
  } = callbacks;
  const { dirtyBlocks, depDirty, changedLabels, typesetCount, forkMs, fgStop, verdict, cold = null } = typesetResult;
  // pin the edit locus so the next keystroke is fork-once, typeset-once
  engine.editHold = rebooted ? [] : nextEditHold(fgStop, dirtySource, engine.blocks, engine.editHold);

  // ---- pages, display lists, patches ---------------------------------
  const pagesRaw = paginateNow();
  const prevPageCount = engine.pages.length;
  const { pages, reused, rebuilt } = reconcile(pagesRaw, engine.pages);
  const { patches, dirtyPages } = buildPagePatches(pages, engine.pages, engine.hfSig, displayList);
  if (!advanceSrcRev) {
    // A cold resume owes the keystroke its page: when another walk already
    // typeset the block and published the page through the async channel,
    // the identity diff is empty, but the anchor plan reads the block's
    // lines from this report's patches. Re-send those pages as they are.
    const patched = new Set(patches.filter((patch) => patch.type === 'replace-page').map((patch) => patch.page));
    for (const page of pages) {
      if (patched.has(page.number)) continue;
      if (!page.dl?.commands?.some((command) => dirtySource.has(command.src))) continue;
      patches.push({ type: 'replace-page', page: page.number, displayList: page.dl });
      dirtyPages.push(page.number);
    }
  }
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

  engine.rev++;
  if (advanceSrcRev) {
    engine.srcRev++;
    // Bind shipping and the foreground exact-render cohort to the same source
    // revision. Cold work keeps the shipping priority window; edited blocks
    // and their changed neighbors may supply an earlier complete preview.
    // A keystroke the viewer paints from these resident patches only needs
    // the replay to upgrade its pages later: hold it until typing pauses
    // (tex64-internal #72, ship-pacing.js).
    if (residentPaintable(engine, pages, patches, projectInputChanges)) {
      deferShipUpdate(text, projectInputChanges);
    } else {
      shipUpdate(text, projectInputChanges);
    }
    // converge to exact: the canonical compile of THIS source is scheduled
    // off the hot path; when it lands the client swaps every clean page to
    // LuaLaTeX's own pixels
    engine.canonical.schedule(text, engine.srcRev);
  }
  // A cold resume publishes the typeset of a source revision that already
  // has its shipping generation and canonical compile scheduled.
  scheduleBackground(fgStop, dirtyBlocks, {
    interactive: !rebooted,
    pageRenderIds: rebooted ? [] : editPageRenderIds(engine.blocks, engine.pages, dirtySource),
  });
  timer.lap('schedule');
  return buildUpdateResponse({
    rev: engine.rev,
    srcRev: engine.srcRev,
    editLabel,
    backendName: engine.backendName,
    mode: engine.mode,
    modeReasons: engine.modeReasons,
    previewPolicy: engine.previewPolicy,
    previewReasons: engine.previewReasons,
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
    cold,
    coldWalk: editLabel === 'cold-resume' ? coldWalkReport(engine) : null,
    pendingChain: engine.pendingChain,
    reused,
    rebuilt,
    pages,
    changedLabels,
    verifyState: engine.verifyState,
    fidelity: fidelitySummary(),
    fonts: engine.getFontManifest(),
    diagnostics,
    engineDiagnostics: engine.diagnostics,
    residentEditCandidate,
  });
}

/**
 * A certified structural alias gives us safe source/region boundaries, not
 * a trustworthy JS page tree.  When ShippingChain is available, an ordinary
 * body keystroke therefore has no reason to wait for resident state jobs or
 * isolated rescue adoption: neither result is eligible for presentation.
 * Advance the immutable source generation immediately and let the native
 * complete-PDF lane prove the next physical pages.  The resident tree stays
 * last-known-good and is explicitly marked for a deferred rebuild.
 */
export function finalizeShippingExactUpdate(engine, {
  text,
  editLabel,
  dirtySource,
  firstDirty,
  rebooted,
  diagnostics,
  projectInputChanges = null,
  timer,
  callbacks,
}) {
  const { queueChainWork, shipUpdate, scheduleBackground, fidelitySummary } = callbacks;
  queueChainWork('rebuild', Math.max(0, firstDirty), []);
  timer.lap('typeset');
  timer.lap('paginate');

  engine.rev++;
  engine.srcRev++;
  // Bind the fast exact replay before scheduling the low-priority canonical
  // audit.  Both consume this immutable source text/srcRev pair.
  shipUpdate(text, projectInputChanges);
  engine.canonical.schedule(text, engine.srcRev);
  scheduleBackground(firstDirty, []);
  timer.lap('schedule');

  const canonical = engine.canonical.info();
  return buildUpdateResponse({
    rev: engine.rev,
    srcRev: engine.srcRev,
    editLabel,
    backendName: engine.backendName,
    mode: engine.mode,
    modeReasons: engine.modeReasons,
    previewPolicy: engine.previewPolicy,
    previewReasons: engine.previewReasons,
    canonical,
    dirtySource,
    dirtyBlocks: [...dirtySource],
    depDirty: [],
    dirtyPages: [],
    patches: [],
    timerStats: timer.done(),
    blocks: engine.blocks,
    typesetCount: 0,
    forkMs: 0,
    rebooted,
    checkpoints: engine.checkpoints,
    verdict: 'shipping-deferred',
    pendingChain: engine.pendingChain,
    reused: engine.pages.length,
    rebuilt: 0,
    pages: engine.pages,
    reportedPageCount: canonical.pageCount || engine.pages.length,
    changedLabels: new Set(),
    verifyState: engine.verifyState,
    fidelity: fidelitySummary(),
    fonts: engine.getFontManifest(),
    diagnostics,
    engineDiagnostics: engine.diagnostics,
  });
}

/** The cold replay's telemetry plus its timeline, in ms since the budgeted stop. */
function coldWalkReport(engine) {
  const walk = engine.coldWalk ?? null;
  const t = engine.coldTrace;
  if (!t?.stopAt) return walk;
  const rel = (v) => (v == null ? null : Math.round(v - t.stopAt));
  return {
    ...(walk ?? {}),
    timeline: {
      gateMs: rel(t.gateAt),
      passLockMs: rel(t.passLockAt),
      walkDoneMs: rel(t.walkDoneAt),
      resumeMs: rel(t.resumeAt),
      publishMs: rel(performance.now()),
    },
  };
}
