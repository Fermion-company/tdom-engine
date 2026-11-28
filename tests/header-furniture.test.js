// tdom-engine #17/#18, tex64-internal #121: the provisional page's running heads
// and folios (docs/10 §10.7a).
//  - the header job (one job over every page's spec, v0.1.32's) returns text runs
//    and rules: \fancyhead set in the body reaches it, luacolor colours reach the
//    runs, the floats that landed and a float page's style are in its spec
//  - a head or foot that draws is shown from the canonical page's own band, bound
//    to the page it was cut from, or not at all; one stateless predicate over what
//    was recorded of it (F4): the source it was compiled from; or the runs job of the
//    current layout landed and the band's own fingerprint is the page's; or that job
//    pending and every spec component that differs measured not to change the
//    template's head and foot (F2). Across sources only on pages whose
//    correspondence was verified (F6), where c53846b held a band, before a changed
//    page-counter assignment (F7); never another page's band
//  - the fingerprint is the whole typeset entry, literals included (F1); a float
//    page after a body \floatpagestyle gets its canonical bands (F5)

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CheckpointEngine } from '../engine/checkpoint/engine-v3.js';
import { buildDisplayList, hfBandChunkKey, hfRenderChunkKey, hfSlotExtent } from '../engine/checkpoint/display-list.js';
import { pageSpecs, hfJobBody, HF_FOLIO, HF_PARITY, HF_UNESTABLISHED } from '../engine/checkpoint/page-metadata.js';
import { bandPaint, samePaint } from '../engine/checkpoint/furniture-render.js';
import { entryFingerprint, pageHfSig, slotFingerprint } from '../engine/checkpoint/header-footer.js';
import { scheduleHeaders, measureSensitivity, rootKey } from '../engine/checkpoint/header-scheduler.js';
import { asyncRepaginate } from '../engine/checkpoint/async-repaginate.js';
import {
  bandShown, entryShown, pruneFurniture, queueCanonicalFurniture, releaseFurniture, pageCorresponds, specInsensitive,
  svgInkRows, furnitureLanded, probePoints, probesCorrespond, bindCanonicalFurniture, blockSpans, bandsApart,
} from '../engine/checkpoint/canonical-arrival.js';
import { buildLeasePreviewSettlement } from '../engine/checkpoint/build-lease-preview.js';
import { drain } from '../tools/harness.mjs';

const texReady = spawnSync('lualatex', ['--version']).status === 0;

let runs = 0;
const withEngine = async (source, fn, inputs = null) => {
  // inside the repository like the other engine tests (the fork shim cached there)
  const root = fileURLToPath(new URL(`../.tdom-v3-test-hf-furniture-${++runs}`, import.meta.url));
  rmSync(root, { recursive: true, force: true });
  // a fork shim another engine test already built (forkshim.js checks its hash)
  const cached = fileURLToPath(new URL('../.tdom-v3-test/', import.meta.url));
  if (existsSync(path.join(cached, 'tdomfork.so'))) {
    mkdirSync(root, { recursive: true });
    for (const f of ['tdomfork.so', 'tdomfork.so.sha256']) copyFileSync(path.join(cached, f), path.join(root, f));
  }
  const docDir = inputs ? path.join(root, 'source') : undefined;
  if (inputs) {
    mkdirSync(docDir, { recursive: true });
    for (const [file, content] of Object.entries(inputs)) writeFileSync(path.join(docDir, file), content);
  }
  const engine = new CheckpointEngine({ workDir: root, docDir });
  engine.canonical.schedule = () => {};
  try {
    await engine.open(source, docDir ? path.join(docDir, 'main.tex') : undefined);
    await drain(engine, 120_000);
    for (let i = 0; i < 100 && (engine.hfPending || !engine.hf?.size); i++) await new Promise((r) => setTimeout(r, 100));
    // Drain does not wait for exact renders. Until a block's pixels land its
    // page carries `pending-exact` and withholds the block's lines, the
    // table's row fills included; the render queue alone does not show
    // every way they are still owed (an isolated render, a capture).
    const owed = () => engine.getDisplayLists().some((list) => list.commands.some((c) => c.op === 'pending-exact'));
    for (let i = 0; i < 300 && (owed() || engine.renderWant?.size || engine.renderPumping > 0 || engine.isoRenderPending?.size); i++) {
      await new Promise((r) => setTimeout(r, 100));
    }
    await fn(engine);
  } finally {
    await engine.close().catch(() => {});
    rmSync(root, { recursive: true, force: true });
  }
};
const hfText = (list) => list.commands.filter((c) => c.src === '_hf' && c.op === 'glyphs').map((c) => c.text).join('');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (cond, what, tries = 600) => {
  for (let i = 0; i < tries && !cond(); i++) await sleep(50);
  assert.ok(cond(), what);
};
const settledHeaders = async (engine) => {
  for (let i = 0; i < 400 && (engine.hfPending || engine.hfQueued); i++) await sleep(50);
  await engine.hfTask;
  for (let i = 0; i < 400 && engine.hfPending; i++) await sleep(50);
};
const runsText = (items) => (items ?? []).flatMap((it) => (it.runs ?? []).map((r) => r.t ?? '')).join('');
// the band a page draws in a slot, if any (its head's, by default: the chunk id and version), the exact PDF's
// or the furniture render's (`__hfr-`)
const drawn = (engine, n, which = 'h') => {
  const c = engine.getDisplayLists()[n - 1]?.commands.find((cmd) => cmd.src === '_hf' && cmd.op === 'chunk' &&
    (cmd.chunk === hfBandChunkKey(n, which) || cmd.chunk === hfRenderChunkKey(n, which)));
  return c ? `${c.chunk}@${c.cv}` : null;
};
// once the runs land, a slot whose exact band is withheld may show the current source's render, never the old band
const fresh = (id) => id === null || id.startsWith('__hfr-');
const slots = (engine, pages) => ['h', 'f'].map((which) => pages.map((n) => drawn(engine, n, which)));
// every drawing page's two bands cut from the exact PDF of the source as it is
const exactBands = async (engine) => {
  await engine.canonical.ensure(engine.getSource(), engine.srcRev);
  const id = engine.canonical.last.id;
  const drawing = () => [...engine.hf].filter(([n, e]) => (e.hg || e.fg) && n <= engine.pages.length).map(([n]) => n);
  await until(() => drawing().length && drawing().every((n) => engine.chunks.get(hfBandChunkKey(n, 'h'))?.canonicalId === id), 'the exact bands');
  // (and its pages' correspondence, F6: a band is reused across sources only on a verified page)
  await until(() => [...(engine.hfBindings.get(id)?.pages.values() ?? [])].every((rec) => rec.verified !== null), 'the pages verified');
  return id;
};
// the header job of the layout as it is now has landed
const landed = (engine) => until(() => !engine.hfPending && engine.hfSig === engine.currentSpecs?.sig, 'the header job of this layout');
// a Build lease held across `fn` (the runs job yields to it: pending throughout)
const underLease = async (engine, fn) => {
  const lease = engine.canonical.acquireBuildLease('test', 30_000);
  try { return await fn(); } finally { engine.canonical.releaseBuildLease('test', lease.token); }
};

test('the body\'s \\fancyhead changes the head of the pages after it', { skip: !texReady && 'lualatex not installed' }, async () => {
  const source = String.raw`\documentclass[twoside]{article}
\usepackage{fancyhdr}
\pagestyle{fancy}
\fancyhf{}
\fancyfoot[C]{folio \thepage}
\begin{document}
\fancyhead[LE,RO]{HeadAlpha}
Page one text.
\clearpage
\fancyhead[LE,RO]{HeadBeta}
Page two text.
\clearpage
Page three text.
\end{document}
`;
  await withEngine(source, async (engine) => {
    const lists = engine.getDisplayLists();
    assert.equal(lists.length, 3);
    assert.match(hfText(lists[0]), /HeadAlpha/);
    assert.match(hfText(lists[1]), /HeadBeta/);
    assert.match(hfText(lists[2]), /HeadBeta/, 'a head stays until the next one');
    assert.match(hfText(lists[2]), /folio3/);
  });
});

test('a luacolor color reaches the rules and glyphs', { skip: !texReady && 'lualatex not installed' }, async () => {
  const source = String.raw`\documentclass{article}
\usepackage{xcolor,luacolor,tabularray}
\begin{document}
\begin{tblr}{colspec={ll}, row{1}={bg=black!10}}
A & B \\
C & D \\
\end{tblr}

Para \textcolor{red}{red} end.
\end{document}
`;
  await withEngine(source, async (engine) => {
    const commands = engine.getDisplayLists().flatMap((list) => list.commands);
    const state = JSON.stringify({
      ops: commands.filter((c) => c.op !== 'glyphs').map((c) => c.op + (c.src ? `:${c.src}` : '')),
      blocks: engine.blocks.map((b) => [b.id, !!b.needsRender, !!b.rescued, engine.chunks.has(b.id)]),
      diagnostics: engine.diagnostics.slice(-8),
    });
    // A coloured block reaches the paper one of two ways, both correct: as
    // vector rules and glyphs carrying its colours (its exact picture shown
    // only where it must be), or inside its exact picture shown whole (the
    // picture's glyphs could not be anchored to the runs: another TeX font
    // cache, say). Which one depends on the machine, not on the colour, so
    // the colour is checked where it is painted.
    const pictured = (src, [r, g, b]) => commands.some((c) => c.op === 'chunk' && c.src === src && !c.part && !c.show &&
      [...String(engine.getChunkSVG(c.chunk) ?? '').matchAll(/rgb\(([\d.]+)%,\s*([\d.]+)%,\s*([\d.]+)%\)/g)]
        .some((m) => Math.abs(m[1] - r) < 0.6 && Math.abs(m[2] - g) < 0.6 && Math.abs(m[3] - b) < 0.6));
    const [table, para] = engine.blocks;
    const fills = commands.filter((c) => c.op === 'rule' && c.h > 5 && c.src === table.id);
    // black!10: 90% grey (#e6e6e6 once rounded to a byte)
    if (fills.length) assert.ok(fills.length >= 2 && fills.every((c) => c.color === '#e6e6e6'), `${JSON.stringify(fills.map((c) => c.color))} ${state}`);
    else assert.ok(pictured(table.id, [90, 90, 90]), `the row background, as rules or in the table's picture (${state})`);
    assert.ok(commands.some((c) => c.op === 'glyphs' && c.src === para.id && c.text?.includes('red') && c.color === '#ff0000') ||
      pictured(para.id, [100, 0, 0]), `the red word (${state})`);
  });
});

// audit/scratch moving.tex, layout.tex and float-style.tex: the output routine's
// float state, which the header job used to ignore (the same head for a figure
// moved between two pages; a float page under \floatpagestyle{empty} given a head).
test('the header job\'s runs follow the floats that landed and a float page\'s style', { skip: !texReady && 'lualatex not installed' }, async () => {
  const source = String.raw`\documentclass[twoside]{article}
\usepackage{fancyhdr,tikz,floatpag}
\floatpagestyle{empty}
\pagestyle{fancy}
\fancyhf{}
\renewcommand\headrulewidth{0pt}
\fancyhead[L]{\tikz\draw (0,0)--(1,0);\iftopfloat{TOPFIG}{NOFIG}}
\begin{document}
First text.
\begin{figure}[t]\centering\rule{2cm}{1cm}\caption{Moving figure}\end{figure}
\clearpage
Second text.
\clearpage
\begin{figure}[p]\centering\rule{3cm}{3cm}\caption{Float page}\end{figure}
\clearpage
Last text.
\end{document}
`;
  await withEngine(source, async (engine) => {
    await settledHeaders(engine);
    const heads = () => engine.currentSpecs.specs.map((spec) => runsText(engine.hf.get(spec.page)?.h));
    assert.deepEqual(engine.currentSpecs.specs.map((spec) => spec.fl), ['t', '', 'p', '']);
    assert.deepEqual(heads(), ['TOPFIG', 'NOFIG', '', 'NOFIG'], 'the float page has no head under its style');
    // nothing of a drawn head before its exact band: no picture of the job's (rule 1)
    assert.ok([1, 2, 4].every((n) => drawn(engine, n) === null));
    const src = engine.getSource();
    const fig = src.indexOf('\\begin{figure}[t]');
    const figEnd = src.indexOf('\\end{figure}', fig) + '\\end{figure}'.length;
    const second = src.indexOf('Second text.');
    await engine.edit(second + 'Second text.'.length, second + 'Second text.'.length, '\n' + src.slice(fig, figEnd));
    await engine.edit(fig, figEnd, '');
    await drain(engine, 120_000);
    await settledHeaders(engine);
    assert.deepEqual(engine.currentSpecs.specs.slice(0, 2).map((spec) => spec.fl), ['', 't']);
    assert.deepEqual(heads().slice(0, 2), ['NOFIG', 'TOPFIG']);
  });
});

const geometry18 = { oddsidemargin: 0, topmargin: 0, headheight: 12, headsep: 25, textheight: 600, textwidth: 400, footskip: 30, paperwidth: 600, paperheight: 800 };
const run18 = (t, x = 0) => ({ t, f: 'F', s: 10, x, dy: 0, w: 10 });
const fonts18 = new Map([['F', { family: 'f-x' }]]);
const spec18 = (page, more = {}) => ({ page, folio: page, fmt: 'arabic', style: 'fancy', lmark: '', rmark: '', fl: '', ...more });
const entry18 = (head, more = {}) => ({ h: [{ k: 'box', h: 8, d: 2, runs: [run18(head), run18('1', 300)] }], f: [], hg: 1, ...more });
const canonBand18 = (v) => ({ wBp: 600, hBp: 100, v, canonicalId: 1, rec: {} });
// what a page's list draws of its head and foot
const shown18 = ({ hf, chunks = new Map(), entry = true, band = true, provisional = true, apart = false }, page = 1) => buildDisplayList({ number: page, draw: [] }, {
  geometry: geometry18, chunks, hf, hfSig: 's', fonts: fonts18,
  hfEntryShown: (which) => (typeof entry === 'function' ? entry(which) : entry),
  hfBandShown: (meta, which) => (typeof band === 'function' ? band(which) : band),
  hfBandsApart: () => apart, hfProvisional: () => provisional,
}).commands.filter((c) => c.src === '_hf' || c.op === 'folio').map((c) => c.op === 'chunk' ? `${c.chunk}@${c.cv}` : c.text);

// docs/10 §10.7a: v0.1.32's presentation, with F4 deciding.
test('a page draws its own exact bands while they are its, else its entry\'s runs (nothing for a head that draws), else the folio its style draws', () => {
  const hf = new Map([[1, entry18('Head')]]);
  const bands = new Map(['h', 'f'].map((which, i) => [hfBandChunkKey(1, which), canonBand18(20 + i)]));
  assert.deepEqual(shown18({ hf, chunks: bands }), [`${hfBandChunkKey(1, 'h')}@20`, `${hfBandChunkKey(1, 'f')}@21`]);
  assert.deepEqual(shown18({ hf, chunks: bands, band: false }), [], 'a band that is not the page\'s: nothing, as v0.1.32 for a head without band');
  assert.deepEqual(shown18({ hf }), [], 'no band yet: nothing (no picture of the header job\'s)');
  const plain = new Map([[1, { ...entry18('Plain'), hg: 0 }]]);
  assert.deepEqual(shown18({ hf: plain, chunks: bands, band: false }), ['Plain', '1'], 'text and rules: the runs');
  assert.deepEqual(shown18({ hf: plain, chunks: bands }), [`${hfBandChunkKey(1, 'h')}@20`, `${hfBandChunkKey(1, 'f')}@21`],
    'the canonical page\'s own bands over the runs (F5: ink the runs left out)');
  assert.deepEqual(shown18({ hf: plain, entry: false }), ['1'], 'an entry not the page\'s: the provisional folio');
  assert.deepEqual(shown18({ hf, chunks: bands, entry: false }), [`${hfBandChunkKey(1, 'h')}@20`, `${hfBandChunkKey(1, 'f')}@21`],
    'the page\'s own bands also while its retained entry is hidden (audit/scratch r9 item 7)');
  assert.deepEqual(shown18({ hf: plain, entry: false, provisional: false }), [], 'under \\thispagestyle{empty}: no spurious folio');
  assert.deepEqual(shown18({ hf: new Map() }, 7), ['7']);
  // slot by slot (audit/scratch r10 restore): the foot's band while only the head's is not the page's
  const footOnly = (which) => which === 'f';
  assert.deepEqual(shown18({ hf, chunks: bands, band: footOnly, apart: true }), [`${hfBandChunkKey(1, 'f')}@21`]);
  assert.deepEqual(shown18({ hf, chunks: bands, band: footOnly }), [], 'art that crosses the bands: both go together');
  const textFoot = new Map([[1, { ...entry18('Head'), f: [{ k: 'box', h: 8, d: 2, runs: [run18('Sheet 1')] }] }]]);
  assert.deepEqual(shown18({ hf: textFoot, chunks: bands, band: false }), ['Sheet 1'], 'a foot of text and rules: its runs, beside a head that draws');
  assert.deepEqual(shown18({ hf: textFoot, entry: footOnly }), ['Sheet 1'], 'the foot\'s entry while only the head\'s is hidden: no folio');
  assert.deepEqual(shown18({ hf: textFoot, entry: (which) => which === 'h' }), ['1'], 'the foot\'s hidden: the provisional folio');
});

// F4 per slot: a band is drawn alone only where all its ink stands where its own slot's items stand.
test('either band may be drawn alone only where each holds only its own slot\'s ink', () => {
  const rec = { extent: { h: [76, 86], f: [732, 741] } };
  const band = (which, ink) => ({ which, ink, rec });
  assert.equal(bandsApart({}, band('h', [[78, 84], [84, 85]]), band('f', [])), true, 'the head\'s words and line; no ink in the foot band');
  assert.equal(bandsApart({}, band('h', [[78, 84]]), band('f', [[733, 740]])), true, 'the foot\'s words at its baseline');
  assert.equal(bandsApart({}, band('h', [[78, 84]]), { which: 'f', ink: [[733, 740]], rec: { extent: { f: [739, 739] } } }), false, 'ink where the foot has no items');
  assert.equal(bandsApart({}, band('h', [[84, 108]]), band('f', [[716, 800]])), false, 'a line drawn from the head down the page');
  assert.equal(bandsApart({}, band('h', [[0, 105]]), band('f', [])), false, 'a background over the head band');
  assert.equal(bandsApart({}, band('h', [[78, 84]]), { which: 'f', ink: [], rec: {} }), false, 'a slot\'s extent not known: paired');
  const svg = '<svg width="600pt" height="800pt" viewBox="0 0 600 800"><path d="M 0 0 L 28 0" transform="matrix(1, 0, 0, 1, 100, 84)"/>' +
    '<path d="M 0 0 L 0 700" transform="matrix(1, 0, 0, 1, 50, 84)"/></svg>';
  assert.deepEqual(svgInkRows(svg, 600), [[84, 84], [84, 784]]);
  // a slot's runs can stand outside its box: fancyhdr's rule after \headruleskip, a glyph as svgInkRows reads one
  // (round 11, the booklet: its head rule 6.5 bp under the head box kept every sheet's bands paired)
  const head = [{ k: 'box', h: 8, d: 0, runs: [run18('Head'), { rule: true, x: 0, dy: 6.5, w: 400, h: 0.4 }] }];
  assert.deepEqual(hfSlotExtent(head, 'h', geometry18), [76, 90.9]);
  const foot = [{ k: 'box', h: 4, d: 0, runs: [run18('25')] }];
  assert.deepEqual(hfSlotExtent(foot, 'f', geometry18), [733, 740], 'a small folio: its glyph row as the page SVG gives it');
});

test('a page shipped whole keeps the header job\'s head and gets no provisional folio', () => {
  const hf = new Map([[1, { h: [{ k: 'box', h: 8, d: 2, runs: [run18('Head')] }], f: [{ k: 'box', h: 8, d: 2, runs: [run18('Foot')] }] }]]);
  const full = { number: 1, draw: [{ y: 600, u: { blockId: 'b1@p1', h: 600, d: 0, li: 0, ln: { boxH: 600, gfxChunk: { blockId: 'b1@p1', yOff: 0, full: 1 } } } }] };
  const chunks = new Map([['b1@p1', { wBp: 600, hBp: 600, v: 1 }]]);
  const list = buildDisplayList(full, { geometry: geometry18, chunks, hf, hfSig: 's', fonts: fonts18 });
  assert.deepEqual(list.commands.filter((c) => c.src === '_hf').map((c) => c.text), ['Head', 'Foot']);
  assert.ok(!buildDisplayList(full, { geometry: geometry18, chunks, hf: new Map(), hfSig: 's', fonts: fonts18 })
    .commands.some((c) => c.op === 'folio'));
});

// F6 (audit/scratch r9 cold-follow): a cold walk had paragraph 152 on sheet 38 where
// the PDF has it on 39, with the same page count. Each page's first and last lines
// must be on its canonical page, nothing more before them than the head holds.
test('a page corresponds to its canonical page when its first and last lines open and close it', () => {
  const lines = (...t) => t.map((x) => x.toLowerCase().replace(/[^a-z0-9]/g, ''));
  const pdf = (...t) => t.join('').toLowerCase().replace(/[^a-z0-9]/g, '');
  const p152 = 'Paragraph 152 of the fixture.', p153 = 'Paragraph 153 of the fixture.', p159 = 'Paragraph 159 ends it.';
  assert.equal(pageCorresponds(lines(p153, p159), pdf('M153', p153, p159, '39'), 4, 2), true);
  assert.equal(pageCorresponds(lines(p153, p159), pdf('M152', p152, p153, p159, '39'), 4, 2), false, 'the PDF page opens with 152');
  assert.equal(pageCorresponds(lines(p152), pdf('M151', 'Paragraph 151 is here.', '38'), 4, 2), false, '152 is not on it');
  assert.equal(pageCorresponds(lines(p153), pdf('M153', p153, p159, '39'), 4, 2), false, 'the PDF page goes on past its last line');
  const rep = 'Repeat this exercise.';
  assert.equal(pageCorresponds(lines(rep, rep, rep, rep), pdf('BETA', rep, rep, rep, rep, 'Sheet2'), 4, 6), true, 'repeated lines in order');
  assert.equal(pageCorresponds(lines('Fig.'), pdf('Fig.'), 0, 0), null, 'no text to tell: decided by its neighbours');
  // a table: the runs by rows, pdftotext by columns; the same letters (audit/scratch r9 repeat table)
  assert.equal(pageCorresponds(lines('Worksheet Answer', 'Exercise Proof', 'Question Result'),
    pdf('ALPHA', 'Worksheet Exercise Question', 'Answer Proof Result', 'Sheet 1'), 5, 6, 'alphasheet1'), true);
  assert.equal(pageCorresponds(lines('Worksheet Answer', 'Exercise Proof'),
    pdf('ALPHA', 'Worksheet Exercise Question', 'Answer Proof Result', 'Sheet 1'), 5, 6, 'alphasheet1'), false, 'a row more on the PDF page');
});

// F6 by SyncTeX (the booklet: pages drawn mostly as exact pictures, no runs to read): the PDF page is
// asked which source line it typeset where the layout has the page's first and last block.
test('a page corresponds when the PDF has its first and last blocks where the layout puts them', () => {
  const geo = { topmargin: 0, headheight: 12, headsep: 25, textheight: 600, textwidth: 400, oddsidemargin: 0 };
  const unit = (bid, y, h = 8) => ({ y, u: { blockId: bid, d: 2, ln: { boxH: h } } });
  const page = { number: 39, draw: [{ y: 2, u: { blockId: 'b150', h: 0, d: 0 } }, unit('b153', 10), unit('b153', 22), unit('b154', 40), unit('b156', 300), unit('b156', 312)] };
  const probes = probePoints(page, geo);
  assert.deepEqual(probes.map((p) => [p.bid, p.x, p.y]), [['b153', 272, 109 + 13], ['b156', 272, 109 + 303]]);
  const spans = new Map([['b152', { file: '/w/canon.tex', first: 10, last: 11 }], ['b153', { file: '/w/canon.tex', first: 13, last: 14 }],
    ['b156', { file: '/w/canon.tex', first: 19, last: 20 }]]);
  const hit = (line) => ({ file: '/w/canon.tex', line });
  assert.equal(probesCorrespond(probes, [hit(13), hit(20)], spans), true);
  assert.equal(probesCorrespond(probes, [hit(10), hit(20)], spans), false, 'the PDF has 152 where the layout has 153 (audit/scratch r9 cold-follow)');
  assert.equal(probesCorrespond(probes, [hit(13), hit(22)], spans), false, 'and the next block where the layout has 156');
  assert.equal(probesCorrespond(probes, [hit(13), { file: '/tex/pgflibraryfadings.code.tex', line: 19 }], spans), null, 'a library\'s line tells nothing');
  const tolerant = new Map([...spans].map(([b, sp]) => [b, { ...sp, file: '/w/canon.tex', until: sp.last + 2 }]));
  assert.equal(probesCorrespond(probes, [hit(13), hit(22)], tolerant), true, 'a paragraph SyncTeX names by the line after it');
  assert.equal(probesCorrespond(probes, [hit(13), null], spans), null, 'SyncTeX has nothing there: the text check decides');
  assert.deepEqual(probePoints({ number: 2, draw: [] }, geo), []);
  assert.deepEqual(probePoints({ number: 1, draw: [{ y: 0, u: { blockId: 'b1', h: 0, d: 0 } }] }, geo), [], 'a cover\'s \\null and overlay: nothing to ask about');
});

// A document the engine sets in vertical writing (update-prepare.js tateExact) is shown as exact
// pages: the yoko head and foot bands would hold body text (round 10, the tate review).
test('a document the engine sets in vertical writing binds no band', () => {
  const engine = { mode: 'structured', previewPolicy: 'structured', tateExact: true, updating: false,
    srcRev: 1, pages: [{ number: 1 }], getSource: () => { throw new Error('not reached'); } };
  assert.equal(bindCanonicalFurniture(engine, { id: 1, rev: 1, pageCount: 1 }, { noteSpecs: () => ({}) }), null);
});

// F2: what the runs job measures in a context, slot by slot, and F4 iii's use of it.
test('a context is sensitive to a component when its probe\'s slot differs, and a missing probe counts as a change', () => {
  const specs = [spec18(1, { tpl: 'A' }), spec18(2, { tpl: 'A' }), spec18(3, { tpl: 'B' }), spec18(4, { tpl: 'A', fl: 't' })];
  const entry = (t) => ({ h: [{ k: 'box', runs: [run18(t)] }], f: [{ k: 'box', runs: [run18('Sheet')] }], hg: 1 });
  const map = new Map([[1, entry('ALPHA')], [2, entry('BETA')], [3, entry('x')], [4, entry('ALPHA')]]);
  const probes = new Map([['0.m0', entry('')], ['0.m1', entry('TDOMprobeRight')], ['0.t', entry('ALPHA')],
    ['0.b', entry('ALPHA')], ['0.p', entry('ALPHA')], ['0.l', entry('ALPHA')]]);
  const sens = measureSensitivity(specs, map, probes);
  assert.deepEqual([...sens.keys()], ['A|', 'B|', 'A|t'], 'a template, and where floats landed: a context each');
  assert.deepEqual(sens.get('A|'), { h: { marks: true, t: false, b: false, p: false, lp: false }, f: { marks: false, t: false, b: false, p: false, lp: false } });
  const all = { marks: true, t: true, b: true, p: true, lp: true };
  assert.deepEqual(sens.get('B|'), { h: all, f: all }, 'no probes returned: all of them');
  assert.deepEqual(sens.get('A|t'), { h: all, f: all }, 'the figure\'s context is measured on its own page');
  const engine = { file: 'main.tex', rootBoots: 1, preDigest: 'P' };
  engine.hfSens = { root: rootKey(engine), byTpl: sens };
  assert.equal(specInsensitive(engine, specs[0], { ...specs[0], fl: 't' }), true, 'a float the head and foot do not read');
  const none = { h: 0, f: 0 };
  assert.equal(specInsensitive(engine, specs[0], { ...specs[0], lp: '9' }, null, none), true, 'a LastPage they do not read');
  assert.equal(specInsensitive(engine, specs[0], { ...specs[0], lp: '9' }), false, 'what they read not known');
  assert.equal(specInsensitive(engine, specs[0], { ...specs[0], lp: '9' }, 'f', { h: 0, f: 2 }), false, 'a foot that read LastPage as it was set');
  assert.equal(specInsensitive(engine, specs[0], { ...specs[0], fl: 't', lp: '9' }), false, 'both at once: not measured together');
  assert.equal(specInsensitive(engine, specs[0], { ...specs[0], fl: 'tb' }), false, 'two float flags at once');
  assert.equal(specInsensitive(engine, specs[0], { ...specs[0], rmark: 'INSERT' }), false, 'a mark the head reads');
  assert.equal(specInsensitive(engine, specs[0], { ...specs[0], rmark: 'INSERT' }, 'h'), false);
  assert.equal(specInsensitive(engine, specs[0], { ...specs[0], rmark: 'INSERT' }, 'f', { h: 1, f: 0 }), true, 'the foot does not read it');
  assert.equal(specInsensitive(engine, specs[0], { ...specs[0], rmark: 'INSERT' }, 'f', { h: 1, f: 1 }), false,
    'the probes saw no change, but the foot expanded the mark: a value it compares with (audit/scratch r11 conditional)');
  assert.equal(specInsensitive(engine, specs[3], { ...specs[3], rmark: 'INSERT' }, 'f', { h: 1, f: 0 }), false, 'measured where the figure is: not known');
  assert.equal(specInsensitive(engine, specs[0], { ...specs[0], tpl: 'C' }), false, 'another chain, style or parity');
  assert.equal(specInsensitive(engine, specs[0], { ...specs[0], folio: 7 }), false, 'another folio');
  assert.equal(specInsensitive(engine, specs[2], { ...specs[2] }), true, 'nothing differs');
  assert.equal(specInsensitive({}, specs[2], { ...specs[2] }), true, 'identical inputs need no sensitivity probe');
  engine.rootBoots = 2;
  assert.equal(specInsensitive(engine, specs[0], { ...specs[0], fl: 't' }), false, 'measured for another root');
});

test('a template is its style, its chain of body definitions and its folio\'s parity', () => {
  const pages = [1, 2, 3].map((number) => ({ number, evs: [] }));
  const specs = pageSpecs(pages, [], 'fancy');
  assert.equal(specs[0].tpl, specs[2].tpl);
  assert.notEqual(specs[0].tpl, specs[1].tpl, 'twoside\'s odd and even heads');
});

// F1, F5 helpers.
test('a fingerprint is the whole entry, literals included; a page SVG\'s ink rows', () => {
  const diag = (d) => ({ h: [{ k: 'box', runs: [], fx: [`pdf_literal:0::: ${d}`] }], f: [], hg: 1, hx: d });
  assert.notEqual(entryFingerprint(diag('0 0 m 28 8 l S')), entryFingerprint(diag('0 8 m 28 0 l S')));
  const svg = '<svg width="600pt" height="800pt" viewBox="0 0 600 800"><defs><g id="glyph-0-0"><path d="M 0 0 L 5 -7 Z"/></g></defs>' +
    '<path d="M 0 0 L 28 8.5" transform="matrix(1, 0, 0, -1, 100, 60)"/><g fill="rgb(0%,0%,0%)"><use xlink:href="#glyph-0-0" x="100" y="400"/></g></svg>';
  const rows = svgInkRows(svg, 600);
  assert.equal(rows.length, 2, 'the glyph outline in <defs> is not paint');
  assert.ok(rows[0][0] >= 51 && rows[0][1] <= 60.1, JSON.stringify(rows));
  assert.ok(rows[1][0] < 400 && rows[1][1] > 400);
});

test('the header job replays each page\'s \\fancyhead in page order, with the floats that landed', () => {
  const pages = [
    { number: 1, evs: [{ k: 'fancy', a: 'head', b: '[LE,RO]{A}' }], topFloats: [{ id: 'b1#1' }] },
    { number: 2, evs: [] },
    { number: 3, evs: [{ k: 'fancy', a: 'hf', b: '[]{}' }], floatPage: true },
  ];
  pages[1].evs = [{ k: 'fpstyle', a: 'fancy', b: '' }];
  const specs = pageSpecs(pages, [], 'fancy');
  assert.deepEqual(specs.map((s) => s.fancy ?? null), [[['head', '[LE,RO]{A}']], [['fps', '{fancy}']], [['hf', '[]{}']]]);
  assert.deepEqual(specs.map((s) => s.fl), ['t', '', 'p']);
  assert.equal(new Set(specs.map((s) => s.tpl)).size, 3, 'each body definition starts a template');
  assert.deepEqual(specs.map((s) => s.lp), ['3', '3', '3']);
  const body = hfJobBody(specs);
  const setup = ['\\fancyhead[LE,RO]{A}', '\\floatpagestyle{fancy}', '\\fancyhf[]{}'].map((line) => body.indexOf(line));
  assert.ok(setup[0] >= 0 && setup[0] < setup[1] && setup[1] < setup[2]);
  assert.ok(body.includes('\\TDOM@hffloats{t}') && body.includes('\\TDOM@hffloats{p}'));
  assert.ok(!/tdom_hf_ship|TDOM@hfship/.test(body), 'no page is shipped: the job makes no pixels');
  // F1, F2: literals made readable; each context's six probes, once
  assert.ok(body.includes('\\protected\\def\\pdfextension{\\directlua{tdom_hf_ext()}}'));
  for (const i of [0, 1, 2]) for (const which of ['m0', 'm1', 't', 'b', 'p', 'l']) assert.ok(body.includes(`'q${i}.${which}'`), `probe ${i}.${which}`);
  assert.ok(!body.includes(`.n'`), 'the folio is not probed');
  assert.ok(!body.includes("'q3."));
});

test('a header job made for another preamble or root publishes nothing', async () => {
  const specs = [spec18(1)];
  let reply;
  let sent;
  const dispatched = new Promise((resolve) => { sent = resolve; });
  const ck = { send() {}, sendRaw: () => sent() };
  const engine = {
    pages: [{ number: 1 }], preDigest: 'A', file: 'main.tex', rootBoots: 1, chunks: new Map(), hf: new Map(), diagnostics: [],
    checkpoints: new Map([[0, ck]]), canonical: { waitForBuildLease: async () => {}, buildLease: null },
    buildLeasePreviewJobs: new Set(), workDir: mkdtempSync(path.join(tmpdir(), 'tdom-hf-root-')), updating: false,
  };
  const helpers = {
    noteSpecs: (pages) => ({ pages, specs, sig: 'S1' }),
    hfJobBody: () => '', registerFont() {}, asyncRepaginate() {},
    awaitGalley: () => new Promise((resolve) => { reply = resolve; }),
  };
  try {
    scheduleHeaders(engine, helpers);
    await dispatched;
    engine.preDigest = 'B'; // the preamble changed while the job ran
    reply({ hf: { p1: { h: [], f: [] } }, fonts: {} });
    await engine.hfTask;
    assert.equal(engine.hf.size, 0, 'the reply from preamble A is not published as B\'s');
    assert.equal(engine.hfSig, undefined);
  } finally {
    rmSync(engine.workDir, { recursive: true, force: true });
  }
});

test('the bands of the generation in use are held for all its pages, others go with their pages; a document\'s furniture state goes with it', () => {
  const engine = { pages: Array.from({ length: 301 }, (_, i) => ({ number: i + 1 })), chunks: new Map(), hfCanon: { id: 1 } };
  // (pages 1-300 cut from generation 1, the one in use; page 301 still from an older generation 2)
  for (let n = 1; n <= 301; n++) for (const which of ['h', 'f']) engine.chunks.set(hfBandChunkKey(n, which), { ...canonBand18(n), canonicalId: n <= 300 ? 1 : 2 });
  engine.hfBandTop = 301;
  engine.chunks.set('b1', { v: 1 });
  engine.pages = [{ number: 1 }];
  pruneFurniture(engine);
  // (audit/scratch r8 undo-window: an undo 42 -> 1 -> 42 waited on fresh SVG reads; v0.1.32 held them)
  assert.equal([...engine.chunks.keys()].filter((k) => k.startsWith('__hf-')).length, 600, 'generation 1: all 300 pages');
  assert.ok(!engine.chunks.has(hfBandChunkKey(301, 'h')), 'generation 2 goes with its page');
  assert.equal(engine.hfBandTop, 300);
  // the next generation's queue replaces it: only the pages there are keep a band
  engine.hfCanon = { id: 3 };
  pruneFurniture(engine);
  // (audit/scratch r7 queue-lease: 1,200 bands, 15.25 MiB, after deleting 301 pages down to one)
  assert.deepEqual([...engine.chunks.keys()].sort(), ['__hf-1-f', '__hf-1-h', 'b1']);
  Object.assign(engine, { currentSpecs: { pages: [] }, hfSpecs: [], hfIdentity: {}, hfSens: {}, hfBindings: new Map([[1, {}]]), hfCanon: { id: 1 },
    hfSourceHash: { rev: 4, hash: 'H' } });
  releaseFurniture(engine);
  assert.deepEqual([engine.currentSpecs, engine.hfSpecs, engine.hfIdentity, engine.hfSens, engine.hfBindings, engine.hfCanon, engine.hfSourceHash, engine.hfBandTop],
    [null, null, null, null, null, null, null, 0]);
  assert.deepEqual([...engine.chunks.keys()], ['b1'], 'and its bands (a demotion to opaque keeps the chunk map)');
});

// F4 on a fake engine: the three ways a band is the page's, and what bars the
// two across sources (F6, F7, c53846b's set).
test('a band is drawn for its own source, for its own fingerprint once the runs land, or while they are pending for an insensitive change', () => {
  const page = { number: 1, draw: [] };
  const gen = { id: 7, rev: 3, srcLength: 5, srcHash: 'H3', root: 'main.tex#1#P', counters: [] };
  const geometry = [600, 800, 0, 12, 25, 600, 0, 0, 30, 400].map((v) => v.toFixed(2)).join(':');
  const rec = { gen, n: 1, geometry, spec: spec18(1, { tpl: 'A', rmark: 'ALPHA' }), fp: null, verified: true, c53: true, pdfInk: false, reads: { h: 1, f: 0 } };
  const meta = { rec };
  const engine = {
    srcRev: 4, getSource: () => 'xxxxxx', geometry: geometry18, file: 'main.tex', rootBoots: 1, preDigest: 'P',
    hf: new Map([[1, { h: [], f: [], hg: 1 }]]), hfSig: 'L4', hfIdentity: { sig: 'L4', rev: 4, root: 'main.tex#1#P' },
    canonical: { compilationIdentity: () => ({ srcHash: 'H4' }) },
    currentSpecs: { sig: 'L4', pages: [page], specs: [spec18(1, { tpl: 'A', rmark: 'ALPHA' })], blocks: [] },
    hfSens: { root: 'main.tex#1#P', byTpl: new Map([['A|', { h: { marks: true, t: false, b: false, p: false, lp: false }, f: { marks: false, t: false, b: false, p: false, lp: false } }]]) },
  };
  // (ii) landed: a known fingerprint, and the page's
  assert.equal(bandShown(engine, page, meta), false, 'fingerprint not known: hidden (audit/scratch r9 no-fingerprint)');
  rec.fp = { h: pageHfSig(engine.hf, 1, 'h'), f: pageHfSig(engine.hf, 1, 'f') };
  assert.equal(bandShown(engine, page, meta), true);
  engine.hf = new Map([[1, { h: [], f: [], hg: 1, hx: 'other' }]]);
  assert.equal(bandShown(engine, page, meta), false, 'another drawing (F1)');
  assert.equal(bandShown(engine, page, meta, 'h'), false);
  assert.equal(bandShown(engine, page, meta, 'f'), true, 'the foot\'s own fingerprint is as it was');
  // (iii) pending: the differing components
  engine.currentSpecs = { ...engine.currentSpecs, sig: 'L5', specs: [spec18(1, { tpl: 'A', rmark: 'ALPHA', fl: 't' })] };
  assert.equal(bandShown(engine, page, meta), true, 'a float the template does not read');
  engine.currentSpecs = { ...engine.currentSpecs, specs: [spec18(1, { tpl: 'A', rmark: 'ALPHA', fl: 't', lp: '2' })] };
  assert.equal(bandShown(engine, page, meta), false, 'a float and LastPage at once: their joint effect was not measured');
  engine.currentSpecs = { ...engine.currentSpecs, specs: [spec18(1, { tpl: 'A', rmark: 'INSERT' })] };
  assert.equal(bandShown(engine, page, meta), false, 'a mark it reads');
  assert.equal(bandShown(engine, page, meta, 'h'), false, 'the head reads it');
  assert.equal(bandShown(engine, page, meta, 'f'), true, 'the foot does not');
  engine.hfFailedSig = 'L5';
  engine.currentSpecs = { ...engine.currentSpecs, specs: [spec18(1, { tpl: 'A', rmark: 'ALPHA' })] };
  assert.equal(bandShown(engine, page, meta), false, 'the job of this layout failed: not pending');
  engine.hfFailedSig = null;
  assert.equal(bandShown(engine, page, meta), true);
  // across sources only where verified, in c53846b's set, before a changed counter assignment
  for (const [field, value] of [['verified', false], ['verified', null], ['c53', false], ['pdfInk', true]]) {
    const was = rec[field];
    rec[field] = value;
    assert.equal(bandShown(engine, page, meta), false, `${field} ${value}`);
    rec[field] = was;
  }
  engine.currentSpecs = { ...engine.currentSpecs, blocks: [{ id: 'b1', text: '\\setcounter{page}{71}' }] };
  assert.equal(bandShown(engine, page, meta), true, 'assignment text alone cannot establish execution');
  engine.currentSpecs = { ...engine.currentSpecs, blocks: [{ id: 'b1', galley: { events: [{ k: 'pagectr', a: 'set', b: '?' }] } }] };
  rec.reads.h |= HF_FOLIO;
  assert.equal(bandShown(engine, page, meta), false, 'the pair includes a slot that reads the unknown folio');
  assert.equal(bandShown(engine, page, meta, 'f'), true, 'the foot is independent of the unknown folio');
  // (i) the very source it was compiled from, whatever else
  engine.srcRev = 3;
  assert.equal(bandShown(engine, page, meta), true, 'an undo back to its source');
  // the folio as bound
  engine.currentSpecs = { ...engine.currentSpecs, specs: [spec18(1, { tpl: 'A', folio: 15 })] };
  assert.equal(bandShown(engine, page, meta), false);
});

// F4: a fingerprint is filled once, from its own source, layout and root.
test('a binding\'s fingerprints are filled once, by the runs job of its own source, layout and root', () => {
  const gen = { id: 1, rev: 3, root: 'R1', layoutSig: 'L', filled: false };
  const rec = { gen, n: 1, spec: spec18(1), fp: null, graphic: null };
  const engine = { hfBindings: new Map([[1, { gen, pages: new Map([[1, rec]]) }]]), geometry: geometry18 };
  const map = (t) => new Map([[1, entry18(t)]]);
  furnitureLanded(engine, {}, { map: map('BRAVO'), identity: { sig: 'L', rev: 4, root: 'R1' } });
  assert.equal(rec.fp, null, 'another source');
  furnitureLanded(engine, {}, { map: map('BRAVO'), identity: { sig: 'L', rev: 3, root: 'R2' } });
  assert.equal(rec.fp, null, 'another root (a preamble reboot)');
  furnitureLanded(engine, {}, { map: map('ALPHA'), identity: { sig: 'L', rev: 3, root: 'R1' } });
  const fp = (entry) => ({ h: slotFingerprint(entry, 'h'), f: slotFingerprint(entry, 'f') });
  assert.deepEqual(rec.fp, fp(entry18('ALPHA')));
  assert.deepEqual(rec.extent, { h: [76, 86], f: [739, 739] }, 'where the head\'s box stands; an empty foot at its baseline');
  furnitureLanded(engine, {}, { map: map('CHARLIE'), identity: { sig: 'L', rev: 3, root: 'R1' } });
  assert.deepEqual(rec.fp, fp(entry18('ALPHA')), 'once');
});

// The cut queue: rule 2 (only bound generations, the latest on arrival), the
// Build lease at page boundaries, and the retry wake across generations
// (audit/scratch r8 retry-generation: a failed page waited for an outside wake).
const queueEngine = (n, { latest = 1 } = {}) => {
  const pages = Array.from({ length: n }, (_, i) => ({ number: i + 1 }));
  const svg = (id) => `<svg xmlns="http://www.w3.org/2000/svg" width="600pt" height="800pt" viewBox="0 0 600 800"><path d="M0 0h${id}"/></svg>`;
  const engine = {
    mode: 'structured', previewPolicy: 'structured', srcRev: 5, pages, geometry: geometry18, chunks: new Map(), diagnostics: [],
    hf: new Map(pages.map((p) => [p.number, entry18('Head')])), updating: false, cuts: 0, latest, hfBindings: new Map(),
    currentSpecs: { pages, specs: pages.map((p) => spec18(p.number)), sig: 'Q', blocks: [] },
    canonical: {
      info: () => ({ id: engine.latest }), buildLease: null, waitForBuildLease: async () => {},
      pageSVG: async (page, id) => { engine.cuts++; return (await engine.svgFor?.(page, id)) ?? svg(id); },
    },
  };
  const bind = (id) => {
    const gen = { id, rev: 5, root: 'R', counters: [] };
    const binding = { gen, pages: new Map() };
    // (the geometry key of geometry18, canonical-arrival.js geometryKey)
    const geometry = [600, 800, 0, 12, 25, 600, 0, 0, 30, 400].map((v) => v.toFixed(2)).join(':');
    for (const p of pages) binding.pages.set(p.number, { gen, n: p.number, geometry, spec: spec18(p.number), fp: null, graphic: true, verified: null, c53: true });
    engine.hfBindings.set(id, binding);
  };
  return { engine, bind, helpers: { asyncRepaginate() {} } };
};
const bandsOf = (engine) => [...engine.chunks].filter(([k]) => /^__hf-\d+-h$/.test(k)).map(([, m]) => m.canonicalId);

test('the bands of a bound generation are cut, every page, the latest generation only; an unbound one cuts nothing', async () => {
  const { engine, bind, helpers } = queueEngine(85);
  await queueCanonicalFurniture(engine, { id: 1 }, helpers);
  assert.equal(engine.cuts, 0, 'generation 1 is not bound (its source was not the layout\'s)');
  bind(1);
  await queueCanonicalFurniture(engine, { id: 1 }, helpers);
  assert.equal(bandsOf(engine).length, 85, 'all 85 pages (v0.1.32 stopped at 80)');
  bind(2);
  engine.latest = 2;
  await queueCanonicalFurniture(engine, { id: 2 }, helpers);
  assert.ok(bandsOf(engine).every((id) => id === 2), 'cut again from generation 2');
  // a late callback of generation 1 does not take the queue back (audit/scratch r7 queue-supersede)
  const cuts = engine.cuts;
  await queueCanonicalFurniture(engine, { id: 1 }, helpers);
  assert.equal(engine.hfCanon.id, 2);
  assert.equal(engine.cuts, cuts);
});

test('the cut waits for Build at page boundaries, and a failed page is tried again across a new generation without an outside wake', async () => {
  const { engine, bind, helpers } = queueEngine(6);
  bind(1);
  let lease = true;
  const waiters = [];
  engine.canonical.buildLease = { requestId: 'build' };
  engine.canonical.waitForBuildLease = () => (lease ? new Promise((resolve) => waiters.push(resolve)) : Promise.resolve());
  const pending = queueCanonicalFurniture(engine, { id: 1 }, helpers);
  await sleep(50);
  assert.equal(engine.cuts, 0, 'no conversion while Build holds its lease');
  lease = false;
  engine.canonical.buildLease = null;
  for (const resolve of waiters) resolve();
  await pending;
  assert.equal(bandsOf(engine).length, 6);
  // generation 2's first conversion fails, then generation 3 supersedes it and fails once too
  bind(2);
  bind(3);
  const failures = new Set(['2:1', '3:1']);
  engine.svgFor = async (page, id) => (failures.delete(`${id}:${page}`) ? Promise.reject(new Error('pdftocairo')) : null);
  engine.latest = 2;
  await queueCanonicalFurniture(engine, { id: 2 }, helpers);
  engine.latest = 3;
  await queueCanonicalFurniture(engine, { id: 3 }, helpers);
  assert.ok(engine.hfCanonRetry, 'the new generation\'s retry is armed');
  await until(() => bandsOf(engine).length === 6 && bandsOf(engine).every((id) => id === 3), 'page 1 of generation 3, by its own retry', 80);
  clearTimeout(engine.hfCanonRetry);
});

// audit/scratch r7 float-macro, deferred-style and alias-marks, against the
// exact PDF: the candidate drew the job's DRAFT over the PDF's FINAL after a
// figure moved, NORMALCLEARFREE and Total 6 on a sheet the PDF leaves bare,
// ONE/FIRST where the PDF says TWO/FIRST. With no synthetic picture the pages
// draw what v0.1.32 drew: nothing of a drawn head before the canonical page,
// then the canonical page's band, kept through an edit until the next
// generation cuts it again.
test('Astra\'s round-7 fixtures keep their heads consistent with the exact PDF', { skip: !texReady && 'lualatex not installed' }, async () => {
  const moving = String.raw`\documentclass{article}
\usepackage{fancyhdr,tikz}
\newcommand\runningtag{DRAFT}
\pagestyle{fancy}\fancyhf{}\renewcommand\headrulewidth{0pt}
\fancyhead[L]{\tikz\draw (0,0)--(1,0);\runningtag}
\begin{document}
\renewcommand\runningtag{FINAL}
First text.
\begin{figure}[t]\centering\rule{2cm}{1cm}\caption{Moving figure}\end{figure}
\clearpage
Second text.
\end{document}
`;
  const deferred = String.raw`\documentclass[twoside]{article}
\usepackage{fancyhdr,tikz,lastpage}
\setlength{\oddsidemargin}{0pt}
\setlength{\evensidemargin}{50pt}
\pagestyle{fancy}
\fancyhf{}
\renewcommand\headrulewidth{0pt}
\fancyhead[L]{\tikz\draw (0,0)--(0.25,0);\iffloatpage{FLOAT}{NORMAL}\iftopfloat{TOP}{CLEAR}\ifbotfloat{BOT}{FREE}}
\fancyfoot[L]{Total \pageref{LastPage}}
\begin{document}
First text.
\begin{figure}[p]\thispagestyle{empty}\centering\rule{3cm}{3cm}\caption{Float page}\end{figure}
\clearpage
\begin{table}[t]\centering\rule{2cm}{1cm}\caption{Top table}\end{table}
Third text.
\clearpage
Fifth text.
\end{document}
`;
  const alias = String.raw`\documentclass{article}
\usepackage{fancyhdr,tikz}
\newcommand\lessonmark[2]{\markboth{#1}{#2}}
\pagestyle{fancy}\fancyhf{}
\fancyhead[C]{\tikz\draw (0,0)--(.2,0);\leftmark/\rightmark}
\begin{document}

\markboth{ONE}{FIRST} Start. \lessonmark{TWO}{SECOND} End. \clearpage \markboth{LATE}{THIRD} Last.
\end{document}
`;
  const drawn = (engine) => engine.getDisplayLists().map((list) => list.commands.filter((c) => c.src === '_hf' && c.op === 'chunk').map((c) => c.chunk));
  const graphicPages = (engine) => [...engine.hf].filter(([, entry]) => entry.hg || entry.fg).map(([n]) => n);
  const until = async (cond, what) => {
    for (let i = 0; i < 600 && !cond(); i++) await new Promise((r) => setTimeout(r, 50));
    assert.ok(cond(), what);
  };
  // the head band's words on page `n` of the exact PDF
  const pdfHead = (engine, n) => {
    const geo = engine.geometry;
    const T = Math.ceil(72 + geo.topmargin + geo.headheight + geo.headsep);
    return spawnSync('pdftotext', ['-f', String(n), '-l', String(n), '-x', '0', '-y', '0', '-W', String(Math.ceil(geo.paperwidth)), '-H', String(T),
      engine.canonical.last.pdf, '-'], { encoding: 'utf8' }).stdout.trim();
  };
  const exact = async (engine) => {
    await engine.canonical.ensure(engine.getSource(), engine.srcRev);
    const id = engine.canonical.last.id;
    await until(() => graphicPages(engine).every((n) => engine.chunks.get(hfBandChunkKey(n, 'h'))?.canonicalId === id), 'every drawn head cut from the exact PDF');
    return id;
  };
  const onlyCanonical = (engine, id, label) => {
    for (const [i, ids] of drawn(engine).entries()) {
      for (const chunk of ids) {
        if (id !== null) assert.equal(engine.chunks.get(chunk).canonicalId, id, `${label}: page ${i + 1} from the exact PDF`);
      }
    }
  };
  for (const [name, source, heads] of [['float-macro', moving, ['FINAL', 'FINAL']], ['deferred-style', deferred, null], ['alias-marks', alias, ['TWO/FIRST', 'LATE/THIRD']]]) {
    await withEngine(source, async (engine) => {
      await settledHeaders(engine);
      onlyCanonical(engine, null, `${name} before the exact PDF`);
      assert.ok(drawn(engine).every((ids) => !ids.length), `${name}: nothing of a drawn head before the exact PDF (v0.1.32)`);
      const id = await exact(engine);
      onlyCanonical(engine, id, name);
      if (heads) assert.deepEqual(heads.map((_, i) => pdfHead(engine, i + 1)), heads, `${name}: the exact PDF's heads`);
      if (name !== 'float-macro') return;
      // A moved figure changes the source. The head still depends on the
      // value set by the body redefinition.
      const src = engine.getSource();
      const at = src.indexOf('\\begin{figure}');
      const mid = src.indexOf('\\clearpage');
      const end = src.indexOf('\\end{document}');
      await engine.edit(at, end, src.slice(mid, end) + src.slice(at, mid));
      await drain(engine, 120_000);
      await settledHeaders(engine);
      const held = [1, 2].map((n) => {
        const chunk = drawn(engine)[n - 1].find((key) => [hfBandChunkKey(n, 'h'), hfRenderChunkKey(n, 'h')].includes(key));
        return chunk && engine.chunks.get(chunk).svg;
      });
      const next = await exact(engine);
      assert.notEqual(next, id);
      onlyCanonical(engine, next, `${name} after the next exact PDF`);
      assert.deepEqual([1, 2].map((n) => pdfHead(engine, n)), ['FINAL', 'FINAL']);
      for (const [index, svg] of held.entries()) {
        if (!svg) continue;
        const band = engine.chunks.get(hfBandChunkKey(index + 1, 'h')).svg;
        const headBottom = 72 + engine.geometry.topmargin + engine.geometry.headheight;
        assert.deepEqual(bandPaint(svg, 0, headBottom).map((p) => p[1]), bandPaint(band, 0, headBottom).map((p) => p[1]));
      }
    });
  }
});

// Design E against real TeX (docs/10 §10.7a): exact bands of a generation of the
// source, then an edit; the header job of the new layout decides by fingerprint.
// audit/scratch r8: identity-repeat, identity-float, bottom-move, known-mark,
// known-lastpage, identity-counter, lineflow, identity-race, undo-window.
const T = String.raw;
const worksheetDoc = (pages, { head = T`\rightmark`, foot = T`Page \thepage` } = {}) => T`\documentclass[twoside]{article}
\usepackage{fancyhdr,tikz,lastpage}
\pagestyle{fancy}\fancyhf{}\fancyhead[L]{\tikz\draw(0,0)--(.5,0);${head}}\fancyfoot[C]{${foot}}
\begin{document}
` + pages.join('\n\n\\clearpage\n\n') + '\n\\end{document}\n';
const sheet = (mark, words) => T`\markboth{${mark}}{${mark}}
${words}

Exercise for section ${mark}.`;
const shared = T`Revision worksheet.\\
Name and date.\\
Show all steps.`;
const unique = (k) => T`${k} apple.\\
${k} orange.\\
${k} pear.`;
const editTo = async (engine, next) => {
  const src = engine.getSource();
  let start = 0;
  let end = 0;
  while (src[start] === next[start]) start++;
  while (src.at(-1 - end) === next.at(-1 - end) && src.length - end > start && next.length - end > start) end++;
  await engine.edit(start, src.length - end, next.slice(start, next.length - end));
};

test('an edit that changes what a page\'s head or foot reads drops its band; one that does not keeps it, and it never blinks', { skip: !texReady && 'lualatex not installed' }, async () => {
  // a worksheet inserted before two with the same opening lines: each page's head is now another lesson's
  const repeat = worksheetDoc([sheet('ALPHA', shared), sheet('BRAVO', shared), sheet('GAMMA', unique('Third'))]);
  await withEngine(repeat, async (engine) => {
    await exactBands(engine);
    await editTo(engine, repeat.replace(T`\markboth{ALPHA}`, sheet('INSERT', shared) + '\n\n\\clearpage\n\n' + T`\markboth{ALPHA}`));
    assert.deepEqual([1, 2, 3].map((n) => drawn(engine, n)), [null, null, null], 'hidden at once: another page\'s lines at each number');
    await drain(engine, 120_000);
    await landed(engine);
    assert.ok([1, 2, 3, 4].every((n) => fresh(drawn(engine, n))), 'INSERT/ALPHA/BRAVO are not ALPHA/BRAVO/GAMMA');
  });
  // a used mark changes on page 1; pages 2 and 3 keep theirs
  const marks = worksheetDoc([sheet('ALPHA', unique('First')), sheet('BRAVO', unique('Second')), sheet('GAMMA', unique('Third'))]);
  await withEngine(marks, async (engine) => {
    await exactBands(engine);
    const before = [1, 2, 3].map((n) => drawn(engine, n));
    await editTo(engine, marks.replace('{ALPHA}{ALPHA}', '{ZULUS}{ZULUS}'));
    await drain(engine, 120_000);
    await landed(engine);
    const after = [1, 2, 3].map((n) => drawn(engine, n));
    assert.ok(fresh(after[0]), after[0]);
    assert.deepEqual(after.slice(1), [before[1], before[2]]);
  });
  // a LastPage total: a fourth page changes every foot
  const total = worksheetDoc([sheet('ALPHA', unique('First')), sheet('BRAVO', unique('Second')), sheet('GAMMA', unique('Third'))],
    { foot: T`Page \thepage\ of \pageref{LastPage}` });
  await withEngine(total, async (engine) => {
    await exactBands(engine);
    await editTo(engine, total.replace('\n\\end{document}', '\n\n\\clearpage\n\nA fourth page.\n\\end{document}'));
    await drain(engine, 120_000);
    await landed(engine);
    // (each slot on its own fingerprint: the head reads no total, audit/scratch r10 restore)
    const [head, foot] = slots(engine, [1, 2, 3]);
    assert.ok(head.every(Boolean) && foot.every(fresh), 'of 3 is now of 4');
  });
  // a page-counter reset the spec folio does not follow (F7): the pages from the
  // assignment on take a band only from their own source (v0.1.32 kept 1-3 over 15-17)
  await withEngine(marks, async (engine) => {
    await exactBands(engine);
    await editTo(engine, marks.replace(T`\markboth{ALPHA}`, T`\setcounter{page}{15}` + '\n' + T`\markboth{ALPHA}`));
    assert.deepEqual([1, 2, 3].map((n) => drawn(engine, n)), [null, null, null], 'at once');
    await drain(engine, 120_000);
    await landed(engine);
    assert.ok([1, 2, 3].every((n) => fresh(drawn(engine, n))), 'only the new folios may be rendered');
  });
  // three lines become four on the same sheet (an unused mark helper in the preamble): kept, never hidden
  const flow = worksheetDoc([sheet('ALPHA', 'Copy the following observations into the worksheet. Then show each step in the construction and explain which properties of a parallel line are used in the solution. Record your answer and draw the remaining right angle carefully.'),
    sheet('BRAVO', unique('Second'))], { head: 'CONSTANT' }).replace('\\begin{document}', '\\newcommand\\idlemark{\\markright{X}}\n\\begin{document}');
  await withEngine(flow, async (engine) => {
    await exactBands(engine);
    const before = drawn(engine, 1);
    const at = engine.getSource().indexOf('Copy the following');
    for (const word of ['Before ', 'writing ', 'anything, ', 'check ', 'the ', 'outline. ']) {
      await engine.edit(at, at, word);
      assert.equal(drawn(engine, 1), before, `typing "${word.trim()}": the band stays`);
    }
    await drain(engine, 120_000);
    await landed(engine);
    assert.equal(drawn(engine, 1), before);
  });
});

test('a figure moved after the exact bands drops the bands of both pages whose float state changed (top and bottom)', { skip: !texReady && 'lualatex not installed' }, async () => {
  for (const [where, flag] of [['t', T`\iftopfloat{TOPFIG}{NOFIG}`], ['b', T`\ifbotfloat{BOTFIG}{NOFIG}`]]) {
    const source = T`\documentclass{article}
\usepackage{fancyhdr,tikz}
\pagestyle{fancy}\fancyhf{}\renewcommand\headrulewidth{0pt}
\fancyhead[L]{\tikz\draw (0,0)--(1,0);${flag}}
\begin{document}
First text.
\begin{figure}[${where}]\centering\rule{2cm}{1cm}\caption{Moving figure}\end{figure}
\clearpage
Second text.
\end{document}
`;
    await withEngine(source, async (engine) => {
      await exactBands(engine);
      assert.ok(drawn(engine, 1) && drawn(engine, 2));
      const src = engine.getSource();
      const fig = src.indexOf('\\begin{figure}');
      const mid = src.indexOf('\\clearpage');
      const end = src.indexOf('\\end{document}');
      await engine.edit(fig, end, src.slice(mid, end) + src.slice(fig, mid));
      await drain(engine, 120_000);
      await landed(engine);
      assert.deepEqual([1, 2].map((n) => drawn(engine, n)), [null, null], `${where}: the figure's two pages`);
      // the next generation: both, from the page each is now
      const id = await exactBands(engine);
      assert.deepEqual([1, 2].map((n) => engine.chunks.get(hfBandChunkKey(n, 'h')).canonicalId), [id, id]);
    });
  }
});

test('a read held across a swap of two pages binds the old pixels to the old page, never the new occupant', { skip: !texReady && 'lualatex not installed' }, async () => {
  const one = sheet('ALPHA', unique('First'));
  const two = sheet('BRAVO', unique('Second'));
  const source = worksheetDoc([one, two, sheet('GAMMA', unique('Third'))]);
  await withEngine(source, async (engine) => {
    const real = engine.canonical.pageSVG.bind(engine.canonical);
    let release = null;
    let held = false;
    engine.canonical.pageSVG = async (n, ...rest) => {
      if (!held) { held = true; await new Promise((r) => { release = r; }); }
      return real(n, ...rest);
    };
    await engine.canonical.ensure(engine.getSource(), engine.srcRev);
    await until(() => held, 'the held read');
    await editTo(engine, source.replace(one + '\n\n\\clearpage\n\n' + two, two + '\n\n\\clearpage\n\n' + one));
    release();
    await drain(engine, 120_000);
    await landed(engine);
    await sleep(500);
    const swapped = [1, 2].map((n) => drawn(engine, n));
    assert.ok(swapped.every(fresh), `ALPHA's pixels are not BRAVO's page, nor BRAVO's ALPHA's: ${swapped}`);
    assert.ok(drawn(engine, 3), 'page 3 kept its own');
  });
});

// A baseline that lands before the boot walk ends is announced again by the
// walk's last schedule(), inside that update (#reconcile). Bound there it
// bound nothing, and a freshly opened document's drawn heads stayed empty
// until the next compile. Here: nothing bound yet, an edit away and back,
// the generation announced again inside the update that returns to it.
test('a generation announced again inside an update is bound once the update has ended', { skip: !texReady && 'lualatex not installed' }, async () => {
  const source = worksheetDoc([sheet('ALPHA', unique('First')), sheet('BRAVO', unique('Second'))]);
  await withEngine(source, async (engine) => {
    const id = await exactBands(engine);
    engine.hfBindings.clear();
    for (const n of [1, 2]) for (const which of ['h', 'f']) engine.chunks.delete(hfBandChunkKey(n, which));
    engine.hfCanon = null;
    engine.canonical.schedule = Object.getPrototypeOf(engine.canonical).schedule.bind(engine.canonical);
    let announcedInside = 0;
    const onResult = engine.canonical.onResult;
    engine.canonical.onResult = (info) => { if (engine.updating) announcedInside++; return onResult(info); };
    await editTo(engine, source.replace('First apple', 'First Apple'));
    await editTo(engine, source);
    assert.ok(announcedInside > 0, 'the generation was announced inside the update');
    await until(() => engine.hfBindings.has(id) && drawn(engine, 1) && drawn(engine, 2), 'bound and cut after the update', 100);
  });
});

// The booklet opened with no Build PDF: its first generation landed while the
// resident layout of the same source was still being built (28 pages for 30),
// bound nothing, and no drawn head appeared until the next compile. Here the
// same state, made deterministic with a cold keystroke: the generation of the
// edited source is compiled first; the cold edit announces it (#reconcile)
// while its layout still has the old page count; the cold resume settles the
// layout with one page more. The bands appear then, with no further edit.
test('a generation that landed before the layout of its source settled is bound and cut once it settles, with no edit', { skip: !texReady && 'lualatex not installed' }, async () => {
  const paragraphs = [];
  for (let i = 1; i <= 160; i += 1) {
    paragraphs.push(`Paragraph ${i} of the settling fixture keeps the resident chain walking for a while.`);
    if (i % 4 === 0) paragraphs.push('\\newpage');
    paragraphs.push('');
  }
  const source = [String.raw`\documentclass{article}`, String.raw`\usepackage{fancyhdr,tikz}`,
    String.raw`\pagestyle{fancy}\fancyhf{}\fancyhead[C]{\tikz\draw(0,0)--(1,0); Head}\fancyfoot[C]{\thepage}`,
    String.raw`\begin{document}`, ...paragraphs, String.raw`\end{document}`, ''].join('\n');
  const root = fileURLToPath(new URL('../.tdom-v3-test-hf-settling', import.meta.url));
  rmSync(root, { recursive: true, force: true });
  const cached = fileURLToPath(new URL('../.tdom-v3-test/', import.meta.url));
  if (existsSync(path.join(cached, 'tdomfork.so'))) {
    mkdirSync(root, { recursive: true });
    for (const f of ['tdomfork.so', 'tdomfork.so.sha256']) copyFileSync(path.join(cached, f), path.join(root, f));
  }
  const engine = new CheckpointEngine({ workDir: root });
  engine.checkpointCeiling = 4; // paragraph 150 is far from every boundary: its keystroke is cold
  const schedule = engine.canonical.schedule;
  engine.canonical.schedule = () => {};
  try {
    await engine.open(source);
    await drain(engine, 120_000);
    await landed(engine);
    const pages = engine.pages.length;
    const at = engine.getSource().indexOf('Paragraph 150 ');
    const next = engine.getSource().slice(0, at) + '\\newpage ' + engine.getSource().slice(at);
    // the generation of the source the cold keystroke makes, compiled ahead
    await engine.canonical.ensure(next, engine.srcRev + 1);
    const generation = engine.canonical.last;
    assert.equal(generation.pageCount, pages + 1);
    assert.equal(engine.hfBindings?.size ?? 0, 0, 'another source: nothing bound');
    engine.canonical.schedule = schedule.bind(engine.canonical);
    engine.coldPrefixBudgetMs = 1;
    engine.coldPreviewEnabled = false;
    const resumed = new Promise((resolve) => { engine.onDeferredUpdate = resolve; });
    const cold = await engine.edit(at, at, '\\newpage ');
    assert.equal(cold.stats.chainVerdict, 'cold');
    assert.equal(engine.canonical.info().id, generation.id, 'the edit announced the compiled generation');
    await sleep(200);
    assert.equal(engine.pages.length, pages, 'the layout of this source still has the old page count');
    assert.ok(!engine.hfBindings?.has(generation.id), 'so the generation bound nothing yet');
    await Promise.race([resumed, sleep(90_000).then(() => { throw new Error('the cold resume never published'); })]);
    assert.equal(engine.pages.length, pages + 1);
    await until(() => engine.hfBindings?.has(generation.id) && [1, pages + 1].every((n) => drawn(engine, n)?.startsWith(hfBandChunkKey(n, 'h'))),
      'bound once the layout settled, and cut', 200);
    assert.ok([1, pages + 1].every((n) => engine.chunks.get(hfBandChunkKey(n, 'h')).canonicalId === generation.id));
  } finally {
    await engine.close().catch(() => {});
    rmSync(root, { recursive: true, force: true });
  }
});

// audit/scratch r8 retry-generation, on real generations: generation B's first read of page 1 fails, C
// supersedes B and its first read of page 1 fails too; C's own retry cuts page 1, with no other wake.
test('a failed cut is tried again across a newer generation, with no outside wake', { skip: !texReady && 'lualatex not installed' }, async () => {
  const source = worksheetDoc([sheet('ALPHA', unique('First')), sheet('BRAVO', unique('Second'))]);
  await withEngine(source, async (engine) => {
    await exactBands(engine);
    const real = engine.canonical.pageSVG.bind(engine.canonical);
    const failed = new Set();
    engine.canonical.pageSVG = async (n, id) => {
      if (n === 1 && !failed.has(id)) {
        failed.add(id);
        throw new Error('pdftocairo failed (test)');
      }
      return real(n, id);
    };
    await editTo(engine, source.replace('First apple', 'First Apple'));
    await engine.canonical.ensure(engine.getSource(), engine.srcRev);
    const b = engine.canonical.last.id;
    await until(() => failed.has(b), 'generation B failed page 1');
    await editTo(engine, engine.getSource().replace('Second apple', 'Second Apple'));
    await engine.canonical.ensure(engine.getSource(), engine.srcRev);
    const c = engine.canonical.last.id;
    await until(() => failed.has(c), 'generation C failed page 1');
    await until(() => engine.chunks.get(hfBandChunkKey(1, 'h'))?.canonicalId === c, 'page 1 cut from C by its own retry', 60);
    assert.ok(drawn(engine, 1) && drawn(engine, 2));
  });
});

// audit/scratch r8 undo-window: after 42 -> 1 -> 42, sheets 26 and 40 waited
// on fresh SVG reads (held 8.5 s there); v0.1.32 held their bands in memory.
// The generation's bands are held for all its pages: they draw at once, the
// reads held. A band missing all the same is cut again from the PDF.
test('an undo back to a generation\'s source draws its held bands at once, beyond 24 pages; a missing one is cut again from its PDF', { skip: !texReady && 'lualatex not installed' }, async () => {
  const pages = Array.from({ length: 42 }, (_, k) => sheet(`L${k + 1}`, `Body of sheet ${k + 1}.`));
  const source = worksheetDoc(pages);
  await withEngine(source, async (engine) => {
    const id = await exactBands(engine);
    const cut = source.indexOf('\n\n\\clearpage\n\n');
    const end = source.indexOf('\n\\end{document}');
    const removed = source.slice(cut, end);
    await engine.edit(cut, end, '');
    await drain(engine, 120_000);
    assert.equal(engine.pages.length, 1);
    assert.equal(engine.chunks.get(hfBandChunkKey(40, 'h'))?.canonicalId, id, 'the generation in use keeps its bands');
    engine.chunks.delete(hfBandChunkKey(33, 'h'));
    engine.chunks.delete(hfBandChunkKey(33, 'f'));
    const real = engine.canonical.pageSVG.bind(engine.canonical);
    let release;
    const held = new Promise((r) => { release = r; });
    engine.canonical.pageSVG = async (...args) => { await held; return real(...args); };
    engine.viewPage = 26;
    await engine.edit(cut, cut, removed);
    assert.equal(engine.pages.length, 42);
    await until(() => [26, 40].every((n) => drawn(engine, n)?.startsWith(hfBandChunkKey(n, 'h'))), 'sheets 26 and 40, reads held', 20);
    assert.equal(drawn(engine, 33), null, 'the missing one waits for its read');
    release();
    await until(() => drawn(engine, 33)?.startsWith(hfBandChunkKey(33, 'h')), 'sheet 33, cut again from generation ' + id, 200);
    assert.ok([26, 33, 40].every((n) => engine.chunks.get(hfBandChunkKey(n, 'h')).canonicalId === id));
  });
});

test('two opens behind one Build lease run one header job; a killed header child releases Build at once', { skip: !texReady && 'lualatex not installed' }, async () => {
  const source = String.raw`\documentclass{article}
\usepackage{fancyhdr,tikz}
\pagestyle{fancy}\fancyhf{}
\fancyhead[C]{\tikz\draw (0,0)--(1,0);Head}
\begin{document}
First text.\clearpage Second text.
\end{document}
`;
  // (audit/scratch reopen.mjs)
  await withEngine(source, async (engine) => {
    const claims = () => [...engine.buildLeasePreviewJobs].filter((job) => job.kind === 'header-render').length;
    const lease = engine.canonical.acquireBuildLease('test', 60_000);
    await engine.open(source.replace('First', 'Other'));
    await engine.open(source.replace('First', 'Third'));
    let most = 0;
    const sample = setInterval(() => { most = Math.max(most, claims()); }, 5);
    engine.canonical.releaseBuildLease('test', lease.token);
    for (let i = 0; i < 400 && (engine.opening || engine.hfScheduleQueued || claims() || engine.hfPending); i++) {
      await new Promise((r) => setTimeout(r, 25));
    }
    clearInterval(sample);
    assert.equal(most, 1, 'one header job holds a claim at a time');
    assert.ok(engine.hf.size >= 2, 'and it made the second document\'s heads');
  });
  // (audit/scratch killed.mjs: Build waited out the 60 s deadline)
  await withEngine(source, async (engine) => {
    let killed = null;
    engine.renderPids ??= new Map();
    const set = engine.renderPids.set.bind(engine.renderPids);
    engine.renderPids.set = (id, pid) => {
      const out = set(id, pid);
      if (!killed && id.startsWith('__hf.') && pid > 0) {
        killed = pid;
        process.kill(pid, 'SIGKILL');
      }
      return out;
    };
    await engine.open(source.replace('First', 'Other'));
    for (let i = 0; i < 200 && !killed; i++) await new Promise((r) => setTimeout(r, 25));
    assert.ok(killed, 'a header child was killed');
    const lease = engine.canonical.acquireBuildLease('test', 60_000);
    const t0 = Date.now();
    while (buildLeasePreviewSettlement(lease, engine.buildLeasePreviewJobs) && Date.now() - t0 < 20_000) {
      await new Promise((r) => setTimeout(r, 50));
    }
    assert.ok(Date.now() - t0 < 5_000, `Build settled ${Date.now() - t0} ms after the child died`);
    engine.canonical.releaseBuildLease('test', lease.token);
  });
});

// docs/10 §10.7a F1–F7 against real TeX, on Astra's round-9 fixtures
// (audit/scratch r9 attack.mjs, empty-page.mjs, diagonal.mjs, float-fixture).
const attackDoc = (sheets, { head = T`\rightmark`, preamble = '' } = {}) => T`\documentclass{article}
\usepackage{fancyhdr,tikz}
\pagestyle{fancy}\fancyhf{}\renewcommand\headrulewidth{0pt}
\fancyhead[L]{\tikz\draw(0,0)--(.5,0); ${head}}\fancyfoot[C]{Sheet \thepage}
` + preamble + '\\begin{document}\n' + sheets.join('\n\\clearpage\n') + '\n\\end{document}';
const mk = (mark, text) => `\\markboth{${mark}}{${mark}}\n${text}`;
const hfOps = (engine, n) => (engine.getDisplayLists()[n - 1]?.commands ?? []).filter((c) => c.src === '_hf' || c.op === 'folio')
  .map((c) => (c.op === 'chunk' ? `${c.chunk}@${c.cv}` : c.text ?? c.op));

test('F4 under a held Build lease: a rewritten one-line sheet keeps ALPHA / Sheet 1 while a sheet is appended; an empty cover gains no folio', { skip: !texReady && 'lualatex not installed' }, async () => {
  const short = attackDoc([mk('ALPHA', 'First question.'), mk('BETA', 'Second question.')]);
  await withEngine(short, async (engine) => {
    await exactBands(engine);
    const before = [1, 2].map((n) => drawn(engine, n));
    assert.ok(before.every(Boolean));
    await underLease(engine, async () => {
      await editTo(engine, short.replace('First question.', 'Entirely different instructions.')
        .replace('Second question.', 'Second question.\n\\clearpage\nAdditional sheet.'));
      assert.deepEqual([1, 2].map((n) => drawn(engine, n)), before, 'at once');
      await sleep(1500);
      assert.ok(!engine.hf.has(3) || engine.hfSig !== engine.currentSpecs.sig, 'the runs of the new layout are pending');
      assert.deepEqual([1, 2].map((n) => drawn(engine, n)), before, 'behind the lease');
    });
    await drain(engine, 120_000);
    await landed(engine);
    assert.deepEqual([1, 2].map((n) => drawn(engine, n)), before, 'the runs landed');
  });
  const cover = attackDoc(['\\thispagestyle{empty}\nFirst question.', mk('BETA', 'Second question.')]);
  await withEngine(cover, async (engine) => {
    await exactBands(engine);
    assert.deepEqual(hfOps(engine, 1), []);
    await underLease(engine, async () => {
      await editTo(engine, cover.replace('First question.', 'Entirely different instructions.')
        .replace('Second question.', 'Second question.\n\\clearpage\nAdditional sheet.'));
      assert.deepEqual(hfOps(engine, 1), [], 'an empty style draws nothing, no provisional folio');
      await sleep(1000);
      assert.deepEqual(hfOps(engine, 1), []);
    });
  });
});

test('F4: a band hidden while its page\'s fingerprint differed is drawn again when it returns', { skip: !texReady && 'lualatex not installed' }, async () => {
  const source = attackDoc([mk('ALPHA', 'First question.'), mk('BETA', 'Second question.')]);
  await withEngine(source, async (engine) => {
    await exactBands(engine);
    const before = [1, 2].map((n) => drawn(engine, n));
    const changed = source.replaceAll('ALPHA', 'ZULUS').replace('First question.', 'First amended question.');
    await editTo(engine, changed);
    await drain(engine, 120_000);
    await landed(engine);
    const zulus = [1, 2].map((n) => drawn(engine, n));
    assert.ok(fresh(zulus[0]), `ZULUS is not ALPHA: ${zulus[0]}`);
    assert.equal(zulus[1], before[1]);
    await editTo(engine, changed.replaceAll('ZULUS', 'ALPHA'));
    await drain(engine, 120_000);
    await landed(engine);
    assert.deepEqual([1, 2].map((n) => drawn(engine, n)), before, 'ALPHA again, the body correction kept (audit/scratch r9 restore)');
  });
});

test('F4: identical exercises in one block, a sheet inserted: BETA / GAMMA hide at once, also behind a held Build lease', { skip: !texReady && 'lualatex not installed' }, async () => {
  const reps = 'Repeat this exercise.\\\\\n'.repeat(3) + 'Repeat this exercise.';
  const source = attackDoc(['ALPHA', 'BETA', 'GAMMA'].map((k) => mk(k, reps)));
  await withEngine(source, async (engine) => {
    await exactBands(engine);
    const before = [1, 2, 3].map((n) => drawn(engine, n));
    assert.ok(before.every(Boolean));
    const next = source.replace('\\markboth{BETA}{BETA}', mk('INSERT', reps) + '\n\\clearpage\n\\markboth{BETA}{BETA}');
    await underLease(engine, async () => {
      await editTo(engine, next);
      assert.deepEqual([1, 2, 3].map((n) => drawn(engine, n)), [before[0], null, null], 'at once: INSERT / BETA are not BETA / GAMMA');
      await sleep(1500);
      const held = [1, 2, 3].map((n) => drawn(engine, n));
      assert.ok(held[0] === before[0] && held.slice(1).every(fresh), `behind the lease: ${held}`);
    });
    await drain(engine, 120_000);
    await landed(engine);
    const after = [1, 2, 3, 4].map((n) => drawn(engine, n));
    assert.equal(after[0], before[0]);
    assert.ok(after.slice(1).every(fresh), JSON.stringify(after));
  });
});

test('F4 iii: under continuous typing a moved figure hides the bands of a float-reading head and keeps those of one that does not', { skip: !texReady && 'lualatex not installed' }, async () => {
  for (const [head, kept] of [[T`\iftopfloat{TOPFIG}{NOFIG}`, false], ['FIXED', true]]) {
    const source = T`\documentclass{article}
\usepackage{fancyhdr,tikz}
\pagestyle{fancy}\fancyhf{}\renewcommand\headrulewidth{0pt}
\fancyhead[L]{\tikz\draw (0,0)--(1,0);${head}}\fancyfoot[C]{Sheet \thepage}
\begin{document}
First text of the first sheet, long enough to be told apart.
\begin{figure}[t]\centering\rule{2cm}{1cm}\caption{Moving figure}\end{figure}
\clearpage
Second text of the second sheet, long enough to be told apart.
\end{document}
`;
    await withEngine(source, async (engine) => {
      await exactBands(engine);
      const before = [1, 2].map((n) => drawn(engine, n));
      assert.ok(before.every(Boolean));
      const src = engine.getSource();
      const fig = src.indexOf('\\begin{figure}');
      const mid = src.indexOf('\\clearpage');
      const end = src.indexOf('\\end{document}');
      await underLease(engine, async () => {
        await engine.edit(fig, end, src.slice(mid, end) + src.slice(fig, mid));
        const want = kept ? before : [null, null];
        assert.deepEqual([1, 2].map((n) => drawn(engine, n)), want, `${head}: after the move`);
        const at = engine.getSource().indexOf('Second text');
        for (const word of ['Now ', 'typing ', 'more ', 'words ', 'here ']) {
          await engine.edit(at, at, word);
          assert.deepEqual([1, 2].map((n) => drawn(engine, n)), want, `${head}: typing "${word.trim()}"`);
          await sleep(150);
        }
      });
    });
  }
});

test('F4 iii: an edit to a mark the head does not read keeps the bands behind a held Build lease', { skip: !texReady && 'lualatex not installed' }, async () => {
  const source = attackDoc([mk('ALPHA', 'First question of the sheet.'), mk('BETA', 'Second question of the sheet.')], { head: 'CONSTANT' });
  await withEngine(source, async (engine) => {
    await exactBands(engine);
    const before = [1, 2].map((n) => drawn(engine, n));
    await underLease(engine, async () => {
      await editTo(engine, source.replace('{ALPHA}{ALPHA}', '{ZULUS}{ZULUS}'));
      assert.deepEqual([1, 2].map((n) => drawn(engine, n)), before, 'at once');
      await sleep(1500);
      assert.deepEqual([1, 2].map((n) => drawn(engine, n)), before, 'behind the lease');
    });
    await drain(engine, 120_000);
    await landed(engine);
    assert.deepEqual([1, 2].map((n) => drawn(engine, n)), before);
  });
});

test('F1: two heads drawing equal-size opposite diagonals have different fingerprints, and a move hides both bands once the runs land', { skip: !texReady && 'lualatex not installed' }, async () => {
  const source = T`\documentclass{article}
\usepackage{fancyhdr,tikz}
\pagestyle{fancy}\fancyhf{}\renewcommand\headrulewidth{0pt}
\fancyhead[L]{\iftopfloat{\tikz\draw(0,0)--(1,.3);}{\tikz\draw(0,.3)--(1,0);}}\fancyfoot[C]{Sheet \thepage}
\begin{document}
First text of the first sheet, long enough to be told apart.
\begin{figure}[t]\centering\rule{2cm}{1cm}\caption{Moving figure}\end{figure}
\clearpage
Second text of the second sheet, long enough to be told apart.
\end{document}
`;
  await withEngine(source, async (engine) => {
    await settledHeaders(engine);
    assert.notEqual(pageHfSig(engine.hf, 1), pageHfSig(engine.hf, 2), 'the two diagonals');
    assert.ok(engine.hf.get(1).hx && engine.hf.get(1).hx !== engine.hf.get(2).hx);
    await exactBands(engine);
    const src = engine.getSource();
    const fig = src.indexOf('\\begin{figure}');
    const mid = src.indexOf('\\clearpage');
    const end = src.indexOf('\\end{document}');
    await engine.edit(fig, end, src.slice(mid, end) + src.slice(fig, mid));
    await drain(engine, 120_000);
    await landed(engine);
    assert.deepEqual([1, 2].map((n) => drawn(engine, n)), [null, null], 'each sheet now draws the other diagonal');
  });
});

test('F5: a float page gets its recorded body style and the empty style stays empty', { skip: !texReady && 'lualatex not installed' }, async () => {
  const doc = (body) => T`\documentclass[twoside]{article}
\usepackage{fancyhdr,tikz,floatpag}
\floatpagestyle{empty}
\pagestyle{fancy}
\fancyhf{}
\renewcommand\headrulewidth{0pt}
\fancyhead[L]{\tikz\draw (0,0)--(1,0);\iftopfloat{TOPFIG}{NOFIG}}
\begin{document}
First text.
\begin{figure}[t]\centering\rule{2cm}{1cm}\caption{Moving figure}\end{figure}
\clearpage
Second text.
${body}
\clearpage
\begin{figure}[p]\centering\rule{3cm}{3cm}\caption{Float page}\end{figure}
\clearpage
Last text.
\end{document}
`;
  const floatPage = async (engine) => {
    await exactBands(engine);
    const id = engine.canonical.last.id;
    const rec = engine.hfBindings.get(id).pages.get(3);
    await until(() => rec.inkChecked || drawn(engine, 3), 'sheet 3 looked at');
    return drawn(engine, 3);
  };
  await withEngine(doc(T`\floatpagestyle{fancy}`), async (engine) => {
    assert.ok(engine.hf.get(3)?.hg, 'the runs job replays the body \\floatpagestyle');
    assert.ok(await floatPage(engine), 'sheet 3 draws its band');
  });
  await withEngine(doc(T`\makeatletter\gdef\at@float@page{\thispagestyle{fancy}}\makeatother`), async (engine) => {
    const entry = engine.hf.get(3);
    assert.ok(await floatPage(engine), 'the canonical page supplies the band for the recorded style');
    if (entry?.hg && Number.isInteger(entry.hr) && !(entry.hr & HF_UNESTABLISHED)) {
      const heading = /(?:TOPFIG|NOFIG)/.exec(runsText(entry.h))?.[0];
      assert.ok(heading && (await engine.canonical.pageTexts(engine.canonical.last.id))[2].includes(heading));
    }
    if (!entry?.hg) assert.equal(engine.chunks.get(hfBandChunkKey(3, 'h')).rec.pdfInk, true);
  });
  await withEngine(doc(''), async (engine) => {
    assert.equal(await floatPage(engine), null, 'the float page under \\floatpagestyle{empty}: nothing');
  });
});

test('F4: a preamble edit that reboots the root leaves the bound fingerprints as they were and hides the old pixels', { skip: !texReady && 'lualatex not installed' }, async () => {
  const source = attackDoc([mk('ALPHA', 'First question of the sheet.'), mk('BETA', 'Second question of the sheet.')], { head: 'OLD-TITLE' });
  await withEngine(source, async (engine) => {
    const id = await exactBands(engine);
    const fps = [1, 2].map((n) => engine.hfBindings.get(id).pages.get(n).fp);
    assert.ok(fps.every(Boolean));
    await editTo(engine, source.replace('OLD-TITLE', 'NEW-TITLE'));
    await drain(engine, 120_000);
    await landed(engine);
    assert.ok(runsText(engine.hf.get(1)?.h).includes('NEW-TITLE'));
    assert.deepEqual([1, 2].map((n) => engine.hfBindings.get(id).pages.get(n).fp), fps, 'filled once');
    assert.deepEqual([1, 2].map((n) => drawn(engine, n)), [null, null], 'OLD-TITLE is not NEW-TITLE');
  });
});

// The booklet (round 10 final chain): pages drawn mostly as exact pictures (example boxes) have little
// text of their own, and what they have stands after the box's text in the PDF. F6 by text alone left
// them unverified, so a lesson typed in after them hid their heads and feet (c53846b kept them). The
// SyncTeX check verifies them by their blocks.
test('F6: exact-picture pages need both block correspondence and matching furniture state', { skip: !texReady && 'lualatex not installed' }, async () => {
  const sheet = (mark, k) => T`\markboth{${mark}}{${mark}}
\begin{tcolorbox}[title=Example ${k}]Solve $x^2-4x+3<0$ and explain each step of the factorisation carefully, writing every intermediate expression.\end{tcolorbox}
A short note after the example box of sheet ${k}.`;
  const source = attackDoc(['ALPHA', 'BRAVO', 'GAMMA'].map((m, i) => sheet(m, i + 1)), { preamble: T`\usepackage[most]{tcolorbox}` + '\n' });
  await withEngine(source, async (engine) => {
    const id = await exactBands(engine);
    assert.deepEqual([1, 2, 3].map((n) => engine.hfBindings.get(id).pages.get(n).verified), [true, true, true], 'verified by their blocks');
    const before = [1, 2, 3].map((n) => drawn(engine, n));
    const beforePaint = [1, 2, 3].map((n) => bandPaint(engine.chunks.get(hfBandChunkKey(n, 'h')).svg, 0, 130));
    assert.ok(before.every(Boolean));
    await underLease(engine, async () => {
      await editTo(engine, source.replace('\n\\end{document}', '\n\\clearpage\n' + sheet('DELTA', 4) + '\n\\end{document}'));
      assert.equal(drawn(engine, 1), before[0], 'the first page has matching state');
      // The synthetic PDF owns its position identifiers. Earlier pictures
      // advancing that allocator do not change the paint on these sheets.
      assert.deepEqual([2, 3].map((n) => drawn(engine, n)), before.slice(1));
      await sleep(1500);
      assert.equal(drawn(engine, 1), before[0], 'the proven band stays behind the lease');
    });
    await drain(engine, 120_000);
    await landed(engine);
    const current = await exactBands(engine);
    assert.notEqual(current, id);
    assert.ok([1, 2, 3].every((n) => engine.chunks.get(hfBandChunkKey(n, 'h')).canonicalId === current && drawn(engine, n)));
    for (const n of [1, 2, 3]) {
      assert.ok(samePaint(bandPaint(engine.chunks.get(hfBandChunkKey(n, 'h')).svg, 0, 130), beforePaint[n - 1]),
        `sheet ${n} retained the exact head`);
    }
  });
});

// Round 10 audit item 6 (audit/scratch r10 unused.tex): \tate inside a macro the document never uses
// is not vertical writing. Vertical writing is the engine's own finding (update-prepare.js: the body's
// \tate, a tate class, or the direction LuaTeX-ja reports at boot); it shows such a document as exact
// pages, and nothing binds there.
test('a horizontal document with \\tate only in a macro it never uses keeps its graphic heads', { skip: !texReady && 'lualatex not installed' }, async () => {
  const source = T`\documentclass[twoside]{article}
\usepackage{fancyhdr,tikz,floatpag}
\floatpagestyle{empty}
\pagestyle{fancy}
\fancyhf{}
\renewcommand\headrulewidth{0pt}
\fancyhead[L]{\tikz\draw (0,0)--(1,0);\iftopfloat{TOPFIG}{NOFIG}}
\newcommand{\unusedbox}{\hbox{\tate X}}
\begin{document}
First text.
\begin{figure}[t]\centering\rule{2cm}{1cm}\caption{Moving figure}\end{figure}
\clearpage
Second text.
\floatpagestyle{fancy}
\clearpage
\begin{figure}[p]\centering\rule{3cm}{3cm}\caption{Float page}\end{figure}
\clearpage
Last text.
\end{document}
`;
  await withEngine(source, async (engine) => {
    assert.equal(engine.previewPolicy, 'structured');
    await exactBands(engine);
    assert.deepEqual([1, 2, 3, 4].map((n) => !!drawn(engine, n)), [true, true, true, true], 'the four graphic heads (c53846b drew them)');
  });
});

// Round 10 audit item 4 (audit/scratch r10 even): the odd pages' head reads no mark, the even pages'
// reads \rightmark. Sensitivity measured on the odd page said nothing of the even page's: sheet 2
// kept BEFORE for 4.2 s behind a held Build lease while its PDF said AFTER. Each parity and float
// context is probed on a page of its own.
test('F2 in context: an even page\'s head that reads the mark hides behind a held Build lease though the odd pages\' does not read it', { skip: !texReady && 'lualatex not installed' }, async () => {
  const source = T`\documentclass[twoside]{article}
\usepackage{fancyhdr,tikz}
\pagestyle{fancy}\fancyhf{}\renewcommand\headrulewidth{0pt}
\fancyhead[LO]{\tikz\draw(0,0)--(.5,0); Common}
\fancyhead[LE]{\tikz\draw(0,0)--(.5,0); \rightmark}
\fancyfoot[C]{Sheet \thepage}
\begin{document}
` + [mk('FIRST', 'First question.'), mk('BEFORE', 'Second question.')].join('\n\\clearpage\n') + '\n\\end{document}';
  await withEngine(source, async (engine) => {
    await exactBands(engine);
    const [head, foot] = slots(engine, [1, 2]);
    assert.ok([...head, ...foot].every(Boolean));
    await underLease(engine, async () => {
      await editTo(engine, source.replaceAll('BEFORE', 'AFTER'));
      assert.deepEqual(slots(engine, [1, 2]), [[head[0], null], foot], 'at once: BEFORE is not AFTER; the folio is as it was');
      await sleep(4200);
      const [hh, ff] = slots(engine, [1, 2]);
      assert.ok(hh[0] === head[0] && fresh(hh[1]) && ff.join() === foot.join(), `behind the lease: ${hh} ${ff}`);
    });
    await drain(engine, 120_000);
    await landed(engine);
    const [h2, f2] = slots(engine, [1, 2]);
    assert.ok(h2[0] === head[0] && fresh(h2[1]) && f2.join() === foot.join(), `the runs landed: ${h2} ${f2}`);
  });
  // a head that reads the mark only where a figure stands at the top: measured with the figure
  const floats = T`\documentclass{article}
\usepackage{fancyhdr,tikz}
\pagestyle{fancy}\fancyhf{}\renewcommand\headrulewidth{0pt}
\fancyhead[L]{\tikz\draw(0,0)--(.5,0); \iftopfloat{\rightmark}{FIXED}}
\fancyfoot[C]{Sheet \thepage}
\begin{document}
` + [mk('ALPHA', 'First question.'), mk('BETA', 'Second question.'),
    mk('GAMMA', 'Third question.\n' + T`\begin{figure}[t]\centering\rule{2cm}{1cm}\caption{Top figure}\end{figure}`)].join('\n\\clearpage\n') + '\n\\end{document}';
  await withEngine(floats, async (engine) => {
    await exactBands(engine);
    assert.deepEqual(engine.currentSpecs.specs.map((s) => s.fl), ['', '', 't']);
    const [head, foot] = slots(engine, [1, 2, 3]);
    assert.ok([...head, ...foot].every(Boolean));
    await underLease(engine, async () => {
      await editTo(engine, floats.replaceAll('GAMMA', 'DELTA'));
      assert.deepEqual(slots(engine, [1, 2, 3]), [[head[0], head[1], null], foot], 'at once: GAMMA over the figure is not DELTA');
      await sleep(1500);
      const [hh, ff] = slots(engine, [1, 2, 3]);
      assert.ok(hh[0] === head[0] && hh[1] === head[1] && fresh(hh[2]) && ff.join() === foot.join(), `behind the lease: ${hh} ${ff}`);
    });
  });
});

// Round 10 audit item 12 (audit/scratch r10 restore): only the head reads the mark. Sheet 1's foot,
// "Sheet 1" before and after, lost its band to a bare provisional 1 while the runs were pending and
// then to nothing once they landed. Each slot is decided on its own fingerprint and dependencies.
test('F4 per slot: a head that reads the changed mark hides alone; the foot keeps its band, held and landed', { skip: !texReady && 'lualatex not installed' }, async () => {
  const source = attackDoc([mk('ALPHA', 'First question.'), mk('BETA', 'Second question.')]);
  await withEngine(source, async (engine) => {
    await exactBands(engine);
    const [head, foot] = slots(engine, [1, 2]);
    assert.ok([...head, ...foot].every(Boolean));
    const changed = source.replaceAll('ALPHA', 'ZULUS').replace('First question.', 'First amended question.');
    await underLease(engine, async () => {
      await editTo(engine, changed);
      assert.deepEqual(slots(engine, [1, 2]), [[null, head[1]], foot], 'at once');
      assert.ok(!hfOps(engine, 1).includes('1'), 'no provisional folio over the foot');
      await sleep(1500);
      const [hh, ff] = slots(engine, [1, 2]);
      assert.ok(fresh(hh[0]) && hh[1] === head[1] && ff.join() === foot.join(), `behind the lease: ${hh} ${ff}`);
    });
    await drain(engine, 120_000);
    await landed(engine);
    const [h1, f1] = slots(engine, [1, 2]);
    assert.ok(fresh(h1[0]) && h1[1] === head[1] && f1.join() === foot.join(), `the runs landed: ${h1} ${f1}`);
  });
});

// The conservative rule kept: art that crosses from the head band into the foot band (an overlay line
// drawn from the head down the page) is the canonical page's as one; the two bands go together.
test('F4 per slot: a head whose art crosses into the foot band takes the foot band with it', { skip: !texReady && 'lualatex not installed' }, async () => {
  const source = attackDoc([mk('ALPHA', 'First question.'), mk('BETA', 'Second question.')],
    { head: T`\tikz[overlay]\draw (0,0)--(0,-750pt); \rightmark` });
  await withEngine(source, async (engine) => {
    await exactBands(engine);
    const [head, foot] = slots(engine, [1, 2]);
    assert.ok([...head, ...foot].every(Boolean));
    await underLease(engine, async () => {
      await editTo(engine, source.replaceAll('ALPHA', 'ZULUS'));
      assert.deepEqual(slots(engine, [1, 2]), [[null, head[1]], [null, foot[1]]], 'at once: the line in the foot band is the old head\'s');
    });
  });
});

// F6 (audit/scratch r10 check-capture): SyncTeX names a physical input. A line of another input with
// the same name is not the block's; the block's own input is, by its full path.
test('F6: a SyncTeX hit in another input of the same name is not the block\'s; one in its own input is', { skip: !texReady && 'lualatex not installed' }, async () => {
  const root = fileURLToPath(new URL(`../.tdom-v3-test-hf-units-${process.pid}`, import.meta.url));
  rmSync(root, { recursive: true, force: true });
  for (const dir of ['unit1', 'unit2', 'work']) mkdirSync(path.join(root, dir), { recursive: true });
  const cached = fileURLToPath(new URL('../.tdom-v3-test/', import.meta.url));
  if (existsSync(path.join(cached, 'tdomfork.so'))) for (const f of ['tdomfork.so', 'tdomfork.so.sha256']) copyFileSync(path.join(cached, f), path.join(root, 'work', f));
  const chapter = (k) => Array.from({ length: 6 }, (_, i) => `Unit ${k} paragraph ${i + 1}, with enough ordinary words in it to fill one line of text.\n`).join('\n');
  for (const k of [1, 2]) writeFileSync(path.join(root, `unit${k}`, 'chapter.tex'), chapter(k));
  const engine = new CheckpointEngine({ workDir: path.join(root, 'work'), docDir: root });
  engine.canonical.schedule = () => {};
  try {
    await engine.open(['\\documentclass{article}', '\\begin{document}', '\\input{unit1/chapter}', '\\clearpage', '\\input{unit2/chapter}', '\\end{document}', ''].join('\n'));
    await drain(engine, 120_000);
    await engine.canonical.ensure(engine.getSource(), engine.srcRev);
    const id = engine.canonical.last.id;
    const spans = blockSpans(engine, engine.pages, engine.blocks);
    const unit = (k) => [...spans.values()].find((span) => span.file.includes(`unit${k}`));
    assert.ok(unit(1) && unit(2), 'both inputs have blocks on the pages');
    // (asked at a block of unit2 in the middle of its page: the first and last blocks there are each
    // joined with the root's text, blocks in two files)
    const page = engine.pages[1];
    const bid = [...spans].find(([, span]) => span.file.includes('unit2'))[0];
    const probe = probePoints({ number: page.number, draw: page.draw.filter((d) => String(d.u?.blockId ?? '').split('@')[0] === bid) }, engine.geometry)[0];
    assert.equal(probe?.bid, bid);
    const hit = await engine.canonical.reverseSync({ page: page.number, x: probe.x, y: probe.y, id });
    assert.match(String(hit?.file), /unit2[\\/]chapter\.tex$/);
    assert.equal(probesCorrespond([probe], [hit], spans), true, 'its own input, by its full path');
    const elsewhere = new Map([[probe.bid, { ...spans.get(probe.bid), file: unit(1).file, inputs: undefined }]]);
    assert.equal(probesCorrespond([probe], [hit], elsewhere), null, 'unit2/chapter.tex is not unit1/chapter.tex');
  } finally {
    await engine.close().catch(() => {});
    rmSync(root, { recursive: true, force: true });
  }
});

// Round 11 audit item 5 (audit/scratch r11 tail) and round 12 item 7 (r12 reset-flat): the header job numbers
// a page from its spec. A body \setcounter{page} / \addtocounter{page} reports where it lands and what it set
// (tex-templates.js), and the spec follows it: "Sheet 71" where TeX prints 71, and a numerically neutral reset
// keeps every slot. Only an assignment whose page cannot be told (inside a paragraph, which TeX may apply to the
// page before its line) withholds the job's text from there: no runs, no provisional folio, the source's own
// bands once its exact PDF has come.
test('F7 for the job\'s own text: a body \\setcounter{page} is replayed into the folios; one inside a paragraph withholds the job\'s text, the exact bands come', { skip: !texReady && 'lualatex not installed' }, async () => {
  const sheets = Array.from({ length: 6 }, (_, i) => `Exercise ${i + 1}.`);
  const source = T`\documentclass{article}
\usepackage{fancyhdr}
\pagestyle{fancy}\fancyhf{}\renewcommand\headrulewidth{0pt}
\fancyhead[L]{Lesson \thepage}\fancyfoot[C]{Sheet \thepage}
\begin{document}
` + sheets.join('\n\\clearpage\n') + '\n\\end{document}';
  const texts = (engine, n) => (engine.getDisplayLists()[n - 1]?.commands ?? []).filter((c) => (c.src === '_hf' && c.op === 'glyphs') || c.op === 'folio').map((c) => c.text).join('').replace(/\s+/g, '');
  await withEngine(source, async (engine) => {
    assert.deepEqual([1, 4, 6].map((n) => texts(engine, n)), ['Lesson1Sheet1', 'Lesson4Sheet4', 'Lesson6Sheet6']);
    const next = source.replace('Exercise 4.', T`\setcounter{page}{71}` + '\nExercise 4.');
    await underLease(engine, async () => {
      await editTo(engine, next);
      assert.deepEqual([3, 4, 6].map((n) => texts(engine, n)), ['Lesson3Sheet3', '71', '73'], 'at once: TeX numbers sheet 4 as 71 (the provisional folio)');
    });
    await drain(engine, 120_000);
    await landed(engine);
    assert.deepEqual([3, 4, 6].map((n) => texts(engine, n)), ['Lesson3Sheet3', 'Lesson71Sheet71', 'Lesson73Sheet73'], 'the runs landed');
    const inside = source.replace('Exercise 4.', T`Exercise 4 \setcounter{page}{71} in a paragraph.`);
    await editTo(engine, inside);
    await drain(engine, 120_000);
    await landed(engine);
    assert.deepEqual([3, 4, 6].map((n) => texts(engine, n)), ['Lesson3Sheet3', '', ''], 'inside a paragraph: not told');
    // the exact PDF of this source: its own bands on the sheets the job cannot number
    await engine.canonical.ensure(engine.getSource(), engine.srcRev);
    const id = engine.canonical.last.id;
    await until(() => [4, 5, 6].every((n) => drawn(engine, n, 'f') && engine.chunks.get(hfBandChunkKey(n, 'f')).canonicalId === id), 'the bands of sheets 4-6');
    assert.equal(texts(engine, 4), '');
  });
});

// Round 12 audit item 7 (audit/scratch r12 reset-flat): \setcounter{page}{2} on sheet 2 changes no folio. The
// round-11 rule took any assignment for an unknown folio and erased sheet 2's and 3's head and foot, which the
// exact PDFs and v0.1.32 kept.
test('F7: a numerically neutral page reset keeps every slot, text and drawn alike', { skip: !texReady && 'lualatex not installed' }, async () => {
  const body = ['First exercise.', 'Second exercise.', 'Third exercise.'].join('\n\\clearpage\n');
  const doc = (head) => T`\documentclass{article}
\usepackage{fancyhdr,tikz}
\pagestyle{fancy}\fancyhf{}\renewcommand\headrulewidth{0pt}
\fancyhead[L]{${head}}\fancyfoot[C]{Sheet \thepage}
\begin{document}
` + body + '\n\\end{document}';
  const reset = (src) => src.replace('Second exercise.', T`\setcounter{page}{2}` + '\nSecond exercise.');
  const texts = (engine, n) => (engine.getDisplayLists()[n - 1]?.commands ?? []).filter((c) => (c.src === '_hf' && c.op === 'glyphs') || c.op === 'folio').map((c) => c.text).join('').replace(/\s+/g, '');
  const plain = doc('Instructor copy');
  await withEngine(plain, async (engine) => {
    const before = [1, 2, 3].map((n) => texts(engine, n));
    assert.deepEqual(before, ['InstructorcopySheet1', 'InstructorcopySheet2', 'InstructorcopySheet3']);
    await underLease(engine, async () => {
      await editTo(engine, reset(plain));
      assert.deepEqual([1, 2, 3].map((n) => texts(engine, n)), before, 'at once');
      await sleep(1000);
      assert.deepEqual([1, 2, 3].map((n) => texts(engine, n)), before, 'behind the lease');
    });
    await drain(engine, 120_000);
    await landed(engine);
    assert.deepEqual([1, 2, 3].map((n) => texts(engine, n)), before, 'the runs landed');
  });
  const drawing = doc(T`\tikz\draw(0,0)--(.5,0); Instructor copy`);
  await withEngine(drawing, async (engine) => {
    await exactBands(engine);
    const before = slots(engine, [1, 2, 3]);
    assert.ok(before.flat().every(Boolean));
    await underLease(engine, async () => {
      await editTo(engine, reset(drawing));
      assert.deepEqual(slots(engine, [1, 2, 3]), before, 'at once');
    });
    await drain(engine, 120_000);
    await landed(engine);
    assert.deepEqual(slots(engine, [1, 2, 3]), before, 'the runs landed');
  });
});

// Round 12 audit item 8 (audit/scratch r12 value): a head that numbers each form with a counter, writes it and
// labels it. The measuring typesetting (the trace, the probes) ran between the pages' own and stepped the counter:
// the preview printed 1, 9, 17, 19 where the PDF and v0.1.32 print 1, 2, 3, 4. The pages are set first, alone;
// the measuring pass after them puts every counter back and writes nothing.
test('F2: measuring a head never changes what the pages\' own heads print (a counter stepped, a write, a label)', { skip: !texReady && 'lualatex not installed' }, async () => {
  const source = T`\documentclass{article}
\usepackage{fancyhdr}
\pagestyle{fancy}\fancyhf{}\renewcommand\headrulewidth{0pt}
\newcounter{leaf}
\fancyhead[L]{\stepcounter{leaf}\immediate\write16{HEAD-SERIAL-\arabic{leaf}}\label{leaf\arabic{leaf}}Form \arabic{leaf}}
\fancyfoot[C]{Sheet \thepage}
\begin{document}
One.\clearpage
Two.\clearpage
Three.\clearpage
Four.
\end{document}
`;
  const heads = (engine) => [1, 2, 3, 4].map((n) => runsText(engine.hf.get(n)?.h).replace(/\s+/g, ''));
  await withEngine(source, async (engine) => {
    assert.deepEqual(heads(engine), ['Form1', 'Form2', 'Form3', 'Form4']);
    await editTo(engine, source.replace('Two.', 'Two amended.'));
    await drain(engine, 120_000);
    await landed(engine);
    assert.deepEqual(heads(engine), ['Form1', 'Form2', 'Form3', 'Form4'], 'after a body edit, as the PDF and v0.1.32');
  });
});

// Round 11 audit item 6 (audit/scratch r11 conditional): the even head prints "Solutions" for the
// mark AFTER and "Exercises" otherwise. Both probe marks (empty, a sentinel) took the Exercises
// branch, so the head was taken not to read the mark and kept "Exercises" behind the lease. Whether a
// slot reads a mark is seen in its own setting: it expanded \leftmark or \rightmark.
test('F2 by what a slot read: a head that compares the mark to one value hides when the mark changes; the foot that never read it stays', { skip: !texReady && 'lualatex not installed' }, async () => {
  const source = T`\documentclass[twoside]{article}
\usepackage{fancyhdr,tikz,pdftexcmds}
\pagestyle{fancy}\fancyhf{}\renewcommand\headrulewidth{0pt}
\fancyhead[LO]{\tikz\draw(0,0)--(.5,0); Common}
\makeatletter
\newcommand{\editionhead}{\ifnum\pdf@strcmp{\rightmark}{AFTER}=0 Solutions\else Exercises\fi}
\makeatother
\fancyhead[LE]{\tikz\draw(0,0)--(.5,0); \editionhead}
\fancyfoot[C]{Sheet \thepage}
\begin{document}
` + [mk('FIRST', 'First question.'), mk('BEFORE', 'Second question.')].join('\n\\clearpage\n') + '\n\\end{document}';
  await withEngine(source, async (engine) => {
    await exactBands(engine);
    const [head, foot] = slots(engine, [1, 2]);
    assert.ok([...head, ...foot].every(Boolean));
    const read = [1, 2].map((n) => [engine.hf.get(n).hr, engine.hf.get(n).fr]);
    await underLease(engine, async () => {
      await editTo(engine, source.replaceAll('{BEFORE}', '{AFTER}'));
      assert.deepEqual(slots(engine, [1, 2]), [[head[0], null], foot], 'at once: Exercises is not Solutions');
      await sleep(1500);
      const [hh, ff] = slots(engine, [1, 2]);
      assert.ok(hh[0] === head[0] && fresh(hh[1]) && ff.join() === foot.join(), `behind the lease: ${hh} ${ff}`);
    });
    assert.deepEqual(read, [[HF_PARITY, HF_FOLIO], [1 | HF_PARITY, HF_FOLIO]],
      'the heads select by parity, the even head also reads the mark, and each foot reads its folio');
  });
});

// Round 12 audit item 5 (the booklet, sheet 29): one `remember picture, overlay` picture in the head draws the head's
// words and, at the bottom of the paper, the folio. A changed head withdrew the old band of the head, and with it the
// folio its picture painted into the foot band (v0.1.32 showed the folio, under the wrong head). Once the runs land,
// the page's furniture is rendered from the current source on its paper: the new head and the folio, cut into the two
// bands, the pixels the exact PDF then has.
test('F4: a page whose changed head also paints the folio gets its furniture rendered from the current source', { skip: !texReady && 'lualatex not installed' }, async () => {
  const source = T`\documentclass[twoside]{article}
\usepackage{fancyhdr,tikz}
\pagestyle{fancy}\fancyhf{}\renewcommand\headrulewidth{0pt}
\newcommand\Head[1]{\begin{tikzpicture}[remember picture,overlay]
\draw[line width=.5pt] ([xshift=2cm,yshift=-2cm]current page.north west) -- ([xshift=-2cm,yshift=-2cm]current page.north east);
\node[anchor=west] at ([xshift=2cm,yshift=-1.6cm]current page.north west) {#1};
\node at ([yshift=1.4cm]current page.south) {--- \thepage\ ---};
\end{tikzpicture}}
\fancyhead[L]{\Head{\rightmark}}
\begin{document}
` + [mk('ALPHA', 'First question.'), mk('BETA', 'Second question.'), mk('GAMMA', 'Third question.'), mk('OMEGA', 'Fourth question.')].join('\n\\clearpage\n') + '\n\\end{document}';
  await withEngine(source, async (engine) => {
    await exactBands(engine);
    const [head] = slots(engine, [1, 2, 3]);
    assert.ok(head.every(Boolean));
    const next = source.replace('{BETA}{BETA}', '{DELTA}{DELTA}');
    const rendered = (n) => ['h', 'f'].every((w) => engine.chunks.get(hfRenderChunkKey(n, w))?.rec?.render && drawn(engine, n, w)?.startsWith('__hfr-'));
    // Body-only repagination can rebuild the notes while the same head and
    // foot job is in flight.
    const repages = setInterval(() => {
      if (engine.hfRendering && engine.currentSpecs) engine.currentSpecs = { ...engine.currentSpecs };
    }, 5);
    try {
      await editTo(engine, next);
      await drain(engine, 120_000);
      await landed(engine);
      await until(() => rendered(2), 'sheet 2\'s furniture rendered from the current source', 180);
    } finally {
      clearInterval(repages);
    }
    assert.deepEqual([1, 3].map((n) => drawn(engine, n)), [head[0], head[2]], 'the other sheets keep their exact bands');
    assert.ok(!engine.chunks.get(hfBandChunkKey(1, 'h')).rec.render);
    const inkOf = (key) => engine.chunks.get(key).ink.map(([a, b]) => [Math.round(a), Math.round(b)]);
    const renderedInk = ['h', 'f'].map((w) => inkOf(hfRenderChunkKey(2, w)));
    // the exact PDF of this source: the same ink in both bands
    const id = await exactBands(engine);
    assert.equal(engine.chunks.get(hfBandChunkKey(2, 'h')).canonicalId, id);
    assert.deepEqual(['h', 'f'].map((w) => inkOf(hfBandChunkKey(2, w))), renderedInk, 'the render\'s ink is the exact PDF\'s');
    assert.ok(['h', 'f'].every((w) => drawn(engine, 2, w) === `${hfBandChunkKey(2, w)}@${engine.chunks.get(hfBandChunkKey(2, w)).v}`), 'and the exact bands are drawn');
  });
  // The overlay can draw both bands when the body's observed counter
  // can be reproduced exactly on the target sheet.
  const counted = source.replace('\\fancyhead[L]{\\Head{\\rightmark}}', '\\fancyhead[L]{\\Head{\\rightmark\\ \\arabic{section}}}')
    .replaceAll('\\markboth{', '\\stepcounter{section}\\markboth{');
  assert.notEqual(counted, source);
  await withEngine(counted, async (engine) => {
    await exactBands(engine);
    await editTo(engine, counted.replace('{BETA}{BETA}', '{DELTA}{DELTA}'));
    await drain(engine, 120_000);
    await landed(engine);
    await until(() => ['h', 'f'].every((w) => drawn(engine, 2, w)?.startsWith('__hfr-')), 'both overlay bands rendered');
    const replacement = engine.chunks.get(hfRenderChunkKey(2, 'h')).svg;
    await exactBands(engine);
    const band = engine.chunks.get(hfBandChunkKey(2, 'h')).svg;
    assert.deepEqual(bandPaint(replacement, 0, 130).map((p) => p[1]), bandPaint(band, 0, 130).map((p) => p[1]));
  });
});

// R13 D: a same-parity control after the target also has the body state.
// The dormant renderer must either reproduce the target's paint or abstain.
test('R13 D: a body counter, macro, or paint change cannot authorize a guessed head', { skip: !texReady && 'lualatex not installed' }, async () => {
  const cases = [
    [T`\newcounter{unit}`, T`Unit \arabic{unit}: \rightmark`, T`\stepcounter{unit}`, 'Unit 1: DELTA', T`\setcounter{unit}{0}`],
    [T`\renewcommand\sectionmark[1]{}`, T`Unit \thesection: \rightmark`, T`\section{Practice}`, 'Unit 1: DELTA'],
    ['', T`\ifnum\value{section}>0\color{blue}\else\color{red}\fi \rightmark`, T`\stepcounter{section}`, 'DELTA'],
    [T`\newcommand\UnitName{Before}`, T`\UnitName: \rightmark`, T`\renewcommand\UnitName{After}`, 'After: DELTA', T`\renewcommand\UnitName{Before}`],
    ['', T`\rightmark`, T`\color{blue}`, 'DELTA'],
  ];
  for (const [pre, head, body, exact, control = ''] of cases) {
    const source = T`\documentclass[twoside]{article}
\usepackage{fancyhdr,tikz}
\pagestyle{fancy}\fancyhf{}\renewcommand\headrulewidth{0pt}
${pre}
\fancyhead[LO]{\tikz\draw(0,0)--(.5,0); Common}
\fancyhead[LE]{\tikz\draw(0,0)--(.5,0); ${head}}
\fancyfoot[C]{Sheet \thepage}
\begin{document}
` + [mk('ALPHA', 'First question.'), body + '\n' + mk('BETA', 'Second question.'), mk('GAMMA', 'Third question.'), control + '\n' + mk('OMEGA', 'Fourth question.')].join('\n\\clearpage\n') + '\n\\end{document}';
    await withEngine(source, async (engine) => {
      await exactBands(engine);
      const independentFoot = drawn(engine, 2, 'f');
      let replacement, retainedFoot;
      await underLease(engine, async () => {
        await editTo(engine, source.replace('{BETA}{BETA}', '{DELTA}{DELTA}'));
        await until(() => !engine.hfRendering, 'furniture render settled');
        const painted = drawn(engine, 2, 'h');
        assert.ok(fresh(painted), `no stale ${exact}`);
        if (painted) replacement = engine.chunks.get(hfRenderChunkKey(2, 'h')).svg;
        const ambientMayDiffer = body === T`\section{Practice}` || body === T`\color{blue}`;
        const foot = drawn(engine, 2, 'f');
        if (!ambientMayDiffer) assert.equal(foot, independentFoot, 'the independent footer stays');
        if (foot && foot === independentFoot) retainedFoot = engine.chunks.get(hfBandChunkKey(2, 'f')).svg;
      });
      await drain(engine, 120_000);
      await landed(engine);
      await exactBands(engine);
      const pdf = spawnSync('pdftotext', ['-f', '2', '-l', '2', engine.canonical.last.pdf, '-'], { encoding: 'utf8' });
      assert.equal(pdf.status, 0);
      assert.ok(pdf.stdout.includes(exact), pdf.stdout);
      if (retainedFoot) {
        const band = engine.chunks.get(hfBandChunkKey(2, 'f')).svg;
        const rows = [650, 800];
        assert.ok(samePaint(bandPaint(retainedFoot, ...rows), bandPaint(band, ...rows)), 'a retained footer has the exact paint');
      }
      if (replacement) {
        const band = engine.chunks.get(hfBandChunkKey(2, 'h')).svg;
        assert.deepEqual(bandPaint(replacement, 0, 130).map((p) => p[1]), bandPaint(band, 0, 130).map((p) => p[1]));
      }
    });
  }
});

test('R13 D: a page style that reads a body counter cannot authorize guessed boxes', { skip: !texReady && 'lualatex not installed' }, async () => {
  const source = T`\documentclass[twoside]{article}
\usepackage{fancyhdr,tikz}
\makeatletter
\def\ps@worksheet{\ps@fancy
  \ifnum\value{section}>0
    \def\@evenhead{\tikz\draw(0,0)--(.5,0); Advanced: \rightmark}%
  \else
    \def\@evenhead{\tikz\draw(0,0)--(.5,0); Basics: \rightmark}%
  \fi}
\makeatother
\fancyhf{}\renewcommand\headrulewidth{0pt}
\fancyhead[LO]{\tikz\draw(0,0)--(.5,0); Common}
\fancyfoot[C]{Sheet \thepage}
\pagestyle{fancy}
\begin{document}
` + [mk('ALPHA', 'First question.'),
    '\\stepcounter{section}\\thispagestyle{worksheet}\n' + mk('BETA', 'Second question.'),
    mk('GAMMA', 'Third question.'),
    '\\setcounter{section}{0}\\thispagestyle{worksheet}\n' + mk('OMEGA', 'Fourth question.')].join('\n\\clearpage\n') + '\n\\end{document}';
  await withEngine(source, async (engine) => {
    await exactBands(engine);
    let replacement;
    await underLease(engine, async () => {
      await editTo(engine, source.replace('{BETA}{BETA}', '{DELTA}{DELTA}'));
      await until(() => engine.hfRenderStats?.renders > 0 && !engine.hfRendering, 'the even control was tried');
      const painted = drawn(engine, 2, 'h');
      assert.ok(fresh(painted));
      if (painted) replacement = engine.chunks.get(hfRenderChunkKey(2, 'h')).svg;
    });
    await drain(engine, 120_000);
    await landed(engine);
    await exactBands(engine);
    const pdf = spawnSync('pdftotext', ['-f', '2', '-l', '2', engine.canonical.last.pdf, '-'], { encoding: 'utf8' });
    assert.equal(pdf.status, 0);
    assert.match(pdf.stdout, /Advanced:\s+DELTA/);
    if (replacement) {
      const band = engine.chunks.get(hfBandChunkKey(2, 'h')).svg;
      assert.deepEqual(bandPaint(replacement, 0, 130).map((p) => p[1]), bandPaint(band, 0, 130).map((p) => p[1]));
    }
  });
});

test('R13 D: control paint distinguishes equal outlines with different inherited colours', () => {
  const paint = (colour) => bandPaint(`<svg><defs><g id="glyph-1"><path d="M 0 0 L 1 1"/></g></defs>
<g style="fill:rgb(${colour});fill-opacity:1;"><use xlink:href="#glyph-1" x="4" y="5"/></g></svg>`, 0, 10);
  assert.notDeepEqual(paint('100%,0%,0%'), paint('0%,0%,100%'));
  const diagonal = (d) => bandPaint(`<svg><path d="${d}" style="fill:none;stroke:black"/></svg>`, 0, 10);
  assert.notDeepEqual(diagonal('M 0 0 L 4 4'), diagonal('M 0 4 L 4 0'));
  assert.deepEqual(bandPaint(`<svg><defs><g id="glyph-2">
</g></defs><use xlink:href="#glyph-2" x="4" y="5"/></svg>`, 0, 10), []);
});

test('R13 D: a target-only top float cannot use a control without a top float', { skip: !texReady && 'lualatex not installed' }, async () => {
  const source = T`\documentclass[twoside]{article}
\usepackage{fancyhdr,tikz}
\pagestyle{fancy}\fancyhf{}\renewcommand\headrulewidth{0pt}
\fancyhead[L]{\tikz\draw(0,0)--(.5,0); \iftopfloat{TOP}{NORMAL} \rightmark}
\fancyfoot[C]{Sheet \thepage}
\begin{document}
` + [mk('ALPHA', 'First question.'), mk('BETA', 'Second question.'), mk('GAMMA', 'Third question.'), mk('OMEGA', 'Fourth question.')].join('\n\\clearpage\n') + '\n\\end{document}';
  await withEngine(source, async (engine) => {
    await exactBands(engine);
    const next = source.replace(mk('BETA', 'Second question.'), mk('DELTA', T`\begin{figure}[t]\centering\rule{20pt}{10pt}\end{figure}
Second question.`));
    await underLease(engine, async () => {
      await editTo(engine, next);
      await until(() => !engine.hfRendering, 'furniture render settled');
      assert.equal(engine.currentSpecs.specs[1].fl, 't');
      assert.equal(drawn(engine, 2, 'h'), null);
    });
    await drain(engine, 120_000);
    await landed(engine);
    await exactBands(engine);
    const pdf = spawnSync('pdftotext', ['-f', '2', '-l', '2', engine.canonical.last.pdf, '-'], { encoding: 'utf8' });
    assert.equal(pdf.status, 0);
    assert.match(pdf.stdout, /TOP DELTA/);
  });
});

test('R13 N: page-dependent operands and assignments inside a discarded box cannot publish guessed folios', { skip: !texReady && 'lualatex not installed' }, async () => {
  const source = T`\documentclass{article}
\usepackage{fancyhdr}
\pagestyle{fancy}\fancyhf{}\fancyhead[L]{Exercises}\fancyfoot[C]{Sheet \thepage}
\newcounter{resumeat}\newsavebox{\teacherbox}
\begin{document}
First lesson.
\clearpage
Second lesson.
\clearpage
Extra practice.
\clearpage
Last lesson.
\end{document}
`;
  const cases = [
    [source.replace('Second lesson.', T`\setcounter{resumeat}{\value{page}}` + '\nSecond lesson.')
      .replace('Last lesson.', T`\setcounter{page}{\value{resumeat}}` + '\nLast lesson.'), 4, 2],
    [source.replace('Second lesson.', T`\sbox{\teacherbox}{\stepcounter{page}X}` + '\nSecond lesson.'), 2, 3],
  ];
  await withEngine(source, async (engine) => {
    for (const [next, sheet, folio] of cases) {
      await editTo(engine, next);
      await drain(engine, 120_000);
      await landed(engine);
      const visible = engine.getDisplayLists().slice(sheet - 1);
      assert.ok(engine.getDisplayLists()[sheet - 2].commands.some((c) => c.src === '_hf' && c.op === 'glyphs'),
        'a sheet preceding the uncertain assignment keeps its text');
      assert.ok(visible.every((list) => !list.commands.some((c) => c.op === 'folio' || c.hfSlot === 'f')),
        `sheet ${sheet} onward has no unproven provisional folio`);
      assert.ok(visible.every((list) => hfText(list).replace(/\s/g, '') === 'Exercises'),
        `sheet ${sheet} onward keeps the independent head`);
      await engine.canonical.ensure(engine.getSource(), engine.srcRev);
      const id = engine.canonical.last.id;
      await until(() => engine.chunks.get(hfBandChunkKey(sheet, 'f'))?.canonicalId === id && drawn(engine, sheet, 'f'),
        'the page’s own exact footer');
      const pdf = spawnSync('pdftotext', ['-f', String(sheet), '-l', String(sheet), engine.canonical.last.pdf, '-'], { encoding: 'utf8' });
      assert.equal(pdf.status, 0);
      assert.ok(pdf.stdout.includes(`Sheet ${folio}`), pdf.stdout);
    }
    const arithmetic = source.replace('Second lesson.', T`\setcounter{page}{\numexpr 70+1\relax}` + '\nSecond lesson.');
    await editTo(engine, arithmetic);
    await drain(engine, 120_000);
    await landed(engine);
    assert.match(hfText(engine.getDisplayLists()[1]).replace(/\s+/g, ''), /Sheet71/);
  });
});

const r14Header = (preamble, head, graphic = false) => T`\documentclass[twoside]{article}
\usepackage{fancyhdr,tikz}
\pagestyle{fancy}\fancyhf{}\renewcommand\headrulewidth{0pt}
${preamble}
\fancyhead[L]{${graphic ? T`\tikz\draw(0,0)--(.5,0);` : ''}${head}}
\fancyfoot[C]{Sheet \thepage}
\begin{document}
`;
const r14Pages = (before = '', after = '') => [
  mk('ALPHA', 'First exercise.'), before + '\n' + mk('BETA', 'Second exercise.'),
  mk('GAMMA', 'Third exercise.'), after + '\n' + mk('OMEGA', 'Fourth exercise.'),
].join('\n\\clearpage\n\n') + '\n\\end{document}\n';

for (const [name, preamble, head, setter, reset] of [
  ['newif', T`\newif\ifanswers`, T`\ifanswers ANSWERS\else STUDENT\fi`, T`\answerstrue`, T`\answersfalse`],
  ['etoolbox toggle', T`\usepackage{etoolbox}\newtoggle{answers}`, T`\iftoggle{answers}{ANSWERS}{STUDENT}`, T`\settoggle{answers}{true}`, T`\togglefalse{answers}`],
  ['ifthen boolean', T`\usepackage{ifthen}\newboolean{answers}`, T`\ifthenelse{\boolean{answers}}{ANSWERS}{STUDENT}`, T`\setboolean{answers}{true}`, T`\setboolean{answers}{false}`],
]) {
  test(`R14 D: a placed ${name} setter establishes the target's text runs`, { skip: !texReady }, async () => {
    await withEngine(r14Header(preamble, head + T`\space\rightmark`) + r14Pages(setter, reset), async (engine) => {
      assert.deepEqual(engine.getDisplayLists().map((p) => hfText(p).replace(/Sheet\d/g, '')),
        ['STUDENTALPHA', 'ANSWERSBETA', 'ANSWERSGAMMA', 'STUDENTOMEGA']);
    });
  });
}

for (const [name, preamble, head, assignment] of [
  ['renewcommand through a helper', T`\newcommand\Edition{STUDENT}\newcommand\Heading{\Edition}`, T`\Heading`, T`\renewcommand\Edition{ANSWERS}`],
  ['let used in an identity test', T`\let\Edition\relax`, T`\ifx\Edition\relax STUDENT\else ANSWERS\fi`, T`\let\Edition\empty`],
  ['gdef in a group', T`\def\Edition{STUDENT}`, T`\Edition`, T`{\gdef\Edition{ANSWERS}}`],
  ['def with a comment before its target', T`\def\Edition{STUDENT}`, T`\Edition`, T`\def% Answer edition
\Edition{ANSWERS}`],
  ['counter changed by sectioning', '', T`\thesection`, T`\section{Answers}`],
  ['register read through a style', T`\newcounter{unit}\makeatletter\def\ps@custom{\ps@fancy\ifnum\value{unit}>0 \def\@oddhead{ANSWERS}\fi}\makeatother`, 'STUDENT', T`\setcounter{unit}{1}\thispagestyle{custom}`],
  ['font default changed in the body', '', 'STUDENT', T`\renewcommand\familydefault{\sfdefault}\normalfont`],
]) {
  test(`R14 D: a ${name} shows only established runs and preserves earlier furniture`, { skip: !texReady }, async () => {
    await withEngine(r14Header(preamble, head) + r14Pages(assignment), async (engine) => {
      assert.ok(hfText(engine.getDisplayLists()[0]).replace(/Sheet1$/, ''), 'the earlier page keeps its heading');
      const preview = hfText(engine.getDisplayLists()[1]).replace(/Sheet2$/, '');
      await engine.canonical.ensure(engine.getSource(), engine.srcRev);
      if (preview) {
        const pdf = spawnSync('pdftotext', ['-f', '2', '-l', '2', engine.canonical.last.pdf, '-'], { encoding: 'utf8' });
        assert.equal(pdf.status, 0);
        assert.ok(pdf.stdout.replace(/\s/g, '').includes(preview), pdf.stdout);
      } else {
        await until(() => drawn(engine, 2, 'h')?.startsWith('__hf-'), 'the exact header recovers a withheld text slot');
      }
    });
  });
}

test('R14 D: a changed body dependency cannot retain the old exact header before or after the runs land', { skip: !texReady }, async () => {
  const source = r14Header(T`\def\Edition{STUDENT}`, T`\Edition\space\rightmark`, true) + r14Pages();
  await withEngine(source, async (engine) => {
    await exactBands(engine);
    assert.ok(drawn(engine, 2));
    await underLease(engine, async () => {
      await editTo(engine, source.replace('Second exercise.', T`\gdef\Edition{ANSWERS} Second exercise.`));
      assert.equal(drawn(engine, 2), null, 'no old exact header while the new runs are blocked');
    });
    await landed(engine);
    assert.ok(fresh(drawn(engine, 2)), 'the job cannot authorize the old edition band');
    await exactBands(engine);
    const pdf = spawnSync('pdftotext', ['-f', '2', '-l', '2', engine.canonical.last.pdf, '-'], { encoding: 'utf8' });
    assert.match(pdf.stdout, /ANSWERS BETA/);
    assert.ok(drawn(engine, 2)?.startsWith('__hf-'));
  });
});

const r14Overlay = T`\newcommand\Head[1]{\begin{tikzpicture}[remember picture,overlay]
\draw[line width=.5pt] ([xshift=2cm,yshift=-2cm]current page.north west) -- ([xshift=-2cm,yshift=-2cm]current page.north east);
\node[anchor=west] at ([xshift=2cm,yshift=-1.6cm]current page.north west) {#1};
\node at ([yshift=1.4cm]current page.south) {--- \thepage\ ---};
\end{tikzpicture}}`;

for (const [name, preamble, head, setter, reset, expected] of [
  ['three sheets without another even control', '', T`\rightmark`, '', null, 'DELTA'],
  ['scoped colour on sheet 1', '', T`\rightmark`, '', '', 'DELTA'],
  ['opposite switch values on the two even sheets', T`\newif\ifanswers`, T`\ifanswers ANSWERS\else STUDENT\fi\space\rightmark`, T`\answerstrue`, T`\answersfalse`, 'ANSWERS DELTA'],
]) {
  test(`R14 D: replacement bands paint the exact heading with ${name}`, { skip: !texReady }, async () => {
    const source = r14Header(r14Overlay + preamble, T`\Head{${head}}`).replace(T`\fancyfoot[C]{Sheet \thepage}`, '') +
      r14Pages(setter, reset ?? '');
    const before = reset === null ? source.replace(/\n\\clearpage\n+\\markboth\{OMEGA\}[\s\S]*?(?=\\end\{document\})/, '\n')
      : name.startsWith('scoped') ? source.replace('First exercise.', T`{\color{blue}Name:} First exercise.`) : source;
    await withEngine(before, async (engine) => {
      await exactBands(engine);
      assert.equal(engine.pages.length, reset === null ? 3 : 4);
      await editTo(engine, before.replace('{BETA}{BETA}', '{DELTA}{DELTA}'));
      await landed(engine);
      await until(() => ['h', 'f'].every((slot) => drawn(engine, 2, slot)?.startsWith('__hfr-')), 'both provisional bands landed', 100);
      const provisional = ['h', 'f'].map((slot) => engine.chunks.get(hfRenderChunkKey(2, slot)).svg);
      await exactBands(engine);
      const pdf = spawnSync('pdftotext', ['-f', '2', '-l', '2', engine.canonical.last.pdf, '-'], { encoding: 'utf8' });
      assert.ok(pdf.stdout.includes(expected), pdf.stdout);
      for (const [i, slot] of ['h', 'f'].entries()) {
        const exact = engine.chunks.get(hfBandChunkKey(2, slot)).svg;
        const rows = slot === 'h' ? [0, 130] : [650, 800];
        assert.deepEqual(bandPaint(provisional[i], ...rows).map((p) => p[1]), bandPaint(exact, ...rows).map((p) => p[1]),
          `${slot} paints the exact glyphs and paths`);
      }
    });
  });
}

for (const [name, insert] of [
  ['false answer-key branch', T`\ifanswerkey\setcounter{page}{1}\fi`],
  ['nested false branch', T`\iftrue\iffalse\stepcounter{page}\fi\fi`],
  ['macro never called', T`\newcommand\TeacherReset{\setcounter{page}{99}}`],
  ['comment', T`% \stepcounter{page}`],
  ['verbatim text', T`\verb|\addtocounter{page}{77}|`],
  ['a reset after end document', ''],
  ['literal numeric identity', T`\setcounter{page}{2}`],
  ['identity via the current counter in a paragraph', T`Exercise label \setcounter{page}{\value{page}}`],
]) {
  test(`R14 W: ${name} leaves all student-copy folios visible`, { skip: !texReady }, async () => {
    const source = r14Header(T`\newif\ifanswerkey\answerkeyfalse`, 'Instructor copy') + r14Pages();
    const edited = insert ? source.replace('Second exercise.', insert + '\nSecond exercise.')
      : source + T`\setcounter{page}{77}`;
    await withEngine(source, async (engine) => {
      await editTo(engine, edited);
      await landed(engine);
      assert.deepEqual(folios(engine), ['1', '2', '3', '4']);
    });
  });
}

test('R14 W: a page assignment in an excluded include emits no event and keeps the resident folios', { skip: !texReady }, async () => {
  const source = r14Header(T`\includeonly{student}`, 'Instructor copy') + r14Pages(T`\include{teacher}`);
  await withEngine(source, async (engine) => {
    assert.deepEqual(engine.getDisplayLists().map((p) => hfText(p).match(/Sheet\d+/)?.[0]), ['Sheet1', 'Sheet2', 'Sheet3', 'Sheet4']);
    assert.ok(engine.blocks.every((b) => !b.galley?.events?.some((ev) => ev.k === 'pagectr')));
  }, { 'teacher.tex': T`\setcounter{page}{77}` + '\nTeacher solutions.\n' });
});

test('R14 D: F4 float sensitivity uses the switch values of the page it would reuse', { skip: !texReady }, async () => {
  const source = r14Header(T`\newif\ifanswers`, T`\ifanswers\iftopfloat{TOP}{NO FIGURE}\else STUDENT\fi`, true) +
    r14Pages('', T`\answerstrue`);
  await withEngine(source, async (engine) => {
    await exactBands(engine);
    assert.ok(drawn(engine, 4)?.startsWith('__hf-'));
    await underLease(engine, async () => {
      const figure = T`\begin{figure}[t]\centering\rule{2cm}{1cm}\end{figure}`;
      await editTo(engine, source.replace('Fourth exercise.', 'Fourth exercise.\n' + figure));
      assert.equal(engine.currentSpecs.specs[3].fl, 't');
      assert.ok(fresh(drawn(engine, 4)), 'the old NO FIGURE band cannot pass the student-copy probe');
    });
  });
});

const edition = T`\newif\ifanswers\let\PrintSolutions\answerstrue`;
const editionHead = T`\ifanswers ANSWERS\else STUDENT\fi\space\rightmark`;
const answerOptions = T`\ProvidesPackage{worksheetedition}
\DeclareOption{answers}{\AtBeginDocument{\global\let\SelectEdition\PrintSolutions}}
\ProcessOptions\relax
`;

for (const [name, extra, setter, word, inputs] of [
  ['a copied setter', '', T`\PrintSolutions`, 'ANSWERS'],
  ['a constructed setter', '', T`\csname PrintSolutions\endcsname`, 'ANSWERS'],
  ['a constructed setter reached through expandafter', T`\def\RunSetter#1{#1}`,
    T`\expandafter\RunSetter\csname PrintSolutions\endcsname`, 'ANSWERS'],
  ['an environment begin hook', T`\newenvironment{answerkey}{\global\PrintSolutions}{}`,
    T`\begin{answerkey}\end{answerkey}`, 'ANSWERS'],
  ['a package option', T`\usepackage[answers]{worksheetedition}`,
    T`\SelectEdition`, 'ANSWERS', { 'worksheetedition.sty': answerOptions }],
  ['an AtBeginDocument callback', T`\AtBeginDocument{\global\let\SelectEdition\PrintSolutions}`,
    T`\SelectEdition`, 'ANSWERS'],
  ['two toggles on the same page', T`\let\PrintStudent\answersfalse`, T`\answerstrue\PrintStudent`, 'STUDENT'],
  ['a global assignment in a float', '',
    T`\begin{figure}[t]\global\PrintSolutions\rule{1cm}{1cm}\end{figure}`, 'ANSWERS'],
  ['an assignment in an input file', '', T`\input{edition-child}`,
    'ANSWERS', { 'edition-child.tex': T`\PrintSolutions` }],
]) {
  test(`R15 D: the runs follow the executed state of ${name}`, { skip: !texReady }, async () => {
    const source = r14Header(edition + '\n' + extra, editionHead) + r14Pages(setter, T`\answersfalse`);
    await withEngine(source, async (engine) => {
      const heads = () => engine.getDisplayLists().map((page) => hfText(page).replace(/Sheet\d+$/, ''));
      assert.deepEqual(heads(), ['STUDENTALPHA', word + 'BETA', word + 'GAMMA', 'STUDENTOMEGA']);
      await editTo(engine, source.replace('{BETA}{BETA}', '{DELTA}{DELTA}'));
      await landed(engine);
      assert.equal(heads()[1], word + 'DELTA');
      await engine.canonical.ensure(engine.getSource(), engine.srcRev);
      const witness = engine.canonical.furnitureState(engine.canonical.last.id, 2);
      assert.equal(witness?.folio, 2, 'the canonical shipout recorded its folio');
      assert.equal(witness.values.some(([cs]) => cs === 'ifanswers'), word === 'ANSWERS');
      const pdf = spawnSync('pdftotext', ['-f', '2', '-l', '2', engine.canonical.last.pdf, '-'], { encoding: 'utf8' });
      assert.equal(pdf.status, 0);
      assert.ok(pdf.stdout.includes(word + ' DELTA'), pdf.stdout);
    }, inputs);
  });
}

for (const [name, initializer, inputs] of [
  ['a begin-document initializer', T`\AtBeginDocument{\PrintSolutions}`],
  ['a package option initializer', T`\RequirePackage[answers]{editioninitial}`, {
    'editioninitial.sty': T`\DeclareOption{answers}{\PrintSolutions}\ProcessOptions\relax`,
  }],
]) {
  test(`R15 D: the preamble fingerprint incorporates ${name}`, { skip: !texReady }, async () => {
    const preamble = edition + '\n' + initializer + '\n' + T`\let\StudentCopy\answersfalse`;
    const source = r14Header(preamble, editionHead) + r14Pages(T`\StudentCopy`, T`\PrintSolutions`);
    await withEngine(source, async (engine) => {
      assert.deepEqual(engine.getDisplayLists().map(hfText), [
        'ANSWERSALPHASheet1', 'STUDENTBETASheet2', 'STUDENTGAMMASheet3', 'ANSWERSOMEGASheet4',
      ]);
      const generation = await engine.canonical.ensure(source, engine.srcRev);
      const pdf = spawnSync('pdftotext', ['-f', '2', '-l', '2', generation.pdf, '-'], { encoding: 'utf8' });
      assert.equal(pdf.status, 0);
      assert.match(pdf.stdout, /STUDENT BETA/);
    }, inputs);
  });
}

test('R15 D: neither the retained nor the replacement band paints a preamble guess for a copied setter', { skip: !texReady }, async () => {
  const source = r14Header(r14Overlay + '\n' + edition, T`\Head{${editionHead}}`)
    .replace(T`\fancyfoot[C]{Sheet \thepage}`, '') + r14Pages();
  await withEngine(source, async (engine) => {
    await exactBands(engine);
    const old = drawn(engine, 2);
    const next = source.replace(T`\markboth{BETA}{BETA}`, T`\PrintSolutions\markboth{BETA}{BETA}`);
    await underLease(engine, async () => {
      await editTo(engine, next);
      assert.notEqual(drawn(engine, 2), old);
    });
    await landed(engine);
    await until(() => drawn(engine, 2)?.startsWith('__hfr-'), 'replacement band for the recorded edition');
    const provisional = engine.chunks.get(hfRenderChunkKey(2, 'h')).svg;
    await exactBands(engine);
    const exact = engine.chunks.get(hfBandChunkKey(2, 'h')).svg;
    assert.deepEqual(bandPaint(provisional, 0, 130).map((p) => p[1]), bandPaint(exact, 0, 130).map((p) => p[1]));
  });
});

for (const [name, preamble, head, change, preview, printed] of [
  ['a round-trippable definition', T`\def\Edition{STUDENT}\def\Choose{\def\Edition{ANSWERS}}`,
    T`\Edition\space\rightmark`, T`\Choose`, 'ANSWERSBETA', 'ANSWERS BETA'],
  ['a register changed through a computed name', T`\newcounter{unit}`,
    T`Unit \arabic{unit}\space\rightmark`, T`\advance\csname c@unit\endcsname 1\relax`, 'Unit1BETA', 'Unit 1 BETA'],
  ['a TeX count register stepped in the body', T`\newcount\EditionCount`,
    T`Unit \the\EditionCount\space\rightmark`, T`\advance\EditionCount 3\relax`, 'Unit3BETA', 'Unit 3 BETA'],
  ['a dimension changed through a computed name', T`\newdimen\EditionWidth`,
    T`Size \the\EditionWidth\space\rightmark`, T`\advance\csname EditionWidth\endcsname 2pt\relax`, 'Size2.0ptBETA', 'Size 2.0pt BETA'],
  ['a definition with parameters', T`\def\Edition#1{STUDENT #1}\def\Choose{\def\Edition##1{ANSWERS ##1}}`,
    T`\Edition{\rightmark}`, T`\Choose`, '', 'ANSWERS BETA'],
]) {
  test(`R15 D: dependency replay treats ${name} according to the recorded value`, { skip: !texReady }, async () => {
    const source = r14Header(preamble, head) + r14Pages(change);
    await withEngine(source, async (engine) => {
      assert.equal(hfText(engine.getDisplayLists()[1]), preview + 'Sheet2');
      await engine.canonical.ensure(engine.getSource(), engine.srcRev);
      const pdf = spawnSync('pdftotext', ['-f', '2', '-l', '2', engine.canonical.last.pdf, '-'], { encoding: 'utf8' });
      assert.equal(pdf.status, 0);
      assert.ok(pdf.stdout.includes(printed), pdf.stdout);
    });
  });
}

const folios = (engine) => engine.getDisplayLists().map((list) =>
  hfText(list).match(/Sheet(-?\w+)$/)?.[1] ?? list.commands.find((command) => command.op === 'folio')?.text ?? null);

for (const [name, preamble, command, expected, exact, inputs] of [
  ['the auditor’s inactive odd branch', '', T`\ifodd\value{page}\addtocounter{page}{1}\fi`, ['1', '2', '3', '4'], '2'],
  ['a taken guard using value', '', T`\ifodd\value{page}\else\addtocounter{page}{1}\fi`, ['1', null, null, null], '3'],
  ['a taken guard using ifthen', T`\usepackage{ifthen}`,
    T`\ifthenelse{\isodd{\value{page}}}{}{\addtocounter{page}{1}}`, ['1', null, null, null], '3'],
  ['a taken guard using a preamble alias of the page register',
    T`\makeatletter\let\SavedFolio\c@page\makeatother`,
    T`\ifodd\SavedFolio\else\addtocounter{page}{1}\fi`, ['1', null, null, null], '3'],
  ['a taken guard using the raw counter', T`\makeatletter\def\Pad{\ifodd\c@page\else\stepcounter{page}\fi}\makeatother`,
    T`\Pad`, ['1', null, null, null], '3'],
  ['a numeric comparison on the formatted folio', '',
    T`\ifnum\thepage=2 \addtocounter{page}{1}\fi`, ['1', null, null, null], '3'],
  ['an earlier folio read in the same block', '',
    T`\edef\SavedFolio{\thepage}\setcounter{page}{7}`, ['1', null, null, null], '7'],
  ['a negative front-matter reset', '', T`\setcounter{page}{-1}`, ['1', '-1', '0', '1'], '-1'],
  ['a reset in an included chapter', '', T`\include{newchapter}`, ['1', '7', '8', '9', '10'], '7',
    { 'newchapter.tex': T`\setcounter{page}{7}Chapter opening.` }],
]) {
  test(`R15 W: folios and exact bands with ${name}`, { skip: !texReady }, async () => {
    const source = r14Header(preamble, 'Instructor copy') + r14Pages(command);
    await withEngine(source, async (engine) => {
      assert.deepEqual(folios(engine), expected, JSON.stringify(engine.currentSpecs.specs.map(({ folio, ctrEvidence }) => ({ folio, ctrEvidence }))));
      if (expected.includes(null)) {
        assert.ok(engine.getDisplayLists().slice(1).every((p) => !p.commands.some((c) => c.op === 'folio' || c.src === '_hf')));
        for (const [n, spec] of engine.currentSpecs.specs.entries()) {
          if (spec.ctr !== 'unknown') continue;
          assert.ok(spec.ctrEvidence.some((witness) => witness.guarded || witness.resident !== witness.placed), `sheet ${n + 1}`);
        }
      }
      await engine.canonical.ensure(engine.getSource(), engine.srcRev);
      const pdf = spawnSync('pdftotext', ['-f', '2', '-l', '2', engine.canonical.last.pdf, '-'], { encoding: 'utf8' });
      assert.equal(pdf.status, 0);
      assert.ok(pdf.stdout.includes(`Sheet ${exact}`), pdf.stdout);
      if (expected.includes(null)) await until(() => drawn(engine, 2, 'f')?.startsWith('__hf-'), 'the same-source exact folio');
    }, inputs);
  });
}

test('R15 W: roman front matter and arabic main matter reset independently', { skip: !texReady }, async () => {
  const source = r14Header('', 'Instructor copy') + T`\pagenumbering{roman}
Front matter.\clearpage
Preface.\clearpage
\pagenumbering{arabic}
Chapter one.\clearpage
Chapter two.
\end{document}
`;
  await withEngine(source, async (engine) => {
    assert.deepEqual(folios(engine), ['i', 'ii', '1', '2']);
    await engine.canonical.ensure(engine.getSource(), engine.srcRev);
    const pdf = spawnSync('pdftotext', [engine.canonical.last.pdf, '-'], { encoding: 'utf8' });
    assert.deepEqual([...pdf.stdout.matchAll(/Sheet (\w+)/g)].map((m) => m[1]), ['i', 'ii', '1', '2']);
  });
});

test('R15b: a missing page record carries only agreeing dependencies', () => {
  const shared = ['ifanswers', 'same', 'let', 'iftrue'];
  const first = [['c@section', 'first', 'count', 1], shared];
  const last = [['c@section', 'last', 'count', 2], shared];
  const blocks = [
    { id: 'first', text: 'first', galley: { furniture: { source: 'first', after: 'a', values: first } } },
    { id: 'isolated', text: 'isolated', galley: {} },
    { id: 'last', text: 'last', galley: { furniture: { source: 'last', before: 'b', values: last } } },
  ];
  const pages = blocks.map((block, i) => ({ number: i + 1, draw: [{ u: { blockId: block.id } }] }));
  const [, gap] = pageSpecs(pages, blocks, 'fancy');
  assert.deepEqual(gap.state.values, [shared]);
  assert.deepEqual(gap.state.uncertain, ['c@section']);
  const was = { ...gap, state: { values: first, uncertain: [] } };
  assert.equal(specInsensitive({}, was, gap, 'h', { deps: { h: ['ifanswers'] } }), true);
  assert.equal(specInsensitive({}, was, gap, 'h', { deps: { h: ['c@section'] } }), false);
  assert.equal(specInsensitive({}, was, { ...gap, state: { guarded: true } }, 'f', { deps: { f: [] } }), true);
});

test('R15 W: a real clear-to-odd blank verso keeps the surrounding folios', { skip: !texReady }, async () => {
  const source = r14Header(T`\usepackage{emptypage}`, 'Instructor copy') + T`First exercise.\cleardoublepage
Second exercise.\clearpage
Third exercise.
\end{document}
`;
  await withEngine(source, async (engine) => {
    assert.deepEqual(folios(engine), ['1', null, '3', '4']);
    await engine.canonical.ensure(engine.getSource(), engine.srcRev);
    const pdf = spawnSync('pdftotext', [engine.canonical.last.pdf, '-'], { encoding: 'utf8' });
    assert.deepEqual([...pdf.stdout.matchAll(/Sheet (\d+)/g)].map((m) => m[1]), ['1', '3', '4']);
  });
});

test('R15 W: a resident event with a different incoming folio is uncertain at its placed sheet', () => {
  const block = { id: 'b1', galley: { events: [{ k: 'pagectr', a: 'set', b: '7', before: 1 }] } };
  const specs = pageSpecs([{ number: 1, folio: 1 }, { number: 2, folio: 2, evs: [{ bid: 'b1', i: 0 }] }], [block], 'plain');
  assert.equal(specs[0].ctr, undefined);
  assert.equal(specs[1].ctr, 'unknown');
  assert.deepEqual(specs[1].ctrEvidence, [{ resident: 1, placed: 2, guarded: false }]);
});

test('R15 D: unchanged block endpoints cannot prove the meaning at an unobserved natural break', () => {
  const text = String.raw`\PrintSolutions Warm-up.\par Worked exercises.\par\PrintStudent Last exercise.`;
  const block = { id: 'b1', text, galley: { furniture: { source: text, values: [] } } };
  const pages = [1, 2].map((number) => ({ number, folio: number, draw: [{ u: { blockId: 'b1' } }] }));
  const specs = pageSpecs(pages, [block], 'fancy');
  assert.equal(specs[0].state?.guarded, true);
  assert.equal(specs[1].state?.guarded, undefined);
});

test('R15 D: a protected redefinition with identical replacement text changes furniture state', { skip: !texReady }, async () => {
  const source = r14Header(
    T`\def\Edition{WORD}\def\Choose{\protected\def\Edition{WORD}}`,
    T`\edef\Copy{\Edition}\ifx\Copy\Edition Plain\else Protected\fi\space\rightmark`) + r14Pages(T`\Choose`);
  await withEngine(source, async (engine) => {
    assert.equal(hfText(engine.getDisplayLists()[1]), 'ProtectedBETASheet2');
    await engine.canonical.ensure(engine.getSource(), engine.srcRev);
    const file = engine.canonical.last.pdf;
    const pdf = spawnSync('pdftotext', ['-f', '2', '-l', '2', file, '-'], { encoding: 'utf8' });
    assert.equal(pdf.status, 0);
    assert.match(pdf.stdout, /Protected BETA/);
  });
});

test('R15 D: the paint comparison respects the visible rows of a cropped band', () => {
  const svg = '<svg viewBox="0 10 100 15"><path d="M 0 14 L 2 14"/><path d="M 0 26 L 2 26"/></svg>';
  assert.equal(bandPaint(svg, 0, 30).length, 1);
});

test('R15 D: canonical state is indexed by shipped sheets when a hook discards a page', { skip: !texReady }, async () => {
  const source = r14Header(T`\AddToHookNext{shipout/before}{\DiscardShipoutBox}`, 'Instructor copy') + r14Pages();
  await withEngine(source, async (engine) => {
    const generation = await engine.canonical.ensure(source, engine.srcRev);
    assert.equal(generation.pageCount, 3);
    assert.equal(engine.canonical.furnitureState(generation.id, 1), null, 'without a trace the recorder stays off');
    engine.canonical.furnitureWatch = 'c@page\n';
    const watched = await engine.canonical.ensure(source + '% folio trace\n', engine.srcRev + 1);
    assert.equal(engine.canonical.furnitureState(watched.id, 1)?.folio, 2);
  });
});

test('R15 D: a trailing setter with no body ink still supplies the last header', { skip: !texReady }, async () => {
  const source = (r14Header(edition, editionHead) + r14Pages())
    .replace('\n\\end{document}', '\n\n\\PrintSolutions\n\\end{document}');
  await withEngine(source, async (engine) => {
    assert.equal(hfText(engine.getDisplayLists().at(-1)), 'ANSWERSOMEGASheet4');
    const generation = await engine.canonical.ensure(source, engine.srcRev);
    const pdf = spawnSync('pdftotext', ['-f', '4', '-l', '4', generation.pdf, '-'], { encoding: 'utf8' });
    assert.equal(pdf.status, 0);
    assert.match(pdf.stdout, /ANSWERS OMEGA/);
  });
});

test('R15 W: a break at the start of a separate block still advances the resident folio', { skip: !texReady }, async () => {
  const source = r14Header('', 'Instructor copy') + T`First exercise.

\clearpage
\ifodd\value{page}\addtocounter{page}{1}\fi
Second exercise.

\clearpage
Third exercise.
\end{document}
`;
  await withEngine(source, async (engine) => {
    assert.deepEqual(folios(engine), ['1', '2', '3']);
    const generation = await engine.canonical.ensure(source, engine.srcRev);
    const pdf = spawnSync('pdftotext', [generation.pdf, '-'], { encoding: 'utf8' });
    assert.equal(pdf.status, 0);
    assert.deepEqual([...pdf.stdout.matchAll(/Sheet (\d+)/g)].map((m) => m[1]), ['1', '2', '3']);
  });
});

test('an unobserved page traces each slot without probing changed page context', () => {
  const spec = spec18(1, { tpl: 'body', state: { guarded: true, values: [], uncertain: [] } });
  const body = hfJobBody([spec]);
  assert.match(body, /tdom_hf_trace[(]1, 'h'[)]/);
  assert.match(body, /tdom_hf_trace[(]1, 'f'[)]/);
  assert.doesNotMatch(body, /q0[.]base/);
});

test('R16: furniture-only evidence queues a new header job when body pages are reused', () => {
  const page = { number: 1, dl: { hfSig: 'ink', hash: 'body' } };
  const engine = { mode: 'structured', pages: [page], blocks: [], hfSig: 'prior', furnitureSig: () => 'ink' };
  let jobs = 0;
  const result = asyncRepaginate(engine, {
    paginateNow: () => [page],
    noteSpecs: () => ({ sig: 'changed-witness' }),
    displayList: () => assert.fail('an unchanged body does not need a new display list'),
    scheduleHeaders: () => jobs++,
  });
  assert.equal(result.patches, 0);
  assert.equal(jobs, 1);
});

test('R16: canonical recording emits only changes to traced controls', { skip: !texReady }, async () => {
  const source = r14Header(
    T`\newif\ifchosen\newif\ifunused`, T`\ifchosen ANSWERS\else STUDENT\fi`,
  ) + r14Pages(T`\chosentrue\unusedtrue`, T`\chosenfalse`);
  await withEngine(source, async (engine) => {
    assert.match(engine.canonical.furnitureWatch, /^ifchosen$/m);
    assert.doesNotMatch(engine.canonical.furnitureWatch, /^ifunused$/m);
    engine.canonical.furnitureWatch = 'c@page\nifchosen\n';
    const generation = await engine.canonical.ensure(source, engine.srcRev);
    const state = (page) => engine.canonical.furnitureState(generation.id, page);
    assert.ok(state(2).covered.includes('ifchosen'));
    assert.ok(!state(2).covered.includes('ifunused'));
    const delta = (page) => state(page).values.find(([name]) => name === 'ifchosen');
    assert.equal(delta(1), undefined);
    assert.deepEqual(delta(2), delta(3));
    assert.ok(delta(2)?.[1]);
    assert.equal(delta(4), undefined);
    assert.equal(state(2).values, state(3).values, 'unchanged pages share the decoded snapshot');
  });
});

for (const [name, options, head, foot, visible] of [
  ['constant head with an uncertain numbered foot', '', T`\fancyhead[L]{Instructor copy}`, 'Sheet \\thepage', ['Instructorcopy', '']],
  ['numbered head with a constant foot', '', T`\fancyhead[L]{Sheet \thepage}`, 'Instructor copy', ['', 'Instructorcopy']],
  ['two-sided head that selects different cells', '[twoside]', T`\fancyhead[LO]{Odd sheet}\fancyhead[LE]{Even sheet}`,
    'Instructor copy', ['', 'Instructorcopy']],
]) {
  test(`R16: ${name} before new exact paper`, { skip: !texReady }, async () => {
    const source = T`\documentclass${options}{article}
\usepackage[margin=1in]{geometry}
\usepackage{fancyhdr}
\pagestyle{fancy}\fancyhf{}\renewcommand\headrulewidth{0pt}
${head}\fancyfoot[C]{${foot}}
\begin{document}
First exercise.\clearpage
Second exercise.\clearpage
Third exercise.
\end{document}
`;
    const next = source.replace('Second exercise.', T`\ifodd\value{page}\else\addtocounter{page}{1}\fi
Second exercise.`);
    await withEngine(source, async (engine) => {
      const generation = await engine.canonical.ensure(source, engine.srcRev);
      await editTo(engine, next);
      await landed(engine);
      assert.equal(engine.canonical.info().id, generation.id);
      for (const list of engine.getDisplayLists().slice(1)) {
        assert.deepEqual(['h', 'f'].map((slot) => list.commands.filter((c) => c.hfSlot === slot)
          .map((c) => c.text).join('').replace(/\s/g, '')), visible, `sheet ${list.page}`);
        assert.ok(!list.commands.some((c) => c.op === 'folio'));
      }
      const exact = await engine.canonical.ensure(next, engine.srcRev);
      const pdf = spawnSync('pdftotext', ['-layout', exact.pdf, '-'], { encoding: 'utf8' });
      assert.equal(pdf.status, 0, pdf.stderr);
      assert.match(pdf.stdout, /Instructor copy|Odd sheet/);
      if (foot.includes('thepage') || head.includes('thepage')) assert.match(pdf.stdout, /Sheet 3[\s\S]*Sheet 4/);
    });
  });
}

test('R16: an unchanged graphical head stays on retained paper while its folio foot is uncertain', { skip: !texReady }, async () => {
  const source = T`\documentclass{article}
\usepackage[margin=1in]{geometry}
\usepackage{fancyhdr,tikz}
\pagestyle{fancy}\fancyhf{}\renewcommand\headrulewidth{0pt}
\fancyhead[L]{\tikz\draw (0,0)--(.5,0); Instructor copy}
\fancyfoot[C]{Sheet \thepage}
\begin{document}
First exercise.

\clearpage

Second exercise.

\clearpage

Third exercise.
\end{document}
`;
  await withEngine(source, async (engine) => {
    await exactBands(engine);
    const heads = [2, 3].map((n) => drawn(engine, n, 'h'));
    assert.ok(heads.every(Boolean));
    await underLease(engine, async () => {
      const next = source.replace('Second exercise.', T`\ifodd\value{page}\else\addtocounter{page}{1}\fi

Second exercise.`);
      await editTo(engine, next);
      assert.deepEqual([2, 3].map((n) => drawn(engine, n, 'h')), heads);
      assert.deepEqual([2, 3].map((n) => drawn(engine, n, 'f')), [null, null]);
    });
  });
});

test('R16: decorated exercises appended beyond the last canonical sheet retain their numbered feet', { skip: !texReady }, async () => {
  const end = '\n\\end{document}';
  const source = T`\documentclass[twoside]{article}
\usepackage{tikz,fancyhdr,tcolorbox}
\usepackage[textheight=350pt]{geometry}
\pagestyle{fancy}\fancyhf{}
\fancyhead[L]{\tikz\draw(0,0)--(.7,0); Lesson \thesection\space\iftopfloat{TOP}{NORMAL}}
\fancyfoot[C]{Sheet \thepage}
\begin{document}
\section{Introduction}
\begin{tcolorbox}First exercise.\end{tcolorbox}
\clearpage
\section{Practice}
\begin{tcolorbox}Second exercise.\end{tcolorbox}` + end;
  const additions = [
    T`\clearpage
\section{New lesson}
\begin{tcolorbox}Construction.\end{tcolorbox}`,
    T`\begin{figure}[t]\centering\tikz\draw (0,0) rectangle (2,1);\caption{Top sketch}\end{figure}`,
    T`\begin{tcolorbox}Explain the construction and label the vertices.\end{tcolorbox}`,
    T`\begin{figure}[b]\centering\rule{20mm}{15mm}\caption{Bottom sketch}\end{figure}`,
    T`\begin{tcolorbox}\rule{1pt}{130pt} Worksheet for the next problem.\end{tcolorbox}`,
    T`\begin{tcolorbox}\rule{1pt}{80pt} Fill the remaining space.\end{tcolorbox}`,
    T`\begin{figure}[p]\centering\rule{3cm}{4cm}\caption{Separate plate}\end{figure}`,
    T`\clearpage
\section{Answer key}
\begin{tcolorbox}Answers.\end{tcolorbox}`,
    T`\begin{figure}[p]\centering\rule{2cm}{6cm}\caption{Second plate}\end{figure}
\clearpage
\begin{tcolorbox}Last answer.\end{tcolorbox}`,
  ];
  await withEngine(source, async (engine) => {
    const opening = await engine.canonical.ensure(source, engine.srcRev);
    assert.equal(opening.pageCount, 2);
    for (const text of additions) {
      const at = engine.getSource().indexOf(end);
      await engine.edit(at, at, '\n\n' + text + '\n');
      const sentence = engine.getSource().indexOf(end);
      await engine.edit(sentence, sentence, ' Working on this exercise.');
    }
    await drain(engine, 45_000);
    await landed(engine);
    assert.equal(engine.canonical.info().id, opening.id);
    const feet = engine.getDisplayLists().slice(5, 8).map((list) => {
      const commands = list.commands.filter((c) => c.hfSlot === 'f');
      const band = commands.find((c) => c.op === 'chunk');
      if (band) {
        const rec = engine.chunks.get(band.chunk)?.rec;
        assert.equal(rec?.gen.rev, engine.srcRev);
        assert.equal(rec?.n, list.page);
        return runsText(engine.hf.get(list.page).f).replace(/\s/g, '');
      }
      return commands.filter((c) => c.op === 'glyphs').map((c) => c.text).join('').replace(/\s/g, '');
    });
    assert.deepEqual(feet, ['Sheet6', 'Sheet7', 'Sheet8'], JSON.stringify([6, 7, 8].map((n) => ({
      page: n, footReads: engine.hf.get(n)?.fr, blocked: engine.hf.get(n)?.fblocked?.slice(0, 10),
      footDraws: engine.hf.get(n)?.fg, footText: runsText(engine.hf.get(n)?.f),
      presentation: hfOps(engine, n),
      folio: engine.currentSpecs.specs[n - 1]?.folio, counter: engine.currentSpecs.specs[n - 1]?.ctr,
    }))));
  });
});
