import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeLiveToolbarSnapshot, stepLiveToolbarPage } from '../host/live-toolbar-state.js';

test('the live toolbar clamps page navigation to the reported page count', () => {
  assert.deepEqual(normalizeLiveToolbarSnapshot({}, { pageCount: 2, page: 9, zoom: 1.25 }), {
    pageCount: 2,
    page: 2,
    zoom: 1.25,
  });
});

test('the live toolbar accepts partial snapshots without losing prior state', () => {
  const current = { pageCount: 3, page: 2, zoom: 1.1 };
  assert.deepEqual(normalizeLiveToolbarSnapshot(current, { zoom: 0.8 }), {
    pageCount: 3,
    page: 2,
    zoom: 0.8,
  });
});

test('the live toolbar resets to a safe empty state', () => {
  assert.deepEqual(normalizeLiveToolbarSnapshot(), { pageCount: 0, page: 1, zoom: 1 });
});

test('a page step moves immediately and clamps repeated clicks', () => {
  const start = { pageCount: 4, page: 2, zoom: 1 };
  assert.deepEqual(stepLiveToolbarPage(start, 1), { pageCount: 4, page: 3, zoom: 1 });
  assert.deepEqual(stepLiveToolbarPage(start, -9), { pageCount: 4, page: 1, zoom: 1 });
  assert.deepEqual(stepLiveToolbarPage(start, 9), { pageCount: 4, page: 4, zoom: 1 });
});
