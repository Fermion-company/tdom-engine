// An update that brings many pages (a keystroke that makes a paragraph a
// line longer moves a line across every page break after it) builds only the
// pages the reader is near. The others keep what they show and are built
// when they come near the pane (web/app.js renderPage, stageDeferredNearSight).
// The viewer's own staging and commit code runs here; only the DOM is faked.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { provisionalViewer, pageList } from './helpers/provisional-viewer.js';

const app = readFileSync(new URL('../web/app.js', import.meta.url), 'utf8');
const span = (start, end) => app.slice(app.indexOf(start), app.indexOf(end, app.indexOf(start) + start.length));
// nearSight, stageDeferredNearSight and the real renderPage (the helper's stand-in builds every page at once)
const STAGING = span('const NEAR_SIGHT_PAGES', '// The text of a line whose exact picture is shown only where it has to be');

const PAGE_PITCH = 820; // (the helper's shells: page n stands at (n - 1) * 820, 800 high)

// `canonicalPages`: how many pages already show a canonical paper (0: a document nothing has been shown of yet)
function viewerOf(pageCount, canonicalPages = 0) {
  const built = [];
  const viewer = provisionalViewer(Array.from({ length: pageCount }, (_, i) => pageList(i + 1)), canonicalPages);
  let listInHand = null;
  Object.assign(viewer, {
    built,
    geometry: { paperwidth: 600, paperheight: 800 },
    readyFonts: new Set(), fontLoads: new Map(), injectFonts() {},
    svgParts: (dl) => { listInHand = dl; built.push(dl.page); return ['<svg>', '</svg>']; },
    svgPartsCut: () => null,
    loadProvisionalSnapshot: (srcRev) => Promise.resolve({ srcRev, documentEpoch: 1 }),
    requestAnimationFrame: (run) => { run(); return 1; },
    document: {
      createElement: () => ({
        childNodes: [], firstElementChild: null,
        set innerHTML(_markup) { this.childNodes = [listInHand]; },
        insertAdjacentHTML() {}, querySelectorAll: () => [],
      }),
    },
  });
  vm.runInContext(`${STAGING}\nthis.renderPage = renderPage; this.stageDeferredNearSight = stageDeferredNearSight; this.nearSight = nearSight;`, viewer);
  // the pane shows the pages from `first` to `last`
  viewer.look = (first, last) => {
    viewer.pagesEl = { getBoundingClientRect: () => ({ top: (first - 1) * PAGE_PITCH + 1, bottom: (last - 1) * PAGE_PITCH + 799,
      left: 0, width: 600, height: (last - first) * PAGE_PITCH + 798 }) };
  };
  viewer.shown = () => [...viewer.pageDivs].sort((a, b) => a[0] - b[0]).map(([, div]) => div.paper?.[0]?.commands?.[0]?.text ?? null);
  viewer.deferred = () => [...viewer.provisionalStages].filter(([, stage]) => stage.deferred).map(([page]) => page).sort((a, b) => a - b);
  return viewer;
}
// the staged pages become ready when their snapshot and fonts have arrived
const settle = () => new Promise((resolve) => setImmediate(resolve));
const version = (page, tag) => pageList(page, [{ op: 'glyphs', src: `b${page}`, text: `page ${page} ${tag}` }]);
const replace = (displayList) => ({ type: 'replace-page', displayList });
const range = (from, to) => Array.from({ length: to - from + 1 }, (_, i) => from + i);

test('of an update of many pages, only the ones near the pane are built; the others keep what they show until they come near', async () => {
  const viewer = viewerOf(12, 12);
  // every page in the pane (a small zoom): every page is built
  viewer.look(1, 12);
  viewer.stageProvisionalPatches(range(1, 12).map((n) => replace(version(n, 'v1'))), false, 12);
  await settle();
  assert.deepEqual(viewer.built, range(1, 12));
  assert.deepEqual(viewer.shown(), range(1, 12).map((n) => `page ${n} v1`));
  assert.deepEqual(viewer.deferred(), []);
  viewer.look(5, 6);

  // a keystroke on page 5 that moves a line across every page break after it
  viewer.built.length = 0;
  viewer.appliedSrcRev = 3;
  viewer.stageProvisionalPatches(range(5, 12).map((n) => replace(version(n, 'v2'))), false, 12);
  await settle();
  assert.deepEqual(viewer.built, [5, 6, 7, 8], 'the pages in sight and the two after them');
  assert.deepEqual(viewer.shown(), [...range(1, 4).map((n) => `page ${n} v1`), ...range(5, 8).map((n) => `page ${n} v2`),
    ...range(9, 12).map((n) => `page ${n} v1`)], 'the pages put off keep what they showed');
  assert.deepEqual(viewer.deferred(), [9, 10, 11, 12]);
  for (const page of [9, 10, 11, 12]) {
    assert.equal(viewer.pageDivs.get(page).dataset.provPending, '1', 'and are marked as not showing this revision');
    assert.equal(viewer.pageDirtyRev.get(page), 3);
  }

  // the next keystroke changes page 5 alone: the pages put off are carried, not built
  viewer.built.length = 0;
  viewer.appliedSrcRev = 4;
  viewer.stageProvisionalPatches([replace(version(5, 'v3'))], false, 12);
  await settle();
  assert.deepEqual(viewer.built, [5]);
  assert.equal(viewer.shown()[4], 'page 5 v3');
  assert.deepEqual(viewer.deferred(), [9, 10, 11, 12]);
  assert.equal(viewer.provisionalStages.get(9).sourceRev, 4, 'a stage put off belongs to the revision in hand, like any stage');

  // the reader scrolls to pages 10 and 11: they and their neighbours are built with the lists that were put off
  viewer.built.length = 0;
  viewer.look(10, 11);
  viewer.stageDeferredNearSight();
  await settle();
  assert.deepEqual(viewer.built, [9, 10, 11, 12]);
  assert.deepEqual(viewer.shown().slice(8), range(9, 12).map((n) => `page ${n} v2`));
  assert.deepEqual(viewer.deferred(), []);
  assert.equal(viewer.provisionalStages.size, 0);
  // nothing put off: nothing happens
  viewer.built.length = 0;
  viewer.stageDeferredNearSight();
  await settle();
  assert.deepEqual(viewer.built, []);
});

test('a few pages are built as they come, wherever the reader is; and every page is with the switch', async () => {
  const viewer = viewerOf(12, 12);
  viewer.look(1, 12);
  viewer.stageProvisionalPatches(range(1, 12).map((n) => replace(version(n, 'v1'))), false, 12);
  await settle();
  viewer.look(1, 1);
  viewer.built.length = 0;
  viewer.appliedSrcRev = 3;
  // three pages far from the pane
  viewer.stageProvisionalPatches(range(9, 11).map((n) => replace(version(n, 'v2'))), false, 12);
  await settle();
  assert.deepEqual(viewer.built, [9, 10, 11]);
  assert.deepEqual(viewer.shown().slice(8, 11), range(9, 11).map((n) => `page ${n} v2`));
  // many pages, with the switch
  viewer.built.length = 0;
  viewer.appliedSrcRev = 4;
  vm.runInContext('globalThis.__tdomStageAllPages = true;', viewer);
  viewer.stageProvisionalPatches(range(4, 12).map((n) => replace(version(n, 'v3'))), false, 12);
  await settle();
  assert.deepEqual(viewer.built, range(4, 12));
  assert.deepEqual(viewer.deferred(), []);
});

test('a page put off that owes exact ink waits as it did; one near a page in sight is not put off', async () => {
  const viewer = viewerOf(12, 12);
  viewer.look(1, 12);
  viewer.stageProvisionalPatches(range(1, 12).map((n) => replace(version(n, 'v1'))), false, 12);
  await settle();
  viewer.look(2, 2);
  viewer.built.length = 0;
  viewer.appliedSrcRev = 3;
  const owing = pageList(10, [{ op: 'pending-exact', src: 'b10' }]);
  viewer.stageProvisionalPatches([...range(1, 9).map((n) => replace(version(n, 'v2'))), replace(owing)], false, 12);
  await settle();
  assert.deepEqual(viewer.built, [1, 2, 3, 4], 'pages 1 to 4 are within two pages of the one in sight');
  assert.deepEqual(viewer.deferred(), [5, 6, 7, 8, 9]);
  const waiting = viewer.provisionalStages.get(10);
  assert.ok(waiting && !waiting.deferred && !waiting.ready, 'the page that owes exact ink has its stage, blocked as before');
  assert.equal(viewer.nearSight(4), true);
  assert.equal(viewer.nearSight(5), false);
  assert.equal(viewer.nearSight(99), true, 'a page that has no shell yet has no place: it is built');
  // a shell that shows nothing yet (a page never scrolled to) is put off like any other
  viewer.built.length = 0;
  viewer.appliedSrcRev = 4;
  for (const page of [11, 12]) {
    delete viewer.pageDivs.get(page).dataset.prov;
    delete viewer.pageDivs.get(page).dataset.canonPresentedRev;
  }
  viewer.stageProvisionalPatches(range(6, 12).map((n) => replace(version(n, 'v3'))), false, 12);
  await settle();
  assert.deepEqual(viewer.built, []);
  assert.deepEqual(viewer.deferred(), [5, 6, 7, 8, 9, 10, 11, 12]);
  // …and built when the reader comes to it
  viewer.look(12, 12);
  viewer.stageDeferredNearSight();
  await settle();
  assert.deepEqual(viewer.built, [10, 11, 12]);
  assert.equal(viewer.shown()[11], 'page 12 v3');
});

test('a page that shows a canonical paper is put off like one that shows resident ink', async () => {
  // twelve pages of a canonical paper on show; the source is one revision ahead of it
  const viewer = viewerOf(12, 12);
  viewer.look(5, 6);
  viewer.stageProvisionalPatches(range(1, 12).map((n) => replace(version(n, 'v1'))), false, 12);
  await settle();
  assert.deepEqual(viewer.built, [3, 4, 5, 6, 7, 8]);
  assert.deepEqual(viewer.deferred(), [1, 2, 9, 10, 11, 12]);
  assert.equal(viewer.pageDivs.get(12).paper, 'canonical:1:12', 'the canonical paper stays where no resident page was built');
  viewer.built.length = 0;
  viewer.look(11, 12);
  viewer.stageDeferredNearSight();
  await settle();
  assert.deepEqual(viewer.built, [9, 10, 11, 12]);
  assert.deepEqual(viewer.deferred(), [1, 2]);
});
