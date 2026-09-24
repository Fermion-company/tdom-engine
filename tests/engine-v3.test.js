// Integration tests for the checkpoint engine — the endgame architecture.
// These fork real lualatex processes; skipped without a TeX installation.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, rmSync, mkdtempSync, writeFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { CheckpointEngine } from '../engine/checkpoint/engine-v3.js';

const DEMO = readFileSync(fileURLToPath(new URL('../samples/demo-lua.tex', import.meta.url)), 'utf8');
const WORK = fileURLToPath(new URL('../.tdom-v3-test', import.meta.url));

const available = await promisify(execFile)('lualatex', ['--version'], { timeout: 15_000 }).then(
  () => true,
  () => false
);
const opts = available ? {} : { skip: 'lualatex not installed' };

let eng;
before(async () => {
  if (!available) return;
  rmSync(WORK, { recursive: true, force: true });
  eng = new CheckpointEngine({ workDir: WORK });
  await eng.open(DEMO);
});
after(async () => {
  if (eng) await eng.close();
});

test('open builds the resident chain with real label values', opts, () => {
  const dom = eng.getDOM();
  assert.ok(dom.pageCount >= 2);
  assert.equal(dom.labels['sec:math'], '2');
  assert.equal(dom.labels['eq:gauss'], '1');
  assert.equal(dom.labels['thm:main'], '2.1');
  assert.ok(dom.checkpoints.length >= dom.blocks.length, 'one checkpoint per block boundary');
  assert.ok(eng.getFontManifest().length >= 3, 'real font files registered');
});

test('a word edit costs single-digit milliseconds of typesetting', opts, async () => {
  const src = eng.getSource();
  const idx = src.indexOf('watch the inspector');
  const t0 = performance.now();
  const r = await eng.edit(idx, idx + 'watch'.length, 'check');
  const wall = performance.now() - t0;
  assert.ok(r.stats.blocksTypeset <= 2, `edited + convergence probe only (got ${r.stats.blocksTypeset})`);
  assert.deepEqual(r.dirtyPages, [1]);
  assert.ok(r.stats.pagesReused >= r.stats.pageCount - 1, 'untouched pages adopted');
  assert.ok(wall < 500, `fork-resume edit should be fast, took ${wall.toFixed(0)}ms`);
  // steady-state check: repeat edits stay in the same class
  let worst = 0;
  for (let i = 0; i < 5; i++) {
    const t1 = performance.now();
    await eng.edit(idx, idx + 5, i % 2 ? 'check' : 'watch');
    worst = Math.max(worst, performance.now() - t1);
  }
  assert.ok(worst < 500, `worst repeat edit ${worst.toFixed(0)}ms`);
});

test('display lists carry real glyph runs with TeX positions', opts, () => {
  const dl = eng.getDisplayLists()[0];
  const glyphs = dl.commands.filter((c) => c.op === 'glyphs');
  assert.ok(glyphs.length > 100, 'page 1 painted from glyph runs');
  assert.ok(glyphs.every((g) => typeof g.x === 'number' && typeof g.y === 'number' && g.fam));
  const rules = dl.commands.filter((c) => c.op === 'rule');
  assert.ok(rules.length >= 1, 'fraction bars / rules present');
});

test('equation insertion renumbers downstream through the live chain', opts, async () => {
  const src = eng.getSource();
  const idx = src.indexOf('\\begin{equation}');
  const r = await eng.edit(idx, idx, '\\begin{equation}q=1\\end{equation}\n\n');
  assert.ok(r.stats.labelsChanged.includes('eq:gauss'));
  assert.equal(eng.getDOM().labels['eq:gauss'], '2', 'gauss renumbered 1 -> 2');
  // revert
  const src2 = eng.getSource();
  const ins = '\\begin{equation}q=1\\end{equation}\n\n';
  const i2 = src2.indexOf(ins);
  await eng.edit(i2, i2 + ins.length, '');
  assert.equal(eng.getDOM().labels['eq:gauss'], '1', 'renumbering reverted');
});

test('TikZ blocks are flagged for the exact-render tier and get chunks', opts, async () => {
  const dom = eng.getDOM();
  const gfx = dom.blocks.filter(
    (b) => b.gfxChunks.length > 0 && eng.blocks[b.index]?.text.includes('tikzpicture')
  );
  assert.ok(gfx.length >= 1, 'tikz block detected via pdf literals');
  // wait for the async exact render to land
  const id = gfx[0].gfxChunks?.[0] ?? gfx[0].id;
  for (let i = 0; i < 100 && !eng.getChunkSVG(id); i++) {
    await new Promise((r) => setTimeout(r, 200));
  }
  const svg = eng.getChunkSVG(id);
  assert.ok(svg && svg.includes('<svg'), 'exact chunk rendered');
});

test('math passes the visual fidelity gate into exact preview chunks', opts, async () => {
  const dom = eng.getDOM();
  const mathBlocks = dom.blocks.filter(
    (b) => b.fidelity === 'exact-preview-required' && b.exactLines > 0
  );
  assert.ok(mathBlocks.length >= 2, `equation/align blocks demand exact preview (got ${mathBlocks.length})`);
  const eqBlock = eng.blocks.find((b) => b.text.includes('\\begin{equation}'));
  assert.ok(eqBlock?.fidelity?.exact, 'equation block gated');
  assert.ok(
    eqBlock.fidelity.exactLines < eqBlock.fidelity.lines || eqBlock.fidelity.lines <= 2,
    'gate is line-granular: prose lines around the math stay safe-glyph'
  );
  // the high-fidelity chunk pump renders the block's exact pixels async
  for (let i = 0; i < 100 && !eng.getChunkSVG(eqBlock.id); i++) {
    await new Promise((r) => setTimeout(r, 200));
  }
  const svg = eng.getChunkSVG(eqBlock.id);
  assert.ok(svg && svg.includes('<svg'), 'exact math chunk rendered from the checkpoint child');
  // and the display list shows the math band as a chunk window, not glyphs
  await eng.renderTask.catch(() => {});
  const dls = eng.getDisplayLists();
  const chunkCmds = dls.flatMap((dl) => dl.commands.filter((c) => c.op === 'chunk'));
  assert.ok(
    chunkCmds.some((c) => c.chunk === eqBlock.id),
    'math band drawn from the exact chunk'
  );
});

test('inline math lines are chunk-banded while plain paragraphs stay glyphs', opts, () => {
  const inline = eng.blocks.find((b) => /\$[^$]+\$/.test(b.text) && !b.gfx);
  if (!inline) return; // demo may not carry inline math outside gfx blocks
  assert.ok(inline.fidelity?.exact, 'inline math demands exact preview');
  const plain = eng.blocks.find(
    (b) => b.fidelity && b.fidelity.level === 'safe-glyph' && b.fidelity.lines > 0
  );
  assert.ok(plain, 'plain prose blocks remain safe-glyph');
});

test('preamble edits take the honest full-rebuild path', opts, async () => {
  const src = eng.getSource();
  const anchor = '\\newcommand{\\engine}{Fermion TeX Engine}';
  const idx = src.indexOf(anchor);
  const r = await eng.edit(idx, idx + anchor.length, '\\newcommand{\\engine}{Fermion Engine}');
  assert.ok(r.stats.rebooted, 'root process rebooted on preamble change');
  assert.ok(eng.getDOM().labels['sec:math'] === '2', 'state rebuilt correctly');
});

test('the engine survives malformed input mid-typing', opts, async () => {
  const src = eng.getSource();
  const idx = src.indexOf('Edit any word');
  const blocksBefore = eng.blocks.map((block) => block.id);
  const pagesBefore = eng.getDisplayLists();
  const r1 = await eng.edit(idx, idx, '\\emph{');
  assert.ok(r1.rev > 0, 'unclosed group tolerated');
  assert.equal(r1.stats.chainVerdict, 'closure-deferred', 'unfinished syntax never enters TeX');
  assert.equal(r1.stats.blocksTypeset, 0, 'no speculative typeset runs');
  assert.deepEqual(eng.blocks.map((block) => block.id), blocksBefore, 'last-good block tree is retained');
  assert.deepEqual(eng.getDisplayLists(), pagesBefore, 'last-good pages are retained byte-for-byte');
  const r2 = await eng.edit(idx, idx + 6, '');
  assert.ok(r2.rev > r1.rev, 'recovered after fix');
  assert.notEqual(r2.stats.chainVerdict, 'closure-deferred', 'normal path resumes after closure');
});

test('footnotes are captured live and placed at the page bottom', opts, () => {
  const withFeet = eng.pages.filter((p) => p.feet.length > 0);
  assert.ok(withFeet.length >= 1, 'a page carries live footnotes');
  const dl = withFeet[0].dl ?? null;
  // the display list must contain the footnote rule
  const dlNow = eng.getDisplayLists()[withFeet[0].number - 1];
  assert.ok(dlNow.commands.some((c) => c.op === 'rule' && c.src === '_footrule'), 'footnote rule drawn');
});

test('figure floats are placed by the live output routine with real captions', opts, () => {
  const dom = eng.getDOM();
  assert.equal(dom.labels['fig:plot'], '1', 'real figure counter');
  const floated = eng.pages.some((p) => p.topFloats.length + p.botFloats.length > 0);
  assert.ok(floated, 'float placed in a top/bottom area');
});

test('the table of contents typesets live with page numbers', opts, () => {
  const toc = eng.blocks.find((b) => /\\tableofcontents/.test(b.text));
  assert.ok(toc?.galley, 'toc block typeset');
  const boxes = (toc.galley.items ?? []).filter((i) => i.k === 'box');
  assert.ok(boxes.length >= 5, `toc entries present (got ${boxes.length})`);
});

test('citations resolve from the live bibliography', opts, async () => {
  assert.equal(eng.getDOM().labels['cite:knuth84'], '1');
  assert.equal(eng.getDOM().labels['cite:lamport94'], '2');
  const citeBlock = eng.blocks.find((b) => b.text.includes('cite{knuth84}'));
  assert.ok(!JSON.stringify(citeBlock.galley.items).includes('[?]'), 'no unresolved citations');
  // swap the two bibliography entries: citation numbers must follow
  const src = eng.getSource();
  const a = '\\bibitem{knuth84}';
  const b = '\\bibitem{lamport94}';
  const ia = src.indexOf(a);
  assert.ok(ia > 0);
  const r = await eng.edit(ia, ia + a.length, '\\bibitem{tempx}');
  assert.ok(r.stats.labelsChanged.some((k) => k.startsWith('cite:')), 'cite keys tracked');
  const src2 = eng.getSource();
  const i2 = src2.indexOf('\\bibitem{tempx}');
  await eng.edit(i2, i2 + '\\bibitem{tempx}'.length, a);
});

test('label renames propagate backwards to earlier referencing blocks', opts, async () => {
  const src = eng.getSource();
  const originalLabel = '\\label{fig:plot}';
  const renamedLabel = '\\label{fig:plotX}';
  const li = src.indexOf(originalLabel);
  await eng.edit(li, li + originalLabel.length, renamedLabel);
  const rb = eng.blocks.find((b) => b.text.includes('is a genuine float'));
  assert.ok(JSON.stringify(rb.galley.items).includes('??'), 'earlier ref turned into ??');
  const src2 = eng.getSource();
  const l2 = src2.indexOf(renamedLabel);
  await eng.edit(l2, l2 + renamedLabel.length, originalLabel);
  const rb2 = eng.blocks.find((b) => b.text.includes('is a genuine float'));
  assert.ok(!JSON.stringify(rb2.galley.items).includes('??'), 'restored and resolved');
});


// ------------------------------------------------ Build lease vs caret warm

test('a caret warm walk yields to a Build lease at its next block boundary and resumes later', opts, async () => {
  const work = WORK + '-warm-yield';
  rmSync(work, { recursive: true, force: true });
  const paragraphs = [];
  for (let i = 1; i <= 160; i += 1) {
    paragraphs.push(`Paragraph ${i} of the warm yield fixture keeps the resident chain walking for a while.`);
    if (i % 4 === 0) paragraphs.push('\\newpage');
    paragraphs.push('');
  }
  const doc = ['\\documentclass{article}', '\\begin{document}', ...paragraphs, '\\end{document}', ''].join('\n');
  const e = new CheckpointEngine({ workDir: work });
  try {
    await e.open(doc);
    const offset = doc.indexOf('Paragraph 150 ');
    assert.ok(offset > 0);
    let settled = false;
    const warm = e.warmEditOffset(offset).finally(() => { settled = true; });
    const deadline = Date.now() + 20_000;
    // the walk can also be instantly ready (both boundaries resident): stop
    // polling as soon as the warm settles instead of waiting out the deadline
    while (!e.warming && !settled && Date.now() < deadline) await new Promise((r) => setTimeout(r, 1));
    if (!e.warming) {
      // the walk finished before it could be observed: nothing to yield
      assert.deepEqual(await e.yieldWarmForBuild(), { yielded: false, warming: false });
      await warm;
      return;
    }
    const yielded = await e.yieldWarmForBuild({ timeoutMs: 15_000 });
    assert.equal(yielded.warming, false, 'the walk stopped so a Build lease can be granted');
    assert.equal(yielded.yielded, true);
    assert.equal(e.bgAbort, false, 'the abort flag is cleared for the deferred chain');
    const first = await warm;
    assert.equal(first.status, 'superseded');
    // the same caret warms again and reaches ready
    const second = await e.warmEditOffset(offset);
    assert.equal(second.status, 'ready');
  } finally {
    await e.close();
  }
});

test('a keystroke far from every checkpoint returns within its cold budget and the resume publishes the typeset', opts, async () => {
  const work = WORK + '-cold-budget';
  rmSync(work, { recursive: true, force: true });
  const paragraphs = [];
  for (let i = 1; i <= 160; i += 1) {
    paragraphs.push(`Paragraph ${i} of the cold budget fixture keeps the resident chain walking for a while.`);
    if (i % 4 === 0) paragraphs.push('\\newpage');
    paragraphs.push('');
  }
  const doc = ['\\documentclass{article}', '\\begin{document}', ...paragraphs, '\\end{document}', ''].join('\n');
  const e = new CheckpointEngine({ workDir: work });
  e.checkpointCeiling = 4; // a sparse skeleton: paragraph 150 is far from its nearest boundary
  try {
    await e.open(doc);
    e.coldPrefixBudgetMs = 1; // stop after the first replayed clean block
    e.coldPreviewEnabled = false; // the plain budget stop (the preview has its own test)
    const deferred = new Promise((resolve) => { e.onDeferredUpdate = resolve; });
    const at = e.getSource().indexOf('Paragraph 150 ');
    assert.ok(at > 0);
    const t0 = performance.now();
    const cold = await e.edit(at, at + 'Paragraph'.length, 'Section');
    const wall = performance.now() - t0;
    assert.equal(cold.stats.chainVerdict, 'cold');
    assert.equal(cold.stats.coldPending.length, 1, 'the edited block waits for the resume');
    assert.equal(cold.dirtySourceNodes.length, 1);
    assert.ok(cold.stats.blocksTypeset < 20, `the hot path replayed ${cold.stats.blocksTypeset} blocks past its budget`);
    assert.ok(wall < 5_000, `cold keystroke took ${wall.toFixed(0)}ms`);
    assert.equal(e.coldDirty.size, 1);
    const resumed = await Promise.race([
      deferred,
      new Promise((_, reject) => setTimeout(() => reject(new Error('cold resume never published')), 90_000)),
    ]);
    assert.equal(resumed.srcRev, cold.srcRev, 'the resume is a display revision of the same source revision');
    assert.ok(resumed.rev > cold.rev);
    assert.equal(resumed.edit, 'cold-resume');
    assert.equal(e.coldDirty.size, 0);
    assert.notEqual(resumed.stats.chainVerdict, 'cold');
    assert.ok(resumed.patches.length >= 1, 'the resume carries the page of the edited block');
    assert.deepEqual(resumed.dirtySourceNodes, cold.dirtySourceNodes);
    const block = e.blocks.find((b) => b.id === String(cold.dirtySourceNodes[0]).replace(/^src-/, ''));
    assert.ok(block?.galley && block.text.startsWith('Section 150'), 'the galley now belongs to the edited text');
    // the boundary the walk reached is pinned: the next keystroke there is hot
    const hot = await e.edit(at, at + 'Section'.length, 'Chapter');
    assert.notEqual(hot.stats.chainVerdict, 'cold');
    assert.ok(hot.stats.blocksTypeset <= 3, `follow-up keystroke replayed ${hot.stats.blocksTypeset} blocks`);
    assert.equal(hot.srcRev, cold.srcRev + 1);
  } finally {
    await e.close();
  }
});

test('a cold keystroke shows its block through a preview typeset from the far checkpoint, and the walk that replaces it still carries its effects on', opts, async () => {
  const work = WORK + '-cold-preview';
  rmSync(work, { recursive: true, force: true });
  const paragraphs = [];
  for (let i = 1; i <= 160; i += 1) {
    if (i === 155) paragraphs.push('\\section{Late}', '');
    const ref = i === 20 ? ' See \\ref{p:hundred}.' : '';
    const label = i === 100 ? '\\label{p:hundred}' : '';
    paragraphs.push(`Paragraph ${i} of the cold preview fixture keeps the resident chain walking for a while.${ref}${label}`);
    if (i % 4 === 0) paragraphs.push('\\newpage');
    paragraphs.push('');
  }
  const doc = ['\\documentclass{article}', '\\begin{document}', '\\section{First}', ...paragraphs, '\\end{document}', ''].join('\n');
  const e = new CheckpointEngine({ workDir: work });
  e.checkpointCeiling = 4;
  const block = (head) => e.blocks.find((b) => b.text.startsWith(head));
  const settle = async () => {
    const until = Date.now() + 90_000;
    while ((e.pendingChain || e.coldDirty.size || e.bgActive || e.updating) && Date.now() < until) {
      await new Promise((r) => setTimeout(r, 50));
    }
    assert.equal(e.coldDirty.size, 0, 'the cold resume landed');
    assert.equal(e.pendingChain, null);
  };
  const coldEdit = async (at, end, text) => {
    const report = await e.edit(at, end, text);
    assert.equal(report.stats.chainVerdict, 'cold');
    assert.equal(report.stats.coldPreview?.adopted, true, JSON.stringify(report.stats.coldPreview));
    return report;
  };
  try {
    await e.open(doc);
    e.coldPrefixBudgetMs = 1; // stop after the first replayed clean block
    e.coldPreviewFromMs = 0; // preview every cold keystroke
    e.coldPreviewWaitMs = 60_000; // and always wait for it
    const section = e.counters.indexOf('section');
    assert.equal(JSON.parse(block('\\section{Late}').stateVec)[section], 2);

    // 1. a moved counter: every later heading is renumbered
    let at = e.getSource().indexOf('Paragraph 150 ');
    const exitBefore = block('Paragraph 150 ').stateVec;
    const cold = await coldEdit(at, at, '\\section{Early} ');
    const id = String(cold.dirtySourceNodes[0]).replace(/^src-/, '');
    assert.deepEqual(cold.stats.coldPending, [id], 'the previewed block still waits for its own lineage');
    const previewed = e.blocks.find((b) => b.id === id);
    assert.ok(previewed.galley.tdomColdPreview && previewed.text.startsWith('\\section{Early} Paragraph 150'));
    assert.equal(previewed.stateVec, exitBefore, 'the block keeps the exit state its successors were typeset against');
    const previewItems = JSON.stringify(previewed.galley.items);
    const commands = cold.patches.flatMap((patch) => patch.displayList?.commands ?? []);
    assert.ok(commands.some((c) => c.src === id), 'the keystroke\'s page paints the previewed block');
    assert.ok(!commands.some((c) => c.op === 'pending-exact' && c.src === id));
    await settle();
    const native = e.blocks.find((b) => b.id === id);
    assert.ok(!native.galley.tdomColdPreview, 'a walk in the block\'s own lineage replaced the preview');
    assert.equal(JSON.stringify(native.galley.items), previewItems, 'the far checkpoint typeset the same lines');
    assert.equal(JSON.parse(block('\\section{Late}').stateVec)[section], 3);

    // 2. untracked state (a font declaration) must still reach the next paragraph
    const fontOf = (b) => b.galley.items.find((it) => it.k === 'box' && it.runs?.some((r) => r.t))?.runs.find((r) => r.t)?.f;
    const nextFont = fontOf(block('Paragraph 141 '));
    at = e.getSource().indexOf('Paragraph 140 ');
    await coldEdit(at, at, '\\bfseries ');
    await settle();
    assert.notEqual(fontOf(block('Paragraph 141 ')), nextFont, 'the declaration leaks into the next paragraph');

    // 3. a renamed label vanishes for its (earlier) reference
    assert.ok(e.labelTable.has('p:hundred'));
    at = e.getSource().indexOf('\\label{p:hundred}') + '\\label{p:hundre'.length;
    await coldEdit(at, at + 1, '');
    await settle();
    assert.ok(!e.labelTable.has('p:hundred'), 'the old label is gone');
    assert.equal(block('Paragraph 20 ').galley.tdomRefVals?.['p:hundred'], undefined, 'its reference re-resolved');
  } finally {
    await e.close();
  }
});

test('a cold preview of a block with exact pixels renders them from the checkpoint it was typeset from', opts, async () => {
  const work = WORK + '-cold-preview-gfx';
  rmSync(work, { recursive: true, force: true });
  const paragraphs = [];
  for (let i = 1; i <= 160; i += 1) {
    // only the edited paragraph needs exact pixels: no cold neighbor holds its page
    paragraphs.push(`Paragraph ${i} holds ${i === 150 ? '$x^2$' : 'text'} marked ${i} in the cold preview fixture.`);
    if (i % 4 === 0) paragraphs.push('\\newpage');
    paragraphs.push('');
  }
  const doc = ['\\documentclass{article}', '\\begin{document}', ...paragraphs, '\\end{document}', ''].join('\n');
  const e = new CheckpointEngine({ workDir: work });
  e.checkpointCeiling = 2; // a long resume walk: the render lands while the preview is shown
  try {
    await e.open(doc);
    await e.renderTask;
    e.coldPrefixBudgetMs = 1;
    e.coldPreviewFromMs = 0;
    e.coldPreviewWaitMs = 60_000;
    const at = e.getSource().indexOf('marked 150') + 'marked'.length;
    const cold = await e.edit(at, at, ' X');
    assert.equal(cold.stats.coldPreview?.adopted, true, JSON.stringify(cold.stats.coldPreview));
    const id = String(cold.dirtySourceNodes[0]).replace(/^src-/, '');
    const previewed = e.blocks.find((b) => b.id === id);
    assert.ok(previewed.needsRender, 'the fixture block needs exact pixels');
    await e.renderTask;
    assert.ok((e.renderStats?.coldPreviews ?? 0) >= 1, 'the preview rendered from its own checkpoint');
    const until = Date.now() + 90_000;
    while ((e.pendingChain || e.coldDirty.size || e.updating || e.bgActive) && Date.now() < until) {
      await new Promise((r) => setTimeout(r, 50));
    }
    await e.renderTask;
    const native = e.blocks.find((b) => b.id === id);
    assert.ok(!native.galley.tdomColdPreview);
    assert.equal(e.chunks.get(id)?.forGalley, native.galleyHash, 'the replacing galley got pixels of its own');
  } finally {
    await e.close();
  }
});

test('a caret warm that reaches the block of a budgeted keystroke hands over to the resume', opts, async () => {
  const work = WORK + '-cold-warm';
  rmSync(work, { recursive: true, force: true });
  const paragraphs = [];
  for (let i = 1; i <= 160; i += 1) {
    paragraphs.push(`Paragraph ${i} of the cold warm fixture keeps the resident chain walking for a while.`);
    if (i % 4 === 0) paragraphs.push('\\newpage');
    paragraphs.push('');
  }
  const doc = ['\\documentclass{article}', '\\begin{document}', ...paragraphs, '\\end{document}', ''].join('\n');
  const e = new CheckpointEngine({ workDir: work });
  e.checkpointCeiling = 4;
  try {
    await e.open(doc);
    e.coldPrefixBudgetMs = 1;
    e.coldPreviewFromMs = 0; // with a preview on screen (docs/10 §10.4b)
    const deferred = new Promise((resolve) => { e.onDeferredUpdate = resolve; });
    const at = e.getSource().indexOf('Paragraph 150 ');
    const cold = await e.edit(at, at + 'Paragraph'.length, 'Section');
    assert.equal(cold.stats.chainVerdict, 'cold');
    // the host warms the caret right after the keystroke: that walk
    // pre-empts the cold chain pass and typesets the block itself
    const warm = await e.warmEditOffset(at);
    assert.ok(['ready', 'incomplete', 'superseded'].includes(warm.status), warm.status);
    const resumed = await Promise.race([
      deferred,
      new Promise((_, reject) => setTimeout(() => reject(new Error('no resume after the warm')), 90_000)),
    ]);
    assert.equal(resumed.srcRev, cold.srcRev);
    assert.equal(resumed.edit, 'cold-resume');
    assert.deepEqual(resumed.dirtySourceNodes, cold.dirtySourceNodes, 'the keystroke still gets its report');
    assert.ok(resumed.patches.length >= 1);
    assert.equal(e.coldDirty.size, 0);
    assert.equal(e.pendingChain, null);
  } finally {
    await e.close();
  }
});

test('a keystroke during the cold walk stops it at a live boundary instead of rebooting', opts, async () => {
  const work = WORK + '-cold-interrupt';
  rmSync(work, { recursive: true, force: true });
  const paragraphs = [];
  for (let i = 1; i <= 160; i += 1) {
    paragraphs.push(`Paragraph ${i} of the cold interrupt fixture keeps the resident chain walking for a while.`);
    if (i % 4 === 0) paragraphs.push('\\newpage');
    paragraphs.push('');
  }
  const doc = ['\\documentclass{article}', '\\begin{document}', ...paragraphs, '\\end{document}', ''].join('\n');
  const e = new CheckpointEngine({ workDir: work });
  e.checkpointCeiling = 4;
  try {
    await e.open(doc);
    e.coldPrefixBudgetMs = 1;
    e.coldPreviewFromMs = 0; // with a preview on screen (docs/10 §10.4b)
    const at = e.getSource().indexOf('Paragraph 150 ');
    const cold = await e.edit(at, at + 'Paragraph'.length, 'Section');
    assert.equal(cold.stats.chainVerdict, 'cold');
    // let the idle gate open and the cold chain pass start its STEP walk
    const deadline = Date.now() + 20_000;
    while (!e.coldWalking && Date.now() < deadline) await new Promise((r) => setTimeout(r, 5));
    const interrupted = e.coldWalking;
    const second = await e.edit(at, at + 'Section'.length, 'Chapter');
    assert.equal(second.stats.rebooted, false, 'the interrupted walk must not poison the next keystroke');
    assert.equal(second.srcRev, cold.srcRev + 1);
    // whichever path finishes (a resume, or the second keystroke reaching the
    // block itself), the document settles with nothing left cold
    const settle = Date.now() + 90_000;
    while ((e.coldDirty.size || e.pendingChain) && Date.now() < settle) await new Promise((r) => setTimeout(r, 50));
    assert.equal(e.coldDirty.size, 0);
    assert.equal(e.pendingChain, null);
    const third = await e.edit(at, at + 'Chapter'.length, 'Part');
    assert.notEqual(third.stats.chainVerdict, 'cold');
    assert.ok(third.stats.blocksTypeset <= 3, `after the walk the block is hot (got ${third.stats.blocksTypeset}${interrupted ? ', interrupted' : ''})`);
  } finally {
    await e.close();
  }
});

test('a keystroke during a caret warm walk takes the lock at the next block boundary', opts, async () => {
  const work = WORK + '-warm-edit-priority';
  rmSync(work, { recursive: true, force: true });
  const paragraphs = [];
  for (let i = 1; i <= 160; i += 1) {
    paragraphs.push(`Paragraph ${i} of the warm priority fixture keeps the resident chain walking for a while.`);
    if (i % 4 === 0) paragraphs.push('\\newpage');
    paragraphs.push('');
  }
  const doc = ['\\documentclass{article}', '\\begin{document}', ...paragraphs, '\\end{document}', ''].join('\n');
  const e = new CheckpointEngine({ workDir: work });
  e.checkpointCeiling = 4;
  try {
    await e.open(doc);
    const far = doc.indexOf('Paragraph 150 ');
    const near = doc.indexOf('Paragraph 2 ');
    // two warms in a row, as a host does (viewer page, then caret): the
    // second waits for the first to stop and then restarts the walk
    const first = e.warmEditOffset(far);
    const second = e.warmEditOffset(far);
    const deadline = Date.now() + 20_000;
    while (!e.warming && Date.now() < deadline) await new Promise((r) => setTimeout(r, 1));
    if (!e.warming) { await first; await second; return; }
    const t0 = performance.now();
    const r = await e.edit(near, near + 'Paragraph'.length, 'Section');
    const wall = performance.now() - t0;
    assert.ok(wall < 4_000, `keystroke waited ${wall.toFixed(0)}ms behind the warm walk`);
    assert.ok(r.stats.blocksTypeset <= 3);
    const results = await Promise.all([first, second]);
    assert.ok(results.some((w) => w.status === 'superseded'), JSON.stringify(results));
    assert.equal(e.editPending, 0);
  } finally {
    await e.close();
  }
});

test('a keep-set boundary without a continuation is materialized by the idle grid pass', opts, async () => {
  const work = WORK + '-grid-fill';
  rmSync(work, { recursive: true, force: true });
  const paragraphs = [];
  for (let i = 1; i <= 120; i += 1) {
    paragraphs.push(`Paragraph ${i} of the grid fill fixture keeps the resident chain walking for a while.`);
    if (i % 4 === 0) paragraphs.push('\\newpage');
    paragraphs.push('');
  }
  const doc = ['\\documentclass{article}', '\\begin{document}', ...paragraphs, '\\end{document}', ''].join('\n');
  const e = new CheckpointEngine({ workDir: work });
  e.checkpointCeiling = 4;
  try {
    await e.open(doc);
    await e.bgTask.catch(() => {});
    const settle = Date.now() + 20_000;
    while (e.gridMissing().length && Date.now() < settle) await new Promise((r) => setTimeout(r, 100));
    assert.deepEqual(e.gridMissing(), [], 'after boot every keep boundary holds a continuation');
    // Lose an interior keep boundary the way memory pressure or a killed
    // walk would: the keep set still wants it, no process holds it.
    const keep = e.gridInfo().keep.filter((idx) => idx > 0 && idx < e.blocks.length && e.checkpoints.has(idx));
    assert.ok(keep.length >= 1, 'an interior keep boundary exists');
    const lost = keep[keep.length - 1];
    const peer = e.checkpoints.get(lost);
    peer.send('DIE\n');
    if (peer.pid) e.dyingPids.add(peer.pid);
    for (const [idx, candidate] of [...e.checkpoints]) if (candidate === peer) e.checkpoints.delete(idx);
    assert.deepEqual(e.gridMissing(), [lost]);
    const t0 = performance.now();
    const ran = await e.maintainGrid();
    assert.equal(ran, true);
    const deadline = Date.now() + 30_000;
    while (e.gridMissing().length && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
    assert.ok(e.checkpoints.has(lost), `boundary ${lost} was materialized again (${(performance.now() - t0).toFixed(0)}ms)`);
    assert.deepEqual(e.gridMissing(), []);
    assert.ok(e.gridInfo().fill.materialized >= 1);
    assert.ok(e.checkpoints.size <= e.maxCheckpoints + 2, `resident set stays near budget: ${e.checkpoints.size}`);
    // a keystroke at the block right after the restored boundary is hot
    const at = e.getSource().indexOf(e.blocks[lost].text.slice(0, 20));
    assert.ok(at > 0);
    const hot = await e.edit(at, at + 'Paragraph'.length, 'Section');
    assert.notEqual(hot.stats.chainVerdict, 'cold');
    assert.ok(hot.stats.blocksTypeset <= 3, `keystroke after the restored boundary replayed ${hot.stats.blocksTypeset} blocks`);
  } finally {
    await e.close();
  }
});

test('a keystroke at the block a caret warm is walking toward resumes from the boundary it reached', opts, async () => {
  const work = WORK + '-warm-frontier-edit';
  rmSync(work, { recursive: true, force: true });
  const paragraphs = [];
  for (let i = 1; i <= 160; i += 1) {
    paragraphs.push(`Paragraph ${i} of the warm frontier fixture keeps the resident chain walking for a while.`);
    if (i % 4 === 0) paragraphs.push('\\newpage');
    paragraphs.push('');
  }
  const doc = ['\\documentclass{article}', '\\begin{document}', ...paragraphs, '\\end{document}', ''].join('\n');
  const e = new CheckpointEngine({ workDir: work });
  e.checkpointCeiling = 4; // the budget in force is derived per document from the ceiling
  try {
    await e.open(doc);
    const far = doc.indexOf('Paragraph 150 ');
    const warm = e.warmEditOffset(far);
    const deadline = Date.now() + 20_000;
    while (!e.warming && Date.now() < deadline) await new Promise((r) => setTimeout(r, 1));
    if (!e.warming) { await warm; return; }
    await new Promise((r) => setTimeout(r, 300)); // let the STEP walk advance a few blocks
    const t0 = performance.now();
    const r = await e.edit(far, far + 'Paragraph'.length, 'Section');
    const wall = performance.now() - t0;
    assert.ok(r.stats.typesetMs < 8_000, `a job at the warm's frontier stalled: ${r.stats.typesetMs}ms (${JSON.stringify(r.stats.diagnostics)})`);
    assert.ok(!r.stats.diagnostics.some((d) => /timed out|failed/.test(d)), JSON.stringify(r.stats.diagnostics));
    assert.ok(wall < 20_000, `keystroke took ${wall.toFixed(0)}ms`);
    const w = await warm;
    // on a fast machine the walk can finish before the keystroke enters
    assert.ok(['superseded', 'ready'].includes(w.status), w.status);
  } finally {
    await e.close();
  }
});

test('a reopened document adopts its cached isolated rescues during the boot walk', opts, async () => {
  const work = WORK + '-iso-disk-cache';
  rmSync(work, { recursive: true, force: true });
  const doc = [
    '\\documentclass{article}', '\\usepackage{multicol}', '\\begin{document}',
    'Plain paragraph before the columns with ordinary prose on the page.', '',
    '\\begin{multicols}{2}',
    'Left column text explains the idea in the first column with several plain sentences.',
    'It continues with another sentence so the column has a few lines of text.', '',
    '\\columnbreak',
    'Right column text compares the idea with another one in the second column.',
    '\\end{multicols}', '',
    'Plain paragraph after the columns. Closing prose for the page.', '',
    '\\end{document}', '',
  ].join('\n');
  const first = new CheckpointEngine({ workDir: work });
  try {
    await first.open(doc);
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
      const block = first.blocks.find((b) => /begin\{multicols\}/.test(b.text));
      if (block?.rescued && !first.rescueQueue.size && !first.rescuePumping) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    const block = first.blocks.find((b) => /begin\{multicols\}/.test(b.text));
    assert.ok(block?.rescued, 'the multicols block was rescued by the isolated compile');
    assert.ok(first.isoDiskCache?.stats.writes >= 1, JSON.stringify(first.isoDiskCache?.stats));
  } finally {
    await first.close();
  }
  const second = new CheckpointEngine({ workDir: work });
  try {
    const report = await second.open(doc);
    const block = second.blocks.find((b) => /begin\{multicols\}/.test(b.text));
    assert.ok(block?.rescued, 'the boot walk adopted the cached rescue inline');
    assert.equal(second.rescueQueue.size, 0, 'nothing left for the async pump');
    assert.ok(second.isoDiskCache?.stats.hits >= 1, JSON.stringify(second.isoDiskCache?.stats));
    assert.ok(second.chunks.size >= 1, 'the cached chunk svg is registered');
    assert.ok(report.stats.pageCount >= 1);
  } finally {
    await second.close();
  }
});

test('a boot walk with the fork runners up measures first-ever rescues before /open returns', opts, async () => {
  const doc = [
    '\\documentclass{article}', '\\usepackage{multicol}', '\\begin{document}',
    'Plain paragraph before the columns with ordinary prose on the page.', '',
    '\\begin{multicols}{2}',
    'Left column text explains the idea in the first column with several plain sentences.',
    'It continues with another sentence so the column has a few lines of text.', '',
    '\\columnbreak',
    'Right column text compares the idea with another one in the second column.',
    '\\end{multicols}', '',
    'Plain paragraph after the columns. Closing prose for the page.', '',
    '\\end{document}', '',
  ].join('\n');
  // a placeholder (no measured box) holds every assembled page: count the
  // page-wide pending markers in the report /open publishes
  const pagesHeld = (report) => report.patches
    .filter((patch) => patch.type === 'replace-page')
    .filter((patch) => patch.displayList.commands.some((cmd) => cmd.op === 'pending-exact' && cmd.wholePage)).length;
  const boot = async (name, budgetMs) => {
    const work = WORK + name;
    rmSync(work, { recursive: true, force: true });
    process.env.TDOM_ISO_REAL_FORK = '1';
    if (budgetMs != null) process.env.TDOM_BOOT_RESCUE_MS = String(budgetMs);
    try {
      return new CheckpointEngine({ workDir: work });
    } finally {
      delete process.env.TDOM_ISO_REAL_FORK;
      delete process.env.TDOM_BOOT_RESCUE_MS;
    }
  };
  const inline = await boot('-boot-rescue', null);
  try {
    const report = await inline.open(doc);
    const block = inline.blocks.find((b) => /begin\{multicols\}/.test(b.text));
    assert.ok(inline.realRoot?.pid > 0);
    assert.equal(pagesHeld(report), 0, 'no placeholder holds the opened pages');
    assert.ok(block?.galley && !block.galley.tdomPendingPaint, 'the boot walk adopted a measured galley');
    assert.equal(inline.isoModeOf.get(block.id), 'fork-real');
    assert.equal(inline.bootRescueBudgetMs, 0, 'the budget ends with the boot walk');
  } finally {
    await inline.close();
  }
  const deferred = await boot('-boot-rescue-off', 0);
  try {
    const report = await deferred.open(doc);
    assert.ok(pagesHeld(report) > 0, 'without a budget the first rescue is a placeholder for the async pump');
  } finally {
    await deferred.close();
  }
});

// --- real-output rescue root (TDOM_ISO_REAL_FORK) -------------------------
//
// Splitting environments used to be rescued COLD (a standalone lualatex,
// the whole preamble again). The real-output root is a pre-dormant sibling
// of checkpoint 0; its ISO children run LaTeX's real \output with the
// preamble COW-shared. The contract: same block, same offset — cold and
// fork-real agree on state, items, labels, chunk geometry and pixels.

const SPLIT_LOREM = 'Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. ';
const SPLIT_DOC = [
  '\\documentclass{article}', '\\usepackage{multicol,longtable,mdframed}', '\\usepackage[most]{tcolorbox}', '\\begin{document}',
  'Plain paragraph before the columns with ordinary prose on the page.', '',
  '\\begin{multicols}{2}', SPLIT_LOREM.repeat(6), '\\columnbreak', SPLIT_LOREM.repeat(3), '\\end{multicols}', '',
  'Plain paragraph between.', '',
  '\\begin{multicols*}{2}', SPLIT_LOREM.repeat(4), '\\end{multicols*}', '',
  'Plain paragraph between two.', '',
  '\\begin{longtable}{ll}', ...Array.from({ length: 12 }, (_, i) => `row ${i} & value ${i} \\\\`), '\\end{longtable}', '',
  'Plain paragraph between three.', '',
  '\\begin{mdframed}', SPLIT_LOREM.repeat(8), '\\end{mdframed}', '',
  'Plain paragraph between four.', '',
  '\\begin{tcolorbox}[breakable]', SPLIT_LOREM.repeat(8), '\\end{tcolorbox}', '',
  'Plain paragraph after.', '',
  '\\end{document}', '',
].join('\n');

const sortedKeys = (o) => Object.fromEntries(Object.keys(o ?? {}).sort().map((k) => [k, o[k]]));
const isoShape = (iso) => ({
  w: iso.w, h: iso.h, d: iso.d, items: iso.items, labels: iso.labels, toclines: iso.toclines,
  state: sortedKeys(iso.state),
  chunks: iso.chunks.map((c) => ({ key: c.key, wBp: c.wBp, hBp: c.hBp, editPage: c.editPage, svg: c.svg })),
});
async function rasterPages(pdfBuf, tag) {
  const dir = mkdtempSync(path.join(tmpdir(), 'tdom-realfork-'));
  try {
    writeFileSync(path.join(dir, 'x.pdf'), pdfBuf);
    await promisify(execFile)('pdftocairo', ['-png', '-r', '72', path.join(dir, 'x.pdf'), path.join(dir, tag)], { timeout: 30_000 });
    return readdirSync(dir).filter((f) => f.startsWith(tag) && f.endsWith('.png')).sort().map((f) => readFileSync(path.join(dir, f)));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
// Process state letter (R, S, Z, ...) or null once the pid is gone.
const processState = (pid) => {
  try { return readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ')[1]?.[0] ?? null; } catch { /* not Linux */ }
  try { return execFileSync('ps', ['-o', 'stat=', '-p', String(pid)], { encoding: 'utf8' }).trim()[0] || null; } catch { return null; }
};
// A SIGKILLed process whose parent died with it stays a zombie until
// something reaps it; in a container whose pid 1 is not an init that can
// outlast the check. Dead is dead: only a process still running counts.
const retired = async (pid, ms = 5000) => {
  const deadline = Date.now() + ms;
  for (;;) {
    if (!alive(pid) || processState(pid) === 'Z') return true;
    if (Date.now() > deadline) return false;
    await new Promise((r) => setTimeout(r, 50));
  }
};

test('the real-output root is opt-in: without the flag splitting rescues stay cold', opts, () => {
  assert.equal(eng.isoRealFork, false);
  assert.equal(eng.realRoot, null);
});

test('fork-real rescues from the real-output root match the cold compile bit for bit', opts, async () => {
  const work = WORK + '-real-fork';
  rmSync(work, { recursive: true, force: true });
  process.env.TDOM_ISO_REAL_FORK = '1';
  let e;
  try {
    e = new CheckpointEngine({ workDir: work });
  } finally {
    delete process.env.TDOM_ISO_REAL_FORK;
  }
  let realRootPid = 0;
  try {
    await e.open(SPLIT_DOC);
    // the boot walk's async pump rescues these blocks into the same job
    // directories the differential compiles use — let it drain first
    const drained = Date.now() + 120_000;
    while (Date.now() < drained && (e.rescueQueue.size || e.rescuePumping)) await new Promise((r) => setTimeout(r, 50));
    assert.equal(e.rescueQueue.size + (e.rescuePumping ? 1 : 0), 0, 'boot rescues drained');
    assert.ok(e.realRoot?.pid > 0, 'the driver forked the real-output root before the dormant setup');
    realRootPid = e.realRoot.pid;
    assert.ok(alive(realRootPid));
    const targets = e.blocks.map((b, i) => [b, i]).filter(([b]) => /\\begin\{(multicols\*?|longtable|mdframed|tcolorbox)/.test(b.text));
    assert.equal(targets.length, 5, targets.map(([b]) => b.text.slice(0, 30)).join(' | '));
    const textheight = e.geometry?.textheight ?? 550;
    // page offsets: top of page, mid-page, near the bottom (forces a split)
    const offsets = [0, Math.round(textheight * 0.55), Math.round(textheight * 0.95)];
    let splitSeen = 0;
    for (const [block, idx] of targets) {
      for (const off of offsets) {
        block.pageOffset = off;
        const cold = await e.compileIsolatedBlock(idx, { forceCold: true });
        const fork = await e.compileIsolatedBlock(idx, { forceCold: false });
        const env = block.text.match(/\\begin\{([^}]*)\}/)[1];
        assert.equal(cold.runner, 'cold', env);
        assert.equal(fork.runner, 'fork-real', `${env}@${off}: ${JSON.stringify(e.diagnostics.slice(-3))}`);
        assert.deepEqual(isoShape(fork.iso), isoShape(cold.iso), `${env}@${off}: state/items/chunks differ`);
        if (cold.iso.chunks.length > 1) splitSeen++;
        // pixels: the first chunk's PDF holds every shipped page of the run
        const a = await rasterPages(cold.iso.chunks[0].editPdf, 'c');
        const b = await rasterPages(fork.iso.chunks[0].editPdf, 'f');
        assert.equal(b.length, a.length, `${env}@${off}: page count`);
        a.forEach((png, k) => assert.ok(png.equals(b[k]), `${env}@${off}: page ${k + 1} pixels differ`));
      }
    }
    assert.ok(splitSeen >= 1, 'at least one offset made an environment split across pages');
    assert.ok(!e.isoForkBroken.size, [...e.isoForkBroken].join());
  } finally {
    if (e) await e.close();
  }
  assert.ok(await retired(realRootPid),
    `close retires the real-output root with the rest of the tree (state ${processState(realRootPid)})`);
});

test('microtype expansion and protrusion keep resident glyphs where the PDF paints them (tex64-internal #66)', opts, async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'tdom-microtype-'));
  const eng = new CheckpointEngine({ workDir: path.join(root, 'work') });
  const prose = 'Resumable typesetting means that a checkpoint taken before an edited block ' +
    'reproduces the complete output once only the following blocks are processed again, ' +
    'which is exactly the property the live preview relies on for every keystroke it shows ' +
    'while the full compilation of the document is still running in the background.';
  try {
    await eng.open([
      '\\documentclass{article}',
      '\\usepackage{microtype}',
      '\\hyphenpenalty=10000 \\emergencystretch=3em',
      '\\begin{document}',
      `\\noindent\`\`Quoted opening'' of a paragraph that protrudes into the margin. ${prose}`,
      '',
      '\\microtypesetup{protrusion=false}',
      prose,
      '\\end{document}',
      '',
    ].join('\n'));
    const lines = (text, not = null) => {
      const block = eng.blocks.find((item) => item.text.includes(text) && !(not && item.text.includes(not)));
      return (block?.galley?.items ?? []).filter((item) => item.k === 'box' && item.runs?.length);
    };
    const quoted = lines('Quoted opening');
    assert.ok(quoted.length >= 3);
    assert.ok(Math.min(...quoted[0].runs.map((run) => run.x)) < -0.1,
      'the opening quote hangs into the left margin as the PDF paints it');
    // without protrusion every justified line fills its box exactly, but
    // only if each glyph and font kern advances by its expanded width
    const plain = lines('Resumable typesetting', 'Quoted opening');
    assert.ok(plain.length >= 3);
    for (const item of plain.slice(0, -1)) {
      const right = Math.max(...item.runs.map((run) => run.x + run.w));
      assert.ok(Math.abs(right - item.w) < 0.05, `line content ends at the box edge (${right} vs ${item.w})`);
    }
  } finally {
    await eng.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('a forward \\cref under hyperref typesets in the resident chain (tex64-internal #66)', opts, async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'tdom-forward-cref-'));
  const eng = new CheckpointEngine({ workDir: path.join(root, 'work') });
  try {
    await eng.open([
      '\\documentclass{article}',
      '\\usepackage{hyperref}',
      '\\usepackage{cleveref}',
      '\\begin{document}',
      'First paragraph refers ahead to \\cref{tab:cost} and \\ref{tab:cost}.',
      '',
      'Second paragraph of ordinary prose.',
      '',
      '\\begin{table}[b]',
      '\\centering',
      '\\begin{tabular}{ll} a & b \\\\ \\end{tabular}',
      '\\caption{Cost}\\label{tab:cost}',
      '\\end{table}',
      '',
      'Closing paragraph.',
      '\\end{document}',
      '',
    ].join('\n'));
    await eng.canonical.settle();
    // the cleveref companion used to get two groups where hyperref reads
    // five: LuaLaTeX rejected the block and it fell to an isolated rescue
    const block = eng.blocks.find((item) => item.text.includes('refers ahead'));
    assert.equal(block.rescued, false, 'the referring paragraph is typeset in-chain');
    assert.notEqual(block.galley?.tdomDeferred, true);
    assert.ok(block.galley.items.length > 0);
    assert.equal(eng.labelTable.get('tab:cost'), '1');
  } finally {
    await eng.close();
    rmSync(root, { recursive: true, force: true });
  }
});
