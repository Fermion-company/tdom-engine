// tex64-internal #121 (round 10): a picture drawn against `current page` (a
// cover, a page-anchored mark) in the live preview (docs/08 §8.5a, docs/10
// §10.4q, engine/checkpoint/page-art.js).
//  - A: a block's exact picture with ink far outside its tight page, or whose
//    pictures read positions on the page, is never shown through its lines
//    that hold no text; they are owed (`pending-exact`) until something correct
//    exists
//  - B: such a block is rendered again from its own checkpoint on the paper,
//    its lines where the page builder put them, \c@page the folio of each
//    page, pgf's positions carried until they settle; a page that holds only
//    such blocks shows their pictures whole, any other through their lines
//  - a cover moved by a page typed in before it matches the full compile; an
//    overlay printing \thepage or testing the parity reads its new page; one
//    that reads another block's picture, a running mark or a page reference
//    stays owed after a bounded number of tries; ordinary pictures are not
//    touched; nothing outlives close

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CheckpointEngine } from '../engine/checkpoint/engine-v3.js';
import { buildDisplayList } from '../engine/checkpoint/display-list.js';
import { artPrelude, farInkOf, inkBounds, FAR_INK_BP } from '../engine/checkpoint/page-art.js';
import { adoptGalleyBlock, samePdf } from '../engine/checkpoint/galley-adoption.js';
import { isoGalley } from '../engine/checkpoint/rescue-block.js';
import { drain } from '../tools/harness.mjs';

const texReady = spawnSync('lualatex', ['--version']).status === 0;
const tool = (name, args) => spawnSync(name, args).status === 0;
const pixelsReady = texReady && tool('rsvg-convert', ['--version']) && tool('magick', ['-version']) && tool('pdftocairo', ['-v']);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const T = String.raw;

let runs = 0;
const withEngine = async (source, fn) => {
  // inside the repository like the other engine tests (the fork shim cached there)
  const root = fileURLToPath(new URL(`../.tdom-v3-test-cover-${++runs}`, import.meta.url));
  rmSync(root, { recursive: true, force: true });
  const cached = fileURLToPath(new URL('../.tdom-v3-test/', import.meta.url));
  if (existsSync(path.join(cached, 'tdomfork.so'))) {
    mkdirSync(root, { recursive: true });
    for (const f of ['tdomfork.so', 'tdomfork.so.sha256']) copyFileSync(path.join(cached, f), path.join(root, f));
  }
  const engine = new CheckpointEngine({ workDir: root });
  engine.canonical.schedule = () => {};
  try {
    await engine.open(source);
    await settle(engine);
    await fn(engine, root);
  } finally {
    await engine.close().catch(() => {});
    rmSync(root, { recursive: true, force: true });
  }
};
const idle = (e) => !(e.hfPending || e.renderWant?.size || e.renderPumping > 0 || e.isoRenderPending?.size ||
  e.artWant?.size || e.artPumping);
async function settle(engine) {
  await drain(engine, 120_000);
  for (let i = 0; i < 400 && !idle(engine); i++) await sleep(100);
  await sleep(300);
  for (let i = 0; i < 400 && !idle(engine); i++) await sleep(100);
}
const until = async (cond, what, tries = 600) => {
  for (let i = 0; i < tries && !cond(); i++) await sleep(50);
  assert.ok(cond(), what);
};
const chunkCommands = (list) => list.commands.filter((c) => c.op === 'chunk' && !String(c.chunk).startsWith('__hf'));
// a page shows a picture on the paper whole
const shownWhole = (list) => chunkCommands(list).some((c) => /@art\d+$/.test(c.chunk) && c.x === 0 && c.y === 0 && c.sy === 0 && c.h > 500);

// The page's exact-chunk windows on white, and the full compile's page, both
// through pdftocairo's SVG and librsvg at 72 dpi; the pixels that differ (8 %).
function pixelsAgainstFullCompile(engine, n, dir) {
  mkdirSync(dir, { recursive: true });
  const W = Math.ceil(engine.geometry.paperwidth), H = Math.ceil(engine.geometry.paperheight);
  const args = ['-size', `${W}x${H}`, 'xc:white'];
  for (const [i, c] of chunkCommands(engine.getDisplayLists()[n - 1]).entries()) {
    const base = path.join(dir, `p${n}-${i}`);
    writeFileSync(base + '.svg', engine.chunks.get(c.chunk).svg);
    execFileSync('rsvg-convert', ['-d', '72', '-p', '72', '-o', base + '.png', base + '.svg']);
    execFileSync('magick', [base + '.png', '-crop', `${Math.max(1, Math.round(c.w))}x${Math.max(1, Math.round(c.h))}+0+${Math.round(c.sy)}`,
      '+repage', base + '-w.png']);
    args.push(base + '-w.png', '-geometry', `+${Math.round(c.x)}+${Math.round(c.y)}`, '-composite');
  }
  const mine = path.join(dir, `p${n}.png`);
  execFileSync('magick', [...args, mine]);
  const pdf = path.join(dir, 'full.pdf');
  writeFileSync(pdf, engine.canonical.pdfBytes());
  execFileSync('pdftocairo', ['-svg', '-f', String(n), '-l', String(n), '-noshrink', '-nocenter', pdf, path.join(dir, `full-${n}.svg`)]);
  execFileSync('rsvg-convert', ['-d', '72', '-p', '72', '-b', 'white', '-o', path.join(dir, `full-${n}.png`), path.join(dir, `full-${n}.svg`)]);
  const out = spawnSync('compare', ['-metric', 'AE', '-fuzz', '8%', path.join(dir, `full-${n}.png`), mine, 'null:']);
  return { differ: Number(String(out.stderr).trim().split(/\s/)[0]), of: W * H };
}

const PRE = T`\documentclass[a4paper]{article}
\usepackage{tikz,fancyhdr}
\pagestyle{fancy}\fancyhf{}\fancyhead[C]{Head}\fancyfoot[C]{\thepage}
\NewDocumentCommand{\CoverPage}{m}{\thispagestyle{empty}\null\begin{tikzpicture}[remember picture,overlay]#1\end{tikzpicture}}
`;
const cover = (fill, words) => T`\clearpage
\CoverPage{%
  \begin{scope}[shift={(current page.south west)}, x=1mm, y=1mm]
    \fill[${fill}] (0,0) rectangle (210,297);
    \foreach \i in {0,10,...,210} \draw[black!25] (\i,0) -- (\i,297);
    \fill[blue!60] (150,250) circle (6); \fill[blue!60] (40,40) circle (6);
    \node[anchor=south west] at (20,20) {${words}};
  \end{scope}
}`;
// p1 front cover | p2 text with a page-anchored mark | p3 a full-height picture
// that is not an overlay | p4 text | p5 back cover (the cover's text and the
// text before it in one block)
const COVERS = PRE + T`\begin{document}
` + cover('yellow!25', 'FRONT COVER') + T`
\clearpage
Text on page two.\tikz[remember picture,overlay]\node[fill=red!40,anchor=north east] at (current page.north east) {CORNER MARK};
More text on page two.

\clearpage
\noindent\begin{tikzpicture}\fill[green!20] (0,0) rectangle (\linewidth,0.9\textheight);\node at (0.5\linewidth,0.45\textheight) {CHAPTER PICTURE};\end{tikzpicture}

\clearpage
Text on page four.
` + cover('cyan!20', 'BACK COVER') + T`
\end{document}
`;

test('ink bounds: drawn paths, glyphs and images under their transforms; definitions and clips are not ink', () => {
  const svg = `<svg width="10pt" height="10pt" viewBox="0 0 10 10"><defs><g id="glyph-0-0"><path d="M 900 900 L 950 950"/></g>` +
    `<clipPath id="clip-0"><path d="M -500 -500 L 500 500 Z"/></clipPath></defs>` +
    `<g clip-path="url(#clip-0)"><path d="M 0 0 L 5 5 C 6 6 7 7 8 8 Z" transform="matrix(1, 0, 0, -1, 10, 20)"/></g>` +
    `<g fill="rgb(0%, 0%, 0%)"><use xlink:href="#glyph-0-0" x="3" y="4"/></g>` +
    `<g transform="matrix(2, 0, 0, 2, 100, 0)"><image width="5" height="5" x="0" y="0"/></g></svg>`;
  assert.deepEqual(inkBounds(svg), { x0: 3, y0: 0, x1: 110, y1: 20 });
  assert.equal(inkBounds('<svg viewBox="0 0 1 1"></svg>'), null);
});

test('a tight picture is page art when its ink is far outside it or its pictures read positions on the page', () => {
  const box = (y0, y1) => `<svg viewBox="0 0 300 40"><path d="M 10 ${y0} L 20 ${y1}"/></svg>`;
  assert.equal(farInkOf(box(0, 40), 300, 40), null);
  assert.equal(farInkOf(box(-FAR_INK_BP + 1, 40 + FAR_INK_BP - 1), 300, 40), null, 'an overhang is the block\'s own');
  assert.deepEqual(farInkOf(box(-700, 30), 300, 40), { x0: 10, y0: -700, x1: 20, y1: 30 });
  // art wholly outside the tight page: the converter keeps nothing of it
  assert.deepEqual(farInkOf('<svg viewBox="0 0 300 40"></svg>', 300, 40, ['pgfpageorigin', 'pgfid3']), { reads: 2 });
});

test('a page-art render carries the positions of the pass before as the .aux would define them, and the first page\'s folio', () => {
  const plan = { key: 'k', segs: [{ folio: 7, lines: [[1, 9.96], [2, 21.92]] }, { folio: 8, lines: [[4, 0]] }] };
  const first = artPrelude(plan);
  assert.match(first, /TDOM_PAGE_ART=\{segs=\{\{f=7,lines=\{\{1,655186\},\{2,1441936\}\}\},\{f=8,lines=\{\{4,0\}\}\}\}\}/);
  assert.match(first, /\\hoffset=0pt\\voffset=0pt/);
  assert.match(first, /\\global\\csname c@page\\endcsname=7\\relax/);
  assert.doesNotMatch(first, /pgf@sys@pdf@mark@pos@/);
  const second = artPrelude(plan, new Map([['pgfid4', [9192734, 45663824]]]));
  // (not \pgfsyspdfmark: its rerun check is \@newl@bel, which only the preamble may run)
  assert.match(second, /\\expandafter\\gdef\\csname pgf@sys@pdf@mark@pos@pgfid4\\endcsname\{\\pgfqpoint\{9192734sp\}\{45663824sp\}\}/);
  assert.doesNotMatch(second, /\\pgfsyspdfmark\{/);
});

// A display list over a hand-made page: block b1's lines `lines` ([li, y, h,
// d, text]) on page `number`, with b2's text line too when `shared`.
function artDisplay({ chunks, lines, shared = false, folio = 5 }) {
  const geometry = { oddsidemargin: 0, topmargin: 0, headheight: 12, headsep: 25, textwidth: 345, textheight: 550,
    paperwidth: 595, paperheight: 842, footskip: 30 };
  const draw = lines.map(([li, y, h, d, text]) => ({
    y, u: { blockId: 'b1', li, h, d, ln: { boxH: h, descent: d, runs: text ? [{ t: 'Text', x: 0, f: 1, s: 10, dy: 0, w: 20 }] : [],
      gfxChunk: { blockId: 'b1', yOff: 10 + li * 12, w: 345 } } },
  }));
  if (shared) draw.push({ y: 300, u: { blockId: 'b2', li: 0, h: 7, d: 2, ln: { boxH: 7, descent: 2, runs: [{ t: 'Other', x: 0, f: 1, s: 10, dy: 0, w: 20 }] } } });
  const page = { number: 3, folio, draw, evs: [] };
  const wanted = [];
  chunks.pageArtWanted = (id) => wanted.push(id);
  const list = buildDisplayList(page, { geometry, chunks, hf: new Map(), fonts: new Map([[1, { family: 'f1' }]]), twinMetrics: null,
    hfSig: '', hfEntryShown: () => false, hfBandShown: () => false, hfProvisional: () => false });
  return { list, wanted };
}
const tight = (extra = {}) => ({ svg: '<svg/>', wBp: 1035, hBp: 80, xBp: -345, v: 3, forGalley: 'g1', farInk: { reads: 1 }, ...extra });
const T0 = 72 + 12 + 25;

test('A: with no picture on the paper for its places, a page-art block\'s lines without text are owed and the others keep the tight picture', () => {
  const chunks = new Map([['b1', tight()]]);
  const { list, wanted } = artDisplay({ chunks, lines: [[1, 10, 0, 0, false], [2, 22, 0, 0, true], [3, 40, 7, 2, true]] });
  const owed = list.commands.filter((c) => c.op === 'pending-exact');
  assert.equal(owed.length, 2, 'the zero-height lines: no band of the tight picture can be right');
  assert.deepEqual(owed.map((c) => c.y), [T0 + 10, T0 + 22]);
  const windows = chunkCommands(list);
  assert.equal(windows.length, 1);
  assert.equal(windows[0].chunk, 'b1', 'the text line keeps the tight picture');
  assert.equal(windows[0].line, 3);
  assert.deepEqual([...new Set(wanted)], ['b1'], 'the picture on the paper is asked for');
});

test('B: a page that holds only the block shows its picture whole; a shared page through its lines; another place is A again', () => {
  const seg = (extra = {}) => ({ folio: 5, lines: [[1, 10], [2, 22]], chunk: 'b1@art1', foot: false, empty: false, ...extra });
  const art = (s) => ({ key: 'k', forGalley: 'g1', segs: [s] });
  const picture = { svg: '<svg/>', wBp: 595, hBp: 842, xBp: 0, v: 2, forGalley: 'g1', pageArt: 1 };
  const lines = [[1, 10, 0, 0, false], [2, 22, 0, 0, false]];
  let { list, wanted } = artDisplay({ chunks: new Map([['b1', tight({ art: art(seg()) })], ['b1@art1', picture]]), lines });
  assert.deepEqual(chunkCommands(list).map(({ chunk, x, y, w, h, sy, ch }) => ({ chunk, x, y, w, h, sy, ch })),
    [{ chunk: 'b1@art1', x: 0, y: 0, w: 595, h: 842, sy: 0, ch: 842 }]);
  assert.equal(list.commands.filter((c) => c.op === 'pending-exact').length, 0);
  assert.deepEqual(wanted, []);
  ({ list } = artDisplay({ chunks: new Map([['b1', tight({ art: art(seg()) })], ['b1@art1', picture]]), lines, shared: true }));
  assert.deepEqual(chunkCommands(list).map(({ chunk, y, h, sy }) => ({ chunk, y, h, sy })),
    [{ chunk: 'b1@art1', y: T0 + 10 - 2, h: 16, sy: T0 + 10 - 2 }], 'the bands of its lines, from the picture on the paper');
  // art under a foot that prints: the foot would stand over it on the paper
  ({ list } = artDisplay({ chunks: new Map([['b1', tight({ art: art(seg({ foot: true })) })], ['b1@art1', picture]]), lines }));
  assert.equal(chunkCommands(list)[0].y, T0 + 8);
  ({ list } = artDisplay({ chunks: new Map([['b1', tight({ art: art(seg({ foot: true, empty: true })) })], ['b1@art1', picture]]), lines }));
  assert.equal(chunkCommands(list)[0].y, 0, '\\thispagestyle{empty}: no foot');
  // made for another folio, or other places
  for (const other of [seg({ folio: 6 }), seg({ lines: [[1, 11], [2, 22]] })]) {
    ({ list, wanted } = artDisplay({ chunks: new Map([['b1', tight({ art: art(other) })], ['b1@art1', picture]]), lines }));
    assert.equal(chunkCommands(list).length, 0);
    assert.equal(list.commands.filter((c) => c.op === 'pending-exact').length, 2);
    assert.deepEqual(wanted, ['b1']);
  }
  // made for an earlier galley of the block
  ({ list } = artDisplay({ chunks: new Map([['b1', tight({ forGalley: 'g2', art: art(seg()) })], ['b1@art1', picture]]), lines }));
  assert.equal(chunkCommands(list).length, 0);
});

test('two page-art blocks on one page are both shown whole, in the page\'s order, once both have their pictures', () => {
  const geometry = { oddsidemargin: 0, topmargin: 0, headheight: 12, headsep: 25, textwidth: 345, textheight: 550,
    paperwidth: 595, paperheight: 842, footskip: 30 };
  const line = (blockId, li, y) => ({ y, u: { blockId, li, h: 0, d: 0, ln: { boxH: 0, descent: 0, runs: [],
    gfxChunk: { blockId, yOff: 10, w: 345 } } } });
  const page = { number: 2, folio: 2, draw: [line('b1', 1, 10), line('b2', 0, 22)], evs: [] };
  const art = (id, top) => ({ key: id, forGalley: 'g', segs: [{ folio: 2, lines: [[id === 'b1' ? 1 : 0, top]], chunk: `${id}@art1`, foot: true, empty: true }] });
  const picture = { svg: '<svg/>', wBp: 595, hBp: 842, xBp: 0, v: 1, forGalley: 'g', pageArt: 1 };
  const build = (chunks) => buildDisplayList(page, { geometry, chunks, hf: new Map(), fonts: new Map(), twinMetrics: null, hfSig: '',
    hfEntryShown: () => false, hfBandShown: () => false, hfProvisional: () => false });
  const both = new Map([['b1', tight({ forGalley: 'g', art: art('b1', 10) })], ['b1@art1', picture],
    ['b2', tight({ forGalley: 'g', art: art('b2', 22) })], ['b2@art1', picture]]);
  assert.deepEqual(chunkCommands(build(both)).map((c) => [c.chunk, c.y, c.h]), [['b1@art1', 0, 842], ['b2@art1', 0, 842]]);
  // one of them without its picture: the other through its line, the first owed
  const one = new Map([...both].filter(([key]) => key !== 'b2@art1'));
  one.set('b2', tight({ forGalley: 'g' }));
  const list = build(one);
  assert.deepEqual(chunkCommands(list).map((c) => [c.chunk, c.y]), [['b1@art1', T0 + 8]]);
  assert.deepEqual(list.commands.filter((c) => c.op === 'pending-exact').map((c) => c.src), ['b2']);
});

test('covers moved by a page typed in before them match the full compile; the mark in the text is on its page; close leaves nothing',
  { skip: !pixelsReady && 'lualatex, librsvg, ImageMagick or Poppler not installed' }, async () => {
    let rootPid = null;
    await withEngine(COVERS, async (engine, root) => {
      rootPid = engine.root?.pid ?? null;
      const lists = () => engine.getDisplayLists();
      await until(() => shownWhole(lists()[0]) && shownWhole(lists()[4]), 'both covers show their pictures on the paper');
      const before = engine.artStats.renders;
      const at = engine.getSource().indexOf('\\begin{document}') + '\\begin{document}\n'.length;
      // (in the cover's block, as in the booklet probe: the front cover moves with it)
      await engine.edit(at, at, 'A page typed in before everything.\n\\clearpage\n');
      // no page-art render before the pause (QUIET_MS after the update, and the update has just ended)
      assert.equal(engine.artStats.renders, before, 'a page-art render waits for the pause');
      // Until the pictures on the paper land, no page shows a page-art block's tight picture through a
      // line without text (A). Sampled, not timed: under load the page can first be laid out from the
      // block's previous galley (#103 held), where the cover has not moved yet and nothing is owed.
      const wrong = [];
      const t0 = Date.now();
      await until(() => {
        for (const list of lists()) {
          for (const c of chunkCommands(list)) {
            if (engine.chunks.get(c.chunk)?.farInk && c.h <= 4.01) wrong.push(`p${list.page} ${c.chunk} h${c.h}`);
          }
        }
        return shownWhole(lists()[1]) && shownWhole(lists()[5]);
      }, 'the moved covers show their pictures on the paper');
      assert.deepEqual(wrong, [], 'a strip of a tight picture drawn against `current page`');
      assert.ok(Date.now() - t0 < 30_000);
      await settle(engine);
      // the text page with the mark, and the back cover's text page: each its block's own picture on the paper
      for (const n of [3, 5]) assert.ok(shownWhole(lists()[n - 1]), `page ${n} shows its picture on the paper`);
      assert.ok(!chunkCommands(lists()[4]).some((c) => c.chunk === 'b3'), 'no tight picture (with the cover art behind) on the back cover\'s text page');
      // the non-overlay chapter picture keeps its tight picture
      assert.deepEqual(chunkCommands(lists()[3]).map((c) => c.chunk), ['b2']);
      assert.equal(engine.chunks.get('b2').farInk, undefined);
      await engine.canonical.ensure(engine.getSource(), engine.srcRev);
      for (const n of [2, 6]) {
        const { differ, of } = pixelsAgainstFullCompile(engine, n, path.join(root, 'pixels'));
        assert.ok(differ <= of * 0.002, `page ${n}: ${differ} of ${of} pixels differ from the full compile`);
      }
      assert.deepEqual(engine.diagnostics.filter((d) => /page art/.test(d)), []);
    });
    if (rootPid) {
      // the root's process group (every checkpoint and render child) is gone
      await until(() => { try { process.kill(-rootPid, 0); return false; } catch { return true; } }, 'no child outlives close', 100);
    }
  });

test('an overlay that prints \\thepage, and one that draws by the page\'s parity, read the page they are on after a shift',
  { skip: !pixelsReady && 'lualatex, librsvg, ImageMagick or Poppler not installed' }, async () => {
    const source = PRE + T`\begin{document}
Text on page one.

\clearpage
\thispagestyle{empty}\null\begin{tikzpicture}[remember picture,overlay]
  \node[font=\Huge, anchor=center] at (current page.center) {PAGE \thepage};
\end{tikzpicture}

\clearpage
\thispagestyle{empty}\null\begin{tikzpicture}[remember picture,overlay]
  \ifodd\value{page}\fill[red!40] (current page.north west) rectangle ([yshift=-3cm]current page.north east);
  \else\fill[green!40] (current page.south west) rectangle ([yshift=3cm]current page.south east);\fi
\end{tikzpicture}

\clearpage
Last text.
\end{document}
`;
    await withEngine(source, async (engine, root) => {
      const lists = () => engine.getDisplayLists();
      await until(() => shownWhole(lists()[1]) && shownWhole(lists()[2]), 'the overlays show their pictures on the paper');
      const at = engine.getSource().indexOf('\\begin{document}') + '\\begin{document}\n'.length;
      await engine.edit(at, at, 'An inserted page.\n\n\\clearpage\n');
      await until(() => lists().length === 5 && shownWhole(lists()[2]) && shownWhole(lists()[3]), 'the moved overlays show their pictures');
      await settle(engine);
      await engine.canonical.ensure(engine.getSource(), engine.srcRev);
      const text = execFileSync('pdftotext', ['-', '-'], { input: engine.chunks.get(engine.chunks.get('b2').art.segs[0].chunk).editPdf }).toString();
      assert.match(text, /PAGE 3/);
      for (const n of [3, 4]) {
        const { differ, of } = pixelsAgainstFullCompile(engine, n, path.join(root, 'pixels'));
        assert.ok(differ <= of * 0.002, `page ${n}: ${differ} of ${of} pixels differ from the full compile`);
      }
    });
  });

test('a cover that reads another block\'s picture, a running mark or a page reference stays owed, tried a bounded number of times',
  { skip: !texReady && 'lualatex not installed' }, async () => {
    const doc = (first, art) => PRE + T`\begin{document}
` + first + T`

\clearpage
\CoverPage{` + art + T`}

\clearpage
Last text.\label{last}
\end{document}
`;
    for (const [source, read] of [
      [doc(T`Anchor \tikz[remember picture]\node (anchor) {A};`, T`\draw[red, line width=2pt] (anchor) -- (current page.center);`), 'pgfid'],
      [doc(T`\section{Alpha}Text.`, T`\node[font=\Huge] at (current page.center) {MARK \leftmark};`), 'mark:left'],
      [doc('Text.', T`\node[font=\Huge] at (current page.center) {SEE \pageref{last}};`), 'ref:page'],
    ]) {
      await withEngine(source, async (engine) => {
        const lists = () => engine.getDisplayLists();
        await until(() => (engine.artStats?.failed ?? 0) >= 2 && idle(engine), `${read}: the render is tried and given up`);
        const tried = engine.artStats.renders;
        for (const { failed } of engine.artTries.values()) {
          assert.ok(failed <= 2, `${read}: ${failed} failed page-art attempts for one layout plan`);
        }
        assert.ok(lists()[1].commands.some((c) => c.op === 'pending-exact' && c.src === 'b2'), `${read}: the cover is owed`);
        assert.ok(!chunkCommands(lists()[1]).length, `${read}: nothing drawn for the cover`);
        assert.ok(engine.diagnostics.some((d) => d.includes('reads what the page around it holds') && d.includes(read)), read);
        // no loop: nothing more without a new place
        await sleep(3000);
        assert.equal(engine.artStats.renders, tried);
      });
    }
});

test('ordinary pictures are not page art: no render on the paper, the tight picture as before', { skip: !texReady && 'lualatex not installed' }, async () => {
  const source = T`\documentclass{article}
\usepackage{tikz}
\usepackage[most]{tcolorbox}
\begin{document}
\begin{tikzpicture}\draw[thick] (0,0) rectangle (4,2);\node at (2,1) {Box};\end{tikzpicture}

\begin{tcolorbox}[enhanced, title=Note, drop shadow]Framed text.\end{tcolorbox}

\begin{tikzpicture}[overlay]\draw (0,0) -- (1,0.3);\end{tikzpicture}Text after an overlay that stays near its line.
\end{document}
`;
  await withEngine(source, async (engine) => {
    for (const [key, chunk] of engine.chunks) assert.equal(chunk?.farInk, undefined, `${key} is not page art`);
    assert.equal(engine.artStats?.renders ?? 0, 0);
    const windows = engine.getDisplayLists().flatMap(chunkCommands);
    assert.ok(windows.length >= 3);
    assert.ok(windows.every((c) => !/@art/.test(c.chunk)));
  });
});

// tex64-internal #121 (round 10, booklet p26): a rescue the walk passes over is adopted again from the
// isolated-compile cache. Read back from the disk cache its PDF is the same bytes in a new buffer; taken
// for a new picture, every page holding a rescue was sent to the viewer again after a lesson was typed
// before the appendix, and a page whose other pictures had never been rendered could not be shown until
// the next canonical. Same bytes: same chunk, same version (galley-adoption.js samePdf).
test('a rescue adopted again with the same pixels read back from the disk cache keeps its chunk and version',
  { skip: !texReady && 'lualatex not installed' }, async () => {
    const source = T`\documentclass{article}
\usepackage{multicol,tikz}
\begin{document}
First page text.

\clearpage
\begin{multicols}{2}
Left column text with a picture \tikz\draw (0,0) -- (1,0.5); and more words to fill the columns.
Right column text, a second paragraph for the second column of the box.
\end{multicols}

\clearpage
Last page.
\end{document}
`;
    await withEngine(source, async (engine) => {
      await until(() => engine.blocks.some((b) => b.rescued) && !engine.rescueQueue?.size, 'the multicols block is rescued');
      const block = engine.blocks.find((b) => b.rescued);
      const [key, iso] = [...engine.isoCache].find(([, r]) => r.chunks?.some((c) => c.key === block.id || c.key.startsWith(block.id + '@'))) ?? [];
      assert.ok(iso, 'the rescue result is in the memory cache');
      const before = new Map(iso.chunks.map((c) => [c.key, engine.chunks.get(c.key)]));
      assert.ok([...before.values()].every(Boolean));
      // the memory cache lets it go; the disk cache gives it back
      engine.isoCache.clear();
      const stored = engine.isoDiskCache?.get(key);
      assert.ok(stored, 'the rescue result is in the disk cache');
      for (const c of stored.chunks) {
        assert.notEqual(c.editPdf, before.get(c.key).editPdf, 'a new buffer');
        assert.ok(samePdf(c.editPdf, before.get(c.key).editPdf), 'the same bytes');
      }
      const adopt = (r) => adoptGalleyBlock(block, isoGalley(r), {
        counters: engine.counters, chunks: engine.chunks, headingRe: /^$/, applyFidelity: () => {},
      });
      adopt(stored);
      for (const [k, chunk] of before) {
        assert.equal(engine.chunks.get(k), chunk, `${k}: the same chunk`);
        assert.equal(engine.chunks.get(k).forGalley, block.galleyHash);
      }
      // (other bytes are another picture: a new version, as before)
      const changed = engine.isoDiskCache.get(key);
      const first = changed.chunks[0];
      first.editPdf = Buffer.from(first.editPdf);
      first.editPdf[first.editPdf.length - 2] ^= 1;
      adopt(changed);
      assert.equal(engine.chunks.get(first.key).v, before.get(first.key).v + 1);
    });
  });

// tex64-internal #121 (round 10, booklet p26): a long document's boot renders no exact picture, and a page of
// them the viewer shows provisionally owes their ink until a warm of the page renders them. The viewer warms the
// page it shows; a reader who scrolls on within a second leaves that warm overtaken by the next page's, and the
// page kept an older paper (the app probe: pages 25-28 half a second each). An overtaken page is warmed again once
// nothing else runs (page-warm-queue.js).
test('a page whose warm the next page\'s overtook is warmed again when things are quiet, and its pictures are made',
  { skip: !texReady && 'lualatex not installed' }, async () => {
    const box = (k) => T`\clearpage
\begin{tcolorbox}[enhanced, title=Box ${k}]Text of box ${k}. \tikz\draw (0,0) -- (1,.4);\end{tcolorbox}`;
    const source = T`\documentclass{article}
\usepackage{tikz}
\usepackage[most]{tcolorbox}
\begin{document}
First page.
` + [2, 3, 4].map(box).join('\n\n') + T`
\end{document}
`;
    // (the boot of a long document: no block's exact picture is queued)
    const hotMax = process.env.TDOM_RENDER_HOT_MAX;
    process.env.TDOM_RENDER_HOT_MAX = '0';
    try {
      await withEngine(source, async (engine) => {
        const { pageOwesExact } = await import('../engine/checkpoint/page-warm-queue.js');
        await until(() => engine.pages.length === 4, 'four pages');
        assert.ok(pageOwesExact(engine, 2) && pageOwesExact(engine, 3), 'the boxes are not rendered at the boot');
        // the reader looks at page 2, then at page 3 at once
        const two = engine.warmPage(2);
        const three = engine.warmPage(3);
        assert.equal((await two).status, 'superseded');
        assert.equal((await three).status, 'ready');
        await until(() => !pageOwesExact(engine, 3), 'page 3 has its picture');
        await until(() => !pageOwesExact(engine, 2), 'page 2, overtaken, has its picture too');
        assert.ok(engine.overtakenStats?.warms >= 1);
        assert.ok(pageOwesExact(engine, 4), 'a page nobody looked at is left to canonical');
        assert.equal(engine.overtakenPages?.size ?? 0, 0);
      });
    } finally {
      if (hotMax === undefined) delete process.env.TDOM_RENDER_HOT_MAX;
      else process.env.TDOM_RENDER_HOT_MAX = hotMax;
    }
  });
