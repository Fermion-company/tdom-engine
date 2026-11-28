// The lists again from /doc (web/app.js docResync): one request or one backoff
// timer while they are owed, the wait doubling from HELD_PATCH_MS to
// DOC_RESYNC_MAX_DELAY; nothing left once a coherent snapshot is taken, or once
// the report the held patches waited for came. (The round-9 click-supersede
// fixture ends with the lists owed and a /doc that never has them: it reads
// /doc every 12 s until it is torn down.)
// The viewer's own event handler, report and recovery code run here; only
// the clock, the timers and /doc are faked.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { eventViewer, pageList } from './helpers/provisional-viewer.js';

function viewer(pageCount = 1) {
  const v = eventViewer(Array.from({ length: pageCount }, (_, i) => pageList(i + 1)));
  v.committedCanonicalGeneration = null;
  let now = 0, id = 0;
  const timers = new Map();
  const reads = [];
  let answer = null;
  Object.assign(v, {
    AbortController,
    performance: { now: () => now },
    setTimeout(fn, ms) { timers.set(++id, { fn, at: now + ms, ms }); return id; },
    clearTimeout(t) { timers.delete(t); },
    fetch(url, { signal } = {}) {
      reads.push({ url, at: now, signal });
      const doc = answer;
      return Promise.resolve({ ok: true, json: async () => await doc });
    },
  });
  const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
  // run the clock to `ms` later, firing the timers due on the way
  v.advance = async (ms) => {
    const end = now + ms;
    for (;;) {
      const next = [...timers].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      if (!next) break;
      now = next[1].at;
      timers.delete(next[0]);
      next[1].fn();
      await flush();
    }
    now = end;
    await flush();
  };
  v.answer = (doc) => { answer = doc; };
  v.reads = reads;
  v.recovery = () => JSON.parse(vm.runInContext('JSON.stringify({ owed: docResync.owed, wanted: docResync.wanted, ' +
    'timer: docResync.timer !== null, request: docResync.request !== null, delay: docResync.delay })', v));
  v.timers = () => [...timers.values()].map((t) => t.ms);
  v.flush = flush;
  return v;
}
const replace = (text, page = 1) => ({ type: 'replace-page', displayList: pageList(page, [{ op: 'glyphs', src: 'b' + page, text }]) });
// a /doc read between an update and its report: its lists are of the next source
const between = { documentEpoch: 1, pages: [pageList(1)], layoutRev: 7, layoutSrcRev: 5, report: { rev: 6, srcRev: 4 } };
const coherent = { documentEpoch: 1, pages: [pageList(1, [{ op: 'glyphs', src: 'b1', text: 'revision 4 note' }])],
  layoutRev: 7, layoutSrcRev: 4, report: { rev: 7, srcRev: 4, stats: { pageCount: 1 }, patches: [] } };

const patches = (v, rev, srcRev, pageCount, ...patches) =>
  v.receivePreviewEvent({ kind: 'patches', documentEpoch: 1, rev, srcRev, pageCount, patches });
const report = (v, rev, srcRev, pageCount, ...patches) =>
  v.receivePreviewEvent({ kind: 'update', documentEpoch: 1, report: { rev, srcRev, stats: { pageCount }, patches } });

test('tearing down the viewer cancels a read, backoff and any later wake', async () => {
  const reading = viewer();
  reading.answer(new Promise(() => {}));
  reading.streamReconnected();
  await reading.flush();
  assert.equal(reading.recovery().request, true);
  assert.deepEqual(reading.timers(), [10_000]);
  reading.teardown();
  assert.equal(reading.reads[0].signal.aborted, true);
  assert.deepEqual(reading.timers(), []);
  reading.streamReconnected();
  patches(reading, 5, 3, 1, replace('future list'));
  await reading.advance(60_000);
  assert.equal(reading.reads.length, 1);
  assert.deepEqual(reading.timers(), []);

  const backingOff = viewer();
  backingOff.answer(between);
  backingOff.streamReconnected();
  await backingOff.flush();
  assert.deepEqual(backingOff.timers(), [3000]);
  backingOff.teardown();
  assert.deepEqual(backingOff.timers(), []);
});

test('Node recovery timers allow a finished VM harness to exit', async () => {
  const v = eventViewer([pageList(1)]);
  const handles = [];
  v.setTimeout = (fn, ms) => {
    const handle = setTimeout(fn, ms);
    handles.push(handle);
    return handle;
  };
  v.clearTimeout = clearTimeout;
  v.fetch = async () => ({ json: async () => between });
  try {
    v.streamReconnected();
    for (let i = 0; i < 20; i++) await Promise.resolve();
    assert.equal(handles.length, 2, 'request deadline and backoff');
    assert.ok(handles.every(handle => !handle.hasRef()));
  } finally {
    for (const handle of handles) clearTimeout(handle);
  }
});

test('a coherent stream report replacing the only owed sheet stops /doc backoff', async () => {
  const v = viewer();
  v.answer(between);
  patches(v, 3, 2, 1, replace('revision 2 note'));
  patches(v, 5, 3, 1, replace('revision 3 note'));
  report(v, 6, 4, 1);
  await v.flush();
  await v.advance(30_000);
  assert.equal(v.reads.length, 4);
  report(v, 7, 4, 1, replace('revision 4 note'));
  assert.equal(v.provisionalDisplayLists.get(1).commands[0].text, 'revision 4 note');
  assert.deepEqual(v.timers(), []);
  await v.advance(60_000);
  assert.equal(v.reads.length, 4);
});

test('reconnect recovery combines reports and patches for surviving sheets of the same source', async () => {
  const v = viewer(3);
  v.streamReconnected();
  await v.flush();
  await v.advance(30_000);
  assert.equal(v.reads.length, 4);
  report(v, 10, 4, 3, replace('current one'));
  assert.equal(v.recovery().owed, true);
  patches(v, 11, 4, 2, replace('current two', 2), { type: 'remove-pages', from: 3 });
  assert.deepEqual([...v.provisionalDisplayLists.keys()], [1, 2]);
  assert.equal(v.provisionalDisplayLists.get(2).commands[0].text, 'current two');
  assert.deepEqual(v.timers(), []);
  await v.advance(60_000);
  assert.equal(v.reads.length, 4);
});

test('a different source or a second reconnect starts fresh coverage', async () => {
  const v = viewer(2);
  v.streamReconnected();
  report(v, 10, 4, 2, replace('source four one'));
  report(v, 11, 5, 2, replace('source five two', 2));
  assert.equal(v.recovery().owed, true);
  v.streamReconnected();
  patches(v, 12, 5, 2, replace('source five one'));
  assert.equal(v.recovery().owed, true);
  patches(v, 13, 5, 2, replace('source five two', 2));
  assert.equal(v.recovery().owed, false);
});

test('a coherent /doc adopts a changed body signature even with identical resident paint', async () => {
  const v = viewer();
  const held = v.provisionalDisplayLists.get(1);
  held.body = 'old body';
  v.answer({ ...coherent, pages: [{ ...held, body: 'new body' }] });
  v.streamReconnected();
  await v.flush();
  assert.equal(v.provisionalDisplayLists.get(1).body, 'new body');
  assert.equal(v.recovery().owed, false);
});

test('stream recovery waits for every owed sheet and aborts an in-flight read when the last arrives', async () => {
  const v = viewer(2);
  v.answer(new Promise(() => {}));
  patches(v, 5, 3, 2, replace('missed one'), replace('missed two', 2));
  report(v, 6, 4, 2, replace('current one'));
  await v.flush();
  assert.equal(v.reads.length, 1);
  patches(v, 7, 3, 2, replace('stale two', 2));
  assert.equal(v.provisionalDisplayLists.get(2).commands[0].text, 'page 2');
  assert.equal(v.reads[0].signal.aborted, false);
  patches(v, 8, 4, 2, replace('current two', 2));
  assert.equal(v.provisionalDisplayLists.get(2).commands[0].text, 'current two');
  assert.equal(v.reads[0].signal.aborted, true);
  assert.deepEqual(v.timers(), []);
  await v.advance(60_000);
  assert.equal(v.reads.length, 1);
});

test('hiding the frame cancels its /doc request and showing it resumes the same recovery', async () => {
  const v = viewer();
  v.answer(new Promise(() => {}));
  patches(v, 5, 3, 1, replace('missed'));
  report(v, 6, 4, 1);
  await v.flush();
  assert.equal(v.reads.length, 1);
  v.document.hidden = true;
  v.syncDocResyncVisibility();
  assert.equal(v.reads[0].signal.aborted, true);
  assert.deepEqual(v.timers(), []);
  await v.advance(60_000);
  assert.equal(v.reads.length, 1);
  assert.equal(v.recovery().owed, true);
  v.answer(coherent);
  v.document.hidden = false;
  v.syncDocResyncVisibility();
  await v.flush();
  assert.equal(v.reads.length, 2);
  assert.equal(v.recovery().owed, false);
});

test('a snapshot that supplies the awaited report stops recovery when canonical anchoring freezes it', async () => {
  const v = viewer();
  v.canonicalAnchorPreview = { retiring: true, pages: [] };
  v.answer({ ...coherent, layoutSrcRev: 3, report: { ...coherent.report, srcRev: 3 } });
  patches(v, 5, 3, 1, replace('awaiting source 3'));
  await v.advance(3000);
  assert.equal(v.appliedSrcRev, 3);
  assert.equal(vm.runInContext('lastReportFrozen', v), true);
  assert.equal(v.provisionalDisplayLists.get(1).commands[0].text, 'page 1');
  assert.equal(v.reads.length, 1);
  assert.deepEqual(v.timers(), []);
  await v.advance(60_000);
  assert.equal(v.reads.length, 1);
});

test('lists owed after a report passed held patches: one request or one timer, 3 s doubling to 12 s, nothing left after a coherent /doc', async () => {
  const v = viewer();
  v.answer(between);
  v.receivePreviewEvent({ kind: 'patches', documentEpoch: 1, rev: 3, srcRev: 2, pageCount: 1, patches: [replace('revision 2 note')] });
  v.receivePreviewEvent({ kind: 'patches', documentEpoch: 1, rev: 5, srcRev: 3, pageCount: 1, patches: [replace('revision 3 note')] });
  // the report of source 4 passes the held patch of source 3: its lists are owed
  v.receivePreviewEvent({ kind: 'update', documentEpoch: 1, report: { rev: 6, srcRev: 4, stats: { pageCount: 1 }, patches: [] } });
  await v.flush();
  assert.equal(v.reads.length, 1);
  assert.deepEqual(v.recovery(), { owed: true, wanted: true, timer: true, request: false, delay: 6000 });
  assert.deepEqual(v.timers(), [3000], 'one backoff timer, nothing else');
  await v.advance(3000 + 6000 + 12000 + 12000 + 12000);
  assert.deepEqual(v.reads.map((read) => read.at), [0, 3000, 9000, 21000, 33000, 45000], 'the waits double to 12 s');
  assert.deepEqual(v.timers(), [12000]);
  v.answer(coherent);
  await v.advance(12000);
  assert.equal(v.reads.length, 7);
  assert.deepEqual(v.recovery(), { owed: false, wanted: false, timer: false, request: false, delay: 3000 });
  assert.deepEqual(v.timers(), [], 'no timer left');
  assert.equal(v.provisionalDisplayLists.get(1).commands[0].text, 'revision 4 note');
  await v.advance(120000);
  assert.equal(v.reads.length, 7, 'no /doc read after it');
});

test('a held patch whose report comes after its /doc read was due: the report ends the read and its timer', async () => {
  const v = viewer();
  v.answer(between);
  v.receivePreviewEvent({ kind: 'patches', documentEpoch: 1, rev: 3, srcRev: 2, pageCount: 1, patches: [replace('revision 2 note')] });
  v.receivePreviewEvent({ kind: 'patches', documentEpoch: 1, rev: 5, srcRev: 3, pageCount: 1, patches: [replace('revision 3 note')] });
  // no report of source 3 within HELD_PATCH_MS: /doc is read, and has nothing to give
  await v.advance(3000);
  assert.equal(v.reads.length, 1);
  assert.deepEqual(v.recovery(), { owed: false, wanted: true, timer: true, request: false, delay: 6000 });
  // the report of source 3 comes: the held patch is its, and nothing is read again
  v.receivePreviewEvent({ kind: 'update', documentEpoch: 1, report: { rev: 6, srcRev: 3, stats: { pageCount: 1 }, patches: [] } });
  await v.flush();
  assert.deepEqual(v.recovery(), { owed: false, wanted: false, timer: false, request: false, delay: 3000 });
  assert.deepEqual(v.timers(), []);
  await v.advance(120000);
  assert.equal(v.reads.length, 1);
});
