import test from 'node:test';
import assert from 'node:assert/strict';
import { createLiveDriver } from '../host/live-driver.js';

// Injected timers: the driver's debounce and health poll are explicit steps
// here rather than wall-clock waits.
const manualTimers = () => {
  let nextId = 0;
  const timeouts = new Map();
  const intervals = new Map();
  return {
    setTimeout(fn) {
      const id = ++nextId;
      timeouts.set(id, fn);
      return id;
    },
    clearTimeout(id) {
      timeouts.delete(id);
    },
    setInterval(fn) {
      const id = ++nextId;
      intervals.set(id, fn);
      return id;
    },
    clearInterval(id) {
      intervals.delete(id);
    },
    flush() {
      const pending = [...timeouts.values()];
      timeouts.clear();
      for (const fn of pending) fn();
    },
    pendingTimeouts: () => timeouts.size,
  };
};

const settle = async (rounds = 6) => {
  for (let i = 0; i < rounds; i += 1) await new Promise((resolve) => setImmediate(resolve));
};

const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

const snapshotOf = (sessionKey, source, extra = {}) => ({
  sessionKey,
  buffers: new Map([[sessionKey, source]]),
  payload: { source, ...extra },
  ...extra,
});

const setup = ({ snapshot, push, status } = {}) => {
  const live = [];
  const errors = [];
  const starts = [];
  const pushes = [];
  let current = snapshot ?? snapshotOf('a', 'one');
  const bridge = {
    start: async () => {
      starts.push(Date.now());
      return { ok: true, url: 'http://127.0.0.1:4646' };
    },
    stop: async () => ({ ok: true }),
    status: status ?? (async () => ({ running: true, state: 'ready' })),
    push:
      push ??
      (async (payload) => {
        pushes.push(payload);
        return { ok: true, url: 'http://127.0.0.1:4646' };
      }),
    focus: async () => ({ ok: true }),
  };
  const timers = manualTimers();
  const driver = createLiveDriver({
    bridge,
    timers,
    getSnapshot: () => current,
    onLive: (url, generation) => live.push({ url, generation }),
    onError: (message) => errors.push(message),
    onLog: () => {},
  });
  return {
    driver,
    timers,
    live,
    errors,
    starts,
    pushes,
    setSnapshot: (next) => {
      current = next;
    },
  };
};

test('keystrokes are debounced into one push and the latest snapshot wins', async () => {
  const ctx = setup();
  ctx.driver.setActive(true);
  await settle();

  ctx.setSnapshot(snapshotOf('a', 'one two'));
  ctx.driver.notifyInput();
  ctx.setSnapshot(snapshotOf('a', 'one two three'));
  ctx.driver.notifyInput();
  assert.equal(ctx.timers.pendingTimeouts() >= 1, true, 'input is still waiting on the debounce');

  ctx.timers.flush();
  await settle();
  assert.deepEqual(
    ctx.pushes.map((payload) => payload.source),
    ['one two three']
  );
  assert.deepEqual(ctx.live.at(-1), { url: 'http://127.0.0.1:4646', generation: 1 });
});

test('an unchanged snapshot is never pushed twice', async () => {
  const ctx = setup();
  ctx.driver.setActive(true);
  await settle();
  ctx.timers.flush();
  await settle();
  const pushed = ctx.pushes.length;

  ctx.driver.notifyInput();
  ctx.timers.flush();
  ctx.driver.refresh();
  ctx.timers.flush();
  await settle();
  assert.equal(ctx.pushes.length, pushed);
});

test('a composing buffer waits instead of typesetting every keystroke', async () => {
  const ctx = setup();
  ctx.driver.setActive(true);
  await settle();
  ctx.timers.flush();
  await settle();
  const pushed = ctx.pushes.length;

  ctx.setSnapshot(snapshotOf('a', 'partial', { deferred: true }));
  ctx.driver.notifyInput();
  ctx.timers.flush();
  await settle();
  assert.equal(ctx.pushes.length, pushed, 'nothing is sent mid-composition');
  assert.equal(ctx.timers.pendingTimeouts() >= 1, true, 'the driver rescheduled itself');

  ctx.setSnapshot(snapshotOf('a', 'committed'));
  ctx.timers.flush();
  await settle();
  assert.equal(ctx.pushes.at(-1).source, 'committed');
});

test('switching projects hides the old surface before the new one arrives', async () => {
  const ctx = setup();
  ctx.driver.setActive(true);
  await settle();
  ctx.timers.flush();
  await settle();
  const generationWhenLive = ctx.live.at(-1).generation;

  ctx.setSnapshot(snapshotOf('b', 'other project'));
  ctx.driver.refresh();
  assert.deepEqual(ctx.live.at(-1), { url: null, generation: generationWhenLive + 1 });

  ctx.timers.flush();
  await settle();
  assert.equal(ctx.pushes.at(-1).source, 'other project');
  assert.equal(ctx.live.at(-1).url, 'http://127.0.0.1:4646');
  assert.equal(
    ctx.live.at(-1).generation,
    generationWhenLive + 2,
    'the viewer re-adopts even though the engine URL is unchanged'
  );
});

test('a push that fails after the preview is switched off surfaces no error', async () => {
  const pending = deferred();
  const ctx = setup({ push: () => pending.promise });
  ctx.driver.setActive(true);
  await settle();
  ctx.timers.flush();
  await settle();

  ctx.driver.setActive(false);
  pending.reject(new Error('engine died while the user was elsewhere'));
  await settle();
  assert.deepEqual(ctx.errors, []);
  assert.equal(ctx.live.at(-1).url, null);
});

test('a stalled engine is dropped and restarted by the health check', async () => {
  let healthy = true;
  const ctx = setup({ status: async () => ({ running: healthy, state: healthy ? 'ready' : 'stopped' }) });
  ctx.driver.setActive(true);
  await settle();
  ctx.timers.flush();
  await settle();
  assert.equal(ctx.starts.length, 1);
  const generationWhenLive = ctx.live.at(-1).generation;

  healthy = false;
  await ctx.driver.checkHealth();
  await settle();
  assert.deepEqual(ctx.live.at(-1), { url: null, generation: generationWhenLive + 1 });
  assert.equal(ctx.starts.length, 2, 'the driver restarts the engine itself');
});
