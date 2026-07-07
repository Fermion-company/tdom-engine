// Canonical layer + safety gate — the two absolute conditions:
//   1. the final display converges to real LuaLaTeX output;
//   2. unknown/unsafe structure demotes to opaque instead of breaking.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { CanonicalRenderer } from '../engine/checkpoint/canonical.js';
import { CheckpointEngine } from '../engine/checkpoint/engine-v3.js';
import { classifyDocument, verifyTokens, tokenContainment } from '../engine/checkpoint/safety.js';
import { drain } from '../tools/harness.mjs';

const WORK = fileURLToPath(new URL('../.tdom-canon-test', import.meta.url));
const available = await promisify(execFile)('lualatex', ['--version'], { timeout: 15_000 }).then(
  () => true,
  () => false
);
const opts = available ? {} : { skip: 'lualatex not installed' };

// -------------------------------------------- demand-paced authority cadence

test('authority pressure paces recompiles by compile cost; display does not', () => {
  const c = new CanonicalRenderer({ workDir: WORK + '-pace' });
  try {
    // no compile yet: base debounce only (fast first exactness)
    assert.equal(c.delayFor(), c.debounceMs);
    // a 8s compile just finished: the next one must wait ~factor× its cost
    c.last = { ms: 8000 };
    c.lastEndAt = Date.now();
    assert.ok(
      c.delayFor() >= 8000 * c.cooldownFactor - 100,
      `cooldown scales with compile cost (got ${c.delayFor()})`
    );
    // the cooldown is capped (a pathological 5-minute doc must still refresh)
    c.last = { ms: 600_000 };
    assert.ok(c.delayFor() <= c.cooldownCapMs, 'cooldown capped');
    // once the cooldown has elapsed, only the base debounce remains
    c.last = { ms: 8000 };
    c.lastEndAt = Date.now() - 8000 * c.cooldownFactor - 1000;
    assert.equal(c.delayFor(), c.debounceMs);
    // opaque mode: the compile IS the display — never pace it
    c.pressure = 'display';
    c.lastEndAt = Date.now();
    assert.equal(c.delayFor(), c.debounceMs);
  } finally {
    c.dispose();
  }
});

// ------------------------------------------------------------ safety gate

test('safety gate: clean documents pass, page-mechanism hazards demote', () => {
  const clean = classifyDocument(
    '\\documentclass{article}\\usepackage{amsmath}\\usepackage{tikz}',
    'Hello \\ref{a} $x^2$.'
  );
  assert.equal(clean.safe, true);
  assert.equal(classifyDocument('\\documentclass{article}\\usepackage{eso-pic}', '').safe, false);
  assert.equal(classifyDocument('\\documentclass[a4paper,twocolumn]{article}', '').safe, false);
  assert.equal(classifyDocument('\\documentclass{article}\\AtBeginShipout{x}', '').safe, false);
  // \marginpar stays STRUCTURED since the canonical-only block tier
  // (paper drafts carry \todo marks routinely): the block's body typesets
  // in-chain, the margin pixels come from the canonical layer
  assert.equal(classifyDocument('\\documentclass{article}', 'a \\marginpar{note} b').safe, true);
  // \includepdf demotes the BLOCK (isolated exact-render rescue ships its
  // foreign pages), never the document — gate granularity is block-first
  assert.equal(classifyDocument('\\documentclass{article}\\usepackage{pdfpages}', 'a \\includepdf{x.pdf}').safe, true);
  // commented-out hazards do not demote
  assert.equal(classifyDocument('\\documentclass{article}\n% \\twocolumn', 'body').safe, true);
  // block-level rescue targets stay structured at the document level
  assert.equal(
    classifyDocument('\\documentclass{article}\\usepackage{multicol}', '\\begin{multicols}{2}x\\end{multicols}').safe,
    true
  );
});

test('verification tokens: containment is robust across scripts and line breaks', () => {
  const prov = verifyTokens('The quick brown fox 123 jumps');
  const canon = verifyTokens('THE QUICK\nbrown fox 123 jumps over the lazy dog');
  assert.equal(tokenContainment(prov, canon), 1);
  const jp = verifyTokens('組版エンジンの検証パス');
  assert.ok(jp.length >= 5, 'CJK bigrams extracted');
  assert.ok(tokenContainment(jp, verifyTokens('これは組版エンジンの検証パスです')) === 1);
  assert.ok(tokenContainment(verifyTokens('completely different words'), canon) < 0.5);
});

// ---------------------------------------------------- canonical renderer

const DOC1 = [
  '\\documentclass{article}',
  '\\begin{document}',
  'Page one canonical test.',
  '\\newpage',
  'Page two.',
  '\\end{document}',
  '',
].join('\n');

test('canonical renderer compiles, counts pages, serves lazy page SVGs', opts, async () => {
  rmSync(WORK, { recursive: true, force: true });
  const c = new CanonicalRenderer({ workDir: WORK, debounceMs: 0 });
  try {
    const res = await c.ensure(DOC1, 1);
    assert.equal(res.pageCount, 2);
    assert.ok(res.paper && res.paper.w > 400, 'paper size parsed from MediaBox');
    const svg = await c.pageSVG(1);
    assert.ok(svg && svg.includes('<svg'), 'page 1 converts to SVG');
    assert.equal(await c.pageSVG(3), null, 'out-of-range page refused');
    assert.equal(await c.pageSVG(1, 9999), null, 'stale compile id refused');
    const texts = await c.pageTexts();
    if (texts) assert.match(texts[0], /canonical test/);

    // latest-wins scheduling: two revisions in quick succession converge
    // on the newest source
    c.schedule(DOC1.replace('Page one', 'Page ONEEDITED'), 2);
    c.schedule(DOC1.replace('Page one', 'Page ONEFINAL'), 3);
    await c.settle();
    assert.equal(c.info().rev, 3);
    const t2 = await c.pageTexts();
    if (t2) assert.match(t2[0], /ONEFINAL/);

    // a broken source keeps the last good compile and reports the error
    c.schedule('\\documentclass{article}\\begin{document}\\errmessage{boom}\\end{document}', 4);
    await c.settle();
    assert.ok(c.info().error, 'TeX error reported');
    assert.equal(c.info().rev, 3, 'last good compile retained');
  } finally {
    c.dispose();
  }
});

// ------------------------------------------------- engine opaque fallback

test('unsafe preamble demotes to opaque and still renders via canonical', opts, async () => {
  const eng = new CheckpointEngine({ workDir: WORK + '-opq' });
  try {
    const r = await eng.open(
      [
        '\\documentclass{article}',
        '\\usepackage{eso-pic}',
        '\\begin{document}',
        'Opaque mode document body.',
        '\\end{document}',
        '',
      ].join('\n')
    );
    assert.equal(r.mode, 'opaque');
    assert.ok(r.modeReasons.some((x) => x.includes('eso-pic')), 'reason names the package');
    assert.equal(eng.getDisplayLists().length, 0, 'no provisional pages in opaque mode');
    await eng.canonical.settle();
    const info = eng.canonical.info();
    assert.equal(info.error, null);
    assert.equal(info.pageCount, 1);
    assert.equal(info.rev, eng.srcRev, 'canonical caught up with the source');
    const svg = await eng.canonical.pageSVG(1);
    assert.ok(svg && svg.includes('<svg'), 'exact page served');
  } finally {
    await eng.close();
  }
});

test('a broken preamble is not fatal: open resolves in opaque mode', opts, async () => {
  const eng = new CheckpointEngine({ workDir: WORK + '-broken' });
  try {
    const r = await eng.open(
      '\\documentclass{article}\n\\usepackage{package-that-does-not-exist-xyz}\n\\begin{document}\nhi\n\\end{document}\n'
    );
    assert.equal(r.mode, 'opaque');
    assert.ok(r.modeReasons.length >= 1);
    await eng.canonical.settle();
    assert.ok(eng.canonical.info().error, 'the real TeX error is surfaced');

    // fixing the preamble promotes back to structured
    const src = eng.getSource();
    const bad = '\\usepackage{package-that-does-not-exist-xyz}\n';
    const i = src.indexOf(bad);
    const r2 = await eng.edit(i, i + bad.length, '');
    assert.equal(r2.mode, 'structured', 'recovered after the fix');
    assert.ok(r2.stats.pageCount >= 1);
  } finally {
    await eng.close();
  }
});

// ------------------------------------------------- structured convergence

test('\\includepdf stays structured: the block rescues, the document does not demote', opts, async () => {
  const work = WORK + '-incpdf';
  rmSync(work, { recursive: true, force: true });
  mkdirSync(work, { recursive: true });
  // build a one-page pdf to include
  writeFileSync(
    path.join(work, 'inc.tex'),
    '\\documentclass{article}\\begin{document}FOREIGN PAGE\\end{document}\n'
  );
  await promisify(execFile)('lualatex', ['-interaction=nonstopmode', 'inc.tex'], {
    cwd: work,
    timeout: 120_000,
  });
  assert.ok(existsSync(path.join(work, 'inc.pdf')), 'fixture pdf built');
  const eng = new CheckpointEngine({ workDir: work, docDir: work });
  try {
    const r = await eng.open(
      [
        '\\documentclass{article}',
        '\\usepackage{pdfpages}',
        '\\begin{document}',
        '',
        'Text before the foreign pages.',
        '',
        '\\includepdf[pages=1]{inc.pdf}',
        '',
        'Text after the foreign pages.',
        '',
        '\\end{document}',
        '',
      ].join('\n')
    );
    assert.equal(r.mode, 'structured', `stays structured (${r.modeReasons?.join('; ')})`);
    // first-ever rescues land through the async pump (placeholder at open)
    await drain(eng);
    const blk = eng.blocks.find((b) => /includepdf/.test(b.text));
    assert.ok(blk?.rescued, 'the \\includepdf block took the exact-render rescue');
    assert.ok(eng.pages.length >= 2, `foreign page paginates (got ${eng.pages.length})`);
  } finally {
    await eng.close();
  }
});

test('structured docs converge: canonical matches the current source after edits', opts, async () => {
  const eng = new CheckpointEngine({ workDir: WORK + '-conv' });
  try {
    const r = await eng.open(
      [
        '\\documentclass{article}',
        '\\begin{document}',
        '',
        'Structured convergence test one.',
        '',
        'Structured paragraph two with \\emph{emphasis}.',
        '',
        '\\end{document}',
        '',
      ].join('\n')
    );
    assert.equal(r.mode, 'structured');
    assert.ok(r.stats.pageCount >= 1);
    await eng.canonical.settle();
    assert.equal(eng.canonical.info().rev, eng.srcRev);

    const idx = eng.getSource().indexOf('one');
    const r2 = await eng.edit(idx, idx + 3, 'ONEDITED');
    assert.equal(r2.mode, 'structured');
    assert.ok(r2.canonical, 'report carries canonical state');
    await eng.canonical.settle();
    const info = eng.canonical.info();
    assert.equal(info.rev, eng.srcRev, 'canonical converged to the edited source');
    assert.equal(info.error, null);
    const texts = await eng.canonical.pageTexts();
    if (texts) assert.match(texts[0], /ONEDITED/);

    // export = the canonical bytes (cached, source unchanged)
    const pdf = await eng.exportPDF();
    assert.equal(pdf.subarray(0, 5).toString('latin1'), '%PDF-');
  } finally {
    await eng.close();
  }
});

// ---------------------------------------------- incremental pagination

test('incremental pagination matches a from-scratch build after edits', opts, async () => {
  const DEMO = (await import('node:fs')).readFileSync(
    new URL('../samples/demo-lua.tex', import.meta.url), 'utf8');
  const eng = new CheckpointEngine({ workDir: WORK + '-incr' });
  const pageSig = (e) =>
    e.pages.map((p) =>
      (p.draw ?? [])
        .map((d) => `${d.y.toFixed(1)}:${(d.u.h ?? 0).toFixed(1)}:${(d.u.d ?? 0).toFixed(1)}`)
        .join('|')
    );
  try {
    await eng.open(DEMO);
    // a sequence of shape-changing edits: grow a paragraph, add an
    // equation (renumbers downstream), then delete the insertion
    const i1 = eng.getSource().indexOf('Edit any word');
    await eng.edit(i1, i1, 'Extra sentence to change line breaking and page fill. ');
    const i2 = eng.getSource().indexOf('\\begin{equation}');
    await eng.edit(i2, i2, '\\begin{equation}q^2=2\\end{equation}\n\n');
    const src2 = eng.getSource();
    const ins = '\\begin{equation}q^2=2\\end{equation}\n\n';
    const i3 = src2.indexOf(ins);
    await eng.edit(i3, i3 + ins.length, '');
    const incremental = pageSig(eng);

    // a fresh engine on the SAME final source paginates from scratch
    const eng2 = new CheckpointEngine({ workDir: WORK + '-incr2' });
    try {
      await eng2.open(eng.getSource());
      const fresh = pageSig(eng2);
      assert.equal(incremental.length, fresh.length, 'page counts match');
      for (let n = 0; n < fresh.length; n++) {
        assert.equal(incremental[n], fresh[n], `page ${n + 1} layout matches`);
      }
    } finally {
      await eng2.close();
    }
  } finally {
    await eng.close();
  }
});
