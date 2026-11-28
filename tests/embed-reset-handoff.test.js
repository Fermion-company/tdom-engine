// tex64-internal #121: a document reset covers Live with the static PDF and
// hands the reader's place back to the rebuilt frame. The frame reports that
// place (viewportCenter) and is handed it back through goto-sync
// (scrollToSync): both must name the same sheet, also when an outer paper's
// live chapter has grown, and the frame says whether the sheets it shows
// have paper on them yet (an empty shell is no place to reveal Live on).
// The embed's own code runs here; only layout is faked.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { jumpViewer, eventViewer, pageList } from './helpers/provisional-viewer.js';

const app = readFileSync(new URL('../web/app.js', import.meta.url), 'utf8');
const span = (start, end) => app.slice(app.indexOf(start), app.indexOf(end, app.indexOf(start) + start.length));
const EMBED = span('    const syncSheetOf =', '    const paperPageElement =') +
  span('    // (an element the viewport shows any of)', '    const presentationPending = (required') +
  span('    const viewportCenter =', '    const postEmbedSnapshot =') +
  '\nthis.viewportCenter = viewportCenter; this.syncTopPage = syncTopPage; this.previewPainted = previewPainted;' +
  '\nthis.visiblePageSnapshot = visiblePageSnapshot; this.previewReady = previewReady; this.inViewport = inViewport;' +
  '\nthis.outerSheetDecoded = outerSheetDecoded; this.holdsCentre = holdsCentre; this.holdsPoint = holdsPoint;';

const PITCH = 820; // each sheet 800 high, 20 apart, 600 wide

// An outer paper: Build sheets 1..before, the live chapter, then the Build's
// sheets afterFrom..pages. `live`: the chapter's pages in this frame.
function outerViewer({ before, afterFrom, pages, live }) {
  const viewer = jumpViewer({ fetch: async () => ({ ok: false, json: async () => ({}) }), pages: live });
  // a Build sheet: its lazy image, decoded or not
  const sheet = (name) => {
    const img = { complete: false, naturalWidth: 0 };
    return { name, img, dataset: {}, querySelector: (selector) => (selector === 'img' ? img : null), querySelectorAll: () => [img] };
  };
  Object.assign(viewer, { bootComplete: true, documentReset: { ...viewer.documentReset, acceptsReady: () => true } });
  viewer.pagesEl.getBoundingClientRect = () => ({ top: 0, bottom: viewer.pagesEl.clientHeight, left: 0, width: 600, height: viewer.pagesEl.clientHeight });
  // (a scroll the paper's two ends hold)
  Object.defineProperty(viewer.pagesEl, 'scrollHeight', { get: () => viewer.sheets().length * PITCH - 20 });
  viewer.pagesEl.scrollTo = ({ top }) => {
    viewer.pagesEl.scrollTop = Math.max(0, Math.min(top, viewer.pagesEl.scrollHeight - viewer.pagesEl.clientHeight));
  };
  const run = (items) => ({ children: items, get childElementCount() { return items.length; } });
  viewer.outerBeforeEl = run(Array.from({ length: before }, (_, i) => sheet(`build ${i + 1}`)));
  viewer.outerAfterEl = run(Array.from({ length: pages - afterFrom + 1 }, (_, i) => sheet(`build ${afterFrom + i}`)));
  viewer.outerPaper = { before, afterFrom, pages, key: 'k' };
  const order = () => [...viewer.outerBeforeEl.children, ...viewer.sortedPages().map(([, div]) => div), ...viewer.outerAfterEl.children];
  viewer.sheets = order;
  const place = (element) => {
    element.getBoundingClientRect = () => {
      const top = order().indexOf(element) * PITCH - viewer.pagesEl.scrollTop;
      return { top, bottom: top + 800, height: 800, left: 0, width: 600 };
    };
  };
  viewer.layout = () => order().forEach(place);
  viewer.grow = (n) => { // the chapter gets page n (a typed page, as Live shows it)
    const div = viewer.ensureShell(n);
    div.markers = []; div.appendChild = (marker) => { marker.parent = div; div.markers.push(marker); };
    viewer.layout();
  };
  viewer.layout();
  vm.runInContext(EMBED, viewer);
  // (the snapshot's own computation, postEmbedSnapshot)
  viewer.snapshot = () => {
    const visible = viewer.visiblePageSnapshot();
    return {
      ready: viewer.previewReady(visible.required, visible.outer),
      painted: viewer.previewPainted(visible.required, visible.outer),
      pending: viewer.presentationPending(visible.required, visible.outer),
      tokenSheetShown: Boolean(viewer.embedViewportSheet && viewer.holdsCentre(viewer.embedViewportSheet)),
      tokenPointShown: Boolean(viewer.embedViewportSheet && viewer.holdsPoint(viewer.embedViewportSheet, viewer.embedViewportPointY)),
    };
  };
  // the element at the centre of the viewport
  viewer.atCenter = () => {
    const y = viewer.pagesEl.clientHeight / 2;
    return order().find((element) => {
      const rect = element.getBoundingClientRect();
      return rect.top <= y && rect.bottom >= y;
    });
  };
  // the reader centres an element at `fraction` of its height
  viewer.look = (element, fraction) => {
    viewer.pagesEl.scrollTop = order().indexOf(element) * PITCH + fraction * 800 - viewer.pagesEl.clientHeight / 2;
  };
  return viewer;
}
// the place the host hands back (pdf-live-handoff.ts liveReaderPlace)
const handBack = (center, token) => ({
  page: center.page, x: 0, y: center.y, blockY: center.y, blockHeight: 0, marker: false,
  ...(center.livePage ? { livePage: center.livePage } : {}), viewportToken: token,
});

test('a reader on the first Build sheet after a grown chapter is handed back to that sheet', async () => {
  // Build: 2 sheets, a 3-page chapter, then sheets 6..8; Live has typed a 4th page
  const viewer = outerViewer({ before: 2, afterFrom: 6, pages: 8, live: 3 });
  viewer.grow(4);
  const first = viewer.outerAfterEl.children[0];
  viewer.look(first, 0.3);
  const center = viewer.viewportCenter();
  assert.equal(center.page, 6, 'the sheet in goto-sync\'s numbering (the Build\'s), not its place in the run (7)');
  assert.equal(center.livePage, undefined);
  assert.equal(Math.round(center.y), Math.round(0.3 * viewer.activePaperGeometry().height));
  assert.equal(viewer.syncTopPage(), 6);
  // the reset rebuilds the frame; the reader's place comes back through goto-sync
  viewer.pagesEl.scrollTop = 0;
  viewer.jump(handBack(center, 'r:1'));
  await viewer.flush();
  assert.equal(viewer.atCenter(), first, 'the same sheet, not the one after it');
  assert.equal(Math.round(viewer.viewportCenter().y), Math.round(center.y), 'at the same point of it');
  assert.equal(viewer.embedViewportToken, 'r:1');
});

test('a reader on a live page whose number a grown chapter shares with a Build sheet is handed back to the live page', async () => {
  const viewer = outerViewer({ before: 2, afterFrom: 6, pages: 8, live: 3 });
  viewer.grow(4);
  const page4 = viewer.pageDivs.get(4);
  viewer.look(page4, 0.6);
  const center = viewer.viewportCenter();
  assert.deepEqual([center.page, center.livePage], [6, 4]);
  viewer.pagesEl.scrollTop = 0;
  viewer.jump(handBack(center, 'r:2'));
  await viewer.flush();
  assert.equal(viewer.atCenter(), page4);
  assert.equal(Math.round(viewer.viewportCenter().y), Math.round(center.y));
  // the static PDF's own place (a Build sheet number, no live page) is a Build sheet
  viewer.jump({ page: 6, x: 0, y: 100, blockY: 100, blockHeight: 0, marker: false, viewportToken: 'r:3' });
  await viewer.flush();
  assert.equal(viewer.atCenter(), viewer.outerAfterEl.children[0]);
});

test('the frame says whether the sheets it shows have paper on them', () => {
  const viewer = outerViewer({ before: 0, afterFrom: 4, pages: 3, live: 3 });
  const shell = viewer.pageDivs.get(2);
  const entry = [[2, shell]];
  assert.equal(viewer.previewPainted(entry), false, 'an empty shell (its page number only) is no paper');
  shell.querySelector = (selector) => (selector === 'svg' ? {} : null);
  assert.equal(viewer.previewPainted(entry), true, 'resident ink');
  shell.querySelector = () => null;
  shell.querySelectorAll = (selector) => (selector === 'img' ? [{ complete: false, naturalWidth: 0 }] : []);
  assert.equal(viewer.previewPainted(entry), false, 'an image still decoding');
  shell.querySelectorAll = (selector) => (selector === 'img' ? [{ complete: true, naturalWidth: 600 }] : []);
  assert.equal(viewer.previewPainted(entry), true, 'a decoded canonical or Build image');
  assert.equal(viewer.previewPainted([]), false, 'nothing in sight is nothing painted');
});

test('paint is measured on the sheets in view: a Build sheet is no first live page', () => {
  const viewer = outerViewer({ before: 2, afterFrom: 6, pages: 8, live: 3 });
  const first = viewer.pageDivs.get(1);
  const paint = (div) => { div.querySelector = (selector) => (selector === 'svg' ? {} : null); div.dataset.prov = '1'; };
  // only Build sheet 6 in view, its lazy image not decoded yet; the first live page is painted
  paint(first);
  const build6 = viewer.outerAfterEl.children[0];
  viewer.look(build6, 0.5);
  assert.equal(viewer.visiblePageSnapshot().required.length, 0, 'no live page stands in for the Build sheet');
  assert.equal(viewer.snapshot().painted, false, 'an undecoded Build sheet is not paper');
  assert.equal(viewer.snapshot().ready, false);
  // decoded: drawn, whatever the first live page is
  build6.img.complete = true; build6.img.naturalWidth = 600;
  first.querySelector = () => null; delete first.dataset.prov;
  assert.equal(viewer.snapshot().painted, true, 'the destination drawn is not held back by an unpainted first page');
  assert.equal(viewer.snapshot().ready, true);
  // a live page and a Build sheet both in view: both must have paper
  viewer.look(viewer.pageDivs.get(3), 0.95);
  assert.equal(viewer.snapshot().painted, false, 'live page 3 is an empty shell');
  paint(viewer.pageDivs.get(3));
  assert.equal(viewer.snapshot().painted, true);
});

test('a handoff is acknowledged only on the sheet it names', async () => {
  // the reader was on live page 4 of a grown chapter; the rebuilt paper has three live pages so far
  const viewer = outerViewer({ before: 2, afterFrom: 6, pages: 8, live: 3 });
  viewer.pagesEl.scrollTop = 0;
  viewer.jump({ page: 6, livePage: 4, x: 0, y: 300, blockY: 300, blockHeight: 0, marker: false, viewportToken: 'r:1' });
  await viewer.flush();
  assert.equal(viewer.embedViewportToken, null, 'not answered with live page 3, the nearest');
  assert.equal(viewer.pagesEl.scrollTop, 0, 'nor scrolled');
  assert.equal(viewer.snapshot().tokenSheetShown, false);
  // the page arrives: the next snapshot's goto-sync is acknowledged on it
  viewer.grow(4);
  viewer.jump({ page: 6, livePage: 4, x: 0, y: 300, blockY: 300, blockHeight: 0, marker: false, viewportToken: 'r:1' });
  await viewer.flush();
  assert.equal(viewer.embedViewportToken, 'r:1');
  assert.equal(viewer.embedViewportSheet, viewer.pageDivs.get(4));
  assert.equal(viewer.atCenter(), viewer.pageDivs.get(4));
  assert.equal(viewer.snapshot().tokenSheetShown, true);
  // a Build sheet the paper does not have is not answered either
  const short = outerViewer({ before: 1, afterFrom: 4, pages: 5, live: 2 });
  short.outerAfterEl.children.length = 0; // (its trailing sheets not placed yet)
  short.jump({ page: 4, x: 0, y: 10, blockY: 10, blockHeight: 0, marker: false, viewportToken: 'r:2' });
  await short.flush();
  assert.equal(short.embedViewportToken, null);
});

test('a centred trailing Build sheet is the sheet in view, whatever number stands at the top', async () => {
  // the chapter grew by two sheets: live sheets 3..7, then Build sheet 6
  const viewer = outerViewer({ before: 2, afterFrom: 6, pages: 8, live: 5 });
  const build6 = viewer.outerAfterEl.children[0];
  viewer.jump({ page: 6, x: 0, y: 100, blockY: 100, blockHeight: 0, marker: false, viewportToken: 'r:3' });
  await viewer.flush();
  assert.equal(viewer.atCenter(), build6);
  assert.equal(viewer.embedViewportSheet, build6);
  assert.equal(viewer.syncTopPage(), 7, 'live sheet 7 at the top');
  assert.equal(viewer.snapshot().tokenSheetShown, true, 'the sheet the token named is in view');
});

test('the acknowledged sheet is shown only while it holds the centre, or the scroll is held at an end', async () => {
  const viewer = outerViewer({ before: 2, afterFrom: 6, pages: 8, live: 4 });
  const page3 = viewer.pageDivs.get(3);
  viewer.jump({ page: 5, livePage: 3, x: 0, y: 400, blockY: 400, blockHeight: 0, marker: false, viewportToken: 'r:4' });
  await viewer.flush();
  assert.equal(viewer.snapshot().tokenSheetShown, true);
  // a layout shift: a sliver of page 3 left at the top, page 4 at the centre
  viewer.pagesEl.scrollTop += 600;
  assert.equal(viewer.inViewport(page3), true, 'page 3 is still in view');
  assert.equal(viewer.snapshot().tokenSheetShown, false, 'but it is not the page shown');
  // a tall viewport (zoomed out): the top of Build sheet 1 cannot be centred,
  // the scroll is held at the top
  viewer.pagesEl.clientHeight = 2000;
  viewer.jump({ page: 1, x: 0, y: 0, blockY: 0, blockHeight: 0, marker: false, viewportToken: 'r:5' });
  await viewer.flush();
  assert.equal(viewer.pagesEl.scrollTop, 0);
  assert.notEqual(viewer.atCenter(), viewer.outerBeforeEl.children[0], 'another sheet holds the centre');
  assert.equal(viewer.snapshot().tokenSheetShown, true, 'yet the sheet stands on the held side of it');
  // and at the bottom: the last Build sheet's foot
  const last = viewer.outerAfterEl.children.at(-1);
  viewer.jump({ page: 8, x: 0, y: 790, blockY: 790, blockHeight: 0, marker: false, viewportToken: 'r:6' });
  await viewer.flush();
  assert.equal(viewer.embedViewportSheet, last);
  assert.equal(viewer.snapshot().tokenSheetShown, true);
});

// The engine numbers updates and async patches from one counter, but an
// update's report goes out only once the update has returned, while work
// that landed meanwhile publishes its patches at once. tdom-engine
// audit/scratch rebind.mjs, through the real engine: an edit, its late
// baseline, then an undo that rebinds it; canonical verification demoted the
// block and published patches 5 before the undo's update 4.
test('an update published after patches of its own revision is taken, and each page keeps its newest list', () => {
  const viewer = eventViewer([pageList(1), pageList(2)]);
  const list = (page, text) => ({ type: 'replace-page', displayList: pageList(page, [{ op: 'glyphs', src: `b${page}`, text }]) });
  const send = (msg) => viewer.receivePreviewEvent({ documentEpoch: 1, ...msg });
  assert.equal(viewer.appliedSrcRev, 2);
  send({ kind: 'patches', rev: 3, patches: [list(1, 'forward, rendered')] });
  send({ kind: 'patches', rev: 5, patches: [list(1, 'undo, verified')] });
  send({ kind: 'update', report: { rev: 4, srcRev: 3, patches: [list(1, 'undo'), list(2, 'undo')], stats: { pageCount: 2 } } });
  assert.equal(viewer.appliedSrcRev, 3, 'the undo\'s source revision is the viewer\'s');
  assert.equal(viewer.provisionalDisplayLists.get(1).commands[0].text, 'undo, verified', 'page 1: the newer list');
  assert.equal(viewer.provisionalDisplayLists.get(2).commands[0].text, 'undo', 'page 2: the update\'s');
  // and an update is still taken in report order only
  send({ kind: 'update', report: { rev: 4, srcRev: 3, patches: [list(2, 'again')], stats: { pageCount: 2 } } });
  assert.equal(viewer.provisionalDisplayLists.get(2).commands[0].text, 'undo');
});

// audit/scratch map.mjs: patch 5 painted page 1 while the viewer still held
// source 2, report 4 (source 3) followed. The page kept the click mapping of
// source 2 and nothing was staged to replace it; Jump took its ink for an
// older layout's.
test('a page painted from patches newer than the report is bound to the report\'s source, for clicks and Jump', async () => {
  const block = { id: 'b1', source: { file: '/paper/main.tex', start: { line: 4 }, end: { line: 12 } } };
  const viewer = jumpViewer({ events: true, fetch: async url => ({ ok: true, json: async () => url === '/dom'
    ? { srcRev: viewer.appliedSrcRev, documentEpoch: 1, blocks: [block] }
    : { pending: true, srcRev: viewer.appliedSrcRev, documentEpoch: 1 } }) });
  const list = (page, text) => ({ type: 'replace-page', displayList: pageList(page, [{ op: 'glyphs', src: `b${page}`, text }]) });
  const send = (msg) => viewer.receivePreviewEvent({ documentEpoch: 1, ...msg });
  const page = viewer.pageDivs.get(1);
  assert.equal(viewer.appliedSrcRev, 2);
  send({ kind: 'patches', rev: 5, patches: [list(1, 'undo, verified')] });
  assert.equal(page.dataset.provRev, '2', 'painted under the source the viewer held');
  assert.equal(page.provisionalSnapshot.srcRev, 2);
  const paints = [];
  const renderPage = viewer.renderPage;
  viewer.renderPage = (dl, ...rest) => { paints.push(dl.page); return renderPage(dl, ...rest); };
  send({ kind: 'update', report: { rev: 4, srcRev: 3, patches: [list(1, 'undo')], stats: { pageCount: 2 } } });
  assert.equal(viewer.appliedSrcRev, 3);
  assert.deepEqual(paints, [1], 'the page is staged again');
  assert.equal(viewer.provisionalDisplayLists.get(1).commands[0].text, 'undo, verified', 'with its newer list');
  assert.equal(page.dataset.provRev, '3');
  assert.equal(page.provisionalSnapshot.srcRev, 3, 'clicks read the mapping of source 3');
  assert.equal(viewer.provisionalStages.size, 0, 'and it is on paper');
  // Jump to line 5 (line 1 of the block): the page's own ink is this source's
  page.querySelectorAll = () => [{ dataset: { line: '1' }, tagName: 'text', classList: { contains: () => false },
    getBoundingClientRect: () => ({ top: page.getBoundingClientRect().top + 100, bottom: page.getBoundingClientRect().top + 112,
      left: 60, right: 240, width: 180, height: 12 }) }];
  viewer.jump({ page: 1, y: 70, sourceFile: block.source.file, sourceLine: 5 });
  await viewer.flush();
  const marker = viewer.markers()[0];
  assert.equal(marker.parent.dataset.page, '1');
  // (the band is centred on the line's own ink, 100-112px; an estimate from
  // the block's lines, for ink of another source, would centre it at 102px)
  assert.equal(marker.style.top, '88px', 'Jump goes by the line\'s own ink');
  // a page the report itself left alone, painted from an older patch of the
  // same source, is not staged again
  paints.length = 0;
  send({ kind: 'patches', rev: 6, patches: [list(2, 'later')] });
  send({ kind: 'update', report: { rev: 7, srcRev: 3, patches: [], stats: { pageCount: 2 } } });
  assert.deepEqual(paints, [2], 'only the patch\'s own paint');
});

// audit/scratch boundaries.mjs: with patches 5 published before report 4,
// the older report took a newly added third page away, and gave back a
// second page the newer patches had removed.
test('a report older than the page set brings its pages, never its page count', () => {
  const list = (page, text) => ({ type: 'replace-page', displayList: pageList(page, [{ op: 'glyphs', src: `b${page}`, text }]) });
  const shells = viewer => [...viewer.pageDivs].filter(([, div]) => div.isConnected).map(([n]) => n);
  // growth
  let viewer = eventViewer([pageList(1), pageList(2)]);
  let send = (msg) => viewer.receivePreviewEvent({ documentEpoch: 1, ...msg });
  send({ kind: 'patches', rev: 5, patches: [list(3, 'later grown')] });
  send({ kind: 'update', report: { rev: 4, srcRev: 3, stats: { pageCount: 2 }, patches: [list(2, 'earlier tail')] } });
  assert.deepEqual([...viewer.provisionalDisplayLists.keys()].sort(), [1, 2, 3], 'the added page stays');
  assert.deepEqual(shells(viewer), [1, 2, 3]);
  assert.equal(viewer.provisionalDisplayLists.get(2).commands[0].text, 'earlier tail', 'a page left alone since takes the report\'s list');
  assert.equal(viewer.pageDivs.get(3).dataset.provRev, '3', 'and the added page is this source\'s');
  // the next report is the newest event again: its count holds
  send({ kind: 'update', report: { rev: 8, srcRev: 4, stats: { pageCount: 2 }, patches: [{ type: 'remove-pages', from: 3 }] } });
  assert.deepEqual([...viewer.provisionalDisplayLists.keys()].sort(), [1, 2]);
  assert.ok(viewer.provisionalRemovedPages.has(3), 'its removal is staged');
  // shrink
  viewer = eventViewer([pageList(1), pageList(2)]);
  send = (msg) => viewer.receivePreviewEvent({ documentEpoch: 1, ...msg });
  send({ kind: 'patches', rev: 5, patches: [list(1, 'new tail'), { type: 'remove-pages', from: 2 }] });
  send({ kind: 'update', report: { rev: 4, srcRev: 3, stats: { pageCount: 2 }, patches: [list(2, 'earlier tail'), list(1, 'old one')] } });
  assert.deepEqual([...viewer.provisionalDisplayLists.keys()], [1], 'the removed page stays removed');
  assert.deepEqual(shells(viewer), [1]);
  assert.equal(viewer.provisionalDisplayLists.get(1).commands[0].text, 'new tail');
  assert.equal(viewer.pageDivs.get(1).dataset.provRev, '3');
  assert.ok(!viewer.pageDirtyRev.has(2), 'no page the set does not have is owed');
});

// audit/scratch r7 ordering.mjs: a patch says nothing of the page set unless
// it carries its revision's page count. A repaint of page 3 under revision
// 5 restored it, and report 4 removed it again; a repaint of page 2 after
// growth to four capped report 4 at two pages. Every async patch now carries
// the engine's page count of its revision (async-repaginate.js).
test('patches carry their revision\'s page count: a report published after them never undoes their page set', () => {
  const list = (n) => ({ type: 'replace-page', displayList: pageList(n) });
  const remove = (n) => ({ type: 'remove-pages', from: n });
  const shells = (viewer) => [...viewer.pageDivs].filter(([, div]) => div.isConnected).map(([n]) => n).sort((a, b) => a - b);
  for (const [initial, reported, older, newer, count] of [
    [1, 4, [list(2), list(3), list(4)], [list(2)], 4],
    [3, 2, [list(2), remove(3)], [list(3)], 3],
    [5, 2, [list(2), remove(3)], [list(3)], 3],
    [2, 4, [list(3), list(4)], [list(3), remove(4)], 3],
    [5, 2, [list(2), remove(3)], [list(1)], 2],
    [2, 2, [list(2)], [list(3)], 3],
  ]) {
    const viewer = eventViewer(Array.from({ length: initial }, (_, i) => pageList(i + 1)));
    viewer.committedCanonicalGeneration = null;
    const send = (msg) => viewer.receivePreviewEvent({ documentEpoch: 1, ...msg });
    send({ kind: 'patches', rev: 5, pageCount: count, srcRev: 3, patches: newer });
    send({ kind: 'update', report: { rev: 4, srcRev: 3, stats: { pageCount: reported }, patches: older } });
    const pages = Array.from({ length: count }, (_, i) => i + 1);
    const label = `from ${initial}, report of ${reported}, patch of ${count}`;
    assert.deepEqual([...viewer.provisionalDisplayLists.keys()].sort((a, b) => a - b), pages, label);
    assert.deepEqual(shells(viewer), pages, label);
    assert.equal(viewer.appliedSrcRev, 3);
  }
});

// audit/scratch r8 click-map: patch 5, of source 3, painted page 1 while the
// viewer held source 2, and until report 4 came the page's click map was
// source 2's (line 12 for ink of line 47). Such patches wait for their
// report and are applied after its lists. r9 click-timeout: the 3 s timer
// let them go under the source before theirs; it no longer paints them.
test('patches of a source the viewer has not applied wait for that source\'s report', () => {
  const list = (text) => ({ type: 'replace-page', displayList: pageList(1, [{ op: 'glyphs', src: 'b1', text }]) });
  const viewer = eventViewer([pageList(1)]);
  viewer.committedCanonicalGeneration = null;
  const timers = [];
  viewer.setTimeout = (fn, ms) => timers.push({ fn, ms });
  viewer.clearTimeout = () => {};
  const send = (msg) => viewer.receivePreviewEvent({ documentEpoch: 1, ...msg });
  const text = () => viewer.provisionalDisplayLists.get(1)?.commands[0]?.text;
  assert.equal(viewer.appliedSrcRev, 2);
  send({ kind: 'patches', rev: 5, srcRev: 3, pageCount: 1, patches: [list('revision 3 note')] });
  assert.notEqual(text(), 'revision 3 note', 'not painted while the viewer holds source 2');
  send({ kind: 'update', report: { rev: 4, srcRev: 3, stats: { pageCount: 1 }, patches: [list('earlier layout')] } });
  assert.equal(text(), 'revision 3 note', 'applied after its report, over the report\'s older list');
  assert.equal(viewer.pageDivs.get(1).dataset.provRev, '3', 'under source 3');
  send({ kind: 'patches', rev: 9, srcRev: 7, pageCount: 1, patches: [list('revision 7')] });
  assert.equal(text(), 'revision 3 note');
  assert.equal(timers.at(-1)?.ms, 3000);
  timers.at(-1).fn();
  assert.equal(text(), 'revision 3 note', 'not let go under source 3 when no report comes');
  assert.equal(viewer.pageDivs.get(1).provisionalSnapshot.srcRev, 3, 'the page keeps its own map');
  send({ kind: 'update', report: { rev: 10, srcRev: 7, stats: { pageCount: 1 }, patches: [] } });
  assert.equal(text(), 'revision 7', 'taken with the report of source 7');
  assert.equal(viewer.pageDivs.get(1).provisionalSnapshot.srcRev, 7);
});

// The held transaction at its edges (audit r9 item 8). Each ink names the
// source it was made for (`src N: …`); the stand-in renderPage stages a list
// under the source the viewer holds, with that source's map, as the real
// one does through loadProvisionalSnapshot. A page's ink is clicked against
// div.provisionalSnapshot.
const inkOf = (page, text) => ({ type: 'replace-page', displayList: pageList(page, [{ op: 'glyphs', src: `b${page}`, text }]) });
const sourceOf = (dl) => Number(/^src (\d+):/.exec(dl?.commands?.[0]?.text ?? '')?.[1]) || null;
const onPaper = (viewer, n = 1) => {
  const div = viewer.pageDivs.get(n);
  return { ink: Array.isArray(div.paper) ? div.paper[0].commands[0].text : div.paper, map: div.provisionalSnapshot?.srcRev };
};
// no ink on paper, nor staged, under the map of another source
function assertCoherent(viewer, label) {
  for (const [n, div] of viewer.pageDivs) {
    const source = sourceOf(Array.isArray(div.paper) ? div.paper[0] : null);
    if (source !== null) assert.equal(div.provisionalSnapshot?.srcRev, source, `${label}: page ${n}, ink of source ${source}, its own map`);
  }
  for (const [n, stage] of viewer.provisionalStages) {
    const source = sourceOf(stage.dl);
    if (source !== null) assert.equal(stage.sourceRev, source, `${label}: page ${n}, staged under its own source`);
  }
}
const heldCount = (viewer) => vm.runInContext('heldPatchEvents.length', viewer);
const settle = async () => { for (let i = 0; i < 4; i++) await new Promise((resolve) => setImmediate(resolve)); };
// a /doc snapshot: its report, and the lists of the engine revision `layoutRev` and source `layoutSrcRev`
const docOf = ({ rev, srcRev, layoutRev = rev, layoutSrcRev = srcRev, pages }) => ({
  documentEpoch: 1, layoutRev, layoutSrcRev, report: { rev, srcRev, stats: { pageCount: pages.length }, patches: [] }, pages,
});
function heldViewer(pages = [pageList(1)]) {
  const viewer = eventViewer(pages);
  viewer.committedCanonicalGeneration = null;
  viewer.send = (msg) => viewer.receivePreviewEvent({ documentEpoch: 1, ...msg });
  viewer.reads = [];
  return viewer;
}

// audit r9 click-timeout, on the real timer: a seeded page of source 2, the
// report of source 3 lost. At 3.15 s the page showed ink of 3 clicked
// against the map of 2 (line 12 for line 47).
test('a held patch whose report is lost is never clicked against the source before it, on the real timer', async () => {
  const viewer = heldViewer();
  Object.assign(viewer, { setTimeout, clearTimeout });
  // the engine between the update of source 3 and its report: lists of 3, report of 2
  viewer.fetch = async (url) => {
    viewer.reads.push(url);
    return { json: async () => docOf({ rev: 3, srcRev: 2, layoutRev: 5, layoutSrcRev: 3, pages: [pageList(1, [{ op: 'glyphs', src: 'b1', text: 'src 3: note' }])] }) };
  };
  viewer.send({ kind: 'patches', rev: 3, srcRev: 2, pageCount: 1, patches: [inkOf(1, 'src 2: note')] });
  assert.deepEqual(onPaper(viewer), { ink: 'src 2: note', map: 2 });
  viewer.send({ kind: 'patches', rev: 5, srcRev: 3, pageCount: 1, patches: [inkOf(1, 'src 3: note')] });
  assert.deepEqual(onPaper(viewer), { ink: 'src 2: note', map: 2 }, 'held');
  assertCoherent(viewer, 'held');
  await new Promise((resolve) => setTimeout(resolve, 3150));
  await settle();
  assert.deepEqual(viewer.reads, ['/doc'], 'the deadline reads the document once');
  assert.deepEqual(onPaper(viewer), { ink: 'src 2: note', map: 2 }, 'a snapshot whose lists are not its report\'s is not taken');
  assertCoherent(viewer, 'after the deadline');
  assert.equal(heldCount(viewer), 1, 'still held');
  viewer.send({ kind: 'update', report: { rev: 4, srcRev: 3, stats: { pageCount: 1 }, patches: [inkOf(1, 'src 3: earlier layout')] } });
  assert.deepEqual(onPaper(viewer), { ink: 'src 3: note', map: 3 }, 'the late report takes it, after its own lists');
  assert.equal(heldCount(viewer), 0);
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.deepEqual(viewer.reads, ['/doc'], 'and nothing is read again');
});

// With no report at the deadline, a /doc whose report is theirs is taken:
// its lists and its map together.
test('at the deadline a snapshot of the held patches\' source is taken whole, and the late report is not', async () => {
  const viewer = heldViewer();
  const timers = [];
  Object.assign(viewer, { setTimeout: (fn, ms) => timers.push({ fn, ms }), clearTimeout() {} });
  viewer.fetch = async (url) => {
    viewer.reads.push(url);
    return { json: async () => docOf({ rev: 4, srcRev: 3, layoutRev: 5, pages: [pageList(1, [{ op: 'glyphs', src: 'b1', text: 'src 3: note' }])] }) };
  };
  viewer.send({ kind: 'patches', rev: 3, srcRev: 2, pageCount: 1, patches: [inkOf(1, 'src 2: note')] });
  viewer.send({ kind: 'patches', rev: 5, srcRev: 3, pageCount: 1, patches: [inkOf(1, 'src 3: note')] });
  assert.equal(timers.length, 1);
  assert.equal(timers[0].ms, 3000);
  timers[0].fn();
  assert.deepEqual(onPaper(viewer), { ink: 'src 2: note', map: 2 }, 'not before the snapshot is in');
  await settle();
  assert.deepEqual(viewer.reads, ['/doc']);
  assert.deepEqual(onPaper(viewer), { ink: 'src 3: note', map: 3 });
  assert.equal(viewer.appliedSrcRev, 3);
  assert.equal(heldCount(viewer), 0, 'the snapshot has the held patch');
  viewer.send({ kind: 'update', report: { rev: 4, srcRev: 3, stats: { pageCount: 1 }, patches: [inkOf(1, 'src 3: earlier layout')] } });
  assert.deepEqual(onPaper(viewer), { ink: 'src 3: note', map: 3 }, 'the report the snapshot stood for is taken once');
  assertCoherent(viewer, 'after the late report');
});

// audit r9 click-supersede: report 3 lost, report 4 came. The held patch of
// source 3 was staged under source 4's map, and a page staged before the
// report would have been carried to source 4 with a list the lost report may
// have changed. Both pages keep their paper until /doc has the lists of 4.
test('a superseding report never puts an older list under its map: the pages wait for /doc', async () => {
  const viewer = heldViewer([pageList(1), pageList(2)]);
  let clock = 10_000;
  viewer.performance = { now: () => clock };
  const docs = [
    // read between the update of source 5 and its report
    docOf({ rev: 6, srcRev: 4, layoutRev: 7, layoutSrcRev: 5, pages: [pageList(1), pageList(2)] }),
    docOf({ rev: 8, srcRev: 5, pages: [pageList(1, [{ op: 'glyphs', src: 'b1', text: 'src 5: note' }]),
      pageList(2, [{ op: 'glyphs', src: 'b2', text: 'src 5: page two' }])] }),
  ];
  viewer.fetch = async (url) => { viewer.reads.push(url); const doc = docs.shift(); return { json: async () => doc }; };
  // page 2 is staged, waiting for exact ink, under source 2
  viewer.send({ kind: 'patches', rev: 3, srcRev: 2, pageCount: 2, patches: [inkOf(1, 'src 2: note'),
    { type: 'replace-page', displayList: pageList(2, [{ op: 'glyphs', src: 'b2', text: 'src 2: page two' }, { op: 'pending-exact', src: 'b2' }]) }] });
  assert.deepEqual(onPaper(viewer), { ink: 'src 2: note', map: 2 });
  assert.equal(viewer.provisionalStages.get(2)?.sourceRev, 2, 'page 2 waits under source 2');
  viewer.send({ kind: 'patches', rev: 5, srcRev: 3, pageCount: 2, patches: [inkOf(1, 'src 3: note')] });
  viewer.send({ kind: 'update', report: { rev: 6, srcRev: 4, stats: { pageCount: 2 }, patches: [] } });
  assert.equal(viewer.appliedSrcRev, 4);
  assert.deepEqual(onPaper(viewer), { ink: 'src 2: note', map: 2 }, 'the held patch of 3 is not painted under 4');
  assert.equal(heldCount(viewer), 0, 'nor kept');
  assert.equal(viewer.provisionalStages.has(2), false, 'page 2 is not carried to source 4');
  assert.equal(onPaper(viewer, 2).ink, 'canonical:1:2', 'it keeps its paper');
  assertCoherent(viewer, 'after the superseding report');
  await settle();
  assert.deepEqual(viewer.reads, ['/doc']);
  assert.deepEqual(onPaper(viewer), { ink: 'src 2: note', map: 2 }, 'a snapshot whose lists are of 5 is not taken under 4');
  assert.equal(vm.runInContext('docResync.owed', viewer), true, 'the lists are still owed');
  // the next report reads it again (not sooner than 3 s after the last read)
  clock += 3000;
  viewer.send({ kind: 'update', report: { rev: 8, srcRev: 5, stats: { pageCount: 2 }, patches: [] } });
  assertCoherent(viewer, 'report of 5');
  await settle();
  assert.deepEqual(viewer.reads, ['/doc', '/doc']);
  assert.deepEqual(onPaper(viewer), { ink: 'src 5: note', map: 5 });
  assert.deepEqual(onPaper(viewer, 2), { ink: 'src 5: page two', map: 5 }, 'page 2 too, under source 5');
  assert.equal(vm.runInContext('docResync.owed', viewer), false);
  assertCoherent(viewer, 'after /doc');
  // nothing owed: the next report reads nothing
  clock += 3000;
  viewer.send({ kind: 'update', report: { rev: 9, srcRev: 6, stats: { pageCount: 2 }, patches: [inkOf(1, 'src 6: note')] } });
  await settle();
  assert.equal(viewer.reads.length, 2);
  assert.deepEqual(onPaper(viewer), { ink: 'src 6: note', map: 6 });
});

// A superseding report still applies the held patches of its own source
// (published between its update and the report), not those it passed.
test('a report applies held patches of its own source and drops those of a source it passed', () => {
  const viewer = heldViewer();
  viewer.send({ kind: 'patches', rev: 3, srcRev: 2, pageCount: 1, patches: [inkOf(1, 'src 2: note')] });
  viewer.send({ kind: 'patches', rev: 5, srcRev: 3, pageCount: 1, patches: [inkOf(1, 'src 3: note')] });
  viewer.send({ kind: 'patches', rev: 7, srcRev: 4, pageCount: 1, patches: [inkOf(1, 'src 4: note')] });
  assert.equal(heldCount(viewer), 2);
  viewer.send({ kind: 'update', report: { rev: 6, srcRev: 4, stats: { pageCount: 1 }, patches: [inkOf(1, 'src 4: earlier')] } });
  assert.deepEqual(onPaper(viewer), { ink: 'src 4: note', map: 4 });
  assert.equal(heldCount(viewer), 0);
  assertCoherent(viewer, 'report of 4');
});

// A reset (a document switch, an engine reboot) starts from /doc: what is
// held for the old document goes at its start, with its timer, and a /doc
// read on the way is not taken.
test('a document reset drops the held transaction, its timer and any /doc on its way', async () => {
  const resetStart = span('function beginClientDocumentReset', 'function completeClientDocumentReset');
  const withReset = (viewer) => {
    Object.assign(viewer, { deferredDirectPresentationCommits: new Set(), directEditRevisits: [], cancelDirectOpenings() {},
      bootComplete: true, window: { parent: { postMessage() {} } }, embedActivationId: 'a' });
    viewer.documentReset.begin = (epoch) => { viewer.documentReset.pending = { epoch }; return true; };
    vm.runInContext(resetStart, viewer);
    return viewer;
  };
  // held, its timer pending
  let viewer = withReset(heldViewer());
  const timers = new Map();
  const cleared = [];
  let id = 0;
  Object.assign(viewer, { setTimeout: (fn, ms) => { timers.set(++id, { fn, ms }); return id; }, clearTimeout: (t) => cleared.push(t) });
  viewer.fetch = async (url) => { viewer.reads.push(url); return { json: async () => ({}) }; };
  viewer.send({ kind: 'patches', rev: 3, srcRev: 2, pageCount: 1, patches: [inkOf(1, 'src 2: note')] });
  viewer.send({ kind: 'patches', rev: 5, srcRev: 3, pageCount: 1, patches: [inkOf(1, 'src 3: note')] });
  assert.equal(heldCount(viewer), 1);
  viewer.send({ kind: 'reset-pending', documentEpoch: 2 });
  assert.ok(viewer.documentReset.pending);
  assert.equal(heldCount(viewer), 0, 'dropped at the reset\'s start');
  assert.deepEqual(cleared, [1], 'with its timer');
  timers.get(1).fn(); // (a callback already on its way)
  await settle();
  assert.deepEqual(viewer.reads, [], 'no /doc of the old document');
  assert.notEqual(onPaper(viewer).ink, 'src 3: note');
  // a /doc read at the deadline, answered after the reset began
  viewer = withReset(heldViewer());
  const deadline = [];
  let answer;
  Object.assign(viewer, { setTimeout: (fn) => deadline.push(fn), clearTimeout() {} });
  viewer.fetch = (url) => { viewer.reads.push(url); return new Promise((resolve) => { answer = resolve; }); };
  viewer.send({ kind: 'patches', rev: 3, srcRev: 2, pageCount: 1, patches: [inkOf(1, 'src 2: note')] });
  viewer.send({ kind: 'patches', rev: 5, srcRev: 3, pageCount: 1, patches: [inkOf(1, 'src 3: note')] });
  deadline[0]();
  await settle();
  assert.deepEqual(viewer.reads, ['/doc']);
  viewer.send({ kind: 'reset-pending', documentEpoch: 2 });
  answer({ json: async () => docOf({ rev: 4, srcRev: 3, layoutRev: 5, pages: [pageList(1, [{ op: 'glyphs', src: 'b1', text: 'src 3: note' }])] }) });
  await settle();
  assert.deepEqual(onPaper(viewer), { ink: 'src 2: note', map: 2 }, 'the old document\'s /doc is not taken');
  assert.equal(viewer.appliedSrcRev, 2);
});

// The stream connected again: what it sent meanwhile (the report the held
// patch waits for, perhaps) is lost. The held patch goes and the lists come
// from /doc. The viewer's own stream code runs here, on a stand-in EventSource.
test('a stream that connects again drops the held patches and takes the lists from /doc', async () => {
  const viewer = heldViewer();
  const sources = [];
  viewer.EventSource = class { constructor(url) { this.url = url; sources.push(this); } close() {} };
  vm.runInContext(`${span('const streamLists = new Map();', '\nopenEventStream();')}\nopenEventStream();`, viewer);
  viewer.fetch = async (url) => {
    viewer.reads.push(url);
    return { json: async () => docOf({ rev: 4, srcRev: 3, layoutRev: 5, pages: [pageList(1, [{ op: 'glyphs', src: 'b1', text: 'src 3: note' }])] }) };
  };
  viewer.send({ kind: 'patches', rev: 3, srcRev: 2, pageCount: 1, patches: [inkOf(1, 'src 2: note')] });
  sources[0].onopen(); // (the first connection)
  viewer.send({ kind: 'patches', rev: 5, srcRev: 3, pageCount: 1, patches: [inkOf(1, 'src 3: note')] });
  await settle();
  assert.deepEqual(viewer.reads, [], 'the first connection reads nothing');
  assert.equal(heldCount(viewer), 1);
  sources[0].onopen(); // connected again: report 4 was sent meanwhile
  assert.equal(heldCount(viewer), 0, 'the held patch goes');
  assert.deepEqual(onPaper(viewer), { ink: 'src 2: note', map: 2 }, 'the page keeps its paper and map meanwhile');
  await settle();
  assert.deepEqual(viewer.reads, ['/doc']);
  assert.deepEqual(onPaper(viewer), { ink: 'src 3: note', map: 3 });
  assert.equal(viewer.appliedSrcRev, 3);
  assertCoherent(viewer, 'after /doc');
});

// audit/scratch r7 ordering.mjs: a /doc response taken before a patch that
// added page 3, delivered after it, took the page back.
test('a /doc snapshot is ordered by its layout revision', async () => {
  const viewer = eventViewer([pageList(1), pageList(2)]);
  viewer.committedCanonicalGeneration = { epoch: 1, residentLayoutCompatible: false, pageCount: 2, rev: 1 };
  let release;
  const old = { documentEpoch: 1, layoutRev: 4, report: { rev: 2, srcRev: 2 }, pages: [pageList(1), pageList(2)] };
  Object.assign(viewer, { performance: { now: () => 6000 }, pendingLayoutResyncAt: 0, pendingLayoutResyncing: false,
    fetch: () => new Promise((resolve) => { release = () => resolve({ json: async () => old }); }) });
  vm.runInContext('resyncPendingLayout()', viewer);
  viewer.receivePreviewEvent({ documentEpoch: 1, kind: 'patches', rev: 5, pageCount: 3, srcRev: 2,
    patches: [{ type: 'replace-page', displayList: pageList(3) }] });
  release();
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual([...viewer.provisionalDisplayLists.keys()].sort(), [1, 2, 3]);
  assert.ok(viewer.provisionalStages.has(3), 'the added page is still staged for paper');
  assert.equal(viewer.provisionalRemovedPages.size, 0, 'and nothing is removed');
});

// audit/scratch r7 points.mjs: y=770 taken on a Build sheet, the Live sheet
// only 500 high: the frame scrolled to 500 and tested 770 for good.
test('the handed-off point is clamped once to the sheet it lands on, for the scroll and the acknowledgement alike', async () => {
  const viewer = outerViewer({ before: 0, afterFrom: 4, pages: 3, live: 3 });
  viewer.pagesEl.clientHeight = 500;
  viewer.activePaperGeometry = () => ({ width: 600, height: 500 });
  viewer.jump({ page: 2, x: 0, y: 770, blockY: 770, blockHeight: 0, marker: false, viewportToken: 'T' });
  await viewer.flush();
  assert.equal(viewer.embedViewportPointY, 500);
  assert.equal(viewer.snapshot().tokenPointShown, true);
});

// audit/scratch boundaries.mjs: the token proved only the sheet. Acknowledged
// at y=300 on live page 3, the frame still confirmed it with y=500 at the
// centre.
test('the acknowledged point, not only its sheet, must stand at the centre', async () => {
  const viewer = outerViewer({ before: 2, afterFrom: 6, pages: 8, live: 4 });
  viewer.jump({ page: 5, livePage: 3, x: 0, y: 300, blockY: 300, blockHeight: 0, marker: false, viewportToken: 'r:7' });
  await viewer.flush();
  assert.deepEqual({ ...viewer.viewportCenter() }, { page: 5, livePage: 3, y: 300, paperPx: 600 });
  assert.equal(viewer.snapshot().tokenPointShown, true);
  // the paper drifts by 200 units on the same sheet
  viewer.pagesEl.scrollTop += 200;
  assert.equal(viewer.viewportCenter().y, 500);
  assert.equal(viewer.snapshot().tokenSheetShown, true, 'the sheet still holds the centre');
  assert.equal(viewer.snapshot().tokenPointShown, false, 'the point does not');
  // within an eighth of the viewport it still does
  viewer.pagesEl.scrollTop -= 200 - viewer.pagesEl.clientHeight / 8;
  assert.equal(viewer.snapshot().tokenPointShown, true);
  // the goto-sync sent again puts it back
  viewer.pagesEl.scrollTop += 100;
  assert.equal(viewer.snapshot().tokenPointShown, false);
  viewer.jump({ page: 5, livePage: 3, x: 0, y: 300, blockY: 300, blockHeight: 0, marker: false, viewportToken: 'r:7' });
  await viewer.flush();
  assert.equal(viewer.snapshot().tokenPointShown, true);
  // a scroll held at the top or the bottom cannot centre a point near that edge
  viewer.jump({ page: 1, x: 0, y: 20, blockY: 20, blockHeight: 0, marker: false, viewportToken: 'r:8' });
  await viewer.flush();
  assert.equal(viewer.pagesEl.scrollTop, 0);
  assert.equal(viewer.snapshot().tokenPointShown, true, 'held at the top');
  viewer.jump({ page: 8, x: 0, y: 790, blockY: 790, blockHeight: 0, marker: false, viewportToken: 'r:9' });
  await viewer.flush();
  assert.equal(viewer.snapshot().tokenPointShown, true, 'held at the bottom');
  viewer.pagesEl.scrollTop -= 300;
  assert.equal(viewer.snapshot().tokenPointShown, false, 'not once the reader scrolls off it');
});

// audit/scratch first-failure.mjs: the document's first canonical failed, so
// there was no earlier generation to count from; the frame never called its
// shrunk count settled and the host waited for a vanished sheet for good.
test('a first canonical that failed leaves the resident count settled', () => {
  const stalled = (reported, srcRev) => vm.runInNewContext(
    span('function canonicalCountStalled', 'function residentPageTransactionValid') + `\ncanonicalCountStalled(${JSON.stringify(reported)}, ${srcRev})`, {});
  assert.equal(stalled({ error: 'TeX failure', rev: null, errorRev: 3, runningRev: null }, 3), true, 'the first canonical failed');
  assert.equal(stalled({ error: 'TeX failure', rev: null, errorRev: 3, runningRev: 3 }, 3), false, 'unless it is compiling again');
  assert.equal(stalled({ error: null, rev: null, errorRev: null, runningRev: null }, 3), false, 'no canonical yet is no failure');
  assert.equal(stalled({ error: 'TeX failure', rev: 2, errorRev: 3, runningRev: null }, 3), true, 'as after an earlier generation');
  assert.equal(stalled({ error: 'TeX failure', rev: 3, errorRev: 3, runningRev: null }, 3), false, 'a generation of this source counts');
});

test('the last lost report recovers after failed, stalled and incoherent /doc reads without more events', async () => {
  const viewer = heldViewer();
  let now = 0;
  let seq = 0;
  const timers = new Map();
  Object.assign(viewer, {
    performance: { now: () => now },
    setTimeout(fn, ms) { timers.set(++seq, { fn, at: now + ms }); return seq; },
    clearTimeout(id) { timers.delete(id); },
  });
  viewer.fetch = async url => {
    viewer.reads.push(url);
    if (viewer.reads.length === 1) throw Error('transient failure');
    if (viewer.reads.length === 2) return new Promise(() => {});
    const layoutSrcRev = viewer.reads.length === 3 ? 2 : 3;
    return { ok: true, json: async () => docOf({ rev: 4, srcRev: 3, layoutRev: 5, layoutSrcRev,
      pages: [inkOf(1, 'src 3: note').displayList] }) };
  };
  viewer.send({ kind: 'patches', rev: 3, srcRev: 2, pageCount: 1, patches: [inkOf(1, 'src 2: note')] });
  viewer.send({ kind: 'patches', rev: 5, srcRev: 3, pageCount: 1, patches: [inkOf(1, 'src 3: note')] });
  for (let attempt = 1; attempt <= 4; attempt++) {
    assert.equal(timers.size, 1, 'one recovery wake-up');
    const [id, timer] = timers.entries().next().value;
    assert.ok(timer.at > now && timer.at - now <= 12000, 'bounded backoff');
    now = timer.at;
    timers.delete(id);
    timer.fn();
    await settle();
    assert.equal(viewer.reads.length, attempt);
    if (attempt === 2) {
      assert.equal(timers.size, 1, 'the stalled request owns the only timer');
      const [deadlineId, deadline] = timers.entries().next().value;
      now = deadline.at;
      timers.delete(deadlineId);
      deadline.fn();
      await settle();
    }
    assert.deepEqual(onPaper(viewer), attempt < 4 ? { ink: 'src 2: note', map: 2 } : { ink: 'src 3: note', map: 3 });
  }
  assert.equal(heldCount(viewer), 0);
  assert.equal(timers.size, 0);
});
