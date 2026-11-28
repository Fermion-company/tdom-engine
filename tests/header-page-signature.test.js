// A page's display list is kept while that page's own head and foot are the
// same (header-footer.js pageHfSig). When a header job lands, only the pages
// whose head or foot changed are rebuilt, and the result is what a fresh
// engine shows.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pageHfSig } from '../engine/checkpoint/header-footer.js';
import { buildPagePatches } from '../engine/checkpoint/page-patches.js';
import { asyncRepaginate } from '../engine/checkpoint/async-repaginate.js';
import { CheckpointEngine } from '../engine/checkpoint/engine-v3.js';
import { drain } from '../tools/harness.mjs';

const head = (text) => ({ h: [{ k: 'box', h: 7, d: 2, runs: [{ t: text, f: 'F1', s: 10, x: 0, dy: 0, w: 40 }] }], f: [] });

test('a page is signed by its own head and foot, whatever map they come in', () => {
  const before = new Map([[1, head('ONE')], [2, head('TWO')], [3, head('TWO')]]);
  const after = new Map([[1, head('ONE')], [2, head('ONE')], [3, head('TWO')], [4, head('TWO')]]);
  assert.equal(pageHfSig(null, 1), '', 'no map yet: the provisional folio');
  assert.equal(pageHfSig(before, 9), '', 'no entry for the page');
  assert.equal(pageHfSig(before, 1), pageHfSig(after, 1));
  assert.notEqual(pageHfSig(before, 2), pageHfSig(after, 2));
  assert.equal(pageHfSig(before, 3), pageHfSig(after, 3));
  assert.notEqual(pageHfSig(before, 4), pageHfSig(after, 4), 'a page that got its head');
  assert.notEqual(pageHfSig(before, 1), '');
});

test('when the map changes, only the pages whose head or foot changed are built again', () => {
  const before = new Map([[1, head('ONE')], [2, head('TWO')], [3, head('TWO')]]);
  const after = new Map([[1, head('ONE')], [2, head('ONE')], [3, head('TWO')]]);
  const pages = [1, 2, 3].map((number) => ({ number, dl: { page: number, commands: [], hash: `h${number}`, hfSig: pageHfSig(before, number) } }));
  const kept = pages.map((page) => page.dl);
  const built = [];
  const result = buildPagePatches(pages, pages.map((page) => ({ number: page.number, dl: page.dl })), (page) => pageHfSig(after, page.number), (page) => {
    built.push(page.number);
    return { page: page.number, commands: [{ op: 'glyphs', text: 'ONE' }], hash: 'changed', hfSig: pageHfSig(after, page.number) };
  });
  assert.deepEqual(built, [2]);
  assert.deepEqual(result.dirtyPages, [2]);
  assert.equal(pages[0].dl, kept[0]);
  assert.equal(pages[2].dl, kept[2]);
  // (one value for every page still means every page)
  const all = [];
  buildPagePatches(pages, pages, 'another', (page) => { all.push(page.number); return { ...page.dl, hfSig: 'another' }; });
  assert.deepEqual(all, [1, 2, 3]);
});

test('a header job that lands builds again the pages whose head changed, and no other', () => {
  const before = new Map(Array.from({ length: 40 }, (_, i) => [i + 1, head(i < 20 ? 'ONE' : 'TWO')]));
  // the heading moved one page on: page 21 now runs under ONE
  const after = new Map(Array.from({ length: 40 }, (_, i) => [i + 1, head(i < 21 ? 'ONE' : 'TWO')]));
  const list = (hf) => (page) => ({ page: page.number, commands: [{ op: 'glyphs', text: hf.get(page.number).h[0].runs[0].t }],
    hash: hf.get(page.number).h[0].runs[0].t, hfSig: pageHfSig(hf, page.number) });
  const pages = Array.from({ length: 40 }, (_, i) => ({ number: i + 1, identity: [`p${i + 1}`], draw: [] }));
  for (const page of pages) page.dl = list(before)(page);
  const kept = pages.map((page) => page.dl);
  const sent = [];
  const built = [];
  const engine = { mode: 'structured', pages, hf: after, hfSig: 'specs-after', rev: 7, blocks: [], pendingChain: null, tocOwed: false,
    getFontManifest: () => [], onAsyncPatches: (message) => sent.push(message),
    // (no keys noted here: the page's entry alone, engine-v3.js furnitureSig)
    furnitureSig: (n) => pageHfSig(after, n) };
  asyncRepaginate(engine, {
    paginateNow: () => pages.map((page) => ({ number: page.number, identity: page.identity, draw: [] })),
    displayList: (page) => { built.push(page.number); return list(after)(page); },
    computeToc: () => ({ hash: '' }), queueChainWork() {}, scheduleBackground() {},
  });
  assert.deepEqual(built, [21], 'one page of forty');
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0].patches.map((patch) => patch.page), [21]);
  assert.equal(engine.rev, 8);
  for (const page of engine.pages) if (page.number !== 21) assert.equal(page.dl, kept[page.number - 1]);
});

const texReady = spawnSync('lualatex', ['--version']).status === 0;

const paragraph = (s, p) => `Section ${s} paragraph ${p} has plain words that fill a few lines of the page, one after another, so that the pages of this document fill up. `.repeat(4).trim();
const DOC = [
  String.raw`\documentclass{article}`,
  String.raw`\pagestyle{headings}`,
  String.raw`\begin{document}`,
  ...Array.from({ length: 9 }, (_, s) => [
    String.raw`\section{Heading ${'ABCDEFGHI'[s]}}`,
    ...Array.from({ length: 6 }, (_, p) => paragraph(s + 1, p + 1)),
  ].join('\n\n')),
  String.raw`\end{document}`,
  '',
].join('\n\n');

const headersIdle = async (engine) => {
  for (const deadline = Date.now() + 20_000; (engine.hfPending || engine.hfQueued) && Date.now() < deadline;) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
};
// (block ids differ between an edited engine and a fresh one)
const shown = (engine) => engine.pages.map((page) => page.dl.commands.map(({ src: _src, ...command }) => command));

test('headings moved to other pages by an edit: every page ends with the head a fresh engine gives it',
  { skip: !texReady && 'lualatex not installed' }, async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'tdom-hf-sig-'));
    const open = async (name, source) => {
      const docDir = path.join(root, name);
      mkdirSync(docDir);
      writeFileSync(path.join(docDir, 'main.tex'), source);
      const engine = new CheckpointEngine({ workDir: path.join(root, `${name}-work`), docDir, overlayDir: path.join(root, `${name}-overlay`) });
      engine.canonical.schedule = () => {};
      await engine.open(source, 'main.tex');
      await drain(engine, 120_000);
      await headersIdle(engine);
      await drain(engine, 120_000);
      return engine;
    };
    const engine = await open('edited', DOC);
    let fresh = null;
    try {
      assert.ok(engine.pages.length >= 4, `the document has several pages (${engine.pages.length})`);
      assert.ok(engine.pages.every((page) => page.dl.hfSig !== ''), 'every page has its head');
      const first = engine.pages[0].dl;
      const specsBefore = engine.hfSig;
      const headsBefore = engine.pages.map((page) => page.dl.hfSig);
      // a page of text in front of the seventh section: the headings after
      // it move to other pages, and there is one page more
      const at = DOC.indexOf(String.raw`\section{Heading G}`);
      const added = Array.from({ length: 12 }, (_, p) => paragraph('new', p + 1)).join('\n\n') + '\n\n';
      await engine.edit(at, at, added);
      await drain(engine, 120_000);
      await headersIdle(engine);
      await drain(engine, 120_000);
      assert.notEqual(engine.hfSig, specsBefore, 'a header job for the new pages landed');
      assert.ok(engine.pages.some((page, i) => page.dl.hfSig !== headsBefore[i]), 'some page has another head');
      // (whether the page object itself was kept depends on what else the
      // engine did meanwhile: the test above pins what is built again)
      assert.equal(engine.pages[0].dl.hfSig, first.hfSig, 'the first page has the head it had');
      assert.equal(engine.pages[0].dl.hash, first.hash, 'and shows what it showed');
      fresh = await open('fresh', engine.getSource());
      assert.equal(engine.pages.length, fresh.pages.length);
      assert.deepEqual(shown(engine), shown(fresh), 'every page shows what a fresh engine shows');
      assert.deepEqual(engine.pages.map((page) => page.dl.hfSig), fresh.pages.map((page) => page.dl.hfSig));
    } finally {
      await engine.close();
      await fresh?.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
