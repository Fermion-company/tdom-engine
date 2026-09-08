// Host side: turning an editor's keystrokes into a live preview.
//
// This is the part that is easy to get subtly wrong. LuaLaTeX work is slower
// than typing and slower than switching tabs, so at any moment there can be
// an in-flight push for a document the user has already left. The driver
// therefore versions everything it can be wrong about:
//
//   lifecycleVersion  bumped whenever the preview is suspended or the engine
//                     is restarted — invalidates every push issued before it
//   pushVersion       bumped per enqueued snapshot — the latest one wins
//   generation        bumped whenever the visible surface must be re-adopted,
//                     so a viewer re-applies even an unchanged URL
//
// A result that fails any of those checks is dropped rather than shown, and
// an obsolete failure never clears a newer pending snapshot or resurfaces an
// error the user has already moved past.
//
// Environment-free by construction (timers are injectable), so a host wires
// it to its own editor, settings and viewers, and tests run in plain Node.

const createDebouncedTask = (task, delayMs, timers) => {
  let timer = null;
  const schedule = () => {
    if (timer) timers.clearTimeout(timer);
    timer = timers.setTimeout(() => {
      timer = null;
      task();
    }, delayMs);
  };
  schedule.cancel = () => {
    if (timer) timers.clearTimeout(timer);
    timer = null;
  };
  return schedule;
};

const sameBuffers = (left, right) => {
  if (left.size !== right.size) return false;
  for (const [key, value] of left) if (right.get(key) !== value) return false;
  return true;
};

export function createLiveDriver({
  bridge,
  getSnapshot,
  getCursorOffset = () => null,
  onLive = () => {},
  onError = () => {},
  onLog = () => {},
  // 80ms matches the engine's own client: it typesets a keystroke in
  // 20-60ms, so the debounce dominates end-to-end latency. A 300ms debounce
  // makes a ~50ms pipeline feel like half a second.
  pushDelayMs = 80,
  focusDelayMs = 160,
  healthIntervalMs = 2_000,
  timers = globalThis,
} = {}) {
  let active = false;
  let starting = false;
  let engineStarted = false;
  let engineUrl = null;
  let liveGeneration = 0;
  let lifecycleVersion = 0;
  let latestPushVersion = 0;
  let liveSessionKey = null;
  let queuedSessionKey = null;
  let queuedBuffers = new Map();
  let pendingPush = null;
  let pushing = false;
  let latestInputAtEpochMs = 0;
  let checkingHealth = false;

  const snapshotNow = () => getSnapshot({ clientEditAtEpochMs: latestInputAtEpochMs || undefined });

  const focusCurrent = () => {
    if (!active || !engineStarted || !bridge?.focus) return;
    // A character insertion moves the caret too. Let its push finish first;
    // a speculative warm against the old source can otherwise grab the
    // resident chain just before the real edit arrives.
    if (pushing || pendingPush || latestInputAtEpochMs) {
      debouncedFocus();
      return;
    }
    const offset = getCursorOffset();
    if (offset == null) return;
    void bridge.focus({ offset }).catch(() => {});
  };
  const debouncedFocus = createDebouncedTask(focusCurrent, focusDelayMs, timers);

  const retireObsoleteSession = (nextSessionKey) => {
    const queuedIsObsolete = queuedSessionKey !== null && queuedSessionKey !== nextSessionKey;
    const visibleIsObsolete = liveSessionKey !== null && liveSessionKey !== nextSessionKey;
    if (!queuedIsObsolete && !visibleIsObsolete) return;

    // Invalidate an in-flight result immediately, before the push debounce.
    // Otherwise a completed /open for the previous project can briefly
    // reactivate its iframe after the editor has already switched.
    latestPushVersion += 1;
    pendingPush = null;
    queuedSessionKey = null;
    queuedBuffers.clear();
    if (engineUrl || visibleIsObsolete) {
      engineUrl = null;
      liveSessionKey = null;
      liveGeneration += 1;
      onLive(null, liveGeneration);
    }
  };

  const drainPushes = async () => {
    if (pushing || !bridge?.push) return;
    pushing = true;
    const drainLifecycleVersion = lifecycleVersion;
    let attempted = null;
    try {
      // Single-flight latest-wins queue: while LuaLaTeX is working, new
      // keystrokes replace the one pending snapshot instead of building an
      // unbounded FIFO of already-obsolete document states.
      while (active && pendingPush) {
        const snapshot = pendingPush;
        pendingPush = null;
        attempted = snapshot;
        const result = await bridge.push(snapshot.payload);
        if (!result?.ok) throw new Error(result?.error || 'live preview push failed');
        const isCurrent =
          active &&
          snapshot.lifecycleVersion === lifecycleVersion &&
          snapshot.pushVersion === latestPushVersion;
        if (result.url && isCurrent) {
          if (snapshot.payload.fresh || engineUrl !== result.url || !engineUrl) liveGeneration += 1;
          engineUrl = result.url;
          liveSessionKey = snapshot.sessionKey;
          onLive(engineUrl, liveGeneration);
        }
        if (snapshot.payload.clientEditAtEpochMs === latestInputAtEpochMs) latestInputAtEpochMs = 0;
        attempted = null;
      }
    } catch (error) {
      const failureIsCurrent = Boolean(
        attempted &&
          active &&
          drainLifecycleVersion === lifecycleVersion &&
          attempted.lifecycleVersion === lifecycleVersion &&
          attempted.pushVersion === latestPushVersion
      );
      if (failureIsCurrent) {
        pendingPush = null;
        // Let refresh() retry a fresh open instead of diffing against a
        // source the engine may not have accepted.
        queuedSessionKey = null;
        queuedBuffers.clear();
      }
      const message = error instanceof Error ? error.message : String(error);
      // A push can reject after Live was switched off, after a newer edit, or
      // after the editor changed projects. Never let that obsolete failure
      // discard the new pending snapshot or reopen a stale error surface.
      if (failureIsCurrent) onError(message);
      onLog(message);
    } finally {
      pushing = false;
      if (active && pendingPush) void drainPushes();
    }
  };

  const pushCurrent = () => {
    if (!active || !bridge?.push) return;
    const snapshot = snapshotNow();
    if (!snapshot) return;
    retireObsoleteSession(snapshot.sessionKey);
    // Never push mid-IME-composition: the buffer is transient and a typeset
    // per composition keystroke is wasted work. Try again after the debounce.
    if (snapshot.deferred) {
      debouncedPush();
      return;
    }
    if (snapshot.sessionKey === queuedSessionKey && sameBuffers(snapshot.buffers, queuedBuffers)) {
      return;
    }
    queuedSessionKey = snapshot.sessionKey;
    queuedBuffers = new Map(snapshot.buffers);
    pendingPush = { ...snapshot, pushVersion: ++latestPushVersion, lifecycleVersion };
    void drainPushes();
  };
  const debouncedPush = createDebouncedTask(pushCurrent, pushDelayMs, timers);

  const start = async () => {
    if (!bridge?.start || starting || !snapshotNow()) return;
    const startLifecycleVersion = lifecycleVersion;
    starting = true;
    try {
      const result = await bridge.start();
      if (!active || startLifecycleVersion !== lifecycleVersion) return;
      if (!result?.ok || !result.url) {
        onError(result?.error || 'the preview engine failed to start');
        onLog(`engine failed to start: ${result?.error ?? 'unknown error'}`);
        return;
      }
      engineStarted = true;
      // Do not reveal the engine's boot sample. The first successful project
      // push returns the same URL and shows the viewer only once the real
      // root document is open.
      debouncedPush();
      debouncedFocus();
    } finally {
      starting = false;
    }
  };

  const suspend = () => {
    lifecycleVersion += 1;
    latestPushVersion += 1;
    debouncedPush.cancel();
    debouncedFocus.cancel();
    queuedSessionKey = null;
    queuedBuffers.clear();
    pendingPush = null;
    engineStarted = false;
    engineUrl = null;
    liveSessionKey = null;
    liveGeneration += 1;
    onLive(null, liveGeneration);
  };

  // Poll rather than subscribe: a host can swap an editor's model, change
  // projects or close the last document without any single event that covers
  // all three. The actual session key plus buffers are the source of truth,
  // and pushCurrent is a no-op when both already match the last enqueue.
  const refresh = () => {
    if (!active) {
      onLive(null, liveGeneration);
      return;
    }
    if (!engineStarted && !starting) void start();
    const snapshot = snapshotNow();
    if (snapshot) retireObsoleteSession(snapshot.sessionKey);
    if (
      snapshot &&
      (snapshot.sessionKey !== queuedSessionKey || !sameBuffers(snapshot.buffers, queuedBuffers))
    ) {
      debouncedPush();
    }
    if (engineUrl) onLive(engineUrl, liveGeneration);
  };

  const checkHealth = async () => {
    if (!active || !engineStarted || checkingHealth || !bridge?.status) return;
    const healthLifecycleVersion = lifecycleVersion;
    checkingHealth = true;
    try {
      const status = await bridge.status();
      if (
        active &&
        healthLifecycleVersion === lifecycleVersion &&
        (!status?.running || status.state !== 'ready')
      ) {
        lifecycleVersion += 1;
        latestPushVersion += 1;
        engineStarted = false;
        engineUrl = null;
        liveSessionKey = null;
        // Force the recovered URL through even when the OS hands the new
        // process the same port as the dead one.
        liveGeneration += 1;
        onLive(null, liveGeneration);
        queuedSessionKey = null;
        queuedBuffers.clear();
        pendingPush = null;
        void start();
      }
    } catch {
      // A transient bridge failure is retried by the next poll.
    } finally {
      checkingHealth = false;
    }
  };
  const healthPoll = healthIntervalMs
    ? timers.setInterval(() => void checkHealth(), healthIntervalMs)
    : null;

  const setActive = (next) => {
    if (active === next) return;
    active = next;
    if (active) void start();
    else {
      suspend();
      void bridge?.stop?.();
    }
  };

  return {
    setActive,
    isActive: () => active,
    refresh,
    notifyInput: () => {
      latestInputAtEpochMs = Date.now();
      debouncedPush();
    },
    notifyCursor: () => debouncedFocus(),
    checkHealth,
    getGeneration: () => liveGeneration,
    getUrl: () => engineUrl,
    dispose: () => {
      if (healthPoll !== null) timers.clearInterval(healthPoll);
      suspend();
      active = false;
    },
  };
}
