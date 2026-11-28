import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { CheckpointEngine } from '../engine/checkpoint/engine-v3.js';
import { bandShown, furnitureRenderKey, geometryKey } from '../engine/checkpoint/canonical-arrival.js';
import { rootKey } from '../engine/checkpoint/header-scheduler.js';
import { sameClearpageContinuation } from '../engine/checkpoint/plain-preview.js';
import { drain } from '../tools/harness.mjs';

const texReady = spawnSync('lualatex', ['--version']).status === 0;

test('open publishes body before tracing and a literal edit reuses the settled proof', { skip: !texReady }, async () => {
  const workDir = mkdtempSync(path.join(tmpdir(), 'tdom-furniture-hot-path-'));
  const engine = new CheckpointEngine({ workDir });
  engine.canonical.schedule = () => {};
  let pendingAtHandoff;
  engine.onOpeningSettled = () => { pendingAtHandoff = engine.hfPending; };
  const source = String.raw`\documentclass{article}
\usepackage{fancyhdr}
\newcommand{\HeadText}{Instructor copy}
\newcommand{\Unrelated}{Original}
\pagestyle{fancy}
\fancyhf{}
\fancyhead[L]{\HeadText}
\fancyfoot[C]{\thepage}
\begin{document}
\renewcommand{\Unrelated}{Changed}

First paragraph.

Second paragraph.

\clearpage

Last paragraph.
\end{document}
`;
  try {
    const opened = engine.open(source, undefined, { canonicalBaseline: false });
    assert.equal(engine.hfPending, true, 'the document owes furniture as soon as open starts');
    const report = await opened;
    assert.ok(report.patches.some((patch) => patch.type === 'replace-page'));
    assert.equal(engine.hfWatchVersion, null, 'the first preview does not wait for furniture tracing');
    assert.equal(engine.hfPending, true, 'the deferred job remains visible as pending');
    await drain(engine);
    assert.equal(pendingAtHandoff, true, 'the opening handoff keeps the furniture obligation visible');
    assert.equal(engine.hfPending, false, 'the furniture obligation clears after the work completes');
    const first = engine.blocks.find((block) => block.text.includes('First paragraph'));
    assert.ok(first.galley.furniture?.covered?.includes('HeadText'));
    assert.ok(!first.galley.furniture.covered.includes('Unrelated'));
    assert.ok(first.galley.furniture.values.every(([name]) =>
      name.startsWith('$') || first.galley.furniture.covered.includes(name)));
    engine.getDisplayLists();
    const specs = engine.currentSpecs;
    const secondPage = engine.pages[1].dl;
    const cache = engine.furnitureChoices.pages;
    const at = source.indexOf('First paragraph') + 'First paragraph'.length;
    await engine.edit(at, at, 's');
    const changed = engine.blocks.find((block) => block.id === first.id);
    assert.equal(changed.galley.furnitureMs, undefined);
    assert.equal(engine.currentSpecs, specs);
    assert.equal(engine.furnitureChoices.pages, cache);
    assert.equal(engine.pages[1].dl, secondPage);
  } finally {
    await engine.close();
    rmSync(workDir, { recursive: true, force: true });
  }
});

test('a plain article with empty page style settles its furniture status', { skip: !texReady }, async () => {
  const workDir = mkdtempSync(path.join(tmpdir(), 'tdom-empty-furniture-'));
  const engine = new CheckpointEngine({ workDir });
  engine.canonical.schedule = () => {};
  try {
    await engine.open(String.raw`\documentclass{article}
\pagestyle{empty}
\begin{document}
A plain paragraph.
\end{document}`, undefined, { canonicalBaseline: false });
    await drain(engine);
    assert.equal(engine.hfPending, false);
    assert.ok(engine.getDisplayLists().every((page) => page.commands.every((cmd) =>
      cmd.op !== 'folio' && cmd.src !== '_hf')));
  } finally {
    await engine.close();
    rmSync(workDir, { recursive: true, force: true });
  }
});

test('a rendered slot keeps its proof across an edit to an unrelated control', () => {
  const page = { number: 1 };
  const spec = { page: 1, folio: 1, fmt: 'arabic', style: 'fancy',
    state: { values: [['HeadText', 'head'], ['Unrelated', 'old']], covered: ['HeadText', 'Unrelated'] } };
  const engine = { srcRev: 1, pages: [page], blocks: [], geometry: {}, file: 'main.tex',
    currentSpecs: { pages: [page], specs: [spec], blocks: [] } };
  const meta = { rec: {
    render: true, n: 1, geometry: geometryKey(engine.geometry), root: rootKey(engine), spec,
    key: furnitureRenderKey(engine, spec), gen: { rev: 1 }, apart: true,
    reads: { h: 0, f: 0 }, deps: { h: ['HeadText'], f: [] },
  } };
  engine.srcRev++;
  const next = { ...spec, state: { ...spec.state, values: [['HeadText', 'head'], ['Unrelated', 'new']] } };
  engine.currentSpecs.specs = [next];
  assert.equal(bandShown(engine, page, meta, 'h'), true);
  engine.currentSpecs.specs = [{ ...next, state: { ...next.state, values: [['HeadText', 'changed']] } }];
  assert.equal(bandShown(engine, page, meta, 'h'), false);
});

test('a clearpage that only compensates for the previous glyph depth reuses the continuation witness', () => {
  const clear = { closure: 'native', items: [{ k: 'eject', v: -10000 },
    { k: 'glue', a: 10, sub: 2 }, { k: 'box', h: 0, d: 0 }, { k: 'eject', v: -10001 }] };
  const state = (depth) => ({ state: { 'tdom@pd': depth } });
  const edited = { ...clear, items: clear.items.map((item) =>
    item.k === 'glue' ? { ...item, a: item.a - 72 / 72.27 } : item) };
  assert.equal(sameClearpageContinuation(clear, edited, state(0), state(65536)), true);
  assert.equal(sameClearpageContinuation(clear, edited, state(0), state(65537)), false);
  assert.equal(sameClearpageContinuation(clear, { ...edited, furniture: { after: 'other' } }, state(0), state(65536)), false);
});
