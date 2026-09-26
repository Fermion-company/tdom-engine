import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeLiveToolbarSnapshot, stepLiveToolbarPage } from '../host/live-toolbar-state.js';

test('the live toolbar clamps page navigation to the reported page count', () => {
  assert.deepEqual(normalizeLiveToolbarSnapshot({}, { pageCount: 2, page: 9, zoom: 1.25 }), {
    pageCount: 2,
    pageCountAuthoritative: true,
    page: 2,
    zoom: 1.25,
  });
});

test('the live toolbar accepts partial snapshots without losing prior state', () => {
  const current = { pageCount: 3, page: 2, zoom: 1.1 };
  assert.deepEqual(normalizeLiveToolbarSnapshot(current, { zoom: 0.8 }), {
    pageCount: 3,
    pageCountAuthoritative: true,
    page: 2,
    zoom: 0.8,
  });
});

test('the live toolbar resets to a safe empty state', () => {
  assert.deepEqual(normalizeLiveToolbarSnapshot(), { pageCount: 0, pageCountAuthoritative: true, page: 1, zoom: 1 });
});

test('a page step moves immediately and clamps repeated clicks', () => {
  const start = { pageCount: 4, page: 2, zoom: 1 };
  assert.deepEqual(stepLiveToolbarPage(start, 1), { pageCount: 4, pageCountAuthoritative: true, page: 3, zoom: 1 });
  assert.deepEqual(stepLiveToolbarPage(start, -9), { pageCount: 4, pageCountAuthoritative: true, page: 1, zoom: 1 });
  assert.deepEqual(stepLiveToolbarPage(start, 9), { pageCount: 4, pageCountAuthoritative: true, page: 4, zoom: 1 });
});

test('a provisional page count stays marked until the frame confirms it (tex64-internal #67)', () => {
  // resident 12 pages against an 11-page real output: the number is not final
  const provisional = normalizeLiveToolbarSnapshot({}, { pageCount: 12, pageCountAuthoritative: false, page: 3 });
  assert.equal(provisional.pageCountAuthoritative, false);
  assert.equal(normalizeLiveToolbarSnapshot(provisional, { zoom: 1.5 }).pageCountAuthoritative, false,
    'a partial snapshot does not confirm the count');
  assert.equal(stepLiveToolbarPage(provisional, 1).pageCountAuthoritative, false, 'a page step does not confirm it');
  const confirmed = normalizeLiveToolbarSnapshot(provisional, { pageCount: 11, pageCountAuthoritative: true });
  assert.deepEqual(confirmed, { pageCount: 11, pageCountAuthoritative: true, page: 3, zoom: 1 });
});
