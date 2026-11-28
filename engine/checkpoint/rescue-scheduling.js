import { shippingPriorityQuietMs } from './interactive-priority.js';

/**
 * Whether a cold keystroke's resume (docs/10 §10.4a) goes before adopting the
 * exact rescue of `blockId`: the adopt walk holds the chain lock for seconds
 * and the keystroke's page is not on screen until the resume runs. Not when
 * the resume is owed only for this very block (an edit inside a multicols
 * that the walk left cold): its adoption walk re-typesets the same path, and
 * the resume would only re-show the held galley (tex64-internal #94).
 *
 * The rescue pump waits while this holds and the adopt walk gives way when it
 * starts to hold: one rule for both. The walk used to give way to any cold
 * chain, the pump only to this one, so a focused rescue whose result was
 * already compiled started a walk that gave way at once, went back on the
 * queue and started again without ever leaving the microtask queue; the cold
 * resume's idle gate is a timer and never ran (tex64-internal #121: typing
 * into a rescued box while a preamble edit rebuilt the paper left the engine
 * at 100% CPU, and Live never came back).
 */
export function coldResumeAhead(engine, blockId) {
  if (!(engine.coldDirty.size > 0 || engine.pendingChain?.kind === 'cold')) return false;
  return !(engine.coldDirty.size > 0 && [...engine.coldDirty].every(id => id === blockId));
}

export function rescueWaitMs(engine, blockId, now = Date.now()) {
  if (engine.editPending > 0 || coldResumeAhead(engine, blockId)) return 200;
  if (engine.rescueFocus.has(blockId)) return 0;
  return Math.min(200, Math.max(0, shippingPriorityQuietMs(engine, 800) - (now - (engine.lastEditAt ?? 0))));
}

// Foreground finalization can make a queued rescue eligible before its idle
// timer expires. Wake the serial pump; it re-reads both focus and cache key.
export function waitForRescueChange(engine, ms) {
  return new Promise(resolve => {
    const wake = () => {
      clearTimeout(timer);
      engine.rescueWakeups.delete(wake);
      resolve();
    };
    const timer = setTimeout(wake, ms);
    (engine.rescueWakeups ??= new Set()).add(wake);
  });
}

export function wakeRescues(engine) {
  for (const wake of engine.rescueWakeups ?? []) wake();
}
