// The reader's place across changes of the paper (web/view-anchor.js and its
// wiring in web/app.js), a Jump that moves the paper once, and direct editing
// switched off. The viewer's own transactions run here (helpers/provisional-
// viewer.js); only page boxes are faked, stacked under pagesEl.scrollTop.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { eventViewer, jumpViewer, pageList } from './helpers/provisional-viewer.js';

const app = readFileSync(new URL('../web/app.js', import.meta.url), 'utf8');
const ANCHOR = readFileSync(new URL('../web/view-anchor.js', import.meta.url), 'utf8');
const span = (start, end) => app.slice(app.indexOf(start), app.indexOf(end, app.indexOf(start) + start.length));
const Anchor = (() => { const context = {}; vm.createContext(context); vm.runInContext(ANCHOR, context); return context.TdomViewAnchor; })();

// rows of a block: one command a row, `rows` rows from paper y `from`, 14 apart
const rows = (src, lines, from, step = 14) => lines.map((line, i) =>
  ({ op: 'glyphs', src, line, x: 72, y: from + i * step, size: 10, gh: 7, gd: 2, text: `${src}.${line}` }));

test('the anchor is the edit\'s line while it is in view, else the line at the centre', () => {
  const dl = { page: 1, commands: [...rows('a', [0, 1, 2, 3, 4], 100), ...rows('b', [0, 1, 2], 400)] };
  const pages = [{ page: 1, top: 0, height: 792, paperHeight: 792, dl }];
  const reading = Anchor.captureAnchor({ pages, viewTop: 0, viewBottom: 300 });
  assert.equal(reading.kind, 'reading');
  // (the centre, 150: a's line 4, 149..158)
  assert.deepEqual([reading.src, reading.line], ['a', 4]);
  const edit = Anchor.captureAnchor({ pages, viewTop: 0, viewBottom: 450, editSrcs: new Set(['b']) });
  assert.deepEqual([edit.kind, edit.src, edit.line], ['edit', 'b', 0]);
  const away = Anchor.captureAnchor({ pages, viewTop: 0, viewBottom: 300, editSrcs: new Set(['b']) });
  assert.equal(away.kind, 'reading', 'an edit out of view is no anchor');
  // exact pixels only: a page and a fraction of it
  const exact = Anchor.captureAnchor({ pages: [{ page: 3, top: -100, height: 800, paperHeight: 792, dl: null }], viewTop: 0, viewBottom: 400 });
  assert.deepEqual([exact.kind, exact.page, exact.fraction], ['page', 3, 0.375]);
});

test('a reading anchor is put back exactly; an edit anchor only once it has left the view', () => {
  const before = { page: 1, commands: rows('a', [0, 1, 2], 300) };
  const pages = [{ page: 1, top: 0, height: 792, paperHeight: 792, dl: before }];
  const reading = Anchor.captureAnchor({ pages, viewTop: 0, viewBottom: 600 });
  const moved = { page: 1, commands: rows('a', [0, 1, 2], 330) };
  const now = Anchor.locateAnchor(reading, [{ ...pages[0], dl: moved }]);
  assert.equal(Math.round(Anchor.restoreDelta(reading, now)), 30, 'the line moved 30 down: so does the paper');
  const edit = Anchor.captureAnchor({ pages, viewTop: 0, viewBottom: 600, editSrcs: new Set(['a']) });
  assert.equal(Anchor.restoreDelta(edit, Anchor.locateAnchor(edit, [{ ...pages[0], dl: moved }])), 0, 'still in view: still');
  const far = { page: 1, commands: rows('a', [0, 1, 2], 700) };
  // (gone below the view: put back where it was, 293 → 693)
  assert.equal(Math.round(Anchor.restoreDelta(edit, Anchor.locateAnchor(edit, [{ ...pages[0], dl: far }]))), 400);
  // a line no longer typeset: the next line of its block
  const gone = { page: 1, commands: rows('a', [0, 2], 300) };
  const next = Anchor.locateAnchor({ ...reading, line: 1 }, [{ ...pages[0], dl: gone }]);
  assert.equal(next.exact, false);
});

// A viewer whose page boxes stand one under the other below pagesEl.scrollTop
// (page n's top at (n - 1) * 820 - scrollTop, 800 high), the viewport 800 high.
function anchoredViewer(pages) {
  const viewer = eventViewer(pages);
  viewer.committedCanonicalGeneration = null;
  viewer.geometry = { paperwidth: 612, paperheight: 792 };
  vm.runInContext(ANCHOR, viewer);
  viewer.pagesEl = { scrollTop: 0, clientHeight: 800,
    getBoundingClientRect: () => ({ top: 0, bottom: 800, left: 0, width: 600, height: 800 }) };
  const place = (n, div) => {
    div.getBoundingClientRect = () => ({ top: (n - 1) * 820 - viewer.pagesEl.scrollTop, bottom: (n - 1) * 820 + 800 - viewer.pagesEl.scrollTop,
      left: 0, width: 600, height: 800 });
  };
  for (const [n, div] of viewer.pageDivs) place(n, div);
  const ensure = viewer.ensureShell;
  viewer.ensureShell = (n) => { const div = ensure(n); place(n, div); return div; };
  viewer.send = (msg) => viewer.receivePreviewEvent({ documentEpoch: 1, ...msg });
  return viewer;
}
const scale = 800 / 792;

test('a commit that moves the reader\'s line on its page moves the paper with it, in the same transaction', () => {
  const viewer = anchoredViewer([pageList(1), pageList(2), pageList(3)]);
  viewer.send({ kind: 'patches', rev: 3, patches: [2, 3].map((n) => ({ type: 'replace-page', displayList: { page: n, commands: rows(`p${n}`, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9], 100, 40) } })) });
  // the reader looks at page 2's middle
  viewer.pagesEl.scrollTop = 820 + 400 - 400;
  const before = viewer.pagesEl.scrollTop;
  // the same lines, 120 units further down (a paragraph grew above them)
  viewer.send({ kind: 'patches', rev: 4, patches: [{ type: 'replace-page', displayList: { page: 2, commands: rows('p2', [0, 1, 2, 3, 4, 5, 6, 7, 8, 9], 220, 40) } }] });
  assert.equal(Math.round(viewer.pagesEl.scrollTop - before), Math.round(120 * scale));
});

test('the page a line moves to is committed with the page it leaves, never after it', () => {
  const viewer = anchoredViewer([pageList(1), pageList(2), pageList(3)]);
  viewer.send({ kind: 'patches', rev: 3, patches: [2, 3].map((n) => ({ type: 'replace-page', displayList: { page: n, commands: rows(`p${n}`, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9], 100, 40) } })) });
  viewer.pagesEl.scrollTop = 820;
  const before = viewer.pagesEl.scrollTop;
  // page 2 now starts with what page 1 had: p2's lines go to page 3, whose
  // pixels are not there yet (a pending exact render)
  viewer.send({ kind: 'patches', rev: 4, patches: [
    { type: 'replace-page', displayList: { page: 2, commands: rows('p1', [0, 1, 2, 3, 4, 5, 6, 7, 8, 9], 100, 40) } },
    { type: 'replace-page', displayList: { page: 3, commands: [...rows('p2', [0, 1, 2, 3, 4, 5, 6, 7, 8, 9], 100, 40), { op: 'pending-exact', src: 'p2' }] } },
  ] });
  assert.equal(viewer.provisionalStages.has(2), true, 'page 2 waits for page 3');
  assert.equal(viewer.pagesEl.scrollTop, before);
  assert.equal(viewer.pageDivs.get(2).provisionalDl.commands[0].src, 'p2', 'and still shows the reader\'s line');
  // page 3 ready: both at once, the paper following the line to page 3
  viewer.send({ kind: 'patches', rev: 5, patches: [{ type: 'replace-page', displayList: { page: 3, commands: rows('p2', [0, 1, 2, 3, 4, 5, 6, 7, 8, 9], 100, 40) } }] });
  assert.equal(viewer.provisionalStages.size, 0);
  assert.equal(viewer.pageDivs.get(2).provisionalDl.commands[0].src, 'p1');
  assert.equal(viewer.pagesEl.scrollTop - before, 820, 'one page down: the same line where it was');
});

test('a Jump on its way, or a handoff the host has not revealed, outranks the reader\'s place', () => {
  const viewer = anchoredViewer([pageList(1), pageList(2), pageList(3)]);
  viewer.send({ kind: 'patches', rev: 3, patches: [{ type: 'replace-page', displayList: { page: 2, commands: rows('p2', [0, 1, 2, 3], 100, 40) } }] });
  viewer.pagesEl.scrollTop = 820;
  vm.runInContext('viewAnchorHolds.jump = () => true', viewer);
  viewer.send({ kind: 'patches', rev: 4, patches: [{ type: 'replace-page', displayList: { page: 2, commands: rows('p2', [0, 1, 2, 3], 300, 40) } }] });
  assert.equal(viewer.pagesEl.scrollTop, 820);
});

test('a canonical generation is committed with the reader\'s line where it was on the old paper', () => {
  const viewer = anchoredViewer([pageList(1), pageList(2), pageList(3)]);
  viewer.activePaperGeometry = () => ({ width: 612, height: 792 });
  // exact pixels on every page (canonical 1, from the harness); the reader at page 2's middle
  viewer.pagesEl.scrollTop = 820;
  // generation 2 puts the line the reader had at page 2's centre on page 3, 100 units down
  const anchor = vm.runInContext('captureViewAnchor()', viewer);
  assert.equal(anchor.kind, 'page');
  const batch = { key: 'g2', id: 2, rev: 2, documentEpoch: 1, pageCount: 3, sealed: true, snapshot: {}, editorStage: {},
    expected: new Map(), viewStageToken: 1,
    viewStage: { anchor: { kind: 'page', page: 2 }, fraction: 0.5, page: 3, top: 90, bottom: 110 } };
  viewer.canonical = { id: 2, rev: 2, pageCount: 3 };
  viewer.appliedSrcRev = 2;
  for (const n of [1, 2, 3]) {
    const page = viewer.pageDivs.get(n);
    const src = `/canonical/${n}.svg?c=2`;
    page.dataset.canonWanted = src;
    batch.expected.set(n, { page, src, apply() { page.dataset.canonPresentedSrc = src; page.dataset.canonPresentedRev = '2'; } });
  }
  viewer.opaqueCanonicalBatches.set(batch.key, batch);
  viewer.tryCommitOpaqueCanonicalBatch(batch);
  // the line's middle (100 units down page 3) now stands where the centre was (400)
  const line = 2 * 820 + 100 * scale - viewer.pagesEl.scrollTop;
  assert.ok(Math.abs(line - 400) < 0.5, String(line));
});

test('a canonical batch waits for the reader\'s place on its pages, and only the batches that ask', () => {
  const viewer = anchoredViewer([pageList(1)]);
  viewer.canonical = { id: 2, rev: 2, pageCount: 1 };
  viewer.appliedSrcRev = 2;
  const page = viewer.pageDivs.get(1);
  const applied = [];
  const batch = { key: 'g2', id: 2, rev: 2, documentEpoch: 1, pageCount: 1, sealed: true, snapshot: {}, editorStage: {},
    expected: new Map([[1, { page, src: '/canonical/1.svg?c=2', apply: () => applied.push(1) }]]), viewStageToken: 1, viewStage: undefined };
  page.dataset.canonWanted = '/canonical/1.svg?c=2';
  viewer.opaqueCanonicalBatches.set(batch.key, batch);
  viewer.tryCommitOpaqueCanonicalBatch(batch);
  assert.deepEqual(applied, [], 'not before its place is found (or given up)');
  batch.viewStage = null;
  viewer.tryCommitOpaqueCanonicalBatch(batch);
  assert.deepEqual(applied, [1]);
});

// Jump: one movement.
const response = (data) => ({ ok: true, json: async () => data });
const box = (top) => ({ left: 60, top, right: 240, bottom: top + 12 });
test('a Jump to a line already well in view does not move the paper', async () => {
  const viewer = jumpViewer({ fetch: async (url) => response(url === '/dom' ? {} : { id: 2, srcRev: 2, documentEpoch: 1, page: 1, boxes: [box(200)] }) });
  viewer.commitCanonical(2, 2);
  const scrolls = [];
  const scrollTo = viewer.pagesEl.scrollTo;
  viewer.pagesEl.scrollTo = (options) => { scrolls.push(options.top); scrollTo.call(viewer.pagesEl, options); };
  viewer.jump({ page: 1, y: 260, blockY: 260, blockHeight: 12, sourceFile: '/paper/main.tex', sourceLine: 5 });
  await viewer.flush();
  await viewer.tick();
  assert.deepEqual(scrolls, [], 'the line stands in the middle of the view already');
  assert.equal(viewer.markers().length, 1, 'it is marked');
  assert.equal(viewer.markers()[0].dataset.exact, 'true');
});

test('a Jump to a line out of view moves the paper once, the host\'s place not first', async () => {
  const viewer = jumpViewer({ pages: 4, fetch: async (url) => response(url === '/dom' ? {} : { id: 2, srcRev: 2, documentEpoch: 1, page: 4, boxes: [box(400)] }) });
  viewer.commitCanonical(4, 2);
  const scrolls = [];
  const scrollTo = viewer.pagesEl.scrollTo;
  viewer.pagesEl.scrollTo = (options) => { scrolls.push(options.top); scrollTo.call(viewer.pagesEl, options); };
  // the last Build's place for the line: 60 units off, on the same page
  viewer.jump({ page: 4, y: 470, blockY: 470, blockHeight: 12, sourceFile: '/paper/main.tex', sourceLine: 5 });
  await viewer.flush();
  await viewer.tick();
  assert.equal(scrolls.length, 1, String(scrolls));
  const page4 = viewer.pageDivs.get(4).getBoundingClientRect();
  assert.ok(Math.abs(page4.top + 406 - 250) < 1, 'the canonical line at the centre');
});

test('a Jump with the engine\'s own place for this revision moves once, asks nothing, and marks once the page shows it', async () => {
  const asked = [];
  const viewer = jumpViewer({ pages: 4, fetch: async (url) => { asked.push(url); return response({}); } });
  viewer.commitCanonical(4, 2);
  const scrolls = [];
  const scrollTo = viewer.pagesEl.scrollTo;
  viewer.pagesEl.scrollTo = (options) => { scrolls.push(options.top); scrollTo.call(viewer.pagesEl, options); };
  viewer.jump({ page: 3, x: 72, y: 400, blockY: 394, blockHeight: 12, sourceFile: '/paper/main.tex', sourceLine: 5,
    liveRevision: { documentEpoch: 1, srcRev: viewer.appliedSrcRev, canonicalId: 2 } });
  await viewer.flush();
  assert.equal(scrolls.length, 1);
  assert.deepEqual(asked, [], 'no refinement');
  assert.equal(viewer.markers().length, 1);
  // another revision's place: approximate, refined as before
  viewer.jump({ page: 2, y: 400, sourceFile: '/paper/main.tex', sourceLine: 5,
    liveRevision: { documentEpoch: 1, srcRev: viewer.appliedSrcRev - 1, canonicalId: 1 } });
  await viewer.flush();
  assert.ok(asked.includes('/dom'));
});

// Direct editing is off: a click on the paper opens no editor, captures no
// key and sends no edit; the test hook turns it on.
function editingListeners(on) {
  const listeners = [];
  const target = (name) => ({ addEventListener: (type) => listeners.push(`${name}:${type}`) });
  const context = { globalThis: null, pagesEl: target('paper'), document: { ...target('document'), createElement: () => ({}), head: { append: () => listeners.push('mathlive') } } };
  context.globalThis = context;
  if (on) context.__tdomDirectEditing = true;
  vm.createContext(context);
  vm.runInContext(span('const directEditingOn = ', '\nlet splitRatio') +
    span("if (directEditingOn()) pagesEl.addEventListener('load'", '\nasync function directProvisionalGeometry') +
    span("if (directEditingOn()) document.addEventListener('selectionchange'", '\nfunction alignOpaqueNativeCaretAnchor') +
    span("if (directEditingOn()) document.addEventListener('keydown'", '\nfunction replayDirectOpeningOperation') +
    span('let directPointer = null;', '\nlet liveSearchRaf'), context);
  return listeners;
}
test('direct editing is off: no editing listener on the paper or the document, no MathLive', () => {
  assert.deepEqual(editingListeners(false), []);
  const on = editingListeners(true);
  for (const listener of ['mathlive', 'paper:pointerdown', 'paper:click', 'paper:pointerup', 'document:keydown', 'document:paste', 'document:selectionchange'])
    assert.ok(on.includes(listener), listener);
  const index = readFileSync(new URL('../web/index.html', import.meta.url), 'utf8');
  assert.doesNotMatch(index, /mathlive/i, 'the page does not load MathLive itself');
  // the paper's other click (Cmd/Ctrl: the source line) and the host's place stay
  assert.match(app, /\npagesEl\.addEventListener\('click', async \(ev\) => \{\n  if \(embeddedHost \? !\(ev\.metaKey \|\| ev\.ctrlKey\)/);
  assert.match(app, /\npagesEl\.addEventListener\('contextmenu'/);
  assert.match(app, /\npagesEl\.addEventListener\('mouseup'/);
});

// The reader scrolled after the canonical's place was found for another
// line: the commit keeps the page and the fraction of it the reader has now,
// measured on the page's new box (here drawn 100 px taller).
test('a staged place for a line the reader has left gives way to the page and fraction at the commit', () => {
  const viewer = anchoredViewer([pageList(1), pageList(2), pageList(3)]);
  viewer.activePaperGeometry = () => ({ width: 612, height: 792 });
  viewer.send({ kind: 'patches', rev: 3, patches: [2, 3].map((n) => ({ type: 'replace-page', displayList: { page: n, commands: rows(`p${n}`, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9], 100, 40) } })) });
  viewer.pagesEl.scrollTop = 820 * 2 - 200; // (page 3's top 200 below the viewport top: the centre 200 down page 3)
  const batch = { key: 'g2', id: 2, rev: 2, documentEpoch: 1, pageCount: 3, sealed: true, snapshot: {}, editorStage: {},
    expected: new Map(), viewStageToken: 1,
    viewStage: { anchor: { kind: 'reading', src: 'p2', line: 4, page: 2 }, fraction: 0.5, page: 2, top: 300, bottom: 320 } };
  viewer.canonical = { id: 2, rev: 2, pageCount: 3 };
  viewer.appliedSrcRev = 2;
  for (const n of [1, 2, 3]) {
    const page = viewer.pageDivs.get(n);
    const src = `/canonical/${n}.svg?c=2`;
    page.dataset.canonWanted = src;
    batch.expected.set(n, { page, src, apply() {
      page.dataset.prov = '0'; // (exact pixels now: no resident line to find)
      page.dataset.canonPresentedSrc = src;
      if (n === 3) {
        const box = page.getBoundingClientRect;
        page.getBoundingClientRect = () => { const r = box(); return { ...r, height: 900, bottom: r.top + 900 }; };
      }
    } });
  }
  viewer.opaqueCanonicalBatches.set(batch.key, batch);
  // (the reader's point: page 3's line 3 at the centre, (y - 200) / 800 of the page down)
  const before = vm.runInContext('captureViewAnchor()', viewer);
  assert.deepEqual([before.src, before.page], ['p3', 3]);
  const fraction = (before.y - 200) / 800;
  viewer.tryCommitOpaqueCanonicalBatch(batch);
  const page3 = viewer.pageDivs.get(3).getBoundingClientRect();
  assert.ok(Math.abs(page3.top + fraction * 900 - before.y) < 0.5, 'the same part of the taller page where it was');
});

// viewportCenter names the source line at the centre, and a handoff naming
// it goes to that line wherever the paper has put it.
function embedViewer() {
  const viewer = jumpViewer({ pages: 3, fetch: async () => ({ ok: false, json: async () => ({}) }) });
  vm.runInContext(ANCHOR, viewer);
  viewer.TdomViewAnchor = viewer.window.TdomViewAnchor; // (the harness's window is not its global, as a browser's is)
  Object.assign(viewer, { geometry: { paperwidth: 600, paperheight: 800 }, outerBeforeEl: { children: [] }, outerAfterEl: { children: [] } });
  vm.runInContext(span('    const syncSheetOf =', '    const paperPageElement =') +
    span('    const viewportCenter =', '    // Every sheet the viewport shows') +
    '\nthis.viewportCenter = viewportCenter;', viewer);
  const snapshot = { srcRev: 2, blocks: [{ id: 'p2', source: { file: '/doc/main.tex', start: { line: 40 }, end: { line: 60 } } }] };
  for (const [n, div] of viewer.pageDivs) {
    div.getBoundingClientRect = () => ({ top: (n - 1) * 820 - viewer.pagesEl.scrollTop, bottom: (n - 1) * 820 + 800 - viewer.pagesEl.scrollTop,
      left: 0, width: 600, height: 800 });
    div.dataset.prov = '1';
    div.provisionalSnapshot = snapshot;
    div.provisionalDl = { page: n, commands: n === 3 ? rows('p2', [0, 1, 2, 3, 4, 5, 6, 7, 8, 9], 100, 40) : rows(`q${n}`, [0, 1, 2], 100, 40) };
    viewer.committedPageSrcs.set(n, new Set([n === 3 ? 'p2' : `q${n}`]));
  }
  viewer.pagesEl.clientHeight = 800;
  return viewer;
}
test('the viewport centre names its source line; a handoff naming it goes to that line', async () => {
  const viewer = embedViewer();
  viewer.pagesEl.scrollTop = 2 * 820 + 220 - 400; // page 3's line 3 (y 220) at the centre
  const center = viewer.viewportCenter();
  assert.equal(center.page, 3);
  assert.deepEqual([center.source.file, center.source.line], ['/doc/main.tex', 43]);
  // a repaginating edit: the reader's page and y now show something else, the line is on page 3 still
  viewer.pagesEl.scrollTop = 0;
  viewer.jump({ page: 1, x: 0, y: 220, blockY: 220, blockHeight: 0, marker: false, viewportToken: 'r:1',
    sourceFile: center.source.file, sourceLine: center.source.line, sourceFraction: center.source.fraction });
  await viewer.flush();
  assert.equal(viewer.embedViewportSheet, viewer.pageDivs.get(3), 'acknowledged on the line\'s page');
  assert.equal(viewer.embedViewportToken, 'r:1');
  assert.ok(Math.abs(viewer.pageDivs.get(3).getBoundingClientRect().top + viewer.embedViewportPointY - 400) < 1, 'the line at the centre');
});

test('the host\'s fit width is this paper\'s zoom 1, taken without moving a Jump or a handoff', () => {
  const calls = [];
  const style = new Map();
  const context = {
    pagesEl: { clientHeight: 0, clientWidth: 900, style: { setProperty: (k, v) => style.set(k, v) } },
    document: { getElementById: () => ({ textContent: '' }) }, localStorage: { setItem() {} },
    dismissSyncMarker: () => calls.push('dismiss'), directEditor: null, noteResizeAnchor() {},
    findZoomAnchorPage: () => null, zoom: 1,
  };
  vm.createContext(context);
  vm.runInContext(span('function setZoom(', '\n// The paper point at the viewport centre, noted') + '\nthis.setZoom = setZoom;', context);
  context.setZoom(1, null, { fitPx: 860, quiet: true });
  assert.equal(style.get('--fit-width'), '860px');
  assert.equal(style.get('--zoom'), 1);
  context.setZoom(1012 / 860, null, { fitPx: 860, quiet: true });
  assert.equal(style.get('--zoom'), 1012 / 860, 'not rounded: the width is what is carried');
  assert.deepEqual(calls, [], 'no Jump or handoff called off');
  context.setZoom(1.1);
  assert.deepEqual(calls, ['dismiss'], 'the reader\'s own zoom still is one');
});

// The engine serves the viewer's own files from an allowlist (server.js): a
// script the page loads but the list leaves out answers 404 in the app, and
// whatever it holds silently does nothing there (view-anchor.js did, while
// every test that loads files itself passed).
test('every file web/index.html loads from the engine is on the engine\'s static allowlist', () => {
  const index = readFileSync(new URL('../web/index.html', import.meta.url), 'utf8');
  const server = readFileSync(new URL('../server.js', import.meta.url), 'utf8');
  const own = [...index.matchAll(/(?:src|href)="(\/[^"]+)"/g)].map((m) => m[1]).filter((file) => !file.startsWith('/host/'));
  assert.ok(own.includes('/view-anchor.js') && own.includes('/app.js'));
  for (const file of own) assert.ok(server.includes(`url.pathname === '${file}'`), `${file} is served`);
});

// A source line set across a page break (one long source line for a whole
// paragraph) has ink on two pages; the canonical's place for it is one of
// its pieces. Seen in the app: a Jump centred the line, the canonical commit
// moved the paper 455 px to the other piece, the Jump moved it back.
test('a line with ink on two pages keeps its page and fraction across a canonical commit, not its place elsewhere', () => {
  const viewer = anchoredViewer([pageList(1), pageList(2), pageList(3)]);
  viewer.activePaperGeometry = () => ({ width: 612, height: 792 });
  // the paragraph's line 0: the foot of page 2 and the head of page 3
  viewer.send({ kind: 'patches', rev: 3, patches: [
    { type: 'replace-page', displayList: { page: 2, commands: [...rows('a', [0, 1, 2], 100, 40), ...rows('p', [0, 0, 0, 0], 380, 14)] } },
    { type: 'replace-page', displayList: { page: 3, commands: [...rows('p', [0, 0, 0], 72, 14), ...rows('b', [0, 1], 200, 40)] } },
  ] });
  viewer.pagesEl.scrollTop = 820 + 400 - 400; // page 2's middle at the centre: the paragraph's piece there
  const before = vm.runInContext('captureViewAnchor()', viewer);
  assert.deepEqual([before.src, before.line, before.page], ['p', 0, 2]);
  const batch = { key: 'g2', id: 2, rev: 2, documentEpoch: 1, pageCount: 3, sealed: true, snapshot: {}, editorStage: {},
    expected: new Map(), viewStageToken: 1,
    viewStage: { anchor: { kind: 'reading', src: 'p', line: 0, page: 2 }, fraction: before.fraction, page: 3, top: 60, bottom: 110 } };
  viewer.canonical = { id: 2, rev: 2, pageCount: 3 };
  viewer.appliedSrcRev = 2;
  for (const n of [1, 2, 3]) {
    const page = viewer.pageDivs.get(n);
    const src = `/canonical/${n}.svg?c=2`;
    page.dataset.canonWanted = src;
    batch.expected.set(n, { page, src, apply() { page.dataset.prov = '0'; page.dataset.canonPresentedSrc = src; } });
  }
  viewer.opaqueCanonicalBatches.set(batch.key, batch);
  const scroll = viewer.pagesEl.scrollTop;
  viewer.tryCommitOpaqueCanonicalBatch(batch);
  assert.equal(viewer.pagesEl.scrollTop, scroll, 'the paper stays: the same part of page 2');
});

// The reader mostly reads exact pixels. The resident list of the same source
// under them names the row at the centre; without it the place was a page and
// a fraction, and an edit two pages above moved the text under the reader by
// a line (app measurement: scrollTop 7770 → 7771, the text 24 px lower).
test('a place read under exact pixels follows its row when the page\'s new list replaces them', () => {
  const viewer = anchoredViewer([pageList(1), pageList(2), pageList(3)]);
  viewer.send({ kind: 'patches', rev: 3, patches: [2, 3].map((n) => ({ type: 'replace-page', displayList: { page: n, commands: rows(`p${n}`, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9], 100, 40) } })) });
  // pages 2 and 3 show the canonical of that same source
  const final = new Map([[2, true], [3, true]]);
  for (const n of [2, 3]) {
    const div = viewer.pageDivs.get(n);
    // (a canonical of a later source than the list's own revision, the page's
    // list no edit changed since: updateCanonState took the list on paper when
    // it put the pixels up; by the commit, the page's next list is staged)
    div.dataset.canonPresentedRev = String(Number(div.dataset.provRev) + 3);
    div.exactListDl = div.provisionalDl;
    div.classList = { contains: (name) => name === 'is-final' && final.get(n) === true, remove() {} };
  }
  // (a dirty page leaves its exact pixels for its new list: updateCanonState)
  viewer.updateCanonState = (n) => final.set(n, false);
  viewer.pagesEl.scrollTop = 820;
  const before = vm.runInContext('captureViewAnchor()', viewer);
  assert.notEqual(before.kind, 'page', 'a row, not only a page');
  viewer.send({ kind: 'patches', rev: 4, patches: [{ type: 'replace-page', displayList: { page: 2, commands: rows('p2', [0, 1, 2, 3, 4, 5, 6, 7, 8, 9], 124, 40) } }] });
  assert.equal(Math.round(viewer.pagesEl.scrollTop - 820), Math.round(24 * scale), 'one line down: so is the paper');
});

test('a live anchor is absent while the reader is on Build paper on either side of a chapter', () => {
  const viewer = anchoredViewer([pageList(1), pageList(2)]);
  viewer.send({ kind: 'patches', rev: 3, patches: [1, 2].map(page => ({
    type: 'replace-page', displayList: pageList(page, rows('chapter', [0], 120)),
  })) });
  for (const [page, div] of viewer.pageDivs) {
    div.getBoundingClientRect = () => {
      const top = 6345 + (page - 1) * 820 - viewer.pagesEl.scrollTop;
      return { top, bottom: top + 800, height: 800, width: 600 };
    };
  }
  for (const top of [1273, 9000]) {
    viewer.pagesEl.scrollTop = top;
    assert.equal(vm.runInContext('captureViewAnchor()', viewer), null);
  }
});

for (const destination of ['unpublished', 'blocked']) {
  test(`a deleted reading line releases a ready page at its deadline with a ${destination} destination`, () => {
    const viewer = anchoredViewer([pageList(1), pageList(2)]);
    const reading = { ...rows('old', [1], 400)[0], text: 'The deleted reading paragraph' };
    const next = { ...rows('next', [0], 430)[0], text: 'The paragraph after the reading line' };
    const patch = (page, commands) => ({ type: 'replace-page', displayList: pageList(page, commands) });
    viewer.send({ kind: 'patches', rev: 3, patches: [patch(1, [reading, next])] });
    let now = 0;
    const timers = [];
    Object.assign(viewer, {
      performance: { now: () => now },
      setTimeout: (fn, ms) => timers.push({ fn, at: now + ms }),
      clearTimeout() {},
    });
    const replacement = { ...next, y: 450 };
    const report = (rev, ink, other = []) => viewer.send({ kind: 'update', report: {
      rev, srcRev: rev, stats: { pageCount: 2 }, patches: [patch(1, [ink]), ...other],
    } });
    report(4, next, destination === 'blocked' ? [patch(2, [reading, { op: 'pending-exact', src: 'b2' }])] : []);
    now = 900;
    report(5, replacement);
    assert.equal(viewer.pageDivs.get(1).provisionalDl.commands[0], reading);
    now = 1100;
    for (const { fn, at } of [...timers]) if (at <= now) fn();
    assert.equal(viewer.pageDivs.get(1).provisionalDl.commands[0], replacement);
    assert.ok(Math.abs(viewer.pagesEl.scrollTop - 20 * scale) <= 1, 'the surviving neighbour stays in place');
  });
}

test('a source report during Jump lookup preserves the first movement deadline', async () => {
  const viewer = jumpViewer({ pages: 4, events: true, fetch: () => new Promise(() => {}) });
  let fallback;
  const setTimer = viewer.setTimeout;
  viewer.setTimeout = (fn, ms) => {
    if (ms === 1200) fallback = fn;
    return setTimer(fn, ms);
  };
  viewer.jump({ page: 3, y: 400, sourceFile: '/paper/main.tex', sourceLine: 5 });
  assert.equal(viewer.pagesEl.scrollTop, 0);
  viewer.receivePreviewEvent({ kind: 'update', documentEpoch: 1,
    report: { rev: 3, srcRev: 3, stats: { pageCount: 4 }, patches: [] } });
  fallback();
  assert.ok(viewer.pagesEl.scrollTop > 2 * 820, 'the original host point is used');
  assert.equal(viewer.markers()[0]?.dataset.exact, 'false');
});

test('a Jump during opening shows the host point and refines to the exact sheet', async () => {
  let answer;
  const viewer = jumpViewer({ pages: 4, events: true, fetch: async url => url === '/dom' ? response({}) :
    new Promise(resolve => { answer = resolve; }) });
  viewer.openingPreview = true;
  viewer.canonical = { id: 2, rev: 2, pageCount: 4 };
  let fallback;
  const setTimer = viewer.setTimeout;
  viewer.setTimeout = (fn, ms) => {
    if (ms === 1200) fallback = fn;
    return setTimer(fn, ms);
  };
  viewer.jump({ page: 4, y: 200, sourceFile: '/paper/main.tex', sourceLine: 403 });
  await viewer.flush();
  fallback();
  assert.ok(viewer.pagesEl.scrollTop > 2 * 820, 'the opening Jump moves to the host position');
  assert.equal(viewer.markers()[0]?.parent, viewer.pageDivs.get(4));
  assert.equal(viewer.markers()[0]?.dataset.exact, 'false');

  viewer.receivePreviewEvent({ kind: 'opening-settled', documentEpoch: 1 });
  assert.equal(viewer.openingPreview, false);
  viewer.commitCanonical(4, 2);
  answer(response({ id: 2, srcRev: 2, documentEpoch: 1, page: 3, boxes: [box(200)] }));
  await viewer.tick();
  assert.equal(viewer.markers()[0]?.parent, viewer.pageDivs.get(3));
  assert.equal(viewer.markers()[0]?.dataset.exact, 'true');
});

for (const { name, exactPage, exactTop, live, moves } of [
  { name: 'one line away', exactPage: 3, exactTop: 400, moves: 1 },
  { name: 'several lines away in the comfortable view', exactPage: 3, exactTop: 470, moves: 2 },
  { name: 'on another page', exactPage: 4, exactTop: 400, moves: 2 },
  { name: 'known for the live revision but still decoding', exactPage: 3, exactTop: 400, live: true, moves: 1 },
]) {
  test(`a Jump lands by 1.2 s and refines an exact answer ${name}`, async () => {
    let answer;
    const viewer = jumpViewer({ pages: 4, fetch: async url => url === '/dom' ? response({}) :
      new Promise(resolve => { answer = resolve; }) });
    if (!live) viewer.commitCanonical(4, 2);
    const deadlines = [];
    const setTimer = viewer.setTimeout;
    viewer.setTimeout = (fn, ms) => {
      if (ms !== 250) deadlines.push({ ms, fn });
      return setTimer(fn, ms);
    };
    const scrolls = [];
    const scrollTo = viewer.pagesEl.scrollTo;
    viewer.pagesEl.scrollTo = options => { scrolls.push(options.top); scrollTo.call(viewer.pagesEl, options); };
    viewer.jump({ page: 3, x: 72, y: 400, sourceFile: '/paper/main.tex', sourceLine: 5,
      ...(live && { liveRevision: { documentEpoch: 1, srcRev: 2, canonicalId: 2 } }),
    });
    await viewer.flush();
    assert.equal(scrolls.length, 0);
    const deadline = deadlines.find(timer => timer.ms === 1200);
    assert.ok(deadline, 'fallback is armed when the Jump is accepted');
    deadline.fn();
    assert.deepEqual(scrolls, [2 * 820 + 400 - 250]);
    assert.equal(viewer.markers()[0]?.dataset.exact, 'false');

    if (live) viewer.commitCanonical(4, 2);
    else answer(response({ id: 2, srcRev: 2, documentEpoch: 1, page: exactPage, boxes: [box(exactTop)] }));
    await viewer.tick();
    assert.equal(scrolls.length, moves, String(scrolls));
    assert.equal(viewer.markers()[0]?.dataset.exact, 'true');
    assert.equal(viewer.markers()[0]?.parent, viewer.pageDivs.get(exactPage));
  });
}

test('fit width preserves the reader baseline offset from the viewport centre', () => {
  const viewer = anchoredViewer([pageList(1)]);
  const ink = { ...rows('b1', [0], 416)[0], text: 'A distinguishable reading line' };
  viewer.send({ kind: 'patches', rev: 3, patches: [{ type: 'replace-page', displayList: pageList(1, [ink]) }] });
  viewer.geometry.paperheight = 800;
  viewer.pagesEl.clientWidth = 900;
  viewer.pagesEl.scrollLeft = 0;
  let height = 800;
  const page = viewer.pageDivs.get(1);
  page.getBoundingClientRect = () => ({ left: 0, top: -viewer.pagesEl.scrollTop,
    bottom: height - viewer.pagesEl.scrollTop, width: 600 * height / 800, height });
  viewer.pagesEl.style = { setProperty(key, value) { if (key === '--zoom') height = 800 * value; } };
  Object.assign(viewer, {
    document: { getElementById: () => ({}) }, localStorage: { setItem() {} },
    findZoomAnchorPage: () => page, noteResizeAnchor() {}, zoom: 1,
  });
  vm.runInContext(readFileSync(new URL('../web/viewport-math.js', import.meta.url), 'utf8'), viewer);
  vm.runInContext(span('function setZoom(', '\n// The paper point at the viewport centre, noted'), viewer);
  const baseline = () => page.getBoundingClientRect().top + ink.y * height / 800;
  const before = baseline();
  viewer.setZoom(0.58, null, { fitPx: 600, quiet: true });
  assert.ok(Math.abs(baseline() - before) <= 0.5, `baseline moved from ${before} to ${baseline()}`);
});

test('an anchor-only exact destination that never decodes cannot hold the visible generation', () => {
  const viewer = anchoredViewer([pageList(1), pageList(2), pageList(3)]);
  const ink = { ...rows('b1', [0], 400)[0], text: 'The line that repaginates' };
  viewer.send({ kind: 'patches', rev: 3, patches: [{ type: 'replace-page', displayList: pageList(1, [ink]) }] });
  const anchor = vm.runInContext('captureViewAnchor()', viewer);
  const pages = [1, 3].map(n => viewer.pageDivs.get(n));
  const src = n => `/canonical/${n}.svg?c=3`;
  const applied = [];
  viewer.canonical = { id: 3, rev: 2, pageCount: 3 };
  pages[0].dataset.canonWanted = src(1);
  const batch = { key: 'g3', id: 3, rev: 2, documentEpoch: 1, pageCount: 3, sealed: true, snapshot: {}, editorStage: {},
    expected: new Map([[1, { page: pages[0], src: src(1), apply: () => applied.push(1) }]]),
    viewStageDeadline: 800, viewStage: { anchor, page: 3, top: 300, bottom: 310 } };
  viewer.pageDirtyRev.clear();
  viewer.opaqueCanonicalBatches.set(batch.key, batch);
  let now = 0;
  const timers = [];
  Object.assign(viewer, {
    performance: { now: () => now }, setTimeout: (fn, ms) => timers.push({ fn, ms }), clearTimeout() {},
    updateCanonState(n) {
      if (n !== 3 || pages[1].dataset.canonStage !== src(3)) return;
      pages[1].dataset.canonWanted = src(3);
      pages[1].dataset.canonPending = src(3);
      batch.expected.set(n, { page: pages[1], src: src(3), apply: null });
    },
  });
  viewer.tryCommitOpaqueCanonicalBatch(batch);
  assert.deepEqual(applied, []);
  now = 800;
  for (const { fn, ms } of [...timers]) if (ms <= now) fn();
  assert.deepEqual(applied, [1]);
  assert.equal(viewer.pagesEl.scrollTop, 0);
});

test('a newer canonical batch keeps the lookup deadline for the same reading line', async () => {
  const viewer = anchoredViewer([pageList(1), pageList(2)]);
  const ink = { ...rows('reading', [0], 400)[0], text: 'The line waits for its canonical destination' };
  viewer.send({ kind: 'patches', rev: 3, patches: [{ type: 'replace-page', displayList: pageList(1, [ink]) }] });
  let now = 0;
  const timers = [];
  Object.assign(viewer, {
    performance: { now: () => now }, setTimeout: (fn, ms) => timers.push({ fn, at: now + ms }),
    fetch() {}, ensurePresentedDomSnapshot: async () => ({}),
    stageDirectEditorForOpaqueBatch: async () => null,
    viewAnchorCanonicalPlace: () => new Promise(() => {}),
  });
  vm.runInContext(span('function opaqueCanonicalBatchKey', 'function directRevisitTokens') +
    span('function getOpaqueCanonicalBatch', 'const postJson'), viewer);

  const page = viewer.pageDivs.get(1);
  const applied = [];
  const generation = (rev) => {
    viewer.send({ kind: 'update', report: { rev: rev + 2, srcRev: rev, stats: { pageCount: 2 }, patches: [] } });
    viewer.canonical = { id: rev, rev, pageCount: 2 };
    const batch = viewer.getOpaqueCanonicalBatch(viewer.canonical);
    const src = `/canonical/1.svg?c=${rev}`;
    page.dataset.canonWanted = src;
    batch.expected.set(1, { page, src, apply() { applied.push(rev); } });
  };
  generation(2);
  now = 600;
  generation(3);
  assert.deepEqual(applied, []);
  now = 800;
  for (const { fn, at } of timers) if (at <= now) fn();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(applied, [3]);
});

test('a quoted handoff falls back to its sheet when the text lookup stalls', () => {
  const viewer = embedViewer();
  viewer.commitCanonical(3, 2);
  viewer.canonicalGlyphs = () => new Promise(() => {});
  const timers = [];
  viewer.setTimeout = (fn, ms) => timers.push({ fn, ms });
  viewer.clearTimeout = () => {};
  const handoff = { page: 3, y: 400, marker: false, viewportToken: 'stalled-text',
    sourceAnchor: { text: 'The reader line before reset' } };
  viewer.jump(handoff);
  assert.equal(viewer.embedViewportToken, null, 'the text lookup gets its chance');
  viewer.commitCanonical(3, 3);
  viewer.appliedSrcRev = 3;
  viewer.jump(handoff);
  assert.equal(timers.filter(timer => timer.ms === 8000).length, 1, 'the same token keeps its lookup deadline');
  for (const { fn, ms } of [...timers]) if (ms <= 8000) fn();
  assert.equal(viewer.embedViewportToken, 'stalled-text');
  assert.equal(viewer.embedViewportSheet, viewer.pageDivs.get(3));
});

test('repeating a handoff token does not extend the hold on the reading anchor', () => {
  const viewer = embedViewer();
  let now = 0;
  viewer.performance = { now: () => now };
  const handoff = { page: 3, y: 400, marker: false, viewportToken: 'same-handoff' };
  viewer.jump(handoff);
  now = 9000;
  viewer.jump(handoff);
  now = 10000;
  assert.equal(vm.runInContext('viewAnchorHolds.handoff()', viewer), false);
});

test('a manual scroll within the same source row invalidates its staged canonical destination', () => {
  const viewer = anchoredViewer([pageList(1), pageList(2)]);
  viewer.activePaperGeometry = () => ({ width: 612, height: 792 });
  const wrap = rows('b1', [0, 0, 0], 350, 40).map((cmd, i) => ({ ...cmd, text: `Reading line fragment ${i}` }));
  viewer.send({ kind: 'patches', rev: 3, patches: [{ type: 'replace-page', displayList: pageList(1, wrap) }] });
  const staged = viewer.captureViewAnchor();
  viewer.pagesEl.scrollTop = 20;
  const current = viewer.captureViewAnchor();
  assert.deepEqual([current.page, current.src, current.line], [staged.page, staged.src, staged.line]);
  viewer.restoreCanonicalViewAnchor(current, { anchor: staged, page: 2, baseline: 300, top: 293, bottom: 302 });
  assert.equal(viewer.pagesEl.scrollTop, 20);
});

test('a late Jump draws its exact marker without recentering a line that repagination already kept in place', async () => {
  let answer;
  const viewer = jumpViewer({ pages: 4, fetch: async url => url === '/dom' ? response({}) :
    new Promise(resolve => { answer = resolve; }) });
  viewer.commitCanonical(4, 2);
  let fallback;
  const setTimer = viewer.setTimeout;
  viewer.setTimeout = (fn, ms) => {
    if (ms === 1200) fallback = fn;
    return setTimer(fn, ms);
  };
  const scrolls = [];
  const scrollTo = viewer.pagesEl.scrollTo;
  viewer.pagesEl.scrollTo = options => { scrolls.push(options.top); scrollTo.call(viewer.pagesEl, options); };
  viewer.jump({ page: 3, x: 72, y: 400, sourceFile: '/paper/main.tex', sourceLine: 5 });
  await viewer.flush();
  fallback();
  assert.equal(scrolls.length, 1);

  // The same line moved to page 4 and the reading restore followed it.
  viewer.pagesEl.scrollTop += 820;
  vm.runInContext('viewAnchorHolds.scrolled()', viewer);
  answer(response({ id: 2, srcRev: 2, documentEpoch: 1, page: 4, boxes: [box(400)] }));
  await viewer.tick();
  assert.equal(scrolls.length, 1, 'the exact line is still within one line of the first landing');
  assert.equal(viewer.markers()[0]?.dataset.exact, 'true');
  assert.equal(viewer.markers()[0]?.parent, viewer.pageDivs.get(4));
});
