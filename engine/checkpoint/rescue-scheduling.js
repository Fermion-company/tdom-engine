import { shippingPriorityQuietMs } from './interactive-priority.js';

export function rescueWaitMs(engine, blockId, now = Date.now()) {
  const resumeOnlyFor = engine.coldDirty.size > 0 && [...engine.coldDirty].every(id => id === blockId);
  const coldAhead = (engine.coldDirty.size > 0 || engine.pendingChain?.kind === 'cold') && !resumeOnlyFor;
  if (engine.editPending > 0 || coldAhead) return 200;
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
