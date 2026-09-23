// ShippingChain pacing (tex64-internal #72).
//
// The chain is the fast exact lane: a keystroke the resident layer cannot
// paint is SEEN through its replay. A keystroke the viewer paints from the
// resident pages needs the replay only to upgrade those pages to exact
// pixels afterwards. Treating both alike had two costs:
//   - while typing, every keystroke replayed the document tail next to the
//     resident job (memoir, 27 pages: app CPU 11.5% without the chain,
//     34.9% with it, for the same keystrokes);
//   - a document left open without editing kept the chain's root and page
//     checkpoints (230-300 MB) for as long as it stayed open.
// A paintable keystroke now holds its replay until typing pauses and the
// chain catches up once. A document that nobody edits retires its chain
// after a quiet period and boots it again on the next caret move or edit.
// Documents whose keystrokes depend on the chain (non-structured policy,
// resident/canonical page-count mismatch, a viewer demanding canonical) are
// never deferred and never retired.

// web/app.js asks for canonical pixels instead of painting these commands
// (stageProvisionalPage). Keep the two gates identical.
const paintBlocked = (cmd) => cmd.op === 'canon' || cmd.op === 'pending-exact' ||
  (cmd.op === 'glyphs' && cmd.math) || (cmd.op === 'chunk' && cmd.st);

const DEFAULT_CATCHUP_MS = 900;
const DEFAULT_IDLE_MS = 120_000;
// After a viewer asked for canonical pixels, the next keystrokes of the
// same passage most likely need the chain too.
const DEPENDENT_HOLD_MS = 15_000;

const envMs = (name, fallback) => {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
};

export const shipCatchupMs = () => envMs('TDOM_SHIP_CATCHUP_MS', DEFAULT_CATCHUP_MS);
export const shipIdleMs = () => envMs('TDOM_SHIP_IDLE_MS', DEFAULT_IDLE_MS);

function hasInputChanges(changes) {
  return !!changes && (changes.unknown || changes.changed?.length || changes.removed?.length);
}

function chainReady(engine) {
  const ship = engine.shipping;
  return !!ship && !engine.shipBooting && engine.shipBootedFor === engine.preHash &&
    !engine.shipStale && !ship.err && !!ship.info?.().baselineReady;
}

/** Keystrokes of this document are painted from resident pages. */
export function residentSufficient(engine, pageCount = engine.pages?.length) {
  return engine.mode === 'structured' && engine.previewPolicy === 'structured' &&
    Number.isInteger(engine.canonicalPageCount) && engine.canonicalPageCount === pageCount &&
    Date.now() >= (engine.shipDependentUntil ?? 0);
}

/**
 * The viewer can paint this keystroke from its resident patches alone:
 * the same gate web/app.js applies before it asks for canonical pixels.
 */
export function residentPaintable(engine, pages, patches, projectInputChanges) {
  if (!shipCatchupMs() || hasInputChanges(projectInputChanges)) return false;
  if (!chainReady(engine) || !residentSufficient(engine, pages.length)) return false;
  return patches.every((patch) => patch.type !== 'replace-page' ||
    !(patch.displayList?.commands ?? []).some(paintBlocked));
}

export function flushDeferredShipUpdate(engine, run) {
  clearTimeout(engine.shipDeferTimer);
  engine.shipDeferTimer = null;
  const pending = engine.shipDeferred;
  engine.shipDeferred = null;
  // shipUpdate binds the replay to the engine's CURRENT srcRev. A held text
  // is only ever replayed on its own (catch-up, display demand) while it is
  // still the newest source; immediateShipUpdate supersedes it in the same
  // tick otherwise.
  if (!pending || pending.srcRev !== engine.srcRev) return false;
  run(pending.text, pending.projectInputChanges);
  return true;
}

/**
 * A keystroke that must reach the chain now. A held edit elsewhere in the
 * document is replayed first: the chain resumes one changed unit at a time,
 * and skipping it would force a full reboot.
 */
export function immediateShipUpdate(engine, text, projectInputChanges, run) {
  const pending = engine.shipDeferred;
  clearTimeout(engine.shipDeferTimer);
  engine.shipDeferTimer = null;
  engine.shipDeferred = null;
  // The held replay is preempted by the next line within this tick, so the
  // current srcRev it is bound to never reaches the renderer.
  if (pending && !engine.shipping?.replayableFrom?.(text)) {
    run(pending.text, pending.projectInputChanges);
  }
  run(text, projectInputChanges);
}

/** Hold a paintable keystroke's replay until typing pauses. */
export function deferShipUpdate(engine, text, projectInputChanges, run) {
  if (engine.shipDeferred && !engine.shipping?.replayableFrom?.(text)) {
    immediateShipUpdate(engine, text, projectInputChanges, run);
    return;
  }
  engine.shipDeferred = { text, projectInputChanges, srcRev: engine.srcRev };
  clearTimeout(engine.shipDeferTimer);
  engine.shipDeferTimer = setTimeout(() => flushDeferredShipUpdate(engine, run), shipCatchupMs());
  engine.shipDeferTimer.unref?.();
}

/** A viewer asked for canonical pixels: the chain is the faster answer. */
export function noteDisplayDemand(engine, run) {
  engine.shipDependentUntil = Date.now() + DEPENDENT_HOLD_MS;
  return flushDeferredShipUpdate(engine, run);
}

/**
 * An edit, a caret move or an open. Re-arms the quiet-period retirement and
 * boots a retired chain again.
 */
export function noteShipActivity(engine, { retire, reboot }) {
  engine.shipActivityAt = Date.now();
  clearTimeout(engine.shipIdleTimer);
  engine.shipIdleTimer = null;
  if (engine.shipIdleRetired) {
    engine.shipIdleRetired = false;
    reboot();
  }
  armShipRetirement(engine, retire);
}

function armShipRetirement(engine, retire) {
  const idleMs = shipIdleMs();
  if (!idleMs || engine.closed) return;
  engine.shipIdleTimer = setTimeout(() => {
    engine.shipIdleTimer = null;
    if (engine.closed) return;
    // A booting chain, a held replay or a document that currently needs the
    // chain is looked at again after another quiet period.
    if (engine.shipDeferred || !chainReady(engine) || !residentSufficient(engine)) {
      armShipRetirement(engine, retire);
      return;
    }
    engine.shipIdleRetired = true;
    engine.diagnostics.push(`shipping: retired after ${Math.round((Date.now() - engine.shipActivityAt) / 1000)} s without editing`);
    void retire();
  }, idleMs);
  engine.shipIdleTimer.unref?.();
}

export function clearShipPacing(engine) {
  clearTimeout(engine.shipDeferTimer);
  clearTimeout(engine.shipIdleTimer);
  engine.shipDeferTimer = null;
  engine.shipIdleTimer = null;
  engine.shipDeferred = null;
  engine.shipIdleRetired = false;
  engine.shipDependentUntil = 0;
}
