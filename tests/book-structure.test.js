// Books: chapters read with \subfile, and code boxes that wrap a breakable
// tcolorbox in an environment of their own. Both come from a 389-page
// translation project whose live preview stayed on the slow path.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { CheckpointEngine } from '../engine/checkpoint/engine-v3.js';
import { segmentBody } from '../engine/segmenter.js';
import { expandIncludes } from '../engine/checkpoint/include-expander.js';
import { collectBreakableTcolorboxNames } from '../engine/checkpoint/rescue-classifier.js';
import {
  documentBodyRange,
  subfileOpenTeX,
  subfileCloseTeX,
} from '../engine/checkpoint/subfile.js';

test('an environment that wraps a breakable tcolorbox splits like one', () => {
  const names = collectBreakableTcolorboxNames(String.raw`
\NewDocumentEnvironment{codebox}{ O{} O{1pt} }{%
  \begin{tcolorbox}[blanker, breakable, left=#2]
}{\end{tcolorbox}}
\newenvironment{oldstyle}[1][x]{\begin{tcolorbox}[title=#1,breakable]}{\end{tcolorbox}}
\newenvironment{outer}{\begin{oldstyle}}{\end{oldstyle}}
\NewDocumentEnvironment{viacommand}{m}{\oldstyle[#1]}{\endoldstyle}
`);
  assert.deepEqual(names.sort(), ['codebox', 'oldstyle', 'outer', 'viacommand']);
});

test('a wrapper of a box that does not break is left on the fast path', () => {
  const names = collectBreakableTcolorboxNames(String.raw`
\newenvironment{plain}{\begin{tcolorbox}[title=x]}{\end{tcolorbox}}
\NewDocumentEnvironment{off}{}{\begin{tcolorbox}[breakable=false]}{\end{tcolorbox}}
\newenvironment{prose}{\begin{quote}breakable text}{\end{quote}}
% \newenvironment{commented}{\begin{tcolorbox}[breakable]}{\end{tcolorbox}}
`);
  assert.deepEqual(names, []);
});

test('the body of a chapter is what lies between its document markers', () => {
  const chapter = String.raw`\documentclass[../all]{subfiles}
% \begin{document}
\begin{document}
\chapter{One}
\begin{verbatim}
\begin{document}
\end{document}
\end{verbatim}
last line
\end{document}
`;
  const range = documentBodyRange(chapter);
  const body = chapter.slice(range.start, range.end);
  assert.match(body, /^\n\\chapter\{One\}/);
  assert.match(body, /last line\n$/);
  assert.match(body, /\\end\{verbatim\}/, 'an example document inside the chapter stays in the body');
  assert.equal(documentBodyRange('no document here'), null);
});

test('\\subfile expands into the blocks of the chapter body', () => {
  const docDir = mkdtempSync(path.join(tmpdir(), 'tdom-subfile-'));
  mkdirSync(path.join(docDir, 'tex'));
  const child = path.join(docDir, 'tex', 'one.tex');
  writeFileSync(child, String.raw`\documentclass[../all]{subfiles}
\usepackage{never-loaded-in-the-book}
\begin{document}
\chapter{One}

First paragraph.

Second paragraph.
\end{document}
`);
  try {
    const segs = expandIncludes(segmentBody('Before.\n\n\\subfile{tex/one}\n\nAfter.\n', 0), 0, {
      docDir,
      workDir: docDir,
      includes: new Map(),
      diagnostics: [],
      watchInclude: () => {},
    });
    const texts = segs.map((seg) => seg.text.trim());
    assert.deepEqual(texts, ['Before.', '\\chapter{One}', 'First paragraph.', 'Second paragraph.', 'After.']);
    const chapter = segs.filter((seg) => seg.file === child);
    assert.equal(chapter.length, 3, 'chapter blocks keep their own file');
    assert.deepEqual(chapter[0].sourceStart, { line: 4, column: 1 });
    assert.equal(chapter[0].subfileStart, true);
    assert.equal(chapter.at(-1).subfileEnd, true);
    assert.equal(chapter[0].importDir, path.join(docDir, 'tex') + path.sep);
    assert.ok(!segs.some((seg) => /documentclass|never-loaded/.test(seg.text)), 'the chapter preamble is not typeset');
    // the group \subfile opens around the chapter, with its folder on the paths
    assert.ok(subfileOpenTeX(chapter[0]).startsWith('\\begingroup'));
    assert.ok(subfileOpenTeX(chapter[0]).includes(`\\import@path{${chapter[0].importDir}}`));
    assert.equal(subfileOpenTeX(chapter[1]), '');
    assert.match(subfileCloseTeX(chapter.at(-1)), /\\endgroup\s*$/);
    assert.equal(subfileCloseTeX(chapter[0]), '');
  } finally {
    rmSync(docDir, { recursive: true, force: true });
  }
});

test('a class that puts the real \\vsize back does not end the dormant page', async () => {
  // jlreq's \tableofcontents leaves \vsize at \textheight. The page the
  // blocks are typeset on must stay unbounded: otherwise the builder fires
  // about once per page of content and each firing plants a page break the
  // document does not have, and one tall block kills its typesetting fork.
  const paragraph = 'The quick brown fox jumps over the lazy dog. '.repeat(18).trim();
  const source = String.raw`\documentclass{article}
\begin{document}
First block.

\makeatletter\global\vsize\textheight\makeatother Second block.

` + Array.from({ length: 24 }, (_, i) => `${i + 1}. ${paragraph}`).join('\n\n') + `

\\begin{itemize}
` + Array.from({ length: 70 }, (_, i) => `\\item item ${i + 1}`).join('\n') + `
\\end{itemize}

Last block.
\\end{document}
`;
  const workDir = mkdtempSync(path.join(tmpdir(), 'tdom-vsize-'));
  const engine = new CheckpointEngine({ workDir, docDir: workDir });
  engine.canonical.schedule = () => {};
  try {
    await engine.open(source);
    assert.equal(engine.mode, 'structured');
    const ejects = engine.blocks.flatMap((block) =>
      (block.galley?.items ?? []).filter((item) => item.k === 'eject').map(() => block.id));
    assert.deepEqual(ejects, [], 'no block carries a page break of its own');
    assert.ok(engine.blocks.every((block) => block.galley && !block.rescued),
      'every block, the one taller than a page included, is typeset on the fast path');
  } finally {
    await engine.close().catch(() => {});
    rmSync(workDir, { recursive: true, force: true });
  }
});

test('an edit renders its own page and the page a straddling block ties to it, no further', async () => {
  const { editPageRenderIds } = await import('../engine/checkpoint/update-helpers.js');
  const blocks = ['b1', 'b2', 'b3', 'b4', 'b5', 'b6'].map((id) => ({ id, needsRender: true }));
  const draw = (...ids) => ids.map((blockId) => ({ u: { blockId } }));
  const pages = [
    { number: 1, draw: [{ u: {} }, ...draw('head', 'b1', 'b2')] },
    { number: 2, draw: [{ u: {} }, ...draw('head', 'b2', 'b3', 'b4')] }, // edited: b3
    { number: 3, draw: [{ u: {} }, ...draw('head', 'b4', 'b5')] },       // b4 runs over the boundary
    { number: 4, draw: [{ u: {} }, ...draw('head', 'b6')] },
  ];
  // "head" is on every page but is not a block of the document; neither is a
  // draw with no block at all. Either one, counted, tied the whole chapter.
  assert.deepEqual(editPageRenderIds(blocks, pages, new Set(['b3'])), ['b1', 'b2', 'b3', 'b4', 'b5']);
  assert.deepEqual(editPageRenderIds(blocks, pages, new Set(['b6'])), ['b6']);
  assert.deepEqual(editPageRenderIds(blocks, pages, new Set()), []);
});

test('a contents list redefined to run in columns takes the real output routine', async () => {
  const { tocTakesRealPage, needsRescue } = await import('../engine/checkpoint/rescue-classifier.js');
  const columns = String.raw`\RenewDocumentCommand{\tableofcontents}{}{%
  \begin{multicols}{2}%
    \@starttoc{toc}%
  \end{multicols}%
  \clearpage
}`;
  assert.equal(tocTakesRealPage(columns), true);
  assert.equal(tocTakesRealPage(String.raw`\renewcommand{\tableofcontents}{\section*{Contents}\@starttoc{toc}}`), false);
  assert.equal(tocTakesRealPage(String.raw`% \renewcommand{\tableofcontents}{\begin{multicols}{2}\@starttoc{toc}\end{multicols}}`), false);
  const source = columns + '\n\\begin{document}\n\\tableofcontents\nText.\n\\end{document}\n';
  const options = { preHash: 'p', breakableFor: null, breakableRe: null, source: () => source };
  assert.equal(needsRescue('\\tableofcontents\n', options).needs, true);
  assert.equal(needsRescue('Text.\n', options).needs, false);
  const plain = '\\documentclass{article}\n\\begin{document}\n\\tableofcontents\n\\end{document}\n';
  assert.equal(needsRescue('\\tableofcontents\n', { ...options, source: () => plain }).needs, false);
});

test('a chapter that reads no other file is segmented once while its text stays the same', () => {
  const docDir = mkdtempSync(path.join(tmpdir(), 'tdom-leaf-'));
  mkdirSync(path.join(docDir, 'tex'));
  const one = path.join(docDir, 'tex', 'one.tex');
  const two = path.join(docDir, 'tex', 'two.tex');
  const sub = path.join(docDir, 'tex', 'sub.tex');
  writeFileSync(one, 'First of one.\n\nSecond of one.\n');
  writeFileSync(two, 'Before.\n\n\\input{tex/sub}\n\nAfter.\n');
  writeFileSync(sub, 'Inside sub.\n');
  const context = { docDir, workDir: docDir, includes: new Map(), diagnostics: [], watchInclude: () => {} };
  const expand = () => expandIncludes(segmentBody('\\input{tex/one}\n\n\\input{tex/two}\n', 0), 0, context);
  try {
    const first = expand();
    const again = expand();
    assert.deepEqual(again, first);
    assert.ok(again.every((seg, i) => seg !== first[i]), 'a kept expansion is handed out as copies');
    again[0].text = 'changed by the caller';
    assert.equal(expand()[0].text, first[0].text, 'what a caller writes into a block stays out of the kept copy');
    // the file's own text changes: its blocks follow (same mtime or not)
    context.includes.set(one, { ...context.includes.get(one), text: 'Rewritten.\n' });
    writeFileSync(one, 'Rewritten.\n');
    assert.equal(expand()[0].text.trim(), 'Rewritten.');
    // a file read through another one is never kept with it
    writeFileSync(sub, 'Inside sub, edited and longer.\n');
    assert.ok(expand().some((seg) => seg.text.includes('edited and longer')));
  } finally {
    rmSync(docDir, { recursive: true, force: true });
  }
});

test('the structural verdict of a body given as blocks is the joined text\'s', async () => {
  const { classifyStructuralAliases, classifyStructuralAliasesOfBlocks } =
    await import('../engine/checkpoint/structural-aliases.js');
  const preamble = String.raw`\documentclass{article}
\usepackage{multicol}
\newenvironment{twocol}{\begin{multicols}{2}}{\end{multicols}}
\newcommand{\cols}{\begin{multicols}{3}}
`;
  const blocks = [
    'Plain text.',
    '\\begin{twocol}\nInside.\n\\end{twocol}',
    'More text with \\emph{emphasis}.',
    '\\cols',
    'Tail.',
  ];
  const plain = (value) => JSON.parse(JSON.stringify(value));
  const same = () => assert.deepEqual(
    plain(classifyStructuralAliasesOfBlocks(preamble, blocks)),
    plain(classifyStructuralAliases(preamble, blocks.join('\n\n'))));
  same();
  blocks[2] += ' One more letter';
  same(); // every other block's scan is kept
  blocks[4] = '\\newcommand{\\late}{\\begin{multicols}{2}}\n\\late';
  same(); // a definition in the body changes what every block's uses mean
  blocks[4] = 'Tail.';
  blocks[0] = '\\def\\twocol{x}\\newenvironment{twocol}{}{}';
  same(); // the same name defined again another way
});

test('an index is compiled from the top of a page, whatever stood above it', async () => {
  const { compileOffset, opensOnFreshPage } = await import('../engine/checkpoint/util/galley.js');
  const index = { text: '\\ifSubfilesClassLoaded{}{\\printindex}\n', pageOffset: 582.53 };
  assert.equal(opensOnFreshPage(index), true);
  assert.equal(compileOffset(index), 0);
  const box = { text: '\\begin{codebox}\nx\n\\end{codebox}\n', pageOffset: 120.13 };
  assert.equal(opensOnFreshPage(box), false);
  assert.equal(compileOffset(box), 120.25, 'every other block keeps its offset, on the quarter-point grid');
  assert.equal(compileOffset({ text: 'Text.' }), 0);
});
