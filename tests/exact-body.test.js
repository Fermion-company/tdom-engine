// tex64-internal #121, round 11, fix 4: the booklet's writing rules (\notefill,
// rules to the foot of a two-column block) are drawn only in the exact page;
// the block's resident picture, made alone, has no column foot to rule to.
// Sheet 25 showed its eleven rules at +8 s and none at +45 s: a warm drew the
// Data box the page owed, the page's resident list was complete, and it took
// the place of the exact page on the paper, though nothing on the page had
// changed.
//  - engine: a page's list says what its body is apart from how it is drawn
//    now (display-list.js bodySignature, `dl.body`): the same when an owed
//    block is drawn and when an edit elsewhere changes only its head, another
//    when its own block is edited
//  - viewer (web/app.js canonicalShowsList / updateCanonState): fed those
//    lists, it keeps the exact page while the body is the one it shows, and
//    gives the head and foot their own decision on top

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { CheckpointEngine } from '../engine/checkpoint/engine-v3.js';
import { blockReadsPageState, bodySignature, buildDisplayList } from '../engine/checkpoint/display-list.js';
import { buildPagePatches } from '../engine/checkpoint/page-patches.js';
import { drain } from '../tools/harness.mjs';
import { provisionalViewer } from './helpers/provisional-viewer.js';

const texReady = spawnSync('lualatex', ['--version']).status === 0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const T = String.raw;

test('equal-height float plates and lines of one block have distinct body identities', () => {
  const galleyOf = () => 'same-parent-galley';
  const line = { blockId: 'plates', yRel: 10, h: 8, d: 2, ln: {} };
  const page = (float, u = line, y = 75) => ({ number: 4, folio: 4, draw: [{ u, y, float }], floatPage: true });
  const aaa = { blockId: 'plates', id: 'plates#0', units: [line] };
  const bbb = { ...aaa, id: 'plates#1' };
  assert.notEqual(bodySignature(page(aaa), galleyOf), bodySignature(page(bbb), galleyOf));
  assert.notEqual(bodySignature(page(aaa), galleyOf), bodySignature(page(aaa, { ...line, yRel: 21 }), galleyOf));
  assert.notEqual(bodySignature(page(aaa), galleyOf), bodySignature(page(aaa, line, 80), galleyOf));
  assert.equal(bodySignature(page(aaa), galleyOf), bodySignature({ ...page(aaa), number: 5, folio: 9 }, galleyOf));
  assert.notEqual(bodySignature({ ...page(aaa), topFloats: [aaa] }, galleyOf),
    bodySignature({ ...page(aaa), botFloats: [aaa] }, galleyOf));
});

test('only literal page-state reads or calls to preamble readers pin a body to its sheet and folio', () => {
  const preamble = T`\newcommand{\Ticket}[1]{Ticket #1: \thepage}
\def\PageParity{\ifodd\c@page Odd\else Even\fi}
\NewDocumentCommand{\FinalPage}{}{\pageref{LastPage}}
\let\PageAlias=\pagename
\renewcommand{\Replaced}{\rightmark}
\newcommand{\LocalCounter}{\arabic{section}}
% \newcommand{\Ignored}{\thepage}`;
  const geometry = { paperwidth: 600, paperheight: 800, textheight: 640, textwidth: 400 };
  const page = { number: 2, folio: 2, pendingExact: ['body'], draw: [] };
  const spec = { folio: 2, fmt: 'arabic', lp: '10', lmark: 'A', rmark: 'B' };
  const render = (text, bodyContext = '2/10', pageSpec = spec, sheet = page) => {
    const block = { text };
    return buildDisplayList(sheet, { geometry, chunks: new Map(), galleyOf: () => 'same',
      readsPageState: () => blockReadsPageState(block, preamble), bodyContext, pageSpec });
  };
  const ordinary = T`\theta \therefore \thesis \then \thead \thepagecount \pagenames
\value{section} \arabic{figure} \LocalCounter \Ignored LastPage \ref{not-a-page}
% \pageref{ignored}
\verb|\thepage| \\thepage`;
  assert.equal(render(ordinary).bodyContext, undefined);
  assert.equal(render(ordinary).body, render(ordinary, '3/10', { ...spec, folio: 10 }, { ...page, number: 3 }).body);
  for (const reader of [T`\thepage:`, T`\pagename`, T`\value{page}`, T`\Roman % comment
{page}`, T`\ifodd\c@page yes\fi`, T`\Ticket{A}`, T`\PageParity`, T`\PageAlias`]) {
    const original = render(reader).body;
    assert.equal(original, render(reader, '3/10').body, reader);
    assert.notEqual(original, render(reader, '3/10', { ...spec, folio: 5 }).body, reader);
    assert.notEqual(original, render(reader, '3/10', spec, { ...page, number: 5 }).body, reader);
  }
  for (const reader of [T`\pageref*{LastPage}`, T`\ref{LastPage}`, T`\FinalPage`]) {
    assert.equal(render(reader).body, render(reader, '3/10').body, reader);
    assert.notEqual(render(reader).body, render(reader, '3/11', { ...spec, lp: '11' }).body, reader);
  }
  assert.notEqual(render(T`\Replaced`).body, render(T`\Replaced`, '3/10', { ...spec, rmark: 'C' }).body);
  for (const reader of [T`\pageref{exercise}`, T`\firstmark`]) {
    assert.notEqual(render(reader).body, render(reader, '3/10').body, reader);
  }
});

test('a different insert from the same galley changes the body even when both use the same local baseline', () => {
  const galleyOf = () => 'same-parent-galley';
  const unit = bodyInsert => ({ blockId: 'notes', bodyInsert, yRel: 8, h: 8, d: 2, ln: {} });
  const page = u => ({ number: 2, draw: [{ u, y: 500 }], feet: [{ e: { units: [u], h: 10 } }] });
  assert.notEqual(bodySignature(page(unit(0)), galleyOf), bodySignature(page(unit(1)), galleyOf));
  const footRule = c => ({ h: 1, d: 0, ln: { runs: [{ rule: true, w: 50, h: 1, c }] } });
  assert.notEqual(bodySignature(page(footRule('#000000')), galleyOf), bodySignature(page(footRule('#ff0000')), galleyOf));
});

test('a pending exact line still publishes its raised body ink in the header band', () => {
  const geometry = { paperwidth: 600, paperheight: 800, textheight: 640, textwidth: 400 };
  const u = { blockId: 'label', li: 0, h: 10, d: 0, ln: { pendingExact: 1, boxH: 10, runs: [],
    editRuns: [{ t: 'ANSWERKEY', x: 10, dy: -30, w: 64, s: 10, gh: 8, gd: 2 }] } };
  const list = buildDisplayList({ number: 2, draw: [{ u, y: 10 }] }, { geometry, chunks: new Map() });
  assert.deepEqual(list.bodyOverhang, [[81, 43, 66, 12]]);
});

test('a page-state reader publishes a replacement when its resident commands stay identical', () => {
  const geometry = { paperwidth: 600, paperheight: 800, textheight: 640, textwidth: 400 };
  const unit = { blockId: 'reader', li: 0, h: 10, d: 0, ln: { runs: [] } };
  const page = { number: 2, folio: 2, draw: [{ u: unit, y: 10 }] };
  const render = (p, bodyContext) => buildDisplayList(p, { geometry, chunks: new Map(), fonts: new Map(),
    hfSig: 'same', galleyOf: () => 'same', readsPageState: () => true, bodyContext });
  page.dl = render(page, '2/3');
  const before = page.dl;
  const { patches } = buildPagePatches([page], [page], 'same', render, { bodyContext: '3/3' });
  assert.equal(patches.length, 1);
  assert.deepEqual(patches[0].displayList.commands, before.commands);
  assert.notEqual(patches[0].displayList.body, before.body);
});

const idle = (e) => !(e.hfPending || e.renderWant?.size || e.renderPumping > 0 || e.isoRenderPending?.size ||
  e.artWant?.size || e.artPumping);
async function settle(engine) {
  await drain(engine, 120_000);
  for (let i = 0; i < 600 && !idle(engine); i++) await sleep(100);
  await sleep(300);
  for (let i = 0; i < 600 && !idle(engine); i++) await sleep(100);
}

// A worksheet: a Data box (an exact picture the boot does not render) and two
// columns whose answer space is ruled to the foot of the page; a running head
// from the last mark.
const SOURCE = T`\documentclass{article}
\usepackage[a5paper,margin=16mm,headheight=14pt]{geometry}
\usepackage[most]{tcolorbox}
\usepackage{multicol,fancyhdr}
\pagestyle{fancy}\fancyhf{}\fancyhead[L]{\leftmark}\fancyfoot[C]{\thepage}
\renewcommand\headrulewidth{0pt}
\newcommand\notefill{\par\leaders\vbox to 16pt{\vss\hrule width\linewidth}\vfill}
\newtcolorbox{Data}{enhanced,colback=black!5,colframe=black!70,title=Data,fonttitle=\bfseries}
\begin{document}
\markboth{Alpha lesson}{Alpha lesson}
An opening page with a little text on it.

\clearpage
\begin{Data}
Theme: rotation about a point. Level B.
\end{Data}

\begin{multicols*}{2}
First answer. Move the centre to the origin.
\notefill
\columnbreak
Second answer. Two ways round.
\notefill
\end{multicols*}

\clearpage
Closing page.
\end{document}
`;

const listOf = (engine, n) => engine.getDisplayLists()[n - 1];
const owedOf = (list) => [...new Set((list?.commands ?? []).filter((c) => c.op === 'pending-exact').map((c) => c.src))];
const furnitureOf = (list) => (list?.commands ?? []).filter((c) => c.op === 'folio' || String(c.src ?? '').startsWith('_'))
  .map((c) => `${c.op}|${c.chunk ?? ''}|${c.text ?? ''}`).join(';');
async function editTo(engine, next) {
  const old = engine.getSource();
  let a = 0, b = 0;
  while (a < Math.min(old.length, next.length) && old[a] === next[a]) a++;
  while (b < Math.min(old.length, next.length) - a && old.at(-b - 1) === next.at(-b - 1)) b++;
  await engine.edit(a, old.length - b, next.slice(a, next.length - b));
  await settle(engine);
}

// the worksheet page's lists: owing its Data box, drawn, after a mark edit elsewhere, after an edit of its own
let lists = null;
async function worksheetLists() {
  if (lists) return lists;
  const root = fileURLToPath(new URL('../.tdom-v3-test-exact-body', import.meta.url));
  rmSync(root, { recursive: true, force: true });
  const cached = fileURLToPath(new URL('../.tdom-v3-test/', import.meta.url));
  if (existsSync(path.join(cached, 'tdomfork.so'))) {
    mkdirSync(root, { recursive: true });
    for (const f of ['tdomfork.so', 'tdomfork.so.sha256']) copyFileSync(path.join(cached, f), path.join(root, f));
  }
  // (as on a long document: the boot renders no block's exact picture, background-scheduler.js)
  const hotMax = process.env.TDOM_RENDER_HOT_MAX;
  process.env.TDOM_RENDER_HOT_MAX = '0';
  const engine = new CheckpointEngine({ workDir: root });
  engine.canonical.schedule = () => {};
  try {
    await engine.open(SOURCE);
    await settle(engine);
    const boot = { list: listOf(engine, 2), srcRev: engine.srcRev };
    assert.equal(engine.pages.length, 3);
    assert.equal(owedOf(boot.list).length, 1, 'the worksheet page owes its Data box');
    assert.equal((await engine.warmPage(2))?.status, 'ready');
    await settle(engine);
    const opening = await engine.canonical.ensure(SOURCE, engine.srcRev);
    const head = (id) => listOf(engine, 2)?.commands.some((c) => c.hfSlot === 'h' && c.hfGeneration === id);
    for (let i = 0; i < 200 && !head(opening.id); i++) await sleep(25);
    assert.ok(head(opening.id), 'the opening PDF supplies the isolated worksheet head');
    const drawn = { list: listOf(engine, 2), srcRev: engine.srcRev, id: opening.id };
    await editTo(engine, SOURCE.replaceAll('Alpha lesson', 'Gamma lesson'));
    const marked = { list: listOf(engine, 2), srcRev: engine.srcRev };
    const current = await engine.canonical.ensure(engine.getSource(), engine.srcRev);
    for (let i = 0; i < 200 && !head(current.id); i++) await sleep(25);
    assert.ok(head(current.id), 'the current exact PDF supplies the revised head');
    const exact = await engine.canonical.pageTexts(current.id);
    assert.match(exact[1], /Gamma lesson/);
    await editTo(engine, engine.getSource().replace('Level B.', 'Level C, with a hint.'));
    const own = { list: listOf(engine, 2), srcRev: engine.srcRev };
    lists = { boot, drawn, marked, own, geometry: { ...engine.geometry } };
    return lists;
  } finally {
    if (hotMax === undefined) delete process.env.TDOM_RENDER_HOT_MAX;
    else process.env.TDOM_RENDER_HOT_MAX = hotMax;
    await engine.close().catch(() => {});
    rmSync(root, { recursive: true, force: true });
  }
}

test('a page\'s list carries its body: the same when an owed block is drawn and when only its head changes, another when its block is edited',
  { skip: !texReady && 'lualatex not installed', timeout: 600_000 }, async () => {
    const { boot, drawn, marked, own } = await worksheetLists();
    assert.equal(typeof boot.list.body, 'string');
    assert.deepEqual(owedOf(drawn.list), [], 'the warm drew the Data box');
    assert.notEqual(drawn.list.hash, boot.list.hash, 'the page was sent again');
    assert.equal(drawn.list.body, boot.list.body, 'a block drawn is the same body as the block owed');
    assert.notEqual(furnitureOf(marked.list), furnitureOf(drawn.list), 'the edit on page 1 changed the worksheet page\'s head');
    assert.ok(!marked.list.commands.some((c) => c.hfSlot === 'h' && c.hfGeneration === drawn.id),
      'the previous PDF head is withheld before canonical');
    assert.equal(marked.list.body, boot.list.body, 'a head changed is the same body');
    assert.notEqual(own.list.body, boot.list.body, 'an edit of the Data box is another body');
  });

// The viewer, fed the engine's lists: its own renderPage and updateCanonState,
// the DOM and the image loads faked (as tests/owed-page-paper.test.js).
const app = readFileSync(new URL('../web/app.js', import.meta.url), 'utf8');
const span = (start, end) => app.slice(app.indexOf(start), app.indexOf(end, app.indexOf(start) + start.length));
function fakePage(n) {
  const classes = new Set(['page']);
  const page = {
    dataset: { page: String(n) }, style: { aspectRatio: '420 / 595' }, isConnected: true, children: [],
    classList: {
      add: (name) => classes.add(name), remove: (...names) => names.forEach((name) => classes.delete(name)),
      contains: (name) => classes.has(name),
      toggle: (name, on = !classes.has(name)) => { if (on) classes.add(name); else classes.delete(name); return on; },
    },
    querySelector(selector) {
      if (selector.startsWith(':scope > svg')) return page.children.find((c) => c.kind === 'svg') ?? null;
      if (selector === 'img.canon') return page.children.find((c) => c.kind === 'canon') ?? null;
      return null;
    },
    querySelectorAll: (selector) => selector === ':scope > .chunkwin' ? page.children.filter((c) => c.kind === 'chunkwin') : [],
    getBoundingClientRect: () => ({ top: (n - 1) * 620, bottom: (n - 1) * 620 + 595, left: 0, width: 420, height: 595 }),
    append(child) { page.children.push(child); },
    add(kind, extra = {}) {
      const child = { kind, dataset: {}, style: {}, ...extra, remove() { page.children = page.children.filter((c) => c !== child); } };
      page.children.push(child);
      return child;
    },
  };
  return page;
}
function viewerOf(pageCount, geometry) {
  const viewer = provisionalViewer([], 0);
  Object.assign(viewer, {
    geometry, mode: 'structured', embeddedHost: false, directEditor: null,
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
    presentedDomSnapshots: new Map(), presentedSnapshotKey: (id, rev) => `1:${Number(id)}:${Number(rev)}`,
    queueCanonicalImageSwap(page, src, paper, generation) {
      const img = page.querySelector('img.canon') ?? page.add('canon');
      img.dataset.src = src;
      page.dataset.canonPresentedSrc = src;
      page.dataset.canonPresentedId = String(generation?.id ?? '');
      page.dataset.canonPresentedRev = String(generation?.rev ?? '');
      page.classList.remove('awaiting-canonical');
      return img;
    },
  });
  viewer.pageDivs.clear();
  for (let n = 1; n <= pageCount; n++) viewer.pageDivs.set(n, fakePage(n));
  vm.runInContext(`${span('const listOwesExactInk', '// The text of a line whose exact picture is shown only where it has to be')}\n` +
    `${span('function updateCanonState', 'function updateBadge')}\n` +
    'this.renderPage = renderPage; this.updateCanonState = updateCanonState; this.noteListContent = noteListContent;', viewer);
  viewer.canonicalAt = (rev, id = rev) => { viewer.canonical = { id, rev, pageCount }; };
  // what tryCommitProvisionalStages does with a ready stage of page `n`, then its updateCanonState
  viewer.commit = (n, dl) => {
    const page = viewer.pageDivs.get(n);
    viewer.pageDirtyRev.set(n, viewer.appliedSrcRev);
    viewer.noteListContent(page, dl, viewer.appliedSrcRev, false);
    page.children = page.children.filter((c) => c.kind === 'canon');
    page.add('svg');
    page.provisionalDl = dl;
    page.dataset.prov = '1';
    page.dataset.provRev = String(viewer.appliedSrcRev);
    delete page.dataset.provPending;
    page.provisionalDropped = false;
    viewer.provisionalStages.delete(n);
    viewer.updateCanonState(n);
  };
  return viewer;
}

test('the viewer keeps the exact page while the body is the one it shows: an owed block drawn, a head changed elsewhere',
  { skip: !texReady && 'lualatex not installed', timeout: 600_000 }, async () => {
    const { boot, drawn, marked, own, geometry } = await worksheetLists();
    const viewer = viewerOf(3, geometry);
    const page = viewer.pageDivs.get(2);
    // the boot: the worksheet page owes its Data box; the canonical page of the boot's source lands
    viewer.appliedSrcRev = boot.srcRev;
    viewer.renderPage(boot.list);
    viewer.canonicalAt(boot.srcRev, drawn.id);
    viewer.updateCanonState(2);
    assert.ok(page.classList.contains('is-final'), 'the exact page, with its rules');
    // a keystroke elsewhere, then the warm: the page's list is complete and is committed
    viewer.appliedSrcRev = boot.srcRev + 1;
    viewer.commit(2, drawn.list);
    assert.ok(page.classList.contains('is-final'), 'the exact page stays: the rules with it');
    // an edit on page 1 changes only the worksheet page's head
    viewer.appliedSrcRev = marked.srcRev;
    viewer.commit(2, marked.list);
    assert.ok(page.classList.contains('is-final'), 'the body stays the exact page\'s');
    assert.notEqual(page.querySelector('img.canon').style.clipPath ?? '', '', 'its old head is not shown');
    // an edit of the page's own Data box: its own list from then on
    viewer.appliedSrcRev = own.srcRev;
    viewer.commit(2, own.list);
    assert.ok(!page.classList.contains('is-final'), 'another body: the resident list');
  });
