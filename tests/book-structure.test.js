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
