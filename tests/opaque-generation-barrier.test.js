import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

await import('../web/opaque-editor-coordinator.js');

const Coordinator = globalThis.TdomOpaqueEditorCoordinator;
const APP = readFileSync(fileURLToPath(new URL('../web/app.js', import.meta.url)), 'utf8');
const INDEX = readFileSync(fileURLToPath(new URL('../web/index.html', import.meta.url)), 'utf8');
const SERVER = readFileSync(fileURLToPath(new URL('../server.js', import.meta.url)), 'utf8');
const STYLE = readFileSync(fileURLToPath(new URL('../web/style.css', import.meta.url)), 'utf8');

const targetSrc = '/canonical/2.svg?c=42';
const base = {
  pageNumber: 2,
  pageConnected: true,
  targetSrc,
  generationId: 42,
  generationRev: 9,
};

test('an active editor target on an older page generation must be staged', () => {
  assert.deepEqual(Coordinator.planGenerationBarrier({
    ...base,
    presentedSrc: '/canonical/2.svg?c=41',
    presentedId: 41,
    presentedRev: 8,
  }), { action: 'stage', pageNumber: 2, targetSrc });

  // A reused canonical URL is not sufficient: the source revision is part
  // of the immutable mapping generation and must be promoted in the batch.
  assert.deepEqual(Coordinator.planGenerationBarrier({
    ...base,
    presentedSrc: targetSrc,
    presentedId: 42,
    presentedRev: 8,
  }), { action: 'stage', pageNumber: 2, targetSrc });
});

test('the editor target waits for decode and becomes ready only with its batch page', () => {
  assert.deepEqual(Coordinator.planGenerationBarrier({
    ...base,
    expectedSrc: targetSrc,
    expectedReady: false,
  }), { action: 'wait', pageNumber: 2, targetSrc });

  assert.deepEqual(Coordinator.planGenerationBarrier({
    ...base,
    expectedSrc: targetSrc,
    expectedReady: true,
  }), { action: 'ready', pageNumber: 2, targetSrc });

  assert.deepEqual(Coordinator.planGenerationBarrier({
    ...base,
    wantedSrc: targetSrc,
    presentedSrc: targetSrc,
    presentedId: 42,
    presentedRev: 9,
  }), { action: 'register', pageNumber: 2, targetSrc });
});

test('a missing target page closes the transient editor instead of reparenting it', () => {
  assert.deepEqual(Coordinator.planGenerationBarrier({ ...base, pageConnected: false }), { action: 'close' });
  assert.deepEqual(Coordinator.planGenerationBarrier({ ...base, pageNumber: NaN }), { action: 'close' });
});

test('two-dimensional duplicate math tokens map by canonical reading order', () => {
  const numerator = { text: 'x', left: 10, top: 10, right: 14, bottom: 16 };
  const denominator = { text: 'x', left: 10, top: 28, right: 14, bottom: 34 };
  const bounds = { left: 8, top: 8, right: 16, bottom: 36 };
  assert.equal(Coordinator.mathSourceOffset({
    value: String.raw`\frac{x}{x}`,
    clickedWord: numerator,
    words: [numerator, denominator],
    bounds,
    point: { x: 11, y: 12 },
  }), 6, 'left half of the numerator maps before the first source x');
  assert.equal(Coordinator.mathSourceOffset({
    value: String.raw`\frac{x}{x}`,
    clickedWord: denominator,
    words: [numerator, denominator],
    bounds,
    point: { x: 13, y: 31 },
  }), 10, 'right half of the denominator maps after the second source x');

  const row1 = { text: 'x', left: 10, top: 10, right: 14, bottom: 16 };
  const row2 = { text: 'x', left: 10, top: 28, right: 14, bottom: 34 };
  assert.equal(Coordinator.mathSourceOffset({
    value: String.raw`x&y\\x&y`,
    clickedWord: row2,
    // pdftotext -bbox-layout commonly emits a matrix column-by-column.
    words: [row1, row2, { text: 'y', left: 20, top: 10, right: 24, bottom: 16 }],
    bounds: { left: 8, top: 8, right: 26, bottom: 36 },
    point: { x: 13, y: 31 },
  }), 6, 'the second matrix row maps to the second source occurrence');

  const topLeft = { text: 'x', left: 10, top: 10, right: 14, bottom: 16 };
  const bottomLeft = { text: 'x', left: 10, top: 28, right: 14, bottom: 34 };
  const topRight = { text: 'x', left: 20, top: 10, right: 24, bottom: 16 };
  const bottomRight = { text: 'x', left: 20, top: 28, right: 24, bottom: 34 };
  assert.equal(Coordinator.mathSourceOffset({
    value: String.raw`x&x\\x&x`,
    clickedWord: bottomLeft,
    words: [topLeft, bottomLeft, topRight, bottomRight],
    bounds: { left: 8, top: 8, right: 26, bottom: 36 },
    point: { x: 13, y: 31 },
  }), 6, 'column-major PDF words are reconstructed into TeX matrix row order');
});

test('ambiguous or incomplete duplicate math extraction fails closed', () => {
  const clicked = { text: 'x', left: 10, top: 10, right: 14, bottom: 16 };
  assert.equal(Coordinator.mathSourceOffset({
    value: String.raw`\frac{x}{x}`,
    clickedWord: clicked,
    words: [clicked],
    bounds: { left: 8, top: 8, right: 16, bottom: 36 },
    point: { x: 13, y: 12 },
  }), null, 'PDF/source occurrence counts must agree');
  assert.equal(Coordinator.mathSourceOffset({
    value: String.raw`x+x`,
    clickedWord: clicked,
    words: [],
    bounds: null,
    point: { x: 13, y: 12 },
  }), null, 'an x-only ratio is never used for duplicate tokens');
  assert.equal(Coordinator.mathSourceOffset({
    value: String.raw`x^x`,
    clickedWord: clicked,
    words: [clicked, { ...clicked, top: 2, bottom: 8 }],
    bounds: { left: 8, top: 0, right: 16, bottom: 18 },
    point: { x: 13, y: 12 },
  }), null, 'script visual order is not guessed from vertical position');
  assert.equal(Coordinator.mathSourceOffset({
    value: 'x+x',
    clickedWord: { ...clicked, text: 'x+x', right: 24 },
    words: [{ ...clicked, text: 'x+x', right: 24 }],
    bounds: { left: 8, top: 8, right: 26, bottom: 18 },
    point: { x: 18, y: 12 },
  }), null, 'compound PDF words have no invented per-glyph metric');
  const fractionTop = { ...clicked, top: 2, bottom: 8 };
  const fractionBottom = { ...clicked, top: 20, bottom: 26 };
  assert.equal(Coordinator.mathSourceOffset({
    value: String.raw`x+\frac{x}{x}`,
    clickedWord: fractionBottom,
    words: [fractionTop, clicked, fractionBottom],
    bounds: { left: 8, top: 0, right: 16, bottom: 28 },
    point: { x: 13, y: 23 },
  }), null, 'mixed baseline and nested fraction occurrences are not reordered visually');
  assert.match(APP, /Coordinator\.mathSourceOffset\(\{[\s\S]*?words: clickedWord\?\.pageWords \?\? \[\]/);
  assert.match(APP, /return readingIndex < 0 \? null : \{ \.\.\.words\[readingIndex\], readingIndex, pageWords: words \};/);
});

test('math source probes skip structural-boundary-only SyncTeX geometry', () => {
  const region = {
    sourceValue: String.raw`
h(x)=\begin{cases}x^2,&x>0\\0,&x\leq0\end{cases}
\label{eq:x}
`,
    source: {
      file: '/paper/main.tex',
      start: { line: 20, column: 17 },
      end: { line: 23, column: 1 },
    },
  };
  assert.deepEqual(Coordinator.sourceProbeLocations(region), [
    { file: '/paper/main.tex', line: 20, column: 17 },
    { file: '/paper/main.tex', line: 21, column: 1 },
    { file: '/paper/main.tex', line: 22, column: 1 },
    { file: '/paper/main.tex', line: 23, column: 1 },
  ]);
});

test('source bounds select formula hierarchy instead of a whole two-column line', () => {
  const results = [
    { page: 1, box: { left: 72, top: 128, right: 301, bottom: 139 } },
    { page: 1, box: { left: 72, top: 148, right: 301, bottom: 185 } },
    { page: 1, box: { left: 142, top: 148, right: 231, bottom: 185 } },
    { page: 1, box: { left: 175, top: 148, right: 231, bottom: 185 } },
    { page: 1, box: { left: 183, top: 149, right: 229, bottom: 166 } },
    { page: 1, box: { left: 188, top: 150, right: 193, bottom: 156 } },
    { page: 1, box: { left: 288, top: 155, right: 301, bottom: 170 } },
  ];
  assert.deepEqual(Coordinator.selectSourceBounds({
    results,
    pageNumber: 1,
    near: { page: 1, x: 190, y: 153 },
  }), { page: 1, left: 175, top: 148, right: 231, bottom: 185 });
  assert.ok(
    Coordinator.selectSourceBounds({ results, pageNumber: 1, near: { x: 190, y: 153 } }).left > 100,
    'the unrelated x=72 column edge is rejected'
  );
});

test('native IME anchor preserves its exact relative PDF point across reflow', () => {
  const ratio = Coordinator.caretAnchorRatio(
    { left: 10, top: 20, right: 30, bottom: 60 },
    { x: 15, y: 50 }
  );
  assert.deepEqual(ratio, { x: 0.25, y: 0.75 });
  assert.deepEqual(
    Coordinator.caretAnchorPoint({ left: 100, top: 200, right: 180, bottom: 240 }, ratio),
    { x: 120, y: 230 }
  );
  assert.equal(Coordinator.caretAnchorRatio({ left: 0, top: 0, right: 0, bottom: 10 }, { x: 0, y: 1 }), null);
  assert.match(APP, /control\.style\.transform = `translate3d\(\$\{dx\}px, \$\{dy\}px, 0\)`;/);
  assert.match(APP, /session\.imeComposing !== true[\s\S]*?!session\.canonicalAnchorPoint/);
  assert.match(APP, /compositionstart[\s\S]*?directEditor\.imeComposing = true[\s\S]*?compositionend[\s\S]*?directEditor\.imeComposing = false/);
  assert.match(APP, /const caretAnchorRatio = Coordinator\?\.caretAnchorRatio\?\.\(printBounds, clickOnPaper\) \?\? null;/);
  assert.match(APP, /directEditor\.element\.style\.minHeight[\s\S]*?alignOpaqueNativeCaretAnchor\(\);/);
});

test('client and displayed-paper transforms survive zoom, scroll and iframe offsets', () => {
  const paper = { width: 600, height: 800 };
  const paperPoint = { x: 420, y: 240 };
  const cases = [
    // baseline, app zoom, #pages scroll, and a host iframe's client offset
    { left: 100, top: 50, width: 600, height: 800 },
    { left: 100, top: 50, width: 900, height: 1200 },
    { left: 20, top: -210, width: 900, height: 1200 },
    { left: 157, top: -127, width: 900, height: 1200 },
  ];
  for (const pageRect of cases) {
    const clientX = pageRect.left + (paperPoint.x / paper.width) * pageRect.width;
    const clientY = pageRect.top + (paperPoint.y / paper.height) * pageRect.height;
    assert.deepEqual(Coordinator.paperPoint({ clientX, clientY, pageRect, paper }), paperPoint);
    assert.deepEqual(Coordinator.clientBounds({
      bounds: { left: paperPoint.x, top: paperPoint.y, right: paperPoint.x + 30, bottom: paperPoint.y + 20 },
      pageRect,
      paper,
    }), {
      left: clientX,
      top: clientY,
      right: pageRect.left + ((paperPoint.x + 30) / paper.width) * pageRect.width,
      bottom: pageRect.top + ((paperPoint.y + 20) / paper.height) * pageRect.height,
    });
  }
  assert.match(APP, /const displaysCanonical = page\?\.classList\?\.contains\('is-final'\)/);
  assert.match(APP, /if \(displaysCanonical && displayedWidth > 0 && displayedHeight > 0\)/);
  assert.match(APP, /TdomOpaqueEditorCoordinator\?\.paperPoint/);
  assert.match(APP, /TdomOpaqueEditorCoordinator\?\.clientBounds/);
});

test('visible suggestions are anchored to the canonical click, not the source-range shell', () => {
  const offset = Coordinator.overlayOffset({
    pageRect: { left: 100, top: 50 },
    shellLeft: 20,
    shellTop: 30,
    anchor: { x: 260, y: 210 },
    gap: 5,
  });
  assert.deepEqual(offset, { left: 140, top: 135 });
  assert.deepEqual({
    x: 100 + 20 + offset.left,
    y: 50 + 30 + offset.top - 5,
  }, { x: 260, y: 210 });
  assert.deepEqual(Coordinator.overlayOffset({
    pageRect: { left: 100, top: 50, right: 700, bottom: 850 },
    viewportRect: { left: 0, top: 0, right: 500, bottom: 400 },
    shellLeft: 20,
    shellTop: 30,
    anchor: { x: 480, y: 380 },
    panelRect: { width: 180, height: 80 },
    gap: 5,
    margin: 8,
  }), {
    left: 192,
    top: 215,
  }, 'a visible panel clamps horizontally and flips above the paper anchor');
  assert.match(APP, /canonicalAnchorPoint: clickOnPaper/);
  assert.match(APP, /positionOpaqueSuggestionPanel\(page, pageRect\)/);
  assert.match(APP, /--tdom-canonical-panel-left', `\$\{offset\.left\}px`/);
  assert.match(APP, /--tdom-canonical-panel-top', `\$\{offset\.top\}px`/);
  assert.match(STYLE, /\.tdom-direct-editor\.is-opaque \{ pointer-events: none; \}/);
  assert.match(STYLE, /\.tdom-direct-editor\.is-opaque \.math-wysiwyg-panel \{[\s\S]*?left: var\(--tdom-canonical-panel-left, 0px\) !important;[\s\S]*?top: var\(--tdom-canonical-panel-top,/);
});

test('raw browser math glyphs are never painted before an exact chunk', () => {
  assert.match(STYLE, /\.page svg text\[data-math="1"\] \{ opacity: 0; \}/);
  assert.doesNotMatch(APP, /scheduleProvisionalMath|tdom-provisional-math/);
  assert.doesNotMatch(STYLE, /tdom-provisional-math/);
});

test('incremental font faces fail closed until the real TeX font is ready', () => {
  assert.match(APP, /function applyReport\(report\) \{[\s\S]*?injectFonts\(report\.fonts\);[\s\S]*?for \(const patch of report\.patches\)/);
  assert.match(APP, /const pending = readyFonts\.has\(cmd\.fam\)[\s\S]*?data-font-family=/);
  assert.match(APP, /readyFonts\.add\(k\);[\s\S]*?removeAttribute\('data-font-pending'\)/);
  assert.match(STYLE, /\.page svg text\[data-font-pending="1"\] \{ opacity: 0; \}/);
  assert.match(SERVER, /kind: 'patches', rev: partial\.rev, fonts: partial\.fonts/);
});

test('the browser entrypoint enforces the planner before the batch commit loop', () => {
  const plannerScript = INDEX.indexOf('<script src="/opaque-editor-coordinator.js"></script>');
  const appScript = INDEX.indexOf('<script src="/app.js"></script>');
  assert.ok(plannerScript >= 0 && plannerScript < appScript, 'barrier policy loads before app.js');
  assert.match(SERVER, /url\.pathname === '\/opaque-editor-coordinator\.js'/);

  const guard = APP.indexOf('if (!ensureOpaqueBatchEditorTargetPage(batch)) return;');
  const commitLoop = APP.indexOf('for (const [pageNumber, entry] of [...batch.expected])', guard);
  assert.ok(guard >= 0 && commitLoop > guard, 'editor target barrier runs before page readiness commit');
  assert.match(APP, /targetPage\.dataset\.canonStage = plan\.targetSrc;\s+updateCanonState\(plan\.pageNumber\);/);
});

test('canonical-surface caret placement never falls through to browser hit geometry', () => {
  assert.match(APP, /if \(usesCanonicalSurface\(\)\) \{[\s\S]*?\} else if \(clickPoint\) \{\s+range = document\.caretRangeFromPoint/);
  assert.match(APP, /\} else if \(usesCanonicalSurface\(\)\) \{[\s\S]*?control\.position = Number\(control\.lastOffset\);[\s\S]*?\} else if \(clickPoint && typeof control\.getOffsetFromPoint/);
});
