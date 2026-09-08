import test from 'node:test';
import assert from 'node:assert/strict';
import { createLiveSurface } from '../host/live-surface.js';

// A stand-in for the iframe, its host window and the compositor. Animation
// frames are explicit steps here, so both sides of the reveal barrier are
// observable — the same thing the browser-level test does by freezing rAF.
const harness = () => {
  const trace = [];
  const posted = [];
  const listeners = new Set();
  const rafQueue = [];
  const events = {
    phases: [],
    toolbars: [],
    statuses: [],
    surfaceReady: [],
    errorReady: [],
    sources: [],
    edits: [],
    staticRestores: [],
  };
  const contentWindow = {
    postMessage: (data) => {
      posted.push(data);
      trace.push(`post:${data.action}`);
    },
  };
  const frame = {
    dataset: {},
    src: '',
    attributes: {},
    contentWindow,
    setAttribute(name, value) {
      this.attributes[name] = value;
    },
  };
  const hostWindow = {
    addEventListener: (_type, fn) => listeners.add(fn),
    removeEventListener: (_type, fn) => listeners.delete(fn),
  };
  const surface = createLiveSurface({
    frame,
    hostWindow,
    raf: (callback) => rafQueue.push(callback),
    now: () => 1_000,
    getTheme: () => 'dark',
    getBackground: () => '#101010',
    forceStyleFlush: () => trace.push('style-flush'),
    onPhase: (phase, info) => events.phases.push({ phase, info }),
    onToolbar: (toolbar) => events.toolbars.push(toolbar),
    onStatus: (status) => events.statuses.push(status),
    onSurfaceReady: (info) => events.surfaceReady.push(info),
    onErrorSurfaceReady: (info) => events.errorReady.push(info),
    onSource: (info) => events.sources.push(info),
    onEdit: (info) => events.edits.push(info),
    onStaticRestore: (request) => events.staticRestores.push(request),
  });
  return {
    surface,
    frame,
    trace,
    posted,
    events,
    // One committed animation frame. Callbacks queued by this flush wait for
    // the next one, exactly like rAF.
    flushFrame: () => {
      const pending = rafQueue.splice(0);
      for (const callback of pending) callback(0);
    },
    pendingFrames: () => rafQueue.length,
    fromFrame: (data, activationId) =>
      [...listeners].forEach((fn) =>
        fn({
          source: contentWindow,
          data: {
            source: 'tdom-embed',
            activationId: activationId ?? surface.getActivation()?.id,
            ...data,
          },
        })
      ),
  };
};

const READY_PAGE = { pageCount: 4, page: 1, zoom: 1, status: { up: true, mode: 'structured' } };

const bringLive = (h, { url = 'http://127.0.0.1:4646', generation = 1, documentEpoch = 1 } = {}) => {
  h.surface.setLive({ url, generation });
  h.fromFrame({ ready: true, documentEpoch, ...READY_PAGE });
  h.flushFrame();
  h.flushFrame();
};

test('a ready child stays covered until two committed frames have passed', () => {
  const h = harness();
  h.surface.setLive({ url: 'http://127.0.0.1:4646/', generation: 1 });
  assert.equal(h.surface.getPhase(), 'activation-pending');
  assert.equal(h.frame.dataset.livePhase, 'activation-pending');
  assert.equal(h.frame.attributes['aria-hidden'], 'true');
  const src = new URL(h.frame.src);
  assert.equal(src.searchParams.get('embed'), '1');
  assert.equal(src.searchParams.get('theme'), 'dark');
  assert.equal(src.searchParams.get('bg'), '#101010');
  assert.equal(src.searchParams.get('activationId'), h.surface.getActivation().id);
  assert.deepEqual(h.events.statuses.at(-1), { key: 'liveUpdating', tone: 'busy', detail: '' });

  h.fromFrame({ ready: true, documentEpoch: 1, ...READY_PAGE });
  assert.equal(h.surface.getPhase(), 'staging', 'ready alone reveals nothing');
  assert.equal(h.surface.isLive(), false);

  h.flushFrame();
  assert.equal(h.surface.isLive(), false, 'the first frame only lets the covered child paint');

  h.flushFrame();
  assert.equal(h.surface.getPhase(), 'active');
  assert.equal(h.frame.attributes['aria-hidden'], 'false');
  assert.deepEqual(h.events.surfaceReady, [
    {
      activationId: h.surface.getActivation().id,
      url: 'http://127.0.0.1:4646',
      generation: 1,
      documentEpoch: 1,
    },
  ]);
  assert.equal(h.surface.getToolbar().pageCount, 4);
  assert.deepEqual(h.events.statuses.at(-1), { key: 'live', tone: 'idle', detail: '' });
});

test('repeated snapshots for the staging epoch do not postpone the barrier', () => {
  const h = harness();
  h.surface.setLive({ url: 'http://127.0.0.1:4646', generation: 1 });
  h.fromFrame({ ready: true, documentEpoch: 1, ...READY_PAGE });
  h.fromFrame({ ready: true, documentEpoch: 1, ...READY_PAGE, pageCount: 7 });
  assert.equal(h.pendingFrames(), 1, 'the second snapshot must not queue another barrier');
  h.flushFrame();
  h.flushFrame();
  assert.equal(h.surface.isLive(), true);
  assert.equal(h.surface.getToolbar().pageCount, 7, 'the newest payload is the one adopted');
});

test('toolbar commands move the visible number before the frame answers', () => {
  const h = harness();
  bringLive(h);
  h.surface.stepPage(1);
  h.surface.stepPage(1);
  assert.equal(h.surface.getToolbar().page, 3);
  assert.deepEqual(
    h.posted.filter((message) => message.action === 'goto-page').map((message) => message.page),
    [2, 3]
  );
  h.surface.gotoPage(99);
  assert.equal(h.surface.getToolbar().page, 4, 'clamped to the reported page count');
  h.surface.zoomIn();
  h.surface.search('lemma', true);
  assert.deepEqual(h.posted.at(-2), {
    source: 'tdom-host',
    activationId: h.surface.getActivation().id,
    action: 'zoom-in',
  });
  assert.equal(h.posted.at(-1).query, 'lemma');
});

test('a sync that arrives while staging is replayed after the reveal', () => {
  const h = harness();
  h.surface.setLive({ url: 'http://127.0.0.1:4646', generation: 1 });
  h.fromFrame({ ready: true, documentEpoch: 1, ...READY_PAGE });
  assert.equal(h.surface.sync({ page: 3, y: 360, sourceFile: 'main.tex', sourceLine: 55 }), true);
  assert.equal(
    h.posted.some((message) => message.action === 'goto-sync'),
    false,
    'scrolling a frame the user cannot see is pointless'
  );
  h.flushFrame();
  h.flushFrame();
  const sync = h.posted.filter((message) => message.action === 'goto-sync');
  assert.equal(sync.length, 1);
  assert.equal(sync[0].sourceLine, 55);
  assert.equal(h.surface.getToolbar().page, 3);
});

test('a document reset restores the cover, resolves style, then acknowledges', () => {
  const h = harness();
  bringLive(h);
  h.trace.length = 0;

  h.fromFrame({ action: 'reset-pending', documentEpoch: 2 });
  assert.equal(h.surface.getPhase(), 'reset-pending');
  assert.equal(h.frame.attributes['aria-hidden'], 'true');
  assert.deepEqual(
    h.trace,
    ['style-flush', 'post:reset-ack'],
    'the child may only discard its DOM once the new stacking order exists'
  );
  assert.equal(h.posted.at(-1).documentEpoch, 2);

  // The old document is still talking; it cannot uncover the surface.
  h.fromFrame({ ready: true, documentEpoch: 1, ...READY_PAGE });
  h.flushFrame();
  h.flushFrame();
  assert.equal(h.surface.isLive(), false);

  h.fromFrame({ ready: true, documentEpoch: 2, ...READY_PAGE, pageCount: 1 });
  assert.equal(h.surface.getPhase(), 'staging');
  h.flushFrame();
  h.flushFrame();
  assert.equal(h.surface.isLive(), true);
  assert.equal(h.events.surfaceReady.at(-1).documentEpoch, 2);
});

test('a new generation is a new activation, and a stale ready cannot reveal it', () => {
  const h = harness();
  bringLive(h);
  const first = h.surface.getActivation().id;

  // Same URL, next generation: still a different surface.
  h.surface.setLive({ url: 'http://127.0.0.1:4646', generation: 2 });
  const second = h.surface.getActivation().id;
  assert.notEqual(second, first);
  assert.equal(h.surface.getPhase(), 'activation-pending');

  h.fromFrame({ ready: true, documentEpoch: 99, ...READY_PAGE }, first);
  h.flushFrame();
  h.flushFrame();
  assert.equal(h.surface.isLive(), false, 'the previous activation is not allowed to speak');

  h.fromFrame({ ready: true, documentEpoch: 1, ...READY_PAGE });
  h.flushFrame();
  h.flushFrame();
  assert.equal(h.surface.isLive(), true);

  // An identical url+generation while a session exists is a no-op, not a
  // re-navigation that would flash for nothing.
  const src = h.frame.src;
  h.surface.setLive({ url: 'http://127.0.0.1:4646', generation: 2 });
  assert.equal(h.frame.src, src);
  assert.equal(h.surface.getActivation().id, second);
});

test('frame messages outside the adopted epoch are dropped', () => {
  const h = harness();
  bringLive(h);
  h.fromFrame({ action: 'source', documentEpoch: 1, file: 'main.tex', line: 12, column: 3 });
  h.fromFrame({ action: 'source', documentEpoch: 5, file: 'stale.tex', line: 99, column: 1 });
  h.fromFrame({ action: 'edit', documentEpoch: 1, regionId: 'r1' });
  assert.deepEqual(h.events.sources, [{ file: 'main.tex', line: 12, column: 3 }]);
  assert.deepEqual(
    h.events.edits.map((edit) => edit.regionId),
    ['r1']
  );
});

test('static loads are frozen under live and the newest resumes one frame later', () => {
  const h = harness();
  bringLive(h);
  assert.equal(h.surface.deferStatic({ url: 'first.pdf' }), true);
  assert.equal(h.surface.deferStatic({ url: 'newest.pdf' }), true);
  assert.deepEqual(h.events.staticRestores, []);

  h.surface.setLive(null);
  assert.equal(h.surface.getPhase(), 'off');
  assert.equal(h.frame.src, 'about:blank');
  assert.equal(h.frame.dataset.livePhase, undefined);
  assert.deepEqual(h.events.staticRestores, [], 'not before the cover is actually gone');

  h.flushFrame();
  assert.deepEqual(h.events.staticRestores, [{ url: 'newest.pdf' }]);
  assert.equal(h.surface.deferStatic({ url: 'ignored.pdf' }), false, 'nothing owns the surface now');
});

test('a live activation during the restore frame keeps the static load deferred', () => {
  const h = harness();
  bringLive(h);
  h.surface.deferStatic({ url: 'deferred.pdf' });
  h.surface.setLive(null);
  h.surface.setLive({ url: 'http://127.0.0.1:4646', generation: 5 });
  h.flushFrame();
  assert.deepEqual(h.events.staticRestores, []);

  h.surface.setLive(null);
  h.flushFrame();
  assert.deepEqual(h.events.staticRestores, [{ url: 'deferred.pdf' }]);
});

test('a terminal error crosses the same two-paint barrier', () => {
  const h = harness();
  h.surface.setError({ error: 'engine failed', url: null, generation: 23 });
  assert.deepEqual(h.events.statuses.at(-1), {
    key: 'liveError',
    tone: 'error',
    detail: 'engine failed',
    message: 'engine failed',
  });
  assert.deepEqual(h.events.errorReady, [], 'setting the text alone reveals nothing');
  h.flushFrame();
  assert.deepEqual(h.events.errorReady, [], 'the first paint is still covered');
  h.flushFrame();
  assert.deepEqual(h.events.errorReady, [{ error: 'engine failed', url: null, generation: 23 }]);
});

test('a live state message supersedes an error acknowledgement in flight', () => {
  const h = harness();
  h.surface.setError({ error: 'engine failed', generation: 23 });
  h.surface.setLive({ url: 'http://127.0.0.1:4646', generation: 1 });
  h.flushFrame();
  h.flushFrame();
  assert.deepEqual(h.events.errorReady, []);
});

test('engine status snapshots become one viewer status while live', () => {
  const h = harness();
  bringLive(h);
  h.fromFrame({ documentEpoch: 1, ...READY_PAGE, status: { up: true, busy: true } });
  assert.deepEqual(h.events.statuses.at(-1), { key: 'liveUpdating', tone: 'busy', detail: '' });
  h.fromFrame({
    documentEpoch: 1,
    ...READY_PAGE,
    search: { query: 'lemma', current: 2, total: 5 },
  });
  assert.deepEqual(h.events.statuses.at(-1), {
    key: 'liveSearch',
    tone: 'idle',
    detail: 'lemma',
    search: { query: 'lemma', current: 2, total: 5 },
  });
});
