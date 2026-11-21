// tdom-engine #17: the provisional page of a booklet lost its running heads
// and folios, and a tabularray row filled with black!10 came out black.
//  - \fancyhead set in the body (a head per chapter) reaches the header job
//  - colors luacolor keeps in an attribute (luwa-ul loads it) reach the runs
//  - a head or foot drawn with graphics is flagged (its band comes from the
//    canonical page), and a page shipped whole still gets its furniture

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CheckpointEngine } from '../engine/checkpoint/engine-v3.js';
import { buildDisplayList, hfBandChunkKey } from '../engine/checkpoint/display-list.js';
import { pageSpecs, hfJobBody } from '../engine/checkpoint/page-metadata.js';
import { drain } from '../tools/harness.mjs';

const texReady = spawnSync('lualatex', ['--version']).status === 0;

let runs = 0;
const withEngine = async (source, fn) => {
  // inside the repository like the other engine tests (the fork shim cached there)
  const root = fileURLToPath(new URL(`../.tdom-v3-test-hf-furniture-${++runs}`, import.meta.url));
  rmSync(root, { recursive: true, force: true });
  // a fork shim another engine test already built (forkshim.js checks its hash)
  const cached = fileURLToPath(new URL('../.tdom-v3-test/', import.meta.url));
  if (existsSync(path.join(cached, 'tdomfork.so'))) {
    mkdirSync(root, { recursive: true });
    for (const f of ['tdomfork.so', 'tdomfork.so.sha256']) copyFileSync(path.join(cached, f), path.join(root, f));
  }
  const engine = new CheckpointEngine({ workDir: root });
  engine.canonical.schedule = () => {};
  try {
    await engine.open(source);
    await drain(engine, 120_000);
    for (let i = 0; i < 100 && (engine.hfPending || !engine.hf?.size); i++) await new Promise((r) => setTimeout(r, 100));
    await fn(engine);
  } finally {
    await engine.close().catch(() => {});
    rmSync(root, { recursive: true, force: true });
  }
};
const hfText = (list) => list.commands.filter((c) => c.src === '_hf' && c.op === 'glyphs').map((c) => c.text).join('');

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
    const fills = commands.filter((c) => c.op === 'rule' && c.h > 5);
    assert.ok(fills.length >= 2, 'the row background');
    assert.ok(fills.every((c) => c.color === '#e6e6e6'), JSON.stringify(fills.map((c) => c.color)));
    assert.ok(commands.some((c) => c.op === 'glyphs' && c.text?.includes('red') && c.color === '#ff0000'));
  });
});

test('a page shipped whole keeps the header job\'s head; a graphic band comes from the canonical crop', () => {
  const geometry = { oddsidemargin: 0, topmargin: 0, headheight: 12, headsep: 25, textheight: 600, textwidth: 400, footskip: 30, paperwidth: 600, paperheight: 800 };
  const run = (t) => ({ t, f: 'F', s: 10, x: 0, dy: 0, w: 10 });
  const hf = new Map([[1, { h: [{ k: 'box', h: 8, d: 2, runs: [run('Head')] }], f: [{ k: 'box', h: 8, d: 2, runs: [run('Foot')] }] }]]);
  const full = { number: 1, draw: [{ y: 600, u: { blockId: 'b1@p1', h: 600, d: 0, li: 0, ln: { boxH: 600, gfxChunk: { blockId: 'b1@p1', yOff: 0, full: 1 } } } }] };
  const chunks = new Map([['b1@p1', { wBp: 600, hBp: 600, v: 1 }]]);
  const fonts = new Map([['F', { family: 'f-x' }]]);
  const list = buildDisplayList(full, { geometry, chunks, hf, hfSig: 's', fonts });
  assert.deepEqual(list.commands.filter((c) => c.src === '_hf').map((c) => c.text), ['Head', 'Foot']);
  assert.ok(!list.commands.some((c) => c.op === 'folio'), 'no provisional folio on a page shipped whole');

  const graphic = new Map([[1, { h: [{ k: 'box', h: 8, d: 2, runs: [run('Wrong')] }], f: [], hg: 1 }]]);
  let page = { number: 1, draw: [] };
  let cmds = buildDisplayList(page, { geometry, chunks: new Map(), hf: graphic, hfSig: 's', fonts }).commands;
  assert.ok(!cmds.some((c) => c.src === '_hf'), 'runs placed without the shipped page are not painted');
  const bands = new Map([[hfBandChunkKey(1, 'h'), { wBp: 600, hBp: 109, v: 1 }], [hfBandChunkKey(1, 'f'), { wBp: 600, hBp: 91, v: 1 }]]);
  cmds = buildDisplayList(page, { geometry, chunks: bands, hf: graphic, hfSig: 's', fonts }).commands;
  assert.deepEqual(cmds.filter((c) => c.op === 'chunk').map((c) => [c.chunk, c.y]), [[hfBandChunkKey(1, 'h'), 0], [hfBandChunkKey(1, 'f'), 709]]);
});

test('the header job replays each page\'s \\fancyhead in page order', () => {
  const pages = [
    { number: 1, evs: [{ k: 'fancy', a: 'head', b: '[LE,RO]{A}' }] },
    { number: 2, evs: [] },
    { number: 3, evs: [{ k: 'fancy', a: 'hf', b: '[]{}' }] },
  ];
  const specs = pageSpecs(pages, [], 'fancy');
  assert.deepEqual(specs.map((s) => s.fancy ?? null), [[['head', '[LE,RO]{A}']], null, [['hf', '[]{}']]]);
  const body = hfJobBody(specs);
  assert.ok(body.indexOf('\\TDOM@fancyhead[LE,RO]{A}') < body.indexOf('\\TDOM@fancyhf[]{}'));
});
