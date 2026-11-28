import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { CheckpointEngine } from '../engine/checkpoint/engine-v3.js';
import { CanonicalRenderer } from '../engine/checkpoint/canonical.js';
import { jumpAnchor, locateJump, parseJumpText, parseJumpTsv, parseJumpRecords, jumpRecords, scoreReverseText } from '../engine/checkpoint/jump-sync.js';
import { jumpViewer } from './helpers/provisional-viewer.js';

const box = (top, left = 60) => ({ left, top, right: left + 180, bottom: top + 12 });
const response = data => ({ ok: true, json: async () => data });
const jump = { page: 1, y: 70, sourceFile: '/paper/main.tex', sourceLine: 5 };
const exact = (page = 2, top = 270) => ({ id: 2, srcRev: 2, documentEpoch: 1, page, boxes: [box(top)] });

test('Live reverse text recognizes a wrapped yoko paragraph from t00', () => {
  // Normalized source and pdftotext -bbox-layout words from the real PDF.
  // These wrapped words are neither TeX tokens nor complete source words.
  const paragraphs = [
    ['はじめに', '吾輩は猫である名前はまだ無いどこで生れたかとんと見当がつかぬ何でも薄暗いじめじめした所でニャーニャー泣いていた事だけは記憶している吾輩はここで始めて人間というものを見た',
      'る吾輩はここで始めて人間というものを見た'],
    ['', 'しかもあとで聞くとそれは書生という人間中で一番獰悪な種族であったそうだこの書生というのは時々我々を捕えて煮て食うという話であるしかしその当時は何という考もなかったから別段恐しいとも思わなかった',
      'しかもあとで聞くとそれは書生という人間中で一番獰悪な種族であったそ'],
  ];
  for (const [wrong, line, word] of paragraphs) {
    assert.equal(scoreReverseText([wrong], { word }), 0);
    assert.equal(scoreReverseText([line], { word }), 1);
  }
  assert.equal(scoreReverseText(['これは本文です'], { word: '本文' }), 0);
  assert.equal(scoreReverseText(['concatenate'], { word: 'cat' }), 0);
  assert.equal(scoreReverseText(['left', 'word', 'right'], { word: 'word', prev: 'left', next: 'right' }), 3);
});

test('the old Build position is only an approximate band until current paper answers', async () => {
  let ready = false;
  const viewer = jumpViewer({ fetch: async url => response(url === '/dom'
    ? { srcRev: 2, documentEpoch: 1, blocks: [] }
    : ready ? exact() : { pending: true, srcRev: 2, documentEpoch: 1 }) });
  viewer.jump({ ...jump, blockX: 60, blockY: 70, blockWidth: 400, blockHeight: 500 });
  await viewer.flush();
  // "about here": a band across the page, never a rectangle around a line
  const band = viewer.markers();
  assert.equal(band.length, 1);
  assert.equal(band[0].dataset.exact, 'false');
  assert.equal(band[0].style.left, '0px');
  assert.equal(band[0].style.width, '600px');
  assert.equal(viewer.demands.at(-1).residentImpossible, true);
  ready = true;
  await viewer.tick();
  assert.ok(viewer.markers().every(marker => marker.dataset.exact === 'false'),
    'new map must wait for the old raster to be replaced');
  viewer.commitCanonical(2, 2);
  await viewer.tick();
  const marker = viewer.markers()[0];
  assert.equal(marker.parent.dataset.page, '2');
  assert.equal(marker.style.top, '269px');
  assert.equal(marker.style.height, '14px');
  assert.equal(marker.dataset.exact, 'true');
});

// Round 20 release audit, "Opening Jump": Jump from line 3 while a ten-page
// article opens, the host's position an older Build's (paper y=200). The
// resident lookup finds the line; the exact lookup is pending. The marker went
// back to the older host band (~75 px off) for a second before the exact box.
test('an opening Jump keeps the resident place it found until the exact answer for the same Jump', async () => {
  let ready = false;
  const viewer = jumpViewer({ fetch: async url => response(url === '/dom'
    ? { srcRev: 2, documentEpoch: 1, blocks: [{ id: 'p1', source: { file: jump.sourceFile, start: { line: 3 }, end: { line: 3 } } }] }
    : ready ? { id: 2, srcRev: 2, documentEpoch: 1, page: 1, boxes: [box(131)] } : { pending: true, srcRev: 2, documentEpoch: 1 }) });
  const fallbacks = [];
  const setTimer = viewer.setTimeout;
  viewer.setTimeout = (fn, ms) => {
    if (ms === 1200) fallbacks.push(fn);
    return setTimer(fn, ms);
  };
  viewer.openingPreview = true;
  // sheet 1 provisional, its line 3 drawn from 120 to 160 px
  const page = viewer.pageDivs.get(1);
  page.dataset.prov = '1'; page.dataset.provRev = '2';
  const ink = { dataset: { line: '0' }, tagName: 'text', classList: { contains: () => false },
    getBoundingClientRect: () => ({ top: page.getBoundingClientRect().top + 120, bottom: page.getBoundingClientRect().top + 160,
      left: 72, right: 520, width: 448, height: 40 }) };
  page.querySelectorAll = selector => selector.includes('data-src="p1"') ? [ink] : [];
  const tops = [];
  const sample = () => tops.push(viewer.markers().map(marker => marker.parent.dataset.page + ':' + Math.round(parseFloat(marker.style.top))).join());
  viewer.jump({ page: 1, y: 200, sourceFile: jump.sourceFile, sourceLine: 3, blockX: 72, blockY: 190, blockWidth: 448, blockHeight: 20 });
  sample();
  await viewer.flush();
  sample();
  await viewer.tick();
  sample();
  // the first-move deadline passes with the exact answer still pending
  assert.equal(fallbacks.length, 1);
  const scrolled = viewer.pagesEl.scrollTop;
  fallbacks[0]();
  sample();
  assert.equal(viewer.pagesEl.scrollTop, scrolled, 'the deadline does not move to the older place');
  ready = true;
  viewer.commitCanonical(2, 2);
  delete page.dataset.prov; // (the exact sheet is on screen now)
  await viewer.tick();
  sample();
  const resident = tops[1];
  assert.notEqual(tops[0], resident, 'the host band first, then the resident place');
  assert.deepEqual(tops.slice(1, 4), [resident, resident, resident], 'the resident place stays: ' + tops.join(' | '));
  const exactMarker = viewer.markers()[0];
  assert.equal(exactMarker.dataset.exact, 'true');
  assert.equal(exactMarker.style.top, '130px');
});

test('an exact chunk supplies a current block estimate, never a box-sized precise marker', async () => {
  const viewer = jumpViewer({ fetch: async url => response(url === '/dom'
    ? { srcRev: 2, documentEpoch: 1, blocks: [{ id: 'box', source: { file: jump.sourceFile,
      start: { line: 4 }, end: { line: 12 } } }] }
    : { pending: true, srcRev: 2, documentEpoch: 1 }) });
  const page = viewer.pageDivs.get(2);
  page.dataset.prov = '1'; page.dataset.provRev = '2';
  page.querySelectorAll = () => [{ dataset: { line: '1' }, tagName: 'DIV',
    classList: { contains: name => name === 'chunkwin' },
    getBoundingClientRect: () => ({ top: page.getBoundingClientRect().top + 120, bottom: page.getBoundingClientRect().top + 520,
      left: 60, right: 540, width: 480, height: 400 }) }];
  viewer.jump(jump);
  await viewer.flush();
  const marker = viewer.markers()[0];
  assert.equal(marker.parent.dataset.page, '2');
  assert.equal(marker.dataset.exact, 'false');
  // line 5 of a block spanning lines 4-12 drawn from 120px to 520px: one
  // eighth of the way down, as a band across the page
  assert.equal(marker.style.left, '0px');
  assert.equal(marker.style.width, '600px');
  assert.equal(marker.style.height, '36px');
  assert.equal(marker.style.top, '152.5px');
  viewer.dispatch('wheel');
  await viewer.tick();
  assert.equal(viewer.markers().length, 0);
});

test('a shipping page with the same revision waits for the canonical mapping generation', async () => {
  const viewer = jumpViewer({ fetch: async url => response(url === '/dom' ? {} : exact()) });
  viewer.commitCanonical(2, 2);
  viewer.pageDivs.get(2).dataset.canonPresentedSrc = '/ship/2.svg?g=7&r=2';
  viewer.jump(jump);
  await viewer.flush();
  assert.equal(viewer.markers().length, 0);
  viewer.commitCanonical(2, 2);
  await viewer.tick();
  assert.equal(viewer.markers().length, 1);
});

for (const action of ['wheel', 'pointerdown', 'scroll', 'new-jump', 'revision', 'reset']) {
  test(`a late Jump answer is cancelled by ${action}`, async () => {
    let complete;
    const viewer = jumpViewer({ fetch: async url => url === '/dom' ? response({}) :
      new Promise(resolve => { complete = resolve; }) });
    viewer.commitCanonical(2, 2);
    viewer.jump(jump);
    await viewer.flush();
    assert.equal(typeof complete, 'function');
    if (action === 'new-jump') viewer.jump({ page: 1, y: 50, marker: false });
    else if (action === 'revision') viewer.appliedSrcRev++;
    else if (action === 'reset') viewer.documentReset.adoptedEpoch++;
    else {
      if (action === 'scroll') viewer.pagesEl.scrollTop += 25;
      viewer.dispatch(action);
    }
    const scrollTop = viewer.pagesEl.scrollTop;
    complete(response(exact()));
    await viewer.flush(); await viewer.tick();
    assert.equal(viewer.markers().length, 0);
    assert.equal(viewer.pagesEl.scrollTop, scrollTop);
  });
}

test('column is ignored; canonical-anchor and shipping-exact use line-sized paper boxes', async () => {
  for (const policy of ['canonical-anchor', 'shipping-exact']) for (const column of [1, 20, 50, 1000]) {
    const requests = [];
    const viewer = jumpViewer({ fetch: async (url, options) => {
      if (options) requests.push(JSON.parse(options.body));
      return response(url === '/dom' ? {} : exact());
    } });
    viewer.previewPolicy = policy;
    viewer.commitCanonical(2, 2);
    viewer.jump({ ...jump, sourceColumn: column });
    await viewer.flush();
    assert.equal(viewer.markers().length, 1);
    assert.equal(viewer.markers()[0].style.height, '14px');
    assert.deepEqual(requests[0], { file: jump.sourceFile, line: 5, srcRev: 2, documentEpoch: 1 });
  }
});

test('the marker uses the destination landscape width, not the first page width', async () => {
  const viewer = jumpViewer({ fetch: async url => response(url === '/dom' ? {} : exact(2, 121)) });
  viewer.activePaperGeometry = page => page.dataset.page === '2' ? { width: 841.89, height: 595.276 } :
    { width: 595.276, height: 841.89 };
  viewer.commitCanonical(2, 2);
  viewer.jump(jump);
  await viewer.flush();
  const marker = viewer.markers()[0], scale = 600 / 841.89;
  assert.equal(marker.parent.dataset.page, '2');
  assert.ok(Math.abs((parseFloat(marker.style.top) + 1) / scale - 121) < 0.001);
  assert.ok(Math.abs((parseFloat(marker.style.top) + 1) / (600 / 595.276) - 121) > 30,
    'a referee using the portrait width would report the correct marker one third too high');
});

for (const [name, source, needles] of [
  ['opening titles, headlines, captions and wrong-page fallback', String.raw`\documentclass{article}
\usepackage[most]{tcolorbox}
\usepackage{epigraph}
\newenvironment{headline}[1]{\par\textbf{#1}\par}{}
\begin{document}
\begin{headline}{HeadlineWitness}
HeadlineBody
\end{headline}
\begin{tcolorbox}[title={TitleWitness}]
TitleBody
\end{tcolorbox}
\section{SectionWitness}
SectionBody
\begin{figure}[h]
\caption{CaptionWitness}
\end{figure}
\begin{description}
\item[ItemWitness] ItemBody
\end{description}
\epigraph{QuotationWitness}{AttributionWitness}
\begin{headline}{WrongpageWitness}
\newpage
FollowingpageBody
\end{headline}
\end{document}`, ['HeadlineWitness', 'TitleWitness', 'SectionWitness', 'CaptionWitness', 'ItemWitness', 'QuotationWitness', 'AttributionWitness', 'WrongpageWitness']],
  ['frame and block titles including fragile frames', String.raw`\documentclass{beamer}
\begin{document}
\begin{frame}{FrameWitness}
\begin{block}{BlockWitness}
BodyWitness
\end{block}
\begin{alertblock}{AlertWitness}
OtherBody
\end{alertblock}
\end{frame}
\begin{frame}[fragile]{FragileWitness}
FragileBody
\end{frame}
\end{document}`, ['FrameWitness', 'BlockWitness', 'AlertWitness', 'FragileWitness']],
  ['all table cells and a rule on the header line', String.raw`\documentclass{article}
\usepackage{booktabs}
\begin{document}
\begin{tabular}{lll}
\toprule HeaderWitness & LabelWitness & Z\\\midrule
FirstWitness & MiddleWitness & LastWitness\\
A & MeasurementWitness & 42\\
\bottomrule
\end{tabular}
\end{document}`, ['HeaderWitness', 'LabelWitness', 'Z', 'FirstWitness', 'MiddleWitness', 'LastWitness', 'A', 'MeasurementWitness', '42']],
  ['protected footnote and its same-line body', String.raw`\documentclass{article}
\usepackage{cprotect}
\begin{document}
\cprotect\footnote{NoteWitness with \verb|%| and \verb|#|.}SentenceWitness in the body.
\end{document}`, ['NoteWitness', 'SentenceWitness']],
  ['ink in picture options', String.raw`\documentclass{article}
\usepackage{pgfplots}
\pgfplotsset{compat=1.18}
\begin{document}
\begin{tikzpicture}
\begin{axis}[ylabel={AmplitudeWitness}]
\addplot coordinates {(0,0) (1,1)};
\end{axis}
\end{tikzpicture}
\end{document}`, ['AmplitudeWitness']],
  ['listing caption rather than a literal caption command in its body', String.raw`\documentclass{article}
\usepackage{listings}
\begin{document}
\begin{lstlisting}[caption={ListingWitness}]
\caption{MisleadingWitness}
\end{lstlisting}
\end{document}`, ['ListingWitness']],
]) test(`canonical Jump resolves ${name}`, { timeout: 90_000 }, async () => {
  const workDir = mkdtempSync(path.join(tmpdir(), 'tdom-jump-ink-'));
  const renderer = new CanonicalRenderer({ workDir });
  try {
    const generation = await renderer.ensure(source, 1);
    const words = execFileSync('pdftotext', ['-tsv', generation.pdf, '-'], { encoding: 'utf8' })
      .split('\n').filter(row => row.startsWith('5\t')).map(row => row.split('\t'));
    for (const needle of needles) {
      const line = source.split('\n').findIndex(value => value.includes(needle)) + 1;
      const answer = await renderer.jumpToSource({ file: path.join(workDir, 'canon.tex'), line, source, rev: 1 });
      const word = words.find(c => c.slice(11).join('\t') === needle);
      assert.ok(word, `missing truth for ${needle}`);
      const x = +word[6], y = +word[7] + +word[9] / 2;
      assert.equal(answer?.page, +word[1], needle);
      assert.ok(answer.boxes.some(b => x >= b.left - 2 && x <= b.right + 2 && y >= b.top - 2 && y <= b.bottom + 2),
        JSON.stringify({ needle, x, y, answer }));
    }
  } finally {
    renderer.dispose();
    rmSync(workDir, { recursive: true, force: true });
  }
});

test('literal text distinguishes captured arguments; repeated text needs source ownership', () => {
  const rows = ['Repeated', 'CapturedAlpha', 'Repeated'].map((text, i) => ({ page: 1, text, box: box(i * 40 + 100) }));
  assert.equal(locateJump(rows, 'CapturedAlpha', []).boxes[0].top, 140);
  assert.equal(locateJump(rows, 'Repeated', []), null);
  assert.equal(locateJump(rows, 'Repeated', [{ page: 1, x: 80, y: 190, ink: true }]).boxes[0].top, 180);
});

test('structural lines select neighbouring output from the unsaved text', () => {
  const lines = ['Before', '', '\\begin{tcolorbox}', 'Upper', '\\tcblower', 'Lower', '\\end{tcolorbox}', '',
    '\\noindent\\begin{minipage}{.5\\linewidth}', 'Mini', '\\item', 'Item'];
  for (const [line, anchor] of [[2, 1], [3, 4], [5, 6], [7, 6], [8, 6], [9, 10], [11, 12]]) {
    assert.equal(jumpAnchor(lines, line).line, anchor);
  }
});

test('PDF line boundaries keep adjacent columns separate', () => {
  const xml = '<page><line><word xMin="10" yMin="20" xMax="50" yMax="30">Left</word></line>' +
    '<line><word xMin="90" yMin="20" xMax="130" yMax="30">Right</word></line></page>';
  const rows = parseJumpText(xml);
  assert.equal(rows.length, 2);
  assert.deepEqual(locateJump(rows, 'Right', []).boxes, [{ left: 90, right: 130, top: 20, bottom: 30 }]);
});

test('one source line retains quotation, attribution and disconnected body ink', () => {
  const rows = ['Timetable', 'Stationmaster', 'Carrying'].map((text, i) => ({ page: 2, text, tokens: [text], box: box(50 + i * 160) }));
  assert.deepEqual(locateJump(rows, '\\epigraph{Timetable}{Stationmaster}', []).boxes, rows.slice(0, 2).map(r => r.box));
  assert.deepEqual(locateJump(rows, '\\cprotect\\footnote{Stationmaster \\verb|%|}Carrying', []).boxes, rows.slice(1).map(r => r.box));
});

test('a blank after a paragraph with a footnote stays at the end of the body run', () => {
  const rows = [
    { page: 1, text: 'BodyparagraphWitness', tokens: ['Bodyparagraph', 'Witness'], box: box(100) },
    { page: 1, text: 'Note', tokens: ['Note'], box: box(700) },
  ];
  const source = 'Bodyparagraph Witness\\footnote{Note}';
  assert.equal(locateJump(rows, source, [], true).boxes[0].top, 100);
  assert.equal(locateJump(rows, source, []).boxes.length, 2);
});

test('Latin ink adjoining Japanese and punctuation remains searchable', () => {
  const rows = [{ page: 1, text: '末尾Witness終端', tokens: ['末尾', 'Witness', '終端'], box: box(100) }];
  assert.deepEqual(locateJump(rows, '最後の文にあるWitness終端。\\par', []).boxes, [rows[0].box]);
});

test('word boundaries and option keys cannot send a title to incidental substring ink', () => {
  const rows = [{ page: 1, text: 'Boundarycondition', tokens: ['Boundary', 'condition'], box: box(100) },
    { page: 2, text: 'prose', tokens: ['prose'], box: box(200) }];
  assert.equal(locateJump(rows, '\\begin{panel}[color=rose]{Boundary condition}', []).page, 1);
});

test('table rows include short and numeric cells without joining a neighbouring table', () => {
  const rows = ['A', 'Measurement', '42', 'Elsewhere'].map((text, i) => ({ page: 1, text, tokens: [text],
    box: { left: 20 + i * 70, right: 60 + i * 70, top: 100, bottom: 112 } }));
  rows.push({ page: 1, text: 'Otherrow', tokens: ['Otherrow'], box: box(130, 20) });
  assert.deepEqual(locateJump(rows, '\\toprule A & Measurement & 42\\\\', []).boxes,
    [{ left: 20, right: 200, top: 100, bottom: 112 }]);
  const numeric = rows.slice(0, 3).map((row, i) => ({ ...row, text: i ? '42' : 'A', tokens: [i ? '42' : 'A'] }));
  assert.deepEqual(locateJump(numeric, 'A & 42 & 42\\\\', [{ page: 1, x: 100, y: 110, ink: true }]).boxes,
    [{ left: 20, right: 200, top: 100, bottom: 112 }]);
  assert.deepEqual(locateJump(numeric, '\\toprule A & 42 & 42\\\\', [{ page: 1, x: 100, y: 110, ink: true }], false, true).boxes,
    [{ left: 20, right: 200, top: 100, bottom: 112 }]);
});

test('TSV fallback retains word boundaries for frame titles', () => {
  const rows = parseJumpTsv('4\t2\t0\t0\t0\t0\t10\t20\t80\t12\t-1\t\n5\t2\t0\t0\t0\t0\t10\t20\t80\t12\t100\tFrameTitle');
  assert.deepEqual(locateJump(rows, '\\begin{frame}{FrameTitle}', []).boxes, [{ left: 10, top: 20, right: 90, bottom: 32 }]);
});

test('SyncTeX leaf records keep file ownership and reject unfamiliar transforms', () => {
  const text = 'SyncTeX Version:1\nInput:1:/p/main.tex\nInput:2:/p/child.tex\nMagnification:1000\nUnit:1\nX Offset:0\nY Offset:0\nContent:\n{1\n' +
    '[1,5:0,0:100,100,0\n(1,5:0,100:100,10,2\nx2,5:50,100\n)\n]\n}1\nPost scriptum:\n';
  const index = parseJumpRecords(text, '/p');
  assert.equal(jumpRecords(index, '/p/main.tex', 5).length, 0);
  assert.equal(jumpRecords(index, '/p/child.tex', 5).length, 1);
  assert.equal(parseJumpRecords(text + 'Magnification:2000\n', '/p'), null);
});

test('included-file Jump requires the bytes in the canonical input manifest', { timeout: 60_000 }, async () => {
  const workDir = mkdtempSync(path.join(tmpdir(), 'tdom-jump-input-'));
  const renderer = new CanonicalRenderer({ workDir });
  const source = 'ChildContentWitness';
  const rootSource = String.raw`\documentclass{article}\begin{document}\input{child}\end{document}`;
  const file = path.join(workDir, 'child.tex');
  writeFileSync(file, source);
  try {
    await renderer.ensure(rootSource, 1);
    assert.ok(await renderer.jumpToSource({ file, line: 1, source, rootSource, rev: 1 }));
    assert.equal(await renderer.jumpToSource({ file, line: 1, source: source + ' new', rootSource, rev: 1 }), null);
  } finally {
    renderer.dispose();
    rmSync(workDir, { recursive: true, force: true });
  }
});

test('current canonical Jump follows a tcolorbox across an unsaved edit without export or Build', { timeout: 120_000 }, async () => {
  const workDir = mkdtempSync(path.join(tmpdir(), 'tdom-jump-'));
  const engine = new CheckpointEngine({ workDir, docDir: workDir });
  const source = String.raw`\documentclass{article}
\usepackage[most]{tcolorbox}
\begin{document}
Before the box.

\begin{tcolorbox}
InsideBoxWitness with several words.
\end{tcolorbox}

AfterBoxWitness is ordinary prose.
\end{document}`;
  const settleDisplay = async () => {
    engine.canonical.requestDisplay(engine.srcRev, 1, { demandId: `jump-${engine.srcRev}`, residentImpossible: true });
    const deadline = Date.now() + 60_000;
    while (engine.canonical.info().rev !== engine.srcRev) {
      assert.ok(Date.now() < deadline, JSON.stringify(engine.canonical.info()));
      await new Promise(resolve => setTimeout(resolve, 50));
    }
  };
  const locate = word => engine.canonical.jumpToSource({ file: path.join(engine.canonical.workDir, 'canon.tex'),
    source: engine.getSource(), rev: engine.srcRev,
    line: engine.getSource().split('\n').findIndex(line => line.includes(word)) + 1 });
  try {
    await engine.open(source);
    await settleDisplay();
    const before = await locate('InsideBoxWitness');
    assert.ok(before?.boxes.length);
    const at = source.indexOf('Before the box.');
    await engine.edit(at, at, 'Extra first paragraph.\n\nExtra second paragraph.\n\nExtra third paragraph.\n\n');
    assert.equal(await locate('InsideBoxWitness'), null, 'old authority is never returned under the new revision');
    await settleDisplay();
    const after = await locate('InsideBoxWitness');
    assert.equal(after.srcRev, engine.srcRev);
    assert.ok(after.boxes[0].top > before.boxes[0].top + 25);
    assert.ok(after.boxes[0].bottom - after.boxes[0].top < 25);
    const afterBox = await locate('AfterBoxWitness');
    assert.ok(afterBox.boxes[0].top > after.boxes[0].bottom);
  } finally {
    await engine.close();
    rmSync(workDir, { recursive: true, force: true });
  }
});

for (const [name, source, needle] of [
  ['collected two-column box', String.raw`\documentclass[twocolumn]{article}
\usepackage{tcolorbox}
\title{DocumentTitle}\author{}\date{}
\begin{document}
\twocolumn[{\maketitle\begin{tcolorbox}
CapturedFirstLine

CapturedSecondLine
\end{tcolorbox}}]
OrdinaryBody
\end{document}`, 'CapturedSecondLine'],
  ['beamer repeated text', String.raw`\documentclass{beamer}
\begin{document}
\begin{frame}{FirstTitle}
RepeatedBody
\end{frame}
\begin{frame}{SecondTitle}
RepeatedBody
\end{frame}
\end{document}`, 'RepeatedBody'],
  ['rotated landscape', String.raw`\documentclass{article}
\usepackage{pdflscape}
\begin{document}
PortraitBody
\begin{landscape}
LandscapeBody
\end{landscape}
\end{document}`, 'LandscapeBody'],
]) test(`canonical Jump handles ${name}`, { timeout: 60_000 }, async () => {
  const workDir = mkdtempSync(path.join(tmpdir(), 'tdom-jump-policy-'));
  const renderer = new CanonicalRenderer({ workDir });
  try {
    const generation = await renderer.ensure(source, 1);
    const line = source.split('\n').findLastIndex(value => value.includes(needle)) + 1;
    const answer = await renderer.jumpToSource({ file: path.join(renderer.workDir, 'canon.tex'), line, source, rev: 1 });
    assert.ok(answer, 'the current revision must resolve');
    const text = execFileSync('pdftotext', ['-tsv', generation.pdf, '-'], { encoding: 'utf8' });
    const record = text.split('\n').findLast(row => row.startsWith('5\t') && row.includes(needle)).split('\t');
    const page = Number(record[1]);
    const word = { top: Number(record[7]), bottom: Number(record[7]) + Number(record[9]) };
    assert.equal(answer.page, page);
    assert.ok(answer.boxes.some(box => (word.top + word.bottom) / 2 >= box.top - 2 &&
      (word.top + word.bottom) / 2 <= box.bottom + 2), JSON.stringify({ answer, word }));
  } finally {
    renderer.dispose();
    rmSync(workDir, { recursive: true, force: true });
  }
});

test('the index starts on the first page its file fills, not on the page stamped before it', async () => {
  const { parseJumpRecords, indexStartRecords } = await import('../engine/checkpoint/jump-sync.js');
  const row = (tag, line, v, glyphs) => [`(${tag},${line}:4000000,${v}:26000000,600000,150000`,
    ...Array.from({ length: glyphs }, (_, i) => `x${tag},${line}:${4000000 + i * 400000},${v}`), ')'];
  const page = (number, rows) => [`{${number}`, '[1,1:4000000,50000000:26000000,46000000,0', ...rows.flat(), ']', `}${number}`];
  const text = ['SyncTeX Version:1', 'Input:1:/doc/main.tex', 'Input:2:/doc/out/main.ind', 'Output:pdf',
    'Magnification:1000', 'Unit:1', 'X Offset:0', 'Y Offset:0', 'Content:',
    // the last page of the text: what it draws while shipping is stamped with line 1 of the index file
    ...page(7, [...Array.from({ length: 20 }, (_, i) => row(1, 40 + i, 5000000 + i * 2000000, 30)), row(2, 1, 4500000, 6), row(2, 1, 44000000, 6)]),
    // the index: two full pages and a short last one
    ...page(8, Array.from({ length: 30 }, (_, i) => row(2, 3 + i, 5000000 + i * 1400000, 12))),
    ...page(9, Array.from({ length: 30 }, (_, i) => row(2, 40 + i, 5000000 + i * 1400000, 12))),
    ...page(10, [row(2, 80, 5000000, 12)]),
    'Postamble:', 'Count:0', ''].join('\n');
  const index = parseJumpRecords(text, '/');
  assert.ok(index);
  const start = indexStartRecords(index);
  assert.equal(start[0].page, 8);
  assert.ok(start.every((record) => record.page === 8));
  // a document without an index file has no such place
  assert.deepEqual(indexStartRecords(parseJumpRecords(text.replace('main.ind', 'other.tex'), '/')), []);
});
