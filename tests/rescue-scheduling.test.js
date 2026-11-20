import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rescueWaitMs, waitForRescueChange, wakeRescues } from '../engine/checkpoint/rescue-scheduling.js';
import { renderIsoPages } from '../engine/checkpoint/iso-pages.js';

const engine = () => ({ coldDirty: new Set(), rescueFocus: new Set(), lastEditAt: 1000 });

test('focused rescue wakes at foreground completion instead of the 200ms poll', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1000 });
  const e = engine();
  e.editPending = 1;
  let resumed = false;
  const waiting = waitForRescueChange(e, rescueWaitMs(e, 'box')).then(() => { resumed = true; });
  t.mock.timers.tick(12);
  assert.equal(resumed, false);
  e.rescueFocus.add('box');
  e.editPending = 0;
  wakeRescues(e);
  await waiting;
  assert.equal(Date.now(), 1012);
  assert.equal(rescueWaitMs(e, 'box'), 0);
  assert.equal(e.rescueWakeups.size, 0);
  t.mock.timers.tick(200);
  assert.equal(e.rescueWakeups.size, 0);
});

test('rescue wake is a notification; current foreground and unrelated cold work still win', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const e = engine();
  e.rescueFocus.add('box');
  e.editPending = 1;
  const wait = waitForRescueChange(e, 200);
  wakeRescues(e);
  await wait;
  assert.equal(rescueWaitMs(e, 'box', 1020), 200);
  e.editPending = 0;
  e.updating = true;
  assert.equal(rescueWaitMs(e, 'box', 1020), 0, 'an active foreground walk retains the existing off-lock rescue overlap');
  e.coldDirty.add('other');
  assert.equal(rescueWaitMs(e, 'box', 1020), 200);
  e.coldDirty = new Set(['box']);
  e.pendingChain = { kind: 'cold' };
  assert.equal(rescueWaitMs(e, 'box', 1020), 0);
});

test('backlog retains its quiet gate and uses only the remaining delay', () => {
  const e = engine();
  assert.equal(rescueWaitMs(e, 'box', 1001), 200);
  assert.equal(rescueWaitMs(e, 'box', 1790), 10);
  assert.equal(rescueWaitMs(e, 'box', 1800), 0);
  e.mode = 'structured';
  e.preHash = 'preamble';
  e.shipping = { baselineReady: true, visibleCutoffMs: () => 1100 };
  assert.equal(rescueWaitMs(e, 'box', 1800), 200);
  e.rescueFocus.add('box');
  assert.equal(rescueWaitMs(e, 'box', 1800), 0);
});

test('timed rescue wake and repeated notifications release every waiter once', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const e = engine();
  let completions = 0;
  const first = waitForRescueChange(e, 25).then(() => completions++);
  t.mock.timers.tick(25);
  await first;
  const second = waitForRescueChange(e, 200).then(() => completions++);
  const third = waitForRescueChange(e, 200).then(() => completions++);
  wakeRescues(e);
  wakeRescues(e);
  await Promise.all([second, third]);
  assert.equal(completions, 3);
  assert.equal(e.rescueWakeups.size, 0);
});

test('large rescue PDFs have only two converters and preserve page order', async () => {
  const active = new Map(), calls = [];
  const convert = (command, args) => new Promise(resolve => {
    assert.equal(command, 'pdftocairo');
    const page = Number(args[2]);
    assert.equal(args[4], String(page));
    calls.push(page);
    active.set(page, () => { active.delete(page); resolve(); });
    assert.ok(active.size <= 2);
  });
  const run = renderIsoPages('/tmp/rescue-pages', '/tmp/input.pdf', 7, convert);
  assert.deepEqual(calls, [1, 2]);
  while (active.size) {
    active.get(Math.max(...active.keys()))();
    await Promise.resolve();
  }
  const paths = await run;
  assert.deepEqual(calls, [1, 2, 3, 4, 5, 6, 7]);
  assert.equal(paths[0], '/tmp/rescue-pages/page-1.svg');
  assert.equal(paths[6], '/tmp/rescue-pages/iso.svg');
});

test('failed page conversion stops dispatch and waits for its sibling before cleanup', async () => {
  let rejectFirst, finishSecond, settled = false, calls = 0;
  const failure = new Error('bad PDF');
  const run = renderIsoPages('/tmp/rescue-pages', '/tmp/input.pdf', 100, () => {
    calls++;
    return new Promise((resolve, reject) => { if (calls === 1) rejectFirst = reject; else finishSecond = resolve; });
  });
  const result = run.catch(error => { settled = true; return error; });
  rejectFirst(failure);
  await Promise.resolve();
  assert.equal(settled, false);
  assert.equal(calls, 2);
  finishSecond();
  assert.equal(await result, failure);
  assert.equal(calls, 2);
});
