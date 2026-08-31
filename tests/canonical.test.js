// Canonical layer + safety gate — the two absolute conditions:
//   1. the final display converges to real LuaLaTeX output;
//   2. unknown/unsafe structure demotes to opaque instead of breaking.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  rmSync,
  mkdirSync,
  writeFileSync,
  existsSync,
  realpathSync,
  symlinkSync,
} from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  CanonicalRenderer,
  parseSynctexEditOutput,
  parseSynctexViewOutput,
  parsePdfTextBoxes,
  parsePdfPageGeometries,
  parsePdfGlobalContentTransform,
  syncTeXPointToDisplayed,
  displayedPointToSyncTeX,
  syncTeXBoxToDisplayed,
  pageTextBoxesShowCounterRotation,
} from '../engine/checkpoint/canonical.js';
import { CheckpointEngine } from '../engine/checkpoint/engine-v3.js';
import { canonicalGeometryMismatchReasons } from '../engine/checkpoint/canonical-arrival.js';
import { classifyDocument, verifyTokens, tokenContainment } from '../engine/checkpoint/safety.js';
import { drain } from '../tools/harness.mjs';

const WORK = fileURLToPath(new URL('../.tdom-canon-test', import.meta.url));
const available = await promisify(execFile)('lualatex', ['--version'], { timeout: 15_000 }).then(
  () => true,
  () => false
);
const opts = available ? {} : { skip: 'lualatex not installed' };
const coordinateToolsAvailable = available && await Promise.all(['pdftops', 'pdftotext', 'pdfinfo', 'synctex'].map((cmd) =>
  promisify(execFile)(cmd, ['-v'], { timeout: 15_000 }).then(() => true, () => false)
)).then((results) => results.every(Boolean));
const coordinateOpts = coordinateToolsAvailable ? {} : { skip: 'LuaLaTeX/Poppler/SyncTeX tools not installed' };

test('SyncTeX reverse output keeps the first valid source result', () => {
  const result = parseSynctexEditOutput([
    'SyncTeX result begin',
    'Input:sections/intro.tex',
    'Line:14',
    'Column:3',
    'Input:main.tex',
    'Line:8',
    'Column:1',
  ].join('\n'), '/paper');
  assert.deepEqual(result, { file: '/paper/sections/intro.tex', line: 14, column: 3 });
});

test('SyncTeX forward output exposes an exact source anchor and line box', () => {
  const result = parseSynctexViewOutput([
    'SyncTeX result begin',
    'Page:2',
    'x:318.25',
    'y:144.5',
    'h:310',
    'v:147',
    'W:225',
    'H:10',
    'SyncTeX result end',
  ].join('\n'));
  assert.deepEqual(result, {
    page: 2,
    x: 318.25,
    y: 144.5,
    box: { left: 310, top: 137, right: 535, bottom: 149.5 },
  });
});

test('canonical PDF word boxes retain text and exact page coordinates', () => {
  const pages = parsePdfTextBoxes('<page width="612" height="792"><word xMin="10" yMin="20" xMax="30" yMax="40">A&amp;B</word></page>');
  assert.deepEqual(pages, [[{ text: 'A&B', left: 10, top: 20, right: 30, bottom: 40 }]]);
});

test('canonical PDF geometry is per-page and follows displayed rotation', () => {
  const papers = parsePdfPageGeometries([
    'Pages:           4',
    'Page    1 size:  612 x 792 pts (letter)',
    'Page    1 rot:   0',
    'Page    2 size:  420 x 600 pts',
    'Page    2 rot:   0',
    'Page    3 size:  420 x 600 pts',
    'Page    3 rot:   90',
    'Page    4 size:  700 x 400 pts',
    'Page    4 rot:   -90',
  ].join('\n'), 4);
  assert.deepEqual(papers, [
    { w: 612, h: 792, rotation: 0 },
    { w: 420, h: 600, rotation: 0 },
    { w: 600, h: 420, rotation: 90 },
    { w: 400, h: 700, rotation: 270 },
  ]);
});

test('SyncTeX points and boxes round-trip through every PDF page rotation', () => {
  const cases = [
    {
      paper: { w: 300, h: 400, rotation: 0 },
      expected: [{ x: 0, y: 0 }, { x: 300, y: 0 }, { x: 0, y: 400 }, { x: 300, y: 400 }],
    },
    {
      paper: { w: 400, h: 300, rotation: 90 },
      expected: [{ x: 400, y: 0 }, { x: 400, y: 300 }, { x: 0, y: 0 }, { x: 0, y: 300 }],
    },
    {
      paper: { w: 300, h: 400, rotation: 180 },
      expected: [{ x: 300, y: 400 }, { x: 0, y: 400 }, { x: 300, y: 0 }, { x: 0, y: 0 }],
    },
    {
      paper: { w: 400, h: 300, rotation: 270 },
      expected: [{ x: 0, y: 300 }, { x: 0, y: 0 }, { x: 400, y: 300 }, { x: 400, y: 0 }],
    },
  ];
  const nativeCorners = [{ x: 0, y: 0 }, { x: 300, y: 0 }, { x: 0, y: 400 }, { x: 300, y: 400 }];
  for (const { paper, expected } of cases) {
    const displayed = nativeCorners.map((point) => syncTeXPointToDisplayed(point, paper));
    assert.deepEqual(displayed, expected, `rotation ${paper.rotation} maps all four corners`);
    assert.deepEqual(
      displayed.map((point) => displayedPointToSyncTeX(point, paper)),
      nativeCorners,
      `rotation ${paper.rotation} is exactly invertible`
    );
  }
  assert.deepEqual(
    syncTeXBoxToDisplayed({ left: 10, top: 20, right: 40, bottom: 60 }, cases[1].paper),
    { left: 340, top: 10, right: 380, bottom: 40 }
  );
});

test('pdflscape page-wide content matrix is composed before page rotation', () => {
  const postscript = [
    '%%Page: 1 1',
    '%%BeginPageSetup',
    '400 300 pdfSetupPaper',
    '270 rotate',
    '-300 0 translate',
    '%%EndPageSetup',
    'q',
    '[1 0 0 1 280 20] cm',
    'q',
    '[0 1 -1 0 0 0] cm',
    '[1 0 0 1 -280 -20] cm',
    '[1 0 0 1 294.944 265] Tm',
    '(TOPLEFT) Tj',
    '[1 0 0 1 594.944 30] Tm',
    '(BOTTOMRIGHT) Tj',
    'Q',
    'Q',
    // LaTeX commonly paints the folio after pdflscape restores the page
    // graphics state. It must not erase the dominant body transform.
    '(1) Tj',
    'showpage',
  ].join('\n');
  const matrix = parsePdfGlobalContentTransform(postscript);
  assert.deepEqual(matrix, [0, 1, -1, 0, 300, -260]);
  const paper = { w: 400, h: 300, rotation: 90 };
  const displayed = syncTeXPointToDisplayed({ x: 294.944, y: 135 }, paper, matrix);
  assert.ok(Math.abs(displayed.x - 34.944) < 1e-9);
  assert.ok(Math.abs(displayed.y - 35) < 1e-9);
  const roundTrip = displayedPointToSyncTeX(displayed, paper, matrix);
  assert.ok(Math.abs(roundTrip.x - 294.944) < 1e-9);
  assert.ok(Math.abs(roundTrip.y - 135) < 1e-9);
});

test('upright words diagnose a missing pdflscape transform without rejecting bare rotation', () => {
  const paper = { w: 400, h: 300, rotation: 90 };
  const upright = Array.from({ length: 4 }, (_, index) => ({
    left: index * 80,
    right: index * 80 + 60,
    top: 20,
    bottom: 32,
  }));
  const bareRotate = Array.from({ length: 4 }, (_, index) => ({
    left: 20,
    right: 32,
    top: index * 60,
    bottom: index * 60 + 45,
  }));
  assert.equal(pageTextBoxesShowCounterRotation(upright, paper), true);
  assert.equal(pageTextBoxesShowCounterRotation(bareRotate, paper), false);
  assert.equal(pageTextBoxesShowCounterRotation(upright.slice(0, 2), paper), false, 'sparse pages stay fallback-safe');
});

// -------------------------------------------- demand-paced authority cadence

test('canonical work paths use the filesystem-native spelling for SyncTeX', () => {
  const actual = WORK + '-realpath';
  const alias = WORK + '-realpath-alias';
  rmSync(actual, { recursive: true, force: true });
  rmSync(alias, { recursive: true, force: true });
  mkdirSync(actual, { recursive: true });
  symlinkSync(actual, alias, 'dir');
  const c = new CanonicalRenderer({ workDir: alias });
  try {
    assert.equal(c.workDir, realpathSync.native(actual),
      'the path queried through SyncTeX exactly matches the spelling recorded by lualatex');
  } finally {
    c.dispose();
    rmSync(alias, { force: true });
    rmSync(actual, { recursive: true, force: true });
  }
});

test('authority pressure: fast baseline, then deep idle + cost cooldown', () => {
  const c = new CanonicalRenderer({ workDir: WORK + '-pace' });
  try {
    // no compile yet: base debounce only (fast first exactness)
    assert.equal(c.delayFor(), c.debounceMs);
    // an 8s compile just finished: the next one waits at least factor× its
    // cost AND the writing-idle gate — active writing never pays a compile
    c.last = { ms: 8000 };
    c.lastEndAt = Date.now();
    assert.ok(
      c.delayFor() >= 8000 * c.cooldownFactor - 100,
      `cooldown scales with compile cost (got ${c.delayFor()})`
    );
    assert.ok(c.delayFor() >= c.idleMs, 'never below the writing-idle gate');
    // the cooldown is capped (a pathological compile must still refresh
    // eventually) — but the cap is far above real compile times so it can
    // no longer break the duty-cycle bound the way the old 30s cap did
    c.last = { ms: 600_000 };
    assert.ok(c.delayFor() <= c.cooldownCapMs, 'cooldown capped');
    assert.ok(c.cooldownCapMs >= 8 * 60_000 || process.env.TDOM_CANON_COOLDOWN_CAP, 'cap far above real compiles');
    // once the cooldown has elapsed, the writing-idle gate remains: a
    // recompile happens only after the user has actually stopped writing
    c.last = { ms: 8000 };
    c.lastEndAt = Date.now() - 8000 * c.cooldownFactor - 1000;
    assert.equal(c.delayFor(), c.idleMs);
    // opaque mode: the compile IS the display — short debounce once the
    // half-duty cooldown has passed…
    c.pressure = 'display';
    assert.equal(c.delayFor(), c.displayDebounceMs);
    // …but a compile that just ended paces the next by its own cost, so a
    // long document cannot recompile back-to-back while the user types
    c.lastEndAt = Date.now();
    c.last = { ms: 8000 };
    assert.ok(
      c.delayFor() >= 8000 * c.displayCooldownFactor - 100,
      `display pacing scales with compile cost (got ${c.delayFor()})`
    );
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
  const twoColumn = classifyDocument('\\documentclass[a4paper,twocolumn]{article}', 'body');
  assert.equal(twoColumn.safe, true);
  assert.equal(twoColumn.previewPolicy, 'canonical-anchor');
  const switchedColumns = classifyDocument(
    '\\documentclass{article}',
    '\\onecolumn Title copy.\\twocolumn Body copy.'
  );
  assert.equal(switchedColumns.safe, true);
  assert.equal(switchedColumns.previewPolicy, 'canonical-anchor');
  assert.deepEqual(switchedColumns.previewReasons, ['body column switch']);
  assert.equal(classifyDocument('\\documentclass[landscape]{article}', '').safe, false);
  assert.equal(classifyDocument('\\documentclass{article}\\AtBeginShipout{x}', '').safe, false);
  assert.equal(classifyDocument('\\documentclass{article}\\usepackage{pdflscape}', 'body').safe, false);
  assert.equal(classifyDocument('\\documentclass{article}', '\\pagewidth=420pt body').safe, false);
  assert.equal(classifyDocument('\\documentclass{article}', '\\pdfvariable pageattr{/Rotate 90} body').safe, false);
  assert.equal(classifyDocument('\\documentclass{article}', '\\begin{landscape}body\\end{landscape}').safe, false);
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

test('canonical geometry gate rejects any non-single viewport proof', () => {
  const geometry = { paperwidth: 612, paperheight: 792 };
  assert.deepEqual(canonicalGeometryMismatchReasons(geometry, {
    pageCount: 2,
    papers: [{ w: 612.1, h: 791.9, rotation: 0 }, { w: 612, h: 792, rotation: 0 }],
  }), []);
  assert.match(canonicalGeometryMismatchReasons(geometry, {
    pageCount: 2,
    papers: [{ w: 612, h: 792, rotation: 0 }, { w: 420, h: 600, rotation: 0 }],
  })[0], /page 2 is 420\.000x600\.000pt/);
  assert.match(canonicalGeometryMismatchReasons(geometry, {
    pageCount: 1,
    papers: [{ w: 792, h: 612, rotation: 90 }],
  })[0], /\/Rotate 90/);
  assert.match(canonicalGeometryMismatchReasons(geometry, {
    pageCount: 2,
    papers: [{ w: 612, h: 792, rotation: 0 }],
  })[0], /geometry is incomplete/);
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

const MIXED_PAPER_DOC = [
  '\\documentclass{article}',
  '\\usepackage{pdflscape}',
  '\\begin{document}',
  'Default portrait page.',
  '\\newpage',
  '\\pagewidth=420pt',
  '\\pageheight=600pt',
  'Small portrait page.',
  '\\begin{landscape}',
  'The same small page, rotated for display.',
  '\\end{landscape}',
  '\\pagewidth=700pt',
  '\\pageheight=400pt',
  'Wide physical page.',
  '\\end{document}',
  '',
].join('\n');

const OPAQUE_MIXED_COORD_DOC = [
  '\\documentclass{article}',
  '\\pagestyle{empty}',
  '\\begin{document}',
  'Default editable target.',
  '\\newpage',
  '\\pagewidth=420pt',
  '\\pageheight=600pt',
  'Small editable target.',
  '\\newpage',
  '\\pdfvariable pageattr{/Rotate 90}',
  'Rotated editable target.',
  '\\end{document}',
  '',
].join('\n');

const INDIRECT_MIXED_COORD_DOC = [
  '\\documentclass{article}',
  '\\pagestyle{empty}',
  '\\begin{document}',
  'Default indirect target.',
  '\\newpage',
  '\\csname pagewidth\\endcsname=420pt',
  '\\csname pageheight\\endcsname=600pt',
  'Small indirect target.',
  '\\end{document}',
  '',
].join('\n');

const INDIRECT_ROTATED_COORD_DOC = [
  '\\documentclass{article}',
  '\\pagestyle{empty}',
  '\\begin{document}',
  'Default indirect target.',
  '\\newpage',
  '\\csname pdfvariable\\endcsname pageattr{/Rotate 90}',
  'Rotated indirect target.',
  '\\end{document}',
  '',
].join('\n');

const ROTATED_SYNC_DOC = [
  '\\documentclass{article}',
  '\\usepackage[paperwidth=300bp,paperheight=400bp,margin=0bp]{geometry}',
  '\\pagestyle{empty}',
  '\\setlength{\\unitlength}{1bp}',
  '\\begin{document}',
  '\\pdfvariable pageattr{/Rotate 0}',
  '\\begin{picture}(300,400)',
  '\\put(10,380){\\mbox{P0-TL}}',
  '\\put(210,380){\\mbox{P0-TR}}',
  '\\put(10,20){\\mbox{P0-BL}}',
  '\\put(210,20){\\mbox{P0-BR}}',
  '\\end{picture}\\newpage',
  '\\pdfvariable pageattr{/Rotate 90}',
  '\\begin{picture}(300,400)',
  '\\put(10,380){\\mbox{P90-TL}}',
  '\\put(210,380){\\mbox{P90-TR}}',
  '\\put(10,20){\\mbox{P90-BL}}',
  '\\put(210,20){\\mbox{P90-BR}}',
  '\\end{picture}\\newpage',
  '\\pdfvariable pageattr{/Rotate 180}',
  '\\begin{picture}(300,400)',
  '\\put(10,380){\\mbox{P180-TL}}',
  '\\put(210,380){\\mbox{P180-TR}}',
  '\\put(10,20){\\mbox{P180-BL}}',
  '\\put(210,20){\\mbox{P180-BR}}',
  '\\end{picture}\\newpage',
  '\\pdfvariable pageattr{/Rotate 270}',
  '\\begin{picture}(300,400)',
  '\\put(10,380){\\mbox{P270-TL}}',
  '\\put(210,380){\\mbox{P270-TR}}',
  '\\put(10,20){\\mbox{P270-BL}}',
  '\\put(210,20){\\mbox{P270-BR}}',
  '\\end{picture}',
  '\\end{document}',
  '',
].join('\n');

const PDFLSCAPE_SYNC_DOC = [
  '\\documentclass{article}',
  '\\usepackage[paperwidth=300bp,paperheight=400bp,margin=20bp]{geometry}',
  '\\usepackage{pdflscape}',
  '\\pagestyle{empty}',
  '\\setlength{\\unitlength}{1bp}',
  '\\begin{document}',
  '\\begin{landscape}',
  '\\begin{picture}(360,260)',
  '\\put(0,245){\\mbox{LS-TL}}',
  '\\put(300,245){\\mbox{LS-TR}}',
  '\\put(0,10){\\mbox{LS-BL}}',
  '\\put(300,10){\\mbox{LS-BR}}',
  '\\end{picture}',
  '\\end{landscape}',
  '\\end{document}',
  '',
].join('\n');
const PDFLSCAPE_FOLIO_SYNC_DOC = PDFLSCAPE_SYNC_DOC.replace('\\pagestyle{empty}\n', '');

async function assertDisplayedWordClicks(canonicalRenderer, generation, source, markerPattern) {
  const pages = await canonicalRenderer.pageTextBoxes(generation.id);
  assert.ok(pages, 'pdftotext word boxes available');
  const sourceLines = source.split('\n');
  let checked = 0;
  for (let pageIndex = 0; pageIndex < pages.length; pageIndex++) {
    for (const word of pages[pageIndex]) {
      if (!markerPattern.test(word.text)) continue;
      markerPattern.lastIndex = 0;
      checked++;
      const expectedLine = sourceLines.findIndex((line) => line.includes(`{${word.text}}`)) + 1;
      assert.ok(expectedLine > 0, `source marker exists for ${word.text}`);
      const x = (word.left + word.right) / 2;
      const y = (word.top + word.bottom) / 2;
      const hit = await canonicalRenderer.reverseSync({ page: pageIndex + 1, x, y, id: generation.id });
      assert.equal(hit?.line, expectedLine, `${word.text} display-pixel click maps to its exact source line`);
      const anchors = await canonicalRenderer.forwardSyncAll({
        file: path.join(canonicalRenderer.workDir, 'canon.tex'),
        line: expectedLine,
        id: generation.id,
      });
      assert.ok(anchors.some((anchor) => anchor.page === pageIndex + 1 &&
        anchor.x >= word.left - 2 && anchor.x <= word.right + 2 &&
        anchor.y >= word.top - 6 && anchor.y <= word.bottom + 6),
      `${word.text} forward anchor is in displayed word coordinates`);
    }
  }
  return checked;
}

test('real /Rotate 0/90/180/270 pages synchronize displayed corner clicks', coordinateOpts, async () => {
  const work = WORK + '-rotated-sync';
  rmSync(work, { recursive: true, force: true });
  const c = new CanonicalRenderer({ workDir: work, debounceMs: 0 });
  try {
    const generation = await c.ensure(ROTATED_SYNC_DOC, 1);
    assert.deepEqual(generation.papers.map((paper) => paper.rotation), [0, 90, 180, 270]);
    assert.equal(await assertDisplayedWordClicks(c, generation, ROTATED_SYNC_DOC, /^P(?:0|90|180|270)-(?:TL|TR|BL|BR)$/), 16);
  } finally {
    c.dispose();
  }
});

test('real pdflscape content matrix keeps displayed corner clicks and anchors exact', coordinateOpts, async () => {
  const work = WORK + '-pdflscape-sync';
  rmSync(work, { recursive: true, force: true });
  const c = new CanonicalRenderer({ workDir: work, debounceMs: 0 });
  try {
    const generation = await c.ensure(PDFLSCAPE_SYNC_DOC, 1);
    assert.deepEqual(generation.papers.map((paper) => paper.rotation), [90]);
    assert.equal(await assertDisplayedWordClicks(c, generation, PDFLSCAPE_SYNC_DOC, /^LS-(?:TL|TR|BL|BR)$/), 4);
    const matrix = c.syncTransformCache.get(`${generation.id}:1`);
    assert.ok(Array.isArray(matrix) && Math.abs(matrix[1]) > 0.9 && Math.abs(matrix[2]) > 0.9,
      'pdflscape counter-rotation was recovered rather than treated as bare /Rotate');
  } finally {
    c.dispose();
  }
});

test('real pdflscape synchronization ignores a folio outside the body transform', coordinateOpts, async () => {
  const work = WORK + '-pdflscape-folio-sync';
  rmSync(work, { recursive: true, force: true });
  const c = new CanonicalRenderer({ workDir: work, debounceMs: 0 });
  try {
    const generation = await c.ensure(PDFLSCAPE_FOLIO_SYNC_DOC, 1);
    assert.deepEqual(generation.papers.map((paper) => paper.rotation), [90]);
    assert.equal(
      await assertDisplayedWordClicks(c, generation, PDFLSCAPE_FOLIO_SYNC_DOC, /^LS-(?:TL|TR|BL|BR)$/),
      4
    );
    const matrix = c.syncTransformCache.get(`${generation.id}:1`);
    assert.ok(Array.isArray(matrix) && Math.abs(matrix[1]) > 0.9 && Math.abs(matrix[2]) > 0.9);
    assert.deepEqual(generation.syncWarnings, []);
  } finally {
    c.dispose();
  }
});

test('canonical metadata preserves every mixed-size and landscape page geometry', opts, async () => {
  const work = WORK + '-papers';
  rmSync(work, { recursive: true, force: true });
  const c = new CanonicalRenderer({ workDir: work, debounceMs: 0 });
  try {
    const mixed = await c.ensure(MIXED_PAPER_DOC, 1);
    assert.equal(mixed.pageCount, 4);
    assert.equal(mixed.papers.length, mixed.pageCount);
    assert.ok(mixed.papers.every(Boolean), 'all PDF pages have geometry');
    const [defaultPage, smallPage, rotatedPage, widePage] = mixed.papers;
    assert.ok(defaultPage.w < defaultPage.h, 'default page is portrait');
    assert.ok(smallPage.w < smallPage.h, 'custom small page is portrait');
    assert.equal(smallPage.rotation, 0);
    assert.equal(rotatedPage.rotation, 90);
    assert.ok(Math.abs(rotatedPage.w - smallPage.h) < 0.01, 'rotated display width is native height');
    assert.ok(Math.abs(rotatedPage.h - smallPage.w) < 0.01, 'rotated display height is native width');
    assert.ok(widePage.w > widePage.h, 'final page keeps its distinct wide MediaBox');
    assert.ok(Math.abs(widePage.w - smallPage.w) > 200, 'physical page sizes remain distinct');
    assert.deepEqual(mixed.paper, { w: defaultPage.w, h: defaultPage.h }, 'legacy paper is page one');
    assert.deepEqual(c.info().paper, mixed.paper);
    assert.deepEqual(c.info().papers, mixed.papers);
    const rotatedSvg = await c.pageSVG(3, mixed.id);
    const svgSize = /\bwidth="([\d.]+)pt"\s+height="([\d.]+)pt"/.exec(rotatedSvg || '');
    assert.ok(svgSize, 'canonical landscape SVG exposes its viewport size');
    assert.ok(Math.abs(Number(svgSize[1]) - rotatedPage.w) < 0.01);
    assert.ok(Math.abs(Number(svgSize[2]) - rotatedPage.h) < 0.01);

    const next = await c.ensure(DOC1, 2);
    assert.notEqual(next.id, mixed.id);
    assert.deepEqual(c.generations.get(mixed.id)?.papers, mixed.papers, 'retained generation keeps its own geometry');
  } finally {
    c.dispose();
  }
});

test('canonical renderer compiles, counts pages, serves lazy page SVGs', opts, async () => {
  rmSync(WORK, { recursive: true, force: true });
  const c = new CanonicalRenderer({ workDir: WORK, debounceMs: 0 });
  try {
    const res = await c.ensure(DOC1, 1);
    const firstId = res.id;
    const firstPdf = res.pdf;
    const firstSynctex = res.synctex;
    assert.equal(res.pageCount, 2);
    assert.ok(res.paper && res.paper.w > 400, 'paper size parsed from MediaBox');
    const svg = await c.pageSVG(1);
    assert.ok(svg && svg.includes('<svg'), 'page 1 converts to SVG');
    assert.equal(await c.pageSVG(3), null, 'out-of-range page refused');
    assert.equal(await c.pageSVG(1, 9999), null, 'unknown compile id refused');
    const texts = await c.pageTexts();
    if (texts) assert.match(texts[0], /canonical test/);

    // Two viewers asking for the same uncached page share one pdftocairo
    // job. At the same time a new generation may compile; both old-page
    // requests must still finish against the PDF they were issued for.
    const oldPageA = c.pageSVG(2, firstId);
    const oldPageB = c.pageSVG(2, firstId);
    assert.equal(c.svgInFlight.size, 1, 'one conversion owns an id/page cache miss');

    // latest-wins scheduling: two revisions in quick succession converge
    // on the newest source while the old SVG conversion remains valid
    c.schedule(DOC1.replace('Page one', 'Page ONEEDITED'), 2);
    c.schedule(DOC1.replace('Page one', 'Page ONEFINAL'), 3);
    const [oldSvgA, oldSvgB] = await Promise.all([oldPageA, oldPageB, c.settle()]);
    assert.ok(oldSvgA.includes('<svg'));
    assert.equal(oldSvgA, oldSvgB, 'both viewers receive the same exact page');
    assert.equal(c.svgInFlight.size, 0, 'in-flight entry is removed after completion');
    assert.equal(c.info().rev, 3);
    const t2 = await c.pageTexts();
    if (t2) assert.match(t2[0], /ONEFINAL/);

    // The page that is still painted with generation 1 must resolve every
    // coordinate/text endpoint against generation 1, not generation 2.
    assert.ok(existsSync(firstPdf), 'previous PDF retained after next compile');
    if (firstSynctex) assert.ok(existsSync(firstSynctex), 'previous SyncTeX retained after next compile');
    assert.ok((await c.pageSVG(1, firstId))?.includes('<svg'), 'old page SVG remains addressable');
    const oldTexts = await c.pageTexts(firstId);
    if (oldTexts) {
      assert.match(oldTexts[0], /canonical test/);
      assert.doesNotMatch(oldTexts[0], /ONEFINAL/);
    }
    const oldBoxes = await c.pageTextBoxes(firstId);
    if (oldBoxes) assert.ok(oldBoxes[0].some((box) => /canonical/.test(box.text)));
    const oldForward = await c.forwardSyncAll({
      file: path.join(WORK, 'canon.tex'),
      line: 3,
      id: firstId,
    });
    assert.ok(oldForward.length >= 1, 'old generation forward SyncTeX resolves');
    const oldReverse = await c.reverseSync({
      page: oldForward[0].page,
      x: oldForward[0].x,
      y: oldForward[0].y,
      id: firstId,
    });
    assert.equal(oldReverse?.line, 3, 'old generation reverse SyncTeX resolves');

    // a broken source keeps the last good compile and reports the error
    c.schedule('\\documentclass{article}\\begin{document}\\errmessage{boom}\\end{document}', 4);
    await c.settle();
    assert.ok(c.info().error, 'TeX error reported');
    assert.equal(c.info().rev, 3, 'last good compile retained');

    // The history is bounded to latest + three predecessors. Advancing
    // beyond that window prunes generation 1 and all of its disk/cache data.
    for (let rev = 5; rev <= 7; rev++) {
      await c.ensure(DOC1.replace('canonical test', `generation ${rev}`), rev);
    }
    assert.equal(c.generations.size, 4, 'canonical generation history is bounded');
    assert.equal(await c.pageSVG(1, firstId), null, 'pruned SVG id is refused');
    assert.equal(await c.pageTexts(firstId), null, 'pruned text id is refused');
    assert.equal(await c.pageTextBoxes(firstId), null, 'pruned text-box id is refused');
    assert.deepEqual(await c.forwardSyncAll({ file: path.join(WORK, 'canon.tex'), line: 3, id: firstId }), []);
    assert.equal(await c.reverseSync({ page: 1, x: 100, y: 100, id: firstId }), null);
    assert.equal(existsSync(firstPdf), false, 'prune removes the retired PDF');
    if (firstSynctex) assert.equal(existsSync(firstSynctex), false, 'prune removes retired SyncTeX');

    const beforeReset = [...c.generations.values()].flatMap((generation) =>
      [generation.pdf, generation.synctex].filter(Boolean));
    await c.resetDocument(WORK);
    assert.equal(c.generations.size, 0);
    assert.equal(c.svgCache.size, 0);
    assert.equal(c.textCache.size, 0);
    assert.equal(c.textBoxCache.size, 0);
    assert.equal(c.syncTransformCache.size, 0);
    assert.equal(c.syncTransformInFlight.size, 0);
    assert.ok(beforeReset.every((file) => !existsSync(file)), 'reset removes every retained generation');

    const afterReset = await c.ensure(DOC1, 8);
    assert.ok(existsSync(afterReset.pdf));
    c.dispose();
    assert.equal(existsSync(afterReset.pdf), false, 'dispose removes the retained PDF');
    if (afterReset.synctex) assert.equal(existsSync(afterReset.synctex), false, 'dispose removes retained SyncTeX');
    assert.equal(c.generations.size, 0);
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
    assert.ok(
      eng.getDOM().blocks.some((block) =>
        block.editRegions?.some((region) => region.value === 'Opaque mode document body.')
      ),
      'canonical-only pages retain direct-edit source regions'
    );
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

test('mixed page size and rotation use the exact direct-edit coordinate path', opts, async () => {
  const work = WORK + '-mixed-coordinate-opaque';
  rmSync(work, { recursive: true, force: true });
  const eng = new CheckpointEngine({ workDir: work });
  try {
    const report = await eng.open(OPAQUE_MIXED_COORD_DOC);
    assert.equal(report.mode, 'opaque');
    assert.ok(report.modeReasons.some((reason) => reason.includes('paper size')));
    assert.equal(eng.getDisplayLists().length, 0, 'no single-geometry provisional hit map is exposed');
    const regions = eng.getDOM().blocks.flatMap((block) => block.editRegions ?? []);
    assert.ok(regions.some((region) => region.value.includes('Small editable target.')));
    assert.ok(regions.some((region) => region.value.includes('Rotated editable target.')));

    await eng.canonical.settle();
    const generation = eng.canonical.last;
    assert.equal(generation.pageCount, 3);
    assert.ok(generation.papers[1].w < generation.papers[0].w, 'second page keeps its smaller MediaBox');
    assert.equal(generation.papers[2].rotation, 90, 'third page keeps its displayed rotation');
    const pages = await eng.canonical.pageTextBoxes(generation.id);
    for (const [pageIndex, label] of [[1, 'Small'], [2, 'Rotated']]) {
      const word = pages[pageIndex].find((item) => item.text === label);
      assert.ok(word, `${label} has a displayed canonical word box`);
      const hit = await eng.canonical.reverseSync({
        page: pageIndex + 1,
        x: (word.left + word.right) / 2,
        y: (word.top + word.bottom) / 2,
        id: generation.id,
      });
      assert.ok(hit, `${label} plain-click point reverse maps through the pinned generation`);
      assert.equal(OPAQUE_MIXED_COORD_DOC.split('\n')[hit.line - 1], `${label} editable target.`);
    }
  } finally {
    await eng.close();
  }
});

test('canonical arrival dynamically demotes indirect mixed geometry missed by source scanning', opts, async () => {
  const bounds = /\\begin\{document\}/.exec(INDIRECT_MIXED_COORD_DOC).index;
  assert.equal(
    classifyDocument(INDIRECT_MIXED_COORD_DOC.slice(0, bounds), INDIRECT_MIXED_COORD_DOC.slice(bounds)).safe,
    true,
    'fixture deliberately evades the static primitive spelling gate'
  );
  const work = WORK + '-mixed-coordinate-dynamic';
  rmSync(work, { recursive: true, force: true });
  const eng = new CheckpointEngine({ workDir: work });
  const arrivals = [];
  try {
    const report = await eng.open(INDIRECT_MIXED_COORD_DOC);
    assert.equal(report.mode, 'structured', 'resident renderer starts before exact geometry is known');
    eng.onCanonical = (info) => arrivals.push({ info, mode: eng.mode });
    await eng.canonical.settle();
    assert.equal(eng.mode, 'opaque');
    assert.equal(eng.getDisplayLists().length, 0, 'mismatched provisional pages are removed');
    assert.ok(eng.modeReasons.some((reason) => /page 2 is/.test(reason)));
    assert.equal(arrivals.at(-1)?.mode, 'opaque', 'client is notified only after the fail-closed mode switch');
    assert.deepEqual(arrivals.at(-1)?.info.modeReasons, eng.modeReasons);
  } finally {
    await eng.close();
  }
});

test('canonical arrival dynamically demotes indirect page rotation missed by source scanning', opts, async () => {
  const bounds = /\\begin\{document\}/.exec(INDIRECT_ROTATED_COORD_DOC).index;
  assert.equal(
    classifyDocument(INDIRECT_ROTATED_COORD_DOC.slice(0, bounds), INDIRECT_ROTATED_COORD_DOC.slice(bounds)).safe,
    true,
    'fixture deliberately evades the static primitive spelling gate'
  );
  const work = WORK + '-rotated-coordinate-dynamic';
  rmSync(work, { recursive: true, force: true });
  const eng = new CheckpointEngine({ workDir: work });
  const arrivals = [];
  try {
    const report = await eng.open(INDIRECT_ROTATED_COORD_DOC);
    assert.equal(report.mode, 'structured', 'resident renderer starts before exact rotation is known');
    eng.onCanonical = (info) => arrivals.push({ info, mode: eng.mode });
    await eng.canonical.settle();
    assert.equal(eng.mode, 'opaque');
    assert.equal(eng.getDisplayLists().length, 0, 'rotated provisional pages are removed');
    assert.ok(eng.modeReasons.some((reason) => /page 2 has \/Rotate 90/.test(reason)));
    assert.equal(arrivals.at(-1)?.mode, 'opaque', 'client is notified only after the fail-closed mode switch');
    assert.deepEqual(arrivals.at(-1)?.info.modeReasons, eng.modeReasons);
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
    assert.equal(eng.mode, 'structured', 'plain article keeps the live structured renderer');
    const initialPaper = eng.canonical.info().papers[0];
    assert.ok(Math.abs(eng.geometry.paperwidth - initialPaper.w) < 0.5,
      `LuaTeX page width ${eng.geometry.paperwidth} matches canonical ${initialPaper.w}`);
    assert.ok(Math.abs(eng.geometry.paperheight - initialPaper.h) < 0.5,
      `LuaTeX page height ${eng.geometry.paperheight} matches canonical ${initialPaper.h}`);

    const idx = eng.getSource().indexOf('one');
    const r2 = await eng.edit(idx, idx + 3, 'ONEDITED');
    assert.equal(r2.mode, 'structured');
    assert.ok(r2.canonical, 'report carries canonical state');
    await eng.canonical.settle();
    const info = eng.canonical.info();
    assert.equal(info.rev, eng.srcRev, 'canonical converged to the edited source');
    assert.equal(info.error, null);
    assert.equal(eng.mode, 'structured');
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
