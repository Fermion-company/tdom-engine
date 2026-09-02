import test from 'node:test';
import assert from 'node:assert/strict';
import { FRAME_MESSAGE_SOURCE, createEmbedClient, embedUrl } from '../host/embed-client.js';

// A stand-in for the iframe and its host window: the client only needs
// postMessage on one side and addEventListener on the other.
const createStubs = () => {
  const posted = [];
  const listeners = new Set();
  const contentWindow = { postMessage: (data) => posted.push(data) };
  const hostWindow = {
    addEventListener: (_type, fn) => listeners.add(fn),
    removeEventListener: (_type, fn) => listeners.delete(fn),
  };
  const emit = (event) => {
    for (const fn of [...listeners]) fn(event);
  };
  return { posted, listeners, contentWindow, hostWindow, emit };
};

test('embedUrl asks for pages only and carries the host look', () => {
  const url = new URL(
    embedUrl('http://127.0.0.1:4646', { activationId: 'a1', theme: 'light', bg: '#1e1e1e' })
  );
  assert.equal(url.pathname, '/');
  assert.equal(url.searchParams.get('embed'), '1');
  assert.equal(url.searchParams.get('activationId'), 'a1');
  assert.equal(url.searchParams.get('theme'), 'light');
  assert.equal(url.searchParams.get('bg'), '#1e1e1e');
  // A colour the engine would reject is dropped rather than passed through.
  assert.equal(new URL(embedUrl('http://127.0.0.1:4646', { bg: 'red' })).searchParams.get('bg'), null);
});

test('toolbar actions reach the frame tagged with the activation', () => {
  const stubs = createStubs();
  const client = createEmbedClient({
    frame: { contentWindow: stubs.contentWindow },
    activationId: 'a1',
    hostWindow: stubs.hostWindow,
  });
  client.zoomIn();
  client.gotoPage(3);
  client.search('lemma', true);
  client.resetAck(7);
  assert.deepEqual(stubs.posted, [
    { source: 'tdom-host', activationId: 'a1', action: 'zoom-in' },
    { source: 'tdom-host', activationId: 'a1', action: 'goto-page', page: 3 },
    { source: 'tdom-host', activationId: 'a1', action: 'search', query: 'lemma', findPrevious: true },
    { source: 'tdom-host', activationId: 'a1', action: 'reset-ack', documentEpoch: 7 },
  ]);
  client.dispose();
  assert.equal(stubs.listeners.size, 0);
});

test('frame messages are routed by action, and stale activations are ignored', () => {
  const stubs = createStubs();
  const frame = { contentWindow: stubs.contentWindow };
  const seen = { snapshots: [], resets: [], sources: [], edits: [] };
  const client = createEmbedClient({
    frame,
    activationId: 'a1',
    hostWindow: stubs.hostWindow,
    onSnapshot: (data) => seen.snapshots.push(data),
    onResetPending: (data) => seen.resets.push(data),
    onSource: (data) => seen.sources.push(data),
    onEdit: (data) => seen.edits.push(data),
  });

  const fromFrame = (data) => stubs.emit({ source: stubs.contentWindow, data });
  fromFrame({ source: FRAME_MESSAGE_SOURCE, activationId: 'a1', pageCount: 4, zoom: 1, page: 2 });
  fromFrame({ source: FRAME_MESSAGE_SOURCE, activationId: 'a1', action: 'reset-pending', documentEpoch: 3 });
  fromFrame({ source: FRAME_MESSAGE_SOURCE, activationId: 'a1', action: 'source', file: 'main.tex', line: 12 });
  fromFrame({ source: FRAME_MESSAGE_SOURCE, activationId: 'a1', action: 'edit', regionId: 'r1' });
  // A frame left over from a previous activation must not drive this viewer.
  fromFrame({ source: FRAME_MESSAGE_SOURCE, activationId: 'a0', pageCount: 99 });
  // Nor may an unrelated page that happens to postMessage at the host.
  fromFrame({ source: 'somebody-else', pageCount: 99 });
  stubs.emit({ source: {}, data: { source: FRAME_MESSAGE_SOURCE, activationId: 'a1', pageCount: 99 } });

  assert.deepEqual(seen.snapshots.map((data) => data.pageCount), [4]);
  assert.deepEqual(seen.resets.map((data) => data.documentEpoch), [3]);
  assert.deepEqual(seen.sources.map((data) => data.line), [12]);
  assert.deepEqual(seen.edits.map((data) => data.regionId), ['r1']);
  client.dispose();
});
