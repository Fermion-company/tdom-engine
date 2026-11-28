// A page whose new list owes an exact picture keeps what it shows until the
// picture comes (web/app.js renderPage). Two things it may show meanwhile:
// - not another page's paper: the boot's first layout puts other pages'
//   blocks in a page's place for a while, and the booklet's page 26 kept the
//   last of them (page 14) while it owed a Data box the boot never rendered
//   (tex64-internal #121, round 10). Such paper goes; the page waits for its
//   canonical page as a shell does, its box kept.
// - the canonical page, while that page still shows the list: a keystroke
//   elsewhere stages the page again under the new source revision, and that
//   no longer takes the right paper away (canonicalShowsList).
// The viewer's own renderPage and updateCanonState run here; only the DOM and
// the image loads are faked.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import { provisionalViewer, pageList } from './helpers/provisional-viewer.js';

const app = readFileSync(new URL('../web/app.js', import.meta.url), 'utf8');
const span = (start, end) => app.slice(app.indexOf(start), app.indexOf(end, app.indexOf(start) + start.length));
const STAGING = span('const listOwesExactInk', '// The text of a line whose exact picture is shown only where it has to be');
const CANON_STATE = span('function updateCanonState', 'function updateBadge');

function fakePage(n) {
  const classes = new Set(['page']);
  const page = {
    dataset: { page: String(n) }, style: { aspectRatio: '600 / 800' }, isConnected: true, children: [],
    classList: {
      add: (name) => classes.add(name),
      remove: (...names) => names.forEach((name) => classes.delete(name)),
      contains: (name) => classes.has(name),
      toggle: (name, on = !classes.has(name)) => { if (on) classes.add(name); else classes.delete(name); return on; },
    },
    querySelector(selector) {
      if (selector.startsWith(':scope > svg')) return page.children.find((c) => c.kind === 'svg') ?? null;
      if (selector === 'img.canon') return page.children.find((c) => c.kind === 'canon') ?? null;
      return null;
    },
    querySelectorAll: (selector) => selector === ':scope > .chunkwin' ? page.children.filter((c) => c.kind === 'chunkwin') : [],
    getBoundingClientRect: () => ({ top: (n - 1) * 820, bottom: (n - 1) * 820 + 800, left: 0, width: 600, height: 800 }),
    append(child) { page.children.push(child); },
    add(kind, extra = {}) {
      const child = { kind, dataset: {}, style: {}, ...extra, remove() { page.children = page.children.filter((c) => c !== child); } };
      page.children.push(child);
      return child;
    },
    classes: () => [...classes].sort(),
  };
  return page;
}

// committed paper: what tryCommitProvisionalStages leaves on a page
function paint(page, dl, rev) {
  page.add('svg');
  for (const cmd of dl.commands) if (cmd.op === 'chunk') page.add('chunkwin', { dataset: { src: cmd.src } });
  page.provisionalDl = dl;
  page.dataset.prov = '1';
  page.dataset.provRev = String(rev);
}

function viewerOf(pageCount) {
  const viewer = provisionalViewer([], 0);
  const traced = [];
  Object.assign(viewer, {
    geometry: { paperwidth: 600, paperheight: 800 }, mode: 'structured', embeddedHost: false, directEditor: null,
    traceStage: (ev, page) => traced.push(`${ev}:${page}`), traced,
    canonicalAnchorForPage: () => null, shippingPresentationBlocked: () => false,
    emptyStructuredCanonicalFallback: () => false,
    retainCanonicalFallbackMarker: ({ newlyEligible, previouslyMarked, final, freshTargetPresented }) =>
      newlyEligible || previouslyMarked && final && !freshTargetPresented,
    requestAnimationFrame: (run) => run(), refreshDirectEditGeometry() {},
    document: { createElement() { return {
      dataset: {}, style: { setProperty() {} }, classList: { toggle() {} }, insertAdjacentHTML() {},
      querySelectorAll: () => [], remove() {},
    }; } },
    svgParts: () => [],
    injectFonts() {}, readyFonts: new Set(), fontLoads: new Map(),
    escapeXml: String, chunkShowClip: () => '', chunkImageSrc: cmd => cmd.chunk,
    // (the hit maps of the canonical generations read while they were current: ensurePresentedDomSnapshot)
    presentedDomSnapshots: new Map(), presentedSnapshotKey: (id, rev) => `1:${Number(id)}:${Number(rev)}`,
    // the canonical page's picture is on the page at once
    queueCanonicalImageSwap(page, src, paper, generation) {
      const img = page.querySelector('img.canon') ?? page.add('canon');
      img.dataset.src = src;
      page.dataset.canonPresentedSrc = src;
      if (generation?.id != null) page.dataset.canonPresentedId = String(generation.id);
      if (generation?.rev != null) page.dataset.canonPresentedRev = String(generation.rev);
      page.classList.remove('awaiting-canonical');
      return img;
    },
  });
  viewer.pageDivs.clear();
  for (let n = 1; n <= pageCount; n++) viewer.pageDivs.set(n, fakePage(n));
  vm.runInContext(`${STAGING}\n${CANON_STATE}\nthis.renderPage = renderPage; this.updateCanonState = updateCanonState; this.noteListContent = noteListContent;`, viewer);
  viewer.canonicalAt = (rev) => { viewer.canonical = { id: rev, rev, pageCount }; };
  return viewer;
}

const owing = (page, blocks, extra = []) => pageList(page, [
  { op: 'sourcebox', src: blocks[0], x: 72, y: 100, w: 400, h: 60 },
  { op: 'chunk', src: blocks[0], chunk: blocks[0], x: 72, y: 100, w: 400, h: 60, sy: 0, cv: 1 },
  { op: 'pending-exact', src: blocks[1], x: 72, y: 180, w: 400, h: 40 },
  { op: 'glyphs', src: blocks[2], x: 72, y: 260, w: 200, text: `${blocks[2]} text`, fam: 'f1', size: 10 },
  ...extra,
]);
const bands = (page) => [
  { op: 'chunk', src: '_hf', chunk: `__hf-${page}-h`, x: 0, y: 0, w: 600, h: 90, sy: 0, cv: 1 },
  { op: 'chunk', src: '_hf', chunk: `__hf-${page}-f`, x: 0, y: 760, w: 600, h: 40, sy: 0, cv: 1 },
];
const folio = (page) => ({ op: 'folio', x: 300, y: 780, text: String(page) });

test('a page that owes a picture and shows another page\'s blocks loses that paper and waits for its canonical page; its own older paper stays', () => {
  const viewer = viewerOf(3);
  viewer.appliedSrcRev = 2;
  const p2 = viewer.pageDivs.get(2), p3 = viewer.pageDivs.get(3);
  // page 2 shows what the boot's first layout had there: another lesson's two-column page
  paint(p2, pageList(2, [{ op: 'chunk', src: 'b69', chunk: 'b69@p1', x: 72, y: 80, w: 450, h: 600, sy: 700, cv: 1 }]), 2);
  // page 3 shows an older version of its own list
  paint(p3, owing(3, ['b30', 'b31', 'b32']), 2);
  viewer.renderPage(owing(2, ['b109', 'b110', 'b111']));
  viewer.renderPage(owing(3, ['b30', 'b33', 'b32']));
  assert.deepEqual(p2.children.filter((c) => c.kind !== 'canon'), [], 'no svg and no chunk window of page 14 left on page 2');
  assert.equal(p2.provisionalDl, null);
  assert.ok(p2.classes().includes('awaiting-canonical'), 'page 2 waits for its canonical page, hidden');
  assert.equal(p2.style.aspectRatio, '600 / 800', 'its box keeps the paper\'s size');
  assert.equal(p2.dataset.provPending, '1', 'the list it owes is still staged');
  assert.ok(viewer.traced.includes('dropped:2'));
  assert.equal(p3.children.length, 2, 'page 3 keeps its older paper');
  assert.ok(!p3.classes().includes('awaiting-canonical'));
  assert.ok(!viewer.traced.includes('dropped:3'));
  // no canonical yet: nothing shows on page 2
  viewer.updateCanonState(2);
  assert.ok(!p2.classes().includes('is-final'));
  // the boot's canonical lands: page 2 shows it
  viewer.canonicalAt(2);
  viewer.updateCanonState(2);
  assert.ok(p2.classes().includes('is-final'));
  assert.ok(!p2.classes().includes('awaiting-canonical'));
});

const foot = (text) => ({ op: 'glyphs', src: '_hf', x: 300, y: 780, w: 20, text, fam: 'f1', size: 9 });

test('a keystroke elsewhere stages an owing page again: the canonical page that still shows its list stays on it', () => {
  const viewer = viewerOf(5);
  viewer.appliedSrcRev = 2;
  const pages = [1, 2, 3, 4, 5].map((n) => viewer.pageDivs.get(n));
  for (const page of pages) paint(page, pageList(Number(page.dataset.page)), 1);
  // boot: pages 2 and 3 owe a picture and draw a provisional folio; page 4 the header job's foot already;
  // page 5 a provisional folio
  const opening = owing(2, ['b1', 'b2', 'b3'], [folio(2)]);
  viewer.renderPage(opening);
  viewer.renderPage(owing(3, ['b4', 'b5', 'b6'], [folio(3)]));
  viewer.renderPage(owing(4, ['b7', 'b8', 'b9'], [foot('— 4 —')]));
  viewer.renderPage(owing(5, ['b10', 'b11', 'b12'], [folio(5)]));
  viewer.canonicalAt(2);
  // keystrokes on page 1 (revisions 3 to 5); the canonical page's bands come to pages 2 and 3; page 4's foot
  // changes (another folio style); page 5 gets its first foot from the header job
  viewer.appliedSrcRev = 3;
  viewer.renderPage(owing(2, ['b1', 'b2', 'b3'], bands(2).map(cmd => ({ ...cmd, hfGeneration: 2 }))));
  // page 3: revision 3 is also an edit of one of its blocks (the edit group stageProvisionalPatches gives it)
  viewer.pageEditGroup.set(3, viewer.editGroupSeq = 1);
  viewer.renderPage(owing(3, ['b4', 'b5', 'b6'], bands(3)));
  viewer.renderPage(owing(4, ['b7', 'b8', 'b9'], [foot('iv')]));
  viewer.renderPage(owing(5, ['b10', 'b11', 'b12'], [foot('— 5 —')]));
  // (the pages carried to the next revisions: stageProvisionalPatches stages their lists again)
  viewer.appliedSrcRev = 5;
  for (const n of [2, 3, 4, 5]) viewer.renderPage(viewer.provisionalStages.get(n).dl);
  for (const n of [2, 3, 4, 5]) {
    assert.equal(viewer.pageDirtyRev.get(n), 5);
    viewer.updateCanonState(n);
  }
  assert.ok(pages[1].classes().includes('is-final'), 'page 2: the revision-2 canonical page still shows its list');
  assert.equal(pages[1].dataset.canonFallback, '1', 'it is not this source\'s pixels: the embed readiness contract is told');
  assert.equal(pages[1].exactListDl, opening, 'the reader\'s place reads the displayed generation\'s list');
  assert.equal(pages[1].querySelector('img.canon').style.clipPath, '', 'late bands certified by the displayed PDF leave it intact');
  assert.ok(!pages[2].classes().includes('is-final'), 'page 3: a block of it was edited since');
  // page 4: its foot changed and is not the canonical page's band: the body stays, the old head and foot do not
  assert.ok(pages[3].classes().includes('is-final'), 'page 4: the canonical page still shows its body');
  assert.notEqual(pages[3].querySelector('img.canon').style.clipPath, '', 'page 4: not the canonical page\'s foot');
  assert.ok(pages[4].classes().includes('is-final'), 'page 5: the first foot after the provisional folio is no change');
  // a page whose list changed (a line moved) since the canonical page is not shown that page
  const moved = owing(2, ['b1', 'b2', 'b3'], bands(2));
  moved.commands[3].y = 270;
  const fresh = viewerOf(2);
  fresh.appliedSrcRev = 2;
  paint(fresh.pageDivs.get(2), pageList(2), 1);
  fresh.renderPage(owing(2, ['b1', 'b2', 'b3'], bands(2)));
  fresh.canonicalAt(2);
  fresh.appliedSrcRev = 6;
  fresh.renderPage(moved);
  fresh.updateCanonState(2);
  assert.ok(!fresh.pageDivs.get(2).classes().includes('is-final'), 'a list that changed since the canonical is not shown by it');
});

test('a blocked page retires its previous exact image when all its body blocks move', () => {
  const viewer = viewerOf(2);
  const page = viewer.pageDivs.get(2);
  const old = owing(2, ['old1', 'old2', 'old3'], [folio(2)]);
  viewer.appliedSrcRev = 2;
  paint(page, old, 2);
  viewer.renderPage(old);
  viewer.canonicalAt(2);
  viewer.updateCanonState(2);
  assert.ok(page.classes().includes('is-final'));

  viewer.appliedSrcRev = 6;
  viewer.renderPage(owing(2, ['new1', 'new2', 'new3'], [folio(2)]));
  viewer.updateCanonState(2);
  assert.equal(page.querySelector('img.canon'), null, 'the earlier exact image is retired');
  assert.ok(!page.classes().includes('is-final'));
  assert.equal(page.dataset.canonPresentedSrc, undefined);
  assert.equal(page.dataset.canonFallback, undefined);
  assert.ok(page.classes().includes('awaiting-canonical'));
  assert.equal(page.style.aspectRatio, '600 / 800');
  viewer.canonicalAt(6);
  viewer.updateCanonState(2);
  assert.equal(page.dataset.canonPresentedSrc, '/canonical/2.svg?c=6');
  assert.ok(page.classes().includes('is-final'));
});

const fragment = (sy) => ({
  op: 'chunk', src: 'b1', chunk: 'b1@p1', x: 72, y: 100, w: 400, h: 600, sy, ch: 600, cv: 1,
});
const fragmentPage = (sy) => pageList(2, [
  { op: 'sourcebox', src: 'b1', x: 72, y: 100, w: 400, h: 600 },
  fragment(sy),
  { op: 'pending-exact', src: 'b2', x: 72, y: 705, w: 200, h: 20 },
]);

test('only ink can corroborate a disjoint crop on the same sheet', () => {
  for (const hidden of [
    { op: 'sourcebox', ink: 1 },
    { op: 'editbox' },
    { op: 'glyphs', text: 'invisible math', math: 1 },
    { op: 'rule', h: 0 },
    { op: 'chunk', chunk: 'clipped-out', sy: 0, show: [[500, 500, 10, 10]] },
    { op: 'pending-exact' },
  ]) {
    const viewer = viewerOf(2);
    const page = viewer.pageDivs.get(2);
    const decorate = sy => pageList(2, [...fragmentPage(sy).commands,
      { src: 'shared', x: 72, y: 85, w: 400, h: 10, ...hidden }]);
    viewer.appliedSrcRev = 2;
    const old = decorate(0);
    paint(page, old, 2);
    viewer.renderPage(old);
    viewer.canonicalAt(2);
    viewer.updateCanonState(2);
    viewer.appliedSrcRev = 3;
    viewer.renderPage(decorate(600));
    viewer.updateCanonState(2);
    assert.deepEqual(page.children, [], hidden.op);
  }
});

test('moving or adding hit boxes does not change the ink matched by a canonical page', () => {
  const viewer = viewerOf(2);
  const page = viewer.pageDivs.get(2);
  const body = ['same-body', 'owing-picture', 'same-instructions'];
  const old = owing(2, body, bands(2));
  viewer.appliedSrcRev = 2;
  viewer.renderPage(old);
  viewer.canonicalAt(2);
  viewer.updateCanonState(2);
  viewer.appliedSrcRev = 3;
  const next = owing(2, body, [...bands(2), { op: 'editbox', src: 'new-hit', x: 10, y: 20, w: 50, h: 40 }]);
  next.commands[0].y += 40;
  viewer.renderPage(next);
  assert.ok(viewer.canonicalShowsList(page, next, 2));
});

test('a displaced image holds a relocating reading line only until the original page-swap deadline', () => {
  const viewer = viewerOf(3);
  const page = viewer.pageDivs.get(2);
  const old = fragmentPage(0);
  viewer.appliedSrcRev = 2;
  paint(page, old, 2);
  viewer.renderPage(old);
  viewer.canonicalAt(2);
  viewer.updateCanonState(2);
  const img = page.querySelector('img.canon');
  let now = 0;
  const timers = [];
  Object.assign(viewer, {
    TdomViewAnchor: {},
    captureViewAnchor: () => ({ kind: 'reading', page: 2 }),
    viewAnchorNow: () => ({ page: 3, exact: true }),
    performance: { now: () => now },
    setTimeout: (fn, ms) => timers.push({ fn, at: now + ms }),
  });
  viewer.appliedSrcRev = 3;
  viewer.renderPage(fragmentPage(600));
  assert.equal(page.querySelector('img.canon'), img, 'the line can carry the viewport to its new sheet');
  now = 900;
  viewer.appliedSrcRev = 4;
  viewer.renderPage(fragmentPage(800));
  assert.equal(page.querySelector('img.canon'), img);
  now = 1000;
  for (const { at, fn } of timers) if (at <= now) fn();
  assert.equal(page.querySelector('img.canon'), null, 'the old crop is retired if the ready swap still has not happened');
});

for (const { name, keep, clip } of [
  { name: 'head withdrawn', keep: ['f'], clip: 'inset(11.25% 0 0% 0)' },
  { name: 'foot withdrawn', keep: ['h'], clip: 'inset(0% 0 5% 0)' },
  { name: 'both withdrawn', keep: [], clip: 'inset(11.25% 0 5% 0)' },
  // This is the list the engine sends for inseparable art: no band chunks,
  // even though a separately typeset running foot can still be in the list.
  { name: 'art crossing bands withdrawn', keep: [], clip: 'inset(11.25% 0 5% 0)' },
]) {
  test(`retained exact paper masks its old furniture with ${name}`, () => {
    const viewer = viewerOf(2);
    const page = viewer.pageDivs.get(2);
    const body = ['question', 'picture', 'instructions'];
    const old = owing(2, body, bands(2));
    viewer.appliedSrcRev = 2;
    paint(page, old, 2);
    viewer.renderPage(old);
    viewer.canonicalAt(2);
    viewer.updateCanonState(2);
    const img = page.querySelector('img.canon');
    assert.equal(img.style.clipPath, '');

    viewer.appliedSrcRev = 3;
    const furniture = bands(2).filter(band => keep.includes(band.chunk.at(-1)));
    if (name.startsWith('art')) furniture.push(foot('new running foot'));
    viewer.renderPage(owing(2, body, furniture));
    viewer.updateCanonState(2);
    assert.equal(page.querySelector('img.canon'), img, 'the body stays on paper');
    assert.ok(page.classes().includes('is-final'));
    assert.equal(img.style.clipPath, clip);

    viewer.canonicalAt(3);
    viewer.updateCanonState(2);
    assert.equal(page.querySelector('img.canon').style.clipPath, '', 'current exact paper is unmasked');
  });
}

for (const exact of [false, true]) {
  test(`disjoint windows of one block retire the ${exact ? 'canonical' : 'provisional'} paper`, () => {
    const viewer = viewerOf(3);
    const page = viewer.pageDivs.get(2);
    const old = fragmentPage(0);
    viewer.appliedSrcRev = 2;
    paint(page, old, 2);
    if (exact) {
      viewer.renderPage(old);
      viewer.canonicalAt(2);
      viewer.updateCanonState(2);
      assert.ok(page.classes().includes('is-final'));
    }
    viewer.appliedSrcRev = 3;
    viewer.renderPage(fragmentPage(600));
    viewer.updateCanonState(2);
    assert.deepEqual(page.children.map(child => child.kind), []);
    assert.ok(page.classes().includes('awaiting-canonical'));
  });
}

test('a genuinely overlapping crop keeps its paper while another picture is owed', () => {
  const viewer = viewerOf(3);
  const page = viewer.pageDivs.get(2);
  const old = fragmentPage(0);
  paint(page, old, 2);
  viewer.appliedSrcRev = 3;
  viewer.renderPage(fragmentPage(500));
  assert.equal(page.provisionalDl, old);
  assert.deepEqual(page.children.map(child => child.kind), ['svg', 'chunkwin']);
});

test('a shifted exact page is retired when its complete body is now on the next sheet', () => {
  const viewer = viewerOf(3);
  const page = viewer.pageDivs.get(2);
  const old = owing(2, ['b1', 'b2', 'b3']);
  viewer.appliedSrcRev = 2;
  paint(page, old, 2);
  viewer.renderPage(old);
  viewer.canonicalAt(2);
  viewer.updateCanonState(2);
  viewer.appliedSrcRev = 3;
  viewer.provisionalDisplayLists.set(3, pageList(3, old.commands));
  viewer.renderPage(owing(2, ['b1', 'b4', 'b5']));
  viewer.updateCanonState(2);
  assert.equal(page.querySelector('img.canon'), null, 'the old body still belongs together on sheet 3');
});

test('exact paper with a picture-only body is retired when its source block changes', () => {
  const viewer = viewerOf(2);
  const page = viewer.pageDivs.get(2);
  const picture = src => pageList(2, [{ op: 'pending-exact', src, wholePage: 1 }]);
  viewer.appliedSrcRev = 2;
  viewer.renderPage(picture('old-picture'));
  viewer.canonicalAt(2);
  viewer.updateCanonState(2);
  assert.ok(page.classes().includes('is-final'));
  viewer.appliedSrcRev = 3;
  viewer.renderPage(picture('new-picture'));
  viewer.updateCanonState(2);
  assert.equal(page.querySelector('img.canon'), null);
  assert.ok(page.classes().includes('awaiting-canonical'));
});

test('two full-size chunk windows with disjoint visible openings share no paper', () => {
  const viewer = viewerOf(3);
  const page = viewer.pageDivs.get(2);
  const clipped = y => pageList(2, [
    { ...fragment(0), show: [[72, y, 400, 40]] },
    { op: 'pending-exact', src: 'b2' },
  ]);
  paint(page, clipped(100), 2);
  viewer.appliedSrcRev = 3;
  viewer.renderPage(clipped(600));
  assert.deepEqual(page.children, []);
});

test('an exact image mounted from the initial snapshot remembers its accepted body list', () => {
  const viewer = viewerOf(2);
  const page = viewer.pageDivs.get(2);
  viewer.appliedSrcRev = 2;
  viewer.canonicalAt(2);
  viewer.provisionalDisplayLists.set(2, owing(2, ['old1', 'old2', 'old3']));
  viewer.committedCanonicalGeneration = { id: 2, rev: 2, epoch: 1, residentLayoutCompatible: true, pageCount: 2 };
  viewer.updateCanonState(2);
  assert.ok(page.classes().includes('is-final'));

  viewer.appliedSrcRev = 3;
  viewer.renderPage(owing(2, ['new1', 'new2', 'new3']));
  viewer.updateCanonState(2);
  assert.equal(page.querySelector('img.canon'), null);
  assert.ok(page.classes().includes('awaiting-canonical'));
});

test('a head or foot band that goes, moves to the other slot or is cut again is a change of the page\'s head and foot', () => {
  const band = (page, slot, cv = 1) => ({ op: 'chunk', src: '_hf', chunk: `__hf-${page}-${slot}`,
    x: 0, y: slot === 'h' ? 0 : 760, w: 600, h: slot === 'h' ? 90 : 40, sy: 0, cv });
  // page: [furniture at the canonical's revision, furniture a keystroke elsewhere later, the canonical's head and foot shown]
  // (the body is the canonical page's in every case: it stays on the paper, round 11 fix 4)
  const cases = new Map([
    [2, [bands(2), [band(2, 'f')], false]], // two bands -> one
    [3, [bands(3), [], false]], // two bands -> none, nothing drawn in their place
    [4, [[band(4, 'h')], [band(4, 'f')], false]], // one band -> the other slot
    [5, [[band(5, 'h')], [band(5, 'h', 2)], false]], // the same slot, cut again
    [6, [[band(6, 'h')], [band(6, 'h')], true]], // (the same band: no change)
    [7, [bands(7), bands(7), true]], // (both bands: the canonical page's own head and foot)
  ]);
  const viewer = viewerOf(7);
  viewer.appliedSrcRev = 2;
  const blocks = (n) => [`b${n}1`, `b${n}2`, `b${n}3`];
  for (const [n, [then]] of cases) {
    paint(viewer.pageDivs.get(n), owing(n, blocks(n)), 1);
    viewer.renderPage(owing(n, blocks(n), then));
  }
  viewer.canonicalAt(2);
  viewer.appliedSrcRev = 3;
  for (const [n, [, now, shown]] of cases) {
    viewer.renderPage(owing(n, blocks(n), now));
    viewer.updateCanonState(n);
    const page = viewer.pageDivs.get(n);
    assert.ok(page.classes().includes('is-final'), `page ${n}: the body`);
    assert.equal(page.querySelector('img.canon').style.clipPath === '', shown, `page ${n}: head and foot`);
  }
});

test('a page kept by its body is shown a canonical generation whose hit map is in hand: the newest one, else the one it shows, else an older one', () => {
  // The booklet (round 11): the canonical of revision 5 landed with the source at 190; /dom describes only the
  // current source, so revision 5's pages could not be shown, and pages not shown before fell back to resident paper.
  const viewer = viewerOf(3);
  viewer.appliedSrcRev = 2;
  const p2 = viewer.pageDivs.get(2), p3 = viewer.pageDivs.get(3);
  paint(p2, owing(2, ['a1', 'a2', 'a3']), 1);
  paint(p3, owing(3, ['c1', 'c2', 'c3']), 1);
  // (the engine's body signature, display-list.js bodySignature: the same while the page's owed picture is drawn)
  const withBody = (list, body) => Object.assign(list, { body });
  viewer.renderPage(withBody(owing(2, ['a1', 'a2', 'a3'], bands(2)), 'body-2'));
  viewer.renderPage(withBody(owing(3, ['c1', 'c2', 'c3'], bands(3)), 'body-3'));
  // generation 1 (revision 2) lands; page 2 is shown it, its map read while it was current; page 3 is out of sight
  viewer.canonical = { id: 1, rev: 2, pageCount: 3 };
  viewer.presentedDomSnapshots.set(viewer.presentedSnapshotKey(1, 2), { srcRev: 2 });
  viewer.updateCanonState(2);
  assert.equal(p2.dataset.canonPresentedSrc, '/canonical/2.svg?c=1');
  // typing elsewhere up to revision 190; generation 2 (revision 5) lands, its map never read
  viewer.appliedSrcRev = 190;
  viewer.renderPage(viewer.provisionalStages.get(2).dl);
  viewer.renderPage(viewer.provisionalStages.get(3).dl);
  viewer.canonical = { id: 2, rev: 5, pageCount: 3 };
  viewer.updateCanonState(2);
  viewer.updateCanonState(3);
  assert.ok(p2.classes().includes('is-final'));
  assert.equal(p2.dataset.canonPresentedSrc, '/canonical/2.svg?c=1', 'page 2 keeps the generation it shows');
  assert.ok(p3.classes().includes('is-final'), 'page 3 is not left to its resident paper');
  assert.equal(p3.dataset.canonPresentedSrc, '/canonical/3.svg?c=1', 'page 3 is shown the older generation, with its map');
  assert.equal(p3.dataset.canonPresentedRev, '2');
  // the list of page 3 completes (its owed picture drawn) and is committed: the older generation stays
  const drawn = withBody(owing(3, ['c1', 'c2', 'c3'], bands(3)), 'body-3');
  drawn.commands[2] = { op: 'chunk', src: 'c2', chunk: 'c2', x: 72, y: 180, w: 400, h: 40, sy: 0, cv: 1 };
  viewer.noteListContent(p3, drawn, 190, false);
  p3.provisionalDl = drawn;
  p3.dataset.provRev = '190';
  delete p3.dataset.provPending;
  viewer.provisionalStages.delete(3);
  viewer.updateCanonState(3);
  assert.ok(p3.classes().includes('is-final'), 'committed, the body stays the exact page\'s');
  assert.equal(p3.dataset.canonPresentedSrc, '/canonical/3.svg?c=1');
  // once generation 2's map is in hand (its revision current again, or read), the newest generation is shown
  viewer.presentedDomSnapshots.set(viewer.presentedSnapshotKey(2, 5), { srcRev: 5 });
  viewer.updateCanonState(2);
  assert.equal(p2.dataset.canonPresentedSrc, '/canonical/2.svg?c=2');
});

test('a body kept whose foot is no longer the page\'s: that slot comes off the image, and the page\'s own foot shows there once committed', () => {
  const viewer = viewerOf(2);
  viewer.appliedSrcRev = 2;
  const page = viewer.pageDivs.get(2);
  const withBody = (list) => Object.assign(list, { body: 'k-body' });
  const then = withBody(owing(2, ['k1', 'k2', 'k3'], [foot('— 2 —')]));
  paint(page, owing(2, ['k1', 'k2', 'k3']), 1);
  viewer.renderPage(then);
  viewer.canonical = { id: 1, rev: 2, pageCount: 2 };
  viewer.updateCanonState(2);
  assert.ok(page.classes().includes('is-final'));
  assert.equal(page.querySelector('img.canon').style.clipPath, '');
  // a keystroke elsewhere changes the page's foot (another folio style): staged, still owing its picture
  viewer.appliedSrcRev = 3;
  const owedNow = withBody(owing(2, ['k1', 'k2', 'k3'], [foot('ii')]));
  viewer.renderPage(owedNow);
  viewer.updateCanonState(2);
  assert.ok(page.classes().includes('is-final'), 'the body stays');
  assert.notEqual(page.querySelector('img.canon').style.clipPath, '', 'the old foot is not shown');
  assert.ok(!page.classes().includes('canon-slots'), 'the paper under the image is not this list: nothing over the slot');
  // the picture comes and the list is committed: the page's own foot shows over the slot
  const drawn = withBody(owing(2, ['k1', 'k2', 'k3'], [foot('ii')]));
  drawn.commands[2] = { op: 'chunk', src: 'k2', chunk: 'k2', x: 72, y: 180, w: 400, h: 40, sy: 0, cv: 1 };
  viewer.noteListContent(page, drawn, 3, false);
  page.provisionalDl = drawn;
  page.dataset.provRev = '3';
  delete page.dataset.provPending;
  viewer.provisionalStages.delete(2);
  viewer.updateCanonState(2);
  assert.ok(page.classes().includes('is-final'));
  assert.notEqual(page.querySelector('img.canon').style.clipPath, '');
  assert.ok(page.classes().includes('canon-slots'), 'the page\'s own foot over the slot');
});

test('a mapped generation keeps its own slot provenance across newer lists and recuts', () => {
  const v = viewerOf(2), page = v.pageDivs.get(2);
  const sheet = furniture => Object.assign(owing(2, ['question', 'picture', 'instructions'], furniture), { body: 'fixed' });
  const before = sheet(bands(2));
  v.appliedSrcRev = 2;
  v.renderPage(before);
  v.presentedDomSnapshots.set(v.presentedSnapshotKey(2, 2), { srcRev: 2 });
  v.canonicalAt(2);
  v.updateCanonState(2);
  const recut = sheet(bands(2).map(cmd => ({ ...cmd, cv: 7 })));
  v.appliedSrcRev = 5;
  v.renderPage(recut);
  v.canonicalAt(4);
  v.updateCanonState(2);
  assert.equal(page.dataset.canonPresentedSrc, '/canonical/2.svg?c=2');
  assert.equal(page.exactListDl, before);
  assert.equal(page.querySelector('img.canon').style.clipPath, 'inset(11.25% 0 5% 0)');
});

test('a committed slot missing from the displayed image is drawn and leaves the other slot alone', () => {
  const v = viewerOf(2), page = v.pageDivs.get(2);
  const sheet = furniture => Object.assign(pageList(2, [
    { op: 'glyphs', src: 'body', x: 72, y: 260, w: 80, size: 10, text: 'Body' }, ...furniture,
  ]), { body: 'fixed' });
  const unchangedFoot = bands(2)[1];
  const before = sheet([unchangedFoot]);
  v.appliedSrcRev = 2;
  paint(page, before, 2);
  v.noteListContent(page, before, 2, false);
  v.presentedDomSnapshots.set(v.presentedSnapshotKey(2, 2), { srcRev: 2 });
  v.canonicalAt(2);
  v.updateCanonState(2);
  const after = sheet([bands(2)[0], unchangedFoot]);
  v.appliedSrcRev = 3;
  paint(page, after, 3);
  v.noteListContent(page, after, 3, false);
  v.pageDirtyRev.set(2, 3);
  v.updateCanonState(2);
  assert.equal(page.querySelector('img.canon').style.clipPath, '');
  assert.ok(page.classes().includes('canon-slot-h'));
  assert.ok(!page.classes().includes('canon-slot-f'));
});

test('render and exact head changes mask the older canonical head while the body waits', () => {
  const v = viewerOf(2), page = v.pageDivs.get(2);
  const [head, foot] = bands(2).map(cmd => ({ ...cmd, hfGeneration: 2 }));
  const sheet = h => Object.assign(pageList(2, [
    { op: 'glyphs', src: 'body', x: 72, y: 260, w: 80, size: 10, text: 'Body' }, h, foot,
  ]), { body: 'fixed' });
  const before = sheet(head);
  v.appliedSrcRev = 2;
  paint(page, before, 2);
  v.noteListContent(page, before, 2, false);
  v.presentedDomSnapshots.set(v.presentedSnapshotKey(2, 2), { srcRev: 2 });
  v.canonicalAt(2);
  v.updateCanonState(2);

  // Source render and PDF cuts have independent version counters.
  const rendered = sheet({ ...head, chunk: '__hfr-2-h' });
  v.appliedSrcRev = 3;
  v.noteListContent(page, rendered, 3, false);
  v.pageDirtyRev.set(2, 3);
  v.provisionalStages.set(2, { dl: rendered, sourceRev: 3 });
  const clip = () => page.querySelector('img.canon').style.clipPath;
  v.updateCanonState(2);
  assert.equal(page.listContent.furnitureRev, 3, 'the source changes even when the counters match');
  assert.equal(clip(), 'inset(11.25% 0 0% 0)', 'the old PDF head is cut before the render decodes');
  paint(page, rendered, 3);
  v.provisionalStages.delete(2);
  v.updateCanonState(2);
  assert.equal(clip(), 'inset(11.25% 0 0% 0)');
  assert.ok(page.classes().includes('canon-slot-h'));
  assert.ok(!page.classes().includes('canon-slot-f'));

  const exact = sheet({ ...head, hfGeneration: 3 });
  v.noteListContent(page, exact, 3, false);
  v.provisionalStages.set(2, { dl: exact, sourceRev: 3 });
  v.updateCanonState(2);
  assert.equal(page.provisionalDl, rendered);
  assert.equal(clip(), 'inset(11.25% 0 0% 0)');
  assert.ok(page.classes().includes('withdrawn-slot-h'), 'the rendered head is hidden while the exact cut decodes');
  paint(page, exact, 3);
  v.provisionalStages.delete(2);
  v.updateCanonState(2);
  assert.equal(page.provisionalDl, exact);
  assert.ok(page.classes().includes('canon-slot-h'), 'the exact head takes the same slot');
  assert.ok(!page.classes().includes('canon-slot-f'));
});

test('a withdrawn rendered head disappears while an unrelated body figure is pending', () => {
  const v = viewerOf(2), page = v.pageDivs.get(2);
  const [head, foot] = bands(2).map(cmd => ({ ...cmd, hfGeneration: 2 }));
  const body = { op: 'glyphs', src: 'body', x: 72, y: 260, w: 80, size: 10, text: 'Body' };
  const sheet = (...commands) => Object.assign(pageList(2, [body, ...commands, foot]), { body: 'fixed' });
  const before = sheet(head);
  v.appliedSrcRev = 2;
  paint(page, before, 2);
  v.noteListContent(page, before, 2, false);
  v.presentedDomSnapshots.set(v.presentedSnapshotKey(2, 2), { srcRev: 2 });
  v.canonicalAt(2);
  v.updateCanonState(2);

  const rendered = sheet({ ...head, chunk: '__hfr-2-h' });
  v.appliedSrcRev = 3;
  paint(page, rendered, 3);
  v.noteListContent(page, rendered, 3, false);
  v.pageDirtyRev.set(2, 3);
  v.updateCanonState(2);
  assert.ok(page.classes().includes('canon-slot-h'), 'the source render is mounted');

  v.appliedSrcRev = 4;
  v.renderPage(sheet({ op: 'pending-exact', src: 'figure' }));
  v.updateCanonState(2);
  assert.equal(page.provisionalDl, rendered, 'the resident body still waits');
  assert.ok(page.classes().includes('is-final'));
  assert.equal(page.querySelector('img.canon').style.clipPath, 'inset(11.25% 0 0% 0)', 'the PDF head is cut');
  assert.ok(!page.classes().includes('canon-slot-h'), 'the withdrawn source render is hidden');
  assert.ok(!page.classes().includes('canon-slot-f'), 'the unchanged PDF foot stays');
});


test('a withdrawn rendered head disappears from resident paper before a pending body image commits', () => {
  const v = viewerOf(2), page = v.pageDivs.get(2);
  const [head, foot] = bands(2);
  const body = { op: 'chunk', src: 'figure', chunk: 'figure', x: 72, y: 200, w: 80, h: 60, sy: 0, cv: 1 };
  const rendered = pageList(2, [body, { ...head, chunk: '__hfr-2-h' }, foot]);
  paint(page, rendered, 3);
  v.appliedSrcRev = 4;
  v.nearSight = () => false;
  const replacement = pageList(2, [{ ...body, cv: 2 }, foot]);

  v.renderPage(replacement, false, true);

  assert.equal(v.provisionalStages.get(2).deferred, true, 'the body image transaction has not committed');
  assert.equal(page.provisionalDl, rendered);
  assert.ok(page.classes().includes('withdrawn-slot-h'), 'hide the mounted head before the next body is available');
  assert.ok(!page.classes().includes('withdrawn-slot-f'), 'leave the independent foot visible');
});


for (const [name, before, after, hidden] of [
  ['exact cut withdrawn', bands(2), [bands(2)[1]], ['h']],
  ['exact cut to rendered head', bands(2), [{ ...bands(2)[0], chunk: '__hfr-2-h' }, bands(2)[1]], ['h']],
  ['rendered head to exact cut', [{ ...bands(2)[0], chunk: '__hfr-2-h' }, bands(2)[1]], bands(2), ['h']],
  ['exact cut version changes', bands(2), [{ ...bands(2)[0], cv: 2 }, bands(2)[1]], ['h']],
  ['both exact cuts withdrawn', bands(2), [], ['h', 'f']],
  ['cross-band art pair withdrawn, independent foot supplied', bands(2), [foot('New running foot')], ['h', 'f']],
  ['old footer runs withdrawn', [foot('Old foot')], [], ['f']],
]) {
  test(`blocked body applies slot changes immediately: ${name}`, () => {
    const v = viewerOf(2), page = v.pageDivs.get(2);
    const body = { op: 'chunk', src: 'figure', chunk: 'figure', x: 72, y: 200, w: 80, h: 60, sy: 0, cv: 1 };
    const rendered = pageList(2, [body, ...before]);
    v.appliedSrcRev = 3;
    paint(page, rendered, 3);
    v.appliedSrcRev = 4;
    v.renderPage(pageList(2, [body, { op: 'pending-exact', src: 'new-figure' }, ...after]));
    v.updateCanonState(2);
    assert.equal(page.provisionalDl, rendered, 'only the body waits');
    assert.deepEqual(['h', 'f'].filter(slot => page.classes().includes(`withdrawn-slot-${slot}`)), hidden);
  });
}

test('late accepted cuts identify the retained PDF slots before any resident commit', () => {
  const v = viewerOf(2), page = v.pageDivs.get(2);
  const body = owing(2, ['question', 'figure', 'instructions']);
  v.appliedSrcRev = 2;
  paint(page, body, 2);
  v.renderPage(body);
  v.canonicalAt(2);
  v.updateCanonState(2);
  v.provisionalStages.delete(2);
  const [head, foot] = bands(2).map(cmd => ({ ...cmd, hfGeneration: 2 }));
  v.provisionalDisplayLists.set(2, owing(2, ['question', 'figure', 'instructions'], [head, foot]));
  v.updateCanonState(2);
  assert.equal(page.provisionalDl, body, 'the cuts were accepted without a resident paint');
  v.appliedSrcRev = 3;
  v.renderPage(owing(2, ['question', 'figure', 'instructions'], [foot]));
  v.updateCanonState(2);
  assert.ok(page.classList.contains('is-final'));
  assert.equal(page.querySelector('img.canon').style.clipPath, 'inset(11.25% 0 0% 0)');
});

test('a mounted exact page keeps its body when its first resident commit has the same body', () => {
  const v = viewerOf(2), page = v.pageDivs.get(2);
  const before = { ...pageList(2), body: 'fixed' };
  v.appliedSrcRev = 2;
  v.provisionalDisplayLists.set(2, before);
  v.presentedDomSnapshots.set(v.presentedSnapshotKey(2, 2), { srcRev: 2 });
  v.committedCanonicalGeneration = { epoch: 1, id: 2, rev: 2, residentLayoutCompatible: true };
  v.canonicalAt(2);
  v.updateCanonState(2);
  assert.equal(page.exactListDl, before, 'the accepted layout belongs to the mounted image');
  assert.equal(page.listContent, undefined, 'no resident list was staged for this shell');

  const after = { ...before, commands: [...before.commands, foot('2')] };
  v.appliedSrcRev = 3;
  v.provisionalDisplayLists.set(2, after);
  v.noteListContent(page, after, 3, false);
  v.pageDirtyRev.set(2, 3);
  paint(page, after, 3);
  v.updateCanonState(2);

  assert.equal(page.listContent.bodyRev, 2);
  assert.ok(page.classes().includes('is-final'), 'the exact body still covers the first resident commit');
  assert.equal(page.dataset.canonPresentedSrc, '/canonical/2.svg?c=2');
});

test('footer paint changes cut only the old footer rectangle and protect overlapping body ink', () => {
  const v = viewerOf(2), page = v.pageDivs.get(2);
  const sheet = (color, x) => Object.assign(pageList(2, [
    { op: 'glyphs', src: 'body', x: 72, y: 260, w: 80, size: 10, text: 'Body' }, bands(2)[0],
    { ...foot('Same footer'), color, x, w: 42, gh: 8, gd: 2 },
  ]), { body: 'fixed', bodyOverhang: [[309, 774, 13, 7]] });
  const before = sheet('red', 300);
  v.appliedSrcRev = 2;
  paint(page, before, 2);
  v.noteListContent(page, before, 2, false);
  v.presentedDomSnapshots.set(v.presentedSnapshotKey(2, 2), { srcRev: 2 });
  v.canonicalAt(2);
  v.updateCanonState(2);
  const after = sheet('blue', 320);
  v.appliedSrcRev = 3;
  paint(page, after, 3);
  v.noteListContent(page, after, 3, false);
  v.pageDirtyRev.set(2, 3);
  v.updateCanonState(2);
  const clip = page.querySelector('img.canon').style.clipPath;
  assert.match(clip, /^polygon\(evenodd,/);
  assert.match(clip, /51\.5% 96\.75%/, 'the body-owned rectangle punches through the footer cut');
  assert.ok(page.classes().includes('canon-slot-f'));
  assert.ok(!page.classes().includes('canon-slot-h'));
});

test('Chromium composites exact and rendered furniture independently and preserves overlapping body ink', async t => {
  const requireHost = createRequire(new URL('../../TeX64-Pro/package.json', import.meta.url));
  let chromium;
  try { ({ chromium } = requireHost('playwright')); } catch { return t.skip('Playwright unavailable'); }
  let browser;
  try {
    browser = await chromium.launch({ args: ['--single-process', '--no-zygote', '--in-process-gpu'] });
  } catch (error) { return t.skip('Chromium unavailable (' + error.message.split('\n')[0] + ')'); }
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 250, height: 250 } });
  const svg = (width, height, content) => 'data:image/svg+xml,' + encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}">${content}</svg>`);
  const head = '<rect x="12" y="7" width="28" height="6" fill="#000" opacity="0.45"/>';
  const body = '<rect x="48" y="82" width="14" height="8" fill="green"/>';
  const oldFoot = '<rect x="68" y="82" width="12" height="8" fill="red"/>';
  const css = readFileSync(new URL('../web/style.css', import.meta.url), 'utf8');
  await page.setContent(`<style>${css}</style><div class="page is-final" id="sheet" data-canon-presented-rev="2"
    style="position:absolute;left:0;top:0;width:200px;height:200px;margin:0">
    <img class="canon" src="${svg(100, 100, head + body + oldFoot)}">
    <div class="chunkwin" data-src="_hf" data-hf-slot="h" style="left:0%;top:0%;width:100%;height:20%">
      <img class="chunk" src="${svg(100, 20, head)}"></div>
    <svg viewBox="0 0 100 100" style="width:100%;height:100%">
      <rect data-hf-slot="f" x="68" y="82" width="12" height="8" fill="blue"/>
    </svg>
  </div>`);
  await page.evaluate(() => Promise.all([...document.images].map(img => img.decode())));
  const crop = (x, y, width, height) => page.screenshot({ clip: { x: x * 2, y: y * 2, width: width * 2, height: height * 2 } });
  const [headBefore, bodyBefore, footBefore] = await Promise.all([crop(0, 0, 45, 20), crop(49, 83, 11, 6), crop(69, 83, 10, 6)]);
  await page.evaluate(`(() => {
    const geometry = { paperwidth: 100, paperheight: 100 };
    const openingPreview = false;
    const assets = new Map(), readyFonts = new Set(), fontLoads = new Map();
    const injectFonts = () => {}, escapeXml = String, chunkShowClip = () => '';
    const chunkImageSrc = cmd => assets.get(cmd.chunk) ?? '';
    const svgParts = ({ commands }) => ['<svg viewBox="0 0 100 100">',
      ...commands.filter(cmd => cmd.op === 'rule').map(cmd =>
        '<rect x="' + cmd.x + '" y="' + cmd.y + '" width="' + cmd.w + '" height="' + cmd.h + '" fill="' + cmd.color + '"/>'),
      '</svg>'];
    ${STAGING}
    const sheet = document.getElementById('sheet');
    const head = { op: 'chunk', src: '_hf', hfSlot: 'h', chunk: '__hf-1-h', x: 0, y: 0, w: 100, h: 20, sy: 0 };
    const foot = { op: 'chunk', src: '_hf', hfSlot: 'f', chunk: '__hf-1-f', x: 0, y: 75, w: 100, h: 25, sy: 0 };
    const bodyOverhang = [[47, 81, 16, 10]];
    sheet.exactListDl = { commands: [head, foot], bodyOverhang };
    const blueFoot = { op: 'rule', hfSlot: 'f', src: '_hf', x: 68, y: 82, w: 12, h: 8, color: 'blue' };
    const apply = dl => updateOwedFurnitureClip(sheet, sheet.querySelector('img.canon'), { dl, sourceRev: 3 });
    window.setTestHead = (key, src) => {
      const h = { ...head, chunk: key, cv: src ? 1 : undefined };
      const dl = { commands: [h, blueFoot], bodyOverhang };
      if (!src) sheet.provisionalDl = dl;
      else assets.set(key, src);
      return apply(dl);
    };
    window.withdrawHead = () => apply({ commands: [blueFoot], bodyOverhang });
    window.readSheet = () => ({
      oldHead: getComputedStyle(sheet.querySelector(':scope > .chunkwin')).visibility,
      staged: [...sheet.querySelectorAll('.tdom-staged-furniture:not([hidden])')].map(el => el.dataset.hfSlot),
      bodyStillMounted: sheet.provisionalDl.commands[0].chunk === head.chunk,
    });
    const pageDivs = new Map(), provisionalStages = new Map();
    const canonical = null, pagesEl = sheet.parentNode, outerAfterEl = null;
    const usesCanonicalSurface = () => false;
    const activePaperGeometry = () => ({ width: 100, height: 100 });
    ${span('function ensureShell(n)', '/** Reconcile shells')}
    window.openOwingShell = () => {
      provisionalStages.set(2, { sourceRev: 3, dl: {
        commands: [blueFoot, { op: 'pending-exact', src: 'figure' }],
      } });
      ensureShell(2);
    };
    return setTestHead(head.chunk);
  })()`);
  assert.equal(await page.locator('.chunkwin').evaluate(el => getComputedStyle(el).opacity), '0');
  assert.deepEqual(await crop(0, 0, 45, 20), headBefore);
  assert.deepEqual(await crop(49, 83, 11, 6), bodyBefore);
  assert.notDeepEqual(await crop(69, 83, 10, 6), footBefore);
  assert.equal(await page.locator('[data-hf-slot="f"]').evaluate(el => getComputedStyle(el).visibility), 'visible');
  const blueFoot = await crop(69, 83, 10, 6);
  await t.test('a newly staged render appears over the retained PDF while its body waits', async () => {
    const renderedHead = '<rect x="40" y="7" width="20" height="6" fill="purple"/>';
    await page.evaluate(src => window.setTestHead('__hfr-1-h', src), svg(100, 20, renderedHead));
    await page.waitForFunction(() => window.readSheet().staged.includes('h'), null, { timeout: 2000 });
    assert.deepEqual(await page.evaluate(() => window.readSheet()), { oldHead: 'hidden', staged: ['h'], bodyStillMounted: true });
    assert.notDeepEqual(await crop(0, 0, 45, 20), headBefore);
    assert.deepEqual(await crop(49, 83, 11, 6), bodyBefore);
    assert.deepEqual(await crop(69, 83, 10, 6), blueFoot);
  });
  await t.test('a new exact cut replaces the staged render without committing the body', async () => {
    const exactHead = '<rect x="40" y="7" width="20" height="6" fill="orange"/>';
    const renderPixels = await crop(40, 7, 20, 6);
    await page.evaluate(src => window.setTestHead('__hf-1-h', src), svg(100, 20, exactHead));
    await page.waitForFunction(() => window.readSheet().staged.includes('h'), null, { timeout: 2000 });
    assert.notDeepEqual(await crop(40, 7, 20, 6), renderPixels);
    assert.deepEqual(await crop(69, 83, 10, 6), blueFoot);
  });
  await t.test('a withdrawn pending decode cannot remount the head', async () => {
    const newerHead = svg(100, 20, '<rect x="40" y="7" width="20" height="6" fill="red"/>');
    await page.evaluate(src => {
      window.setTestHead('__hfr-1-h', src);
      window.withdrawHead();
    }, newerHead);
    assert.deepEqual(await page.evaluate(() => window.readSheet()), { oldHead: 'hidden', staged: [], bodyStillMounted: true });
    assert.deepEqual(await crop(49, 83, 11, 6), bodyBefore);
  });
  await t.test('a previously absent head becomes visible before the body commits', async () => {
    const blank = await crop(40, 7, 20, 6);
    const restored = svg(100, 20, '<rect x="40" y="7" width="20" height="6" fill="green"/>');
    await page.evaluate(src => window.setTestHead('__hf-1-h', src), restored);
    await page.waitForFunction(() => window.readSheet().staged.includes('h'), null, { timeout: 2000 });
    assert.notDeepEqual(await crop(40, 7, 20, 6), blank);
    assert.ok((await page.evaluate(() => window.readSheet())).bodyStillMounted);
  });
  await t.test('the first slot of a new shell can paint while its first body is owed', async () => {
    await page.evaluate(() => window.openOwingShell());
    const firstSlot = page.locator('.page[data-page="2"] > .tdom-staged-furniture');
    await firstSlot.waitFor({ state: 'attached', timeout: 2000 });
    assert.equal(await firstSlot.evaluate(el => getComputedStyle(el).visibility), 'visible');
  });
});

// B1 (final release review): two-page headings article opening; the PDF of
// revision 1 is on sheet 2 while the document still opens (its list made no
// statement about the head and foot); `\section{Alpha}` on sheet 1 becomes
// Bravo. Sheet 2's head reads that mark, and its body is unchanged, so the
// same-body rule kept the old ALPHA head on screen until the next PDF.
test('an edit that changes a retained sheet\'s head takes the exact page off when its bands are not known, also while opening', () => {
  // (its body owes a picture: the staged list waits, the exact page is retained meanwhile)
  const sheet = (extra = {}) => Object.assign(owing(2, ['b2', 'b3', 'b4']), { body: 'page-two-body', hfUnknown: 'hf' }, extra);
  for (const stamp of [2, null]) {
    const v = viewerOf(2), page = v.pageDivs.get(2);
    v.openingPreview = true;
    v.openingEdited = false;
    v.appliedSrcRev = 1;
    v.renderPage(sheet());
    v.canonicalAt(1);
    v.updateCanonState(2);
    assert.ok(page.classes().includes('is-final'), 'the opening shows the PDF of revision 1');
    // the edit: revision 2, sheet 2's head made from another mark (the engine's stamp) or not
    v.appliedSrcRev = 2;
    v.openingEdited = true;
    v.renderPage(sheet(stamp ? { hfSince: stamp } : {}));
    v.updateCanonState(2);
    if (stamp) {
      assert.equal(page.querySelector('img.canon'), null, 'the old head is not shown while the next PDF is on its way');
      assert.ok(!page.classes().includes('is-final'));
      assert.ok(v.traced.includes('dropped-canonical:2'));
      // it is not shown again by the same generation
      v.updateCanonState(2);
      assert.equal(page.querySelector('img.canon'), null);
      // the PDF of the edited source brings the sheet back
      v.canonicalAt(2);
      v.updateCanonState(2);
      assert.ok(page.classes().includes('is-final'));
      assert.equal(page.dataset.canonPresentedRev, '2');
    } else {
      assert.ok(page.classes().includes('is-final'), 'an edit that leaves its head and foot keeps the exact page');
      assert.equal(page.dataset.canonPresentedRev, '1');
    }
  }
});

test('an edit that changes a retained sheet\'s head withdraws only that slot when its band is known, also while opening', () => {
  const head = (text) => ({ op: 'glyphs', src: '_hf', hfSlot: 'h', x: 300, y: 40, w: 60, text, fam: 'f1', size: 9 });
  const sheet = (text, extra = {}) => Object.assign(owing(2, ['b2', 'b3', 'b4'], [head(text), foot('2')]),
    { body: 'page-two-body' }, extra);
  for (const opening of [false, true]) {
    const v = viewerOf(2), page = v.pageDivs.get(2);
    v.appliedSrcRev = 1;
    v.renderPage(sheet('1 ALPHA'));
    v.canonicalAt(1);
    v.updateCanonState(2);
    assert.ok(page.classes().includes('is-final'));
    v.openingPreview = opening;
    v.openingEdited = true;
    v.appliedSrcRev = 2;
    v.renderPage(sheet('1 BRAVO', { hfSince: 2 }));
    v.updateCanonState(2);
    assert.ok(page.classes().includes('is-final'), 'the body stays');
    assert.notEqual(page.querySelector('img.canon').style.clipPath, '', 'the old head is cut from the exact page');
  }
});
