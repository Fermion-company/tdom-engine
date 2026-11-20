import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { buildPagePatches } from '../engine/checkpoint/page-patches.js';
import { classifyPreamble } from '../engine/checkpoint/safety.js';
import { CheckpointEngine } from '../engine/checkpoint/engine-v3.js';
import { pageList, provisionalViewer } from './helpers/provisional-viewer.js';

const replace = dl => ({ type: 'replace-page', displayList: dl });
const papers = viewer => [...viewer.pageDivs.values()].map(page => page.paper);

test('empty resident updates cannot erase settled canonical slots', () => {
  const viewer = provisionalViewer([pageList(1, [{ op: 'pending-exact', src: 'b1', wholePage: 1 }])], 3);
  const before = papers(viewer);
  for (let rev = 2; rev <= 4; rev++) {
    viewer.appliedSrcRev = rev;
    viewer.stageProvisionalPatches([], true, 1);
    assert.deepEqual(papers(viewer), before);
  }
  assert.equal(viewer.demands.at(-1).residentImpossible, true);
  viewer.commitCanonical(3);
  assert.deepEqual(papers(viewer), ['canonical:4:1', 'canonical:4:2', 'canonical:4:3']);
});

test('a count or removal alone cannot erase pages, even without a pending marker', () => {
  for (const patches of [[], [{ type: 'remove-pages', from: 2 }]]) {
    const viewer = provisionalViewer([pageList(1), pageList(2)]);
    viewer.stageProvisionalPatches(patches, true, 1);
    assert.deepEqual(papers(viewer), ['canonical:1:1', 'canonical:1:2']);
    assert.equal(viewer.demands.at(-1).residentImpossible, true);
  }
});

test('a ready replacement cannot shrink past missing layout elsewhere', () => {
  const viewer = provisionalViewer([pageList(1), pageList(2), pageList(3)]);
  const pending = pageList(1, [{ op: 'pending-exact', src: 'b1', wholePage: 1 }]);
  viewer.stageProvisionalPatches([replace(pending)], true, 3);
  // Canonical had cleared stages in the reported failure; the layout marker
  // still matters even when no unready stage survives to veto the transaction.
  viewer.provisionalStages.clear();
  viewer.stageProvisionalPatches([replace(pageList(2))], true, 2);
  assert.deepEqual(papers(viewer), ['canonical:1:1', 'canonical:1:2', 'canonical:1:3']);
});

test('known resident/canonical pagination drift cannot publish phantom pages', () => {
  const viewer = provisionalViewer([pageList(1), pageList(2), pageList(3)], 2);
  viewer.stageProvisionalPatches([], true, 3);
  assert.equal(viewer.pageDirtyRev.get(1), 2, 'the physical edit page is unknown, so even an empty delta reports pending');
  assert.equal(viewer.presentationPending([[1, viewer.pageDivs.get(1)]]), true);
  viewer.stageProvisionalPatches([1, 2, 3].map(n => replace(pageList(n))), true, 3);
  assert.deepEqual(papers(viewer), ['canonical:1:1', 'canonical:1:2']);
  // A coincidental count match after an edit does not repair its base mapping.
  viewer.stageProvisionalPatches([replace(pageList(1)), replace(pageList(2))], true, 2);
  assert.deepEqual(papers(viewer), ['canonical:1:1', 'canonical:1:2']);
  viewer.commitCanonical(2);
  assert.equal(viewer.pageDirtyRev.size, 0, 'current canonical retires the pending display');
  assert.equal(viewer.presentationPending([...viewer.pageDivs]), false);
  viewer.appliedSrcRev++;
  viewer.stageProvisionalPatches([replace(pageList(2))], true, 2);
  assert.equal(viewer.pageDivs.get(2).dataset.provRev, '3');
});

test('same-revision resident completion repairs the baseline without another canonical', () => {
  const viewer = provisionalViewer([pageList(1, [{ op: 'pending-exact', wholePage: 1 }])], 2);
  viewer.appliedSrcRev = 1;
  viewer.stageProvisionalPatches([replace(pageList(1)), replace(pageList(2))], false, 2);
  viewer.appliedSrcRev = 2;
  viewer.stageProvisionalPatches([replace(pageList(2))], true, 2);
  assert.equal(viewer.pageDivs.get(2).dataset.provRev, '2');
});

test('real tail deletion supplies a replacement and waits only for its ink', () => {
  const pages = [1, 2, 3].map(number => ({ number, dl: { ...pageList(number), hash: `h${number}`, hfSig: 'hf' } }));
  const result = buildPagePatches(pages.slice(0, 2), pages, 'hf', () => assert.fail('cached DL expected'));
  assert.deepEqual(result.patches.map(p => p.type), ['replace-page', 'remove-pages']);
  assert.equal(result.patches[0].page, 2);
  const viewer = provisionalViewer(pages.map(p => p.dl));
  const render = viewer.renderPage;
  viewer.renderPage = dl => { render(dl); viewer.provisionalStages.get(dl.page).ready = false; };
  viewer.stageProvisionalPatches(result.patches, true, 2);
  assert.equal(viewer.pageDivs.size, 3);
  viewer.provisionalStages.get(2).ready = true;
  viewer.tryCommitProvisionalStages();
  assert.equal(viewer.pageDivs.size, 2, 'a complete shrink does not wait for canonical');
  assert.equal(viewer.pageDivs.get(2).dataset.provRev, '2');
  assert.equal(viewer.canonical.rev, 1);
});

test('complete resident growth remains prompt from a compatible baseline', () => {
  const viewer = provisionalViewer([pageList(1), pageList(2)]);
  viewer.stageProvisionalPatches([replace(pageList(2)), replace(pageList(3))], true, 3);
  assert.equal(viewer.pageDivs.size, 3);
  assert.equal(viewer.pageDivs.get(3).dataset.provRev, '2');
});

test('beamer uses real page output, including class options and LoadClass', () => {
  for (const preamble of [String.raw`\documentclass{beamer}`, String.raw`\documentclass[aspectratio=169]{beamer}`,
    String.raw`\LoadClass { beamer }`, String.raw`\LoadClassWithOptions{beamer}`]) {
    const gate = classifyPreamble(preamble);
    assert.equal(gate.safe, true, 'complete Shipping replay remains available');
    assert.equal(gate.previewPolicy, 'shipping-exact');
    assert.deepEqual(gate.previewReasons, ['beamer frame output routine']);
  }
  assert.equal(classifyPreamble('% \\documentclass{beamer}\n\\documentclass{article}').safe, true);
  assert.equal(classifyPreamble(String.raw`\documentclass{article}\usepackage{beamerarticle}`).safe, true);
});

test('beamer edits retain canonical slides until complete page output arrives', async () => {
  const workDir = mkdtempSync(path.join(tmpdir(), 'tdom-beamer-retention-'));
  const engine = new CheckpointEngine({ workDir });
  const scheduled = [];
  engine.canonical.schedule = (source, rev) => scheduled.push({ source, rev });
  const source = String.raw`\documentclass{beamer}
\begin{document}
\begin{frame}First slide\end{frame}
\begin{frame}Second slide\pause Overlay\end{frame}
\end{document}`;
  try {
    await engine.open(source);
    assert.equal(engine.previewPolicy, 'shipping-exact');
    const canonical = await engine.canonical.ensure(source, engine.srcRev);
    assert.equal(canonical.pageCount, 3);
    const viewer = provisionalViewer(engine.getDisplayLists(), 3);
    viewer.previewPolicy = engine.previewPolicy;
    const report = await engine.edit(source.indexOf('Second'), source.indexOf('Second'), 'ZQX7 ');
    assert.equal(report.previewPolicy, 'shipping-exact');
    assert.equal(report.srcRev, 2);
    assert.equal(report.canonical.rev, 1);
    assert.equal(scheduled.at(-1).rev, 2);
    assert.match(scheduled.at(-1).source, /ZQX7 Second/);
    viewer.stageProvisionalPatches(report.patches, true, report.stats.pageCount);
    assert.deepEqual(papers(viewer), ['canonical:1:1', 'canonical:1:2', 'canonical:1:3']);
    assert.equal(viewer.presentationPending([...viewer.pageDivs]), true, 'held slides report work pending');
    const current = await engine.canonical.ensure(engine.getSource(), engine.srcRev);
    assert.equal(current.pageCount, 3);
    const texts = await engine.canonical.pageTexts(current.id);
    assert.match(texts[1], /ZQX7 Second/);
    assert.match(texts[2], /ZQX7 Second/);
    viewer.commitCanonical(3);
    assert.equal(viewer.presentationPending([...viewer.pageDivs]), false);
  } finally {
    await engine.close();
    rmSync(workDir, { recursive: true, force: true });
  }
});
