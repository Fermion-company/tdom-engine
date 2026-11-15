// A keystroke of prose in front of a block that is slow to typeset again is
// shown before that block is verified (plain-preview.js). The admission must
// take ordinary typing in any paragraph, of an included file too, and refuse
// anything TeX could read as more than characters to print.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { CheckpointEngine } from '../engine/checkpoint/engine-v3.js';
import { proseKeystroke } from '../engine/checkpoint/plain-preview.js';
import { drain, signature } from '../tools/harness.mjs';

const TEXT = 'ソート比較の詳細は \\ref{sec:a} 節で\\textbf{説明}されています。 Plain words follow, $x+y$ too.';
const prose = (before, after) => !!proseKeystroke(before && { text: before }, { text: after });
const typed = (from, to) => prose(TEXT, TEXT.replace(from, to));

test('ordinary characters typed into printed prose are a prose keystroke', () => {
  assert.equal(typed('詳細は', '詳細あは'), true);
  assert.equal(typed('比較', '比'), true, 'a deletion');
  assert.equal(typed('説明', '説明する'), true, 'inside the argument of a text command');
  assert.equal(typed('words', 'wor ds'), true, 'a space');
  assert.equal(typed('Plain words', 'Plain several words'), true, 'a pasted word');
});

test('anything TeX reads as syntax, or outside printed prose, is not', () => {
  assert.equal(typed('sec:a', 'sec:ab'), false, 'a label key');
  assert.equal(typed('\\ref', '\\refx'), false, 'a command name');
  assert.equal(typed('節で', '節\\bfseries で'), false, 'a command');
  assert.equal(typed('節で', '節{で'), false, 'a brace');
  assert.equal(typed('words', 'wor\nds'), false, 'a line break');
  assert.equal(typed('words', 'wor%ds'), false, 'a comment sign');
  assert.equal(typed('x+y', 'x+y+z'), false, 'mathematics');
  assert.equal(prose(TEXT, TEXT.replace('ソート', 'ソートa').replace('います', 'いまxす')), false, 'two places at once');
  assert.equal(prose(TEXT, TEXT), false, 'no change');
  assert.equal(prose('\\let\\a bcd', '\\let\\a xbcd'), false, 'the character a command in front may take');
  assert.equal(prose('One.', 'One. \\begin{quote}x\\end{quote}'), false);
  assert.equal(prose(null, 'x'), false);
  assert.deepEqual(proseKeystroke({ text: 'Plain words.' }, { text: 'Plain new words.' }), { inserted: 'new ', removed: '' });
});

const texReady = spawnSync('lualatex', ['--version']).status === 0;

test('a prose keystroke in an included chapter is shown before the heavy block after it is verified',
  { skip: !texReady && 'lualatex not installed' }, async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'tdom-prose-keystroke-'));
    const docDir = path.join(root, 'doc');
    const overlayDir = path.join(root, 'overlay');
    mkdirSync(docDir);
    mkdirSync(overlayDir);
    const chapter = String.raw`Lead paragraph.

PlainMarker abcd with \textbf{bold} words and Section~\ref{sec:end} named.

\begin{tcolorbox}
Next graphics witness.
\end{tcolorbox}

Tail paragraph.

\section{End}\label{sec:end}
Last.
`;
    writeFileSync(path.join(docDir, 'chapter.tex'), chapter);
    const source = String.raw`\documentclass{article}
\usepackage{fontspec}
\usepackage{tcolorbox}
\begin{document}
\input{chapter}
\end{document}`;
    const engine = new CheckpointEngine({ workDir: path.join(root, 'work'), docDir, overlayDir });
    let text = chapter;
    const edit = async (from, to) => {
      text = text.replace(from, to);
      writeFileSync(path.join(overlayDir, 'chapter.tex'), text);
      return engine.edit(0, 0, '', engine.file, { changed: [path.join(docDir, 'chapter.tex')] });
    };
    try {
      await engine.open(source, 'main.tex');
      await drain(engine);
      const original = engine.blocks.find((block) => block.text.includes('PlainMarker'));
      assert.ok(original.file, 'the paragraph comes from the included file');
      for (const [from, to] of [['abcd', 'abcde'], ['abcde', 'abcdef'], ['abcdef', 'abcde']]) {
        const report = await edit(from, to);
        assert.equal(report.stats.chainVerdict, 'verify', JSON.stringify(report.stats));
        assert.equal(report.stats.blocksTypeset, 1, 'the box after the paragraph is not on the response path');
        assert.equal(engine.pendingChain?.plainBlockId, original.id, 'its verification is still owed');
      }
      await drain(engine);
      assert.equal(engine.pendingChain, null, 'and is done once the typing stops');
      // a command typed into the same paragraph takes the ordinary, verified path
      const command = await edit('abcde', 'abcde \\itshape leaks');
      assert.notEqual(command.stats.chainVerdict, 'verify');
      await drain(engine);
      const incremental = signature(engine);
      const finalText = text;
      await engine.close();
      writeFileSync(path.join(docDir, 'chapter.tex'), finalText);
      const fresh = new CheckpointEngine({ workDir: path.join(root, 'fresh'), docDir });
      try {
        await fresh.open(source, 'main.tex');
        await drain(fresh);
        assert.deepEqual(signature(fresh), incremental, 'the result is that of a fresh engine on the final text');
      } finally {
        await fresh.close();
      }
    } finally {
      await engine.close().catch(() => {});
      rmSync(root, { recursive: true, force: true });
    }
  });

test('a prose keystroke in a plain single-file article leaves the paragraph after it for later, and the next one does not wait',
  { skip: !texReady && 'lualatex not installed' }, async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'tdom-prose-plain-'));
    const paragraphs = Array.from({ length: 8 }, (_, i) =>
      `Paragraph ${i + 1} of an ordinary article, PlainWord${i + 1} here, long enough to run over a second line of the text block when it is typeset.`);
    const source = ['\\documentclass{article}', '\\begin{document}', paragraphs.join('\n\n'), '\\end{document}', ''].join('\n');
    const engine = new CheckpointEngine({ workDir: path.join(root, 'work') });
    try {
      await engine.open(source);
      await drain(engine);
      const original = engine.blocks.find((block) => block.text.includes('PlainWord4'));
      const waits = [];
      for (let k = 0; k < 9; k++) {
        const at = engine.getSource().indexOf('PlainWord4') + 'PlainWord4'.length;
        const report = k % 3 === 2 ? await engine.edit(at, at + 1, '') : await engine.edit(at, at, 'x');
        assert.equal(report.stats.chainVerdict, 'verify', JSON.stringify(report.stats));
        assert.equal(report.stats.blocksTypeset, 1, 'the paragraph after it is not on the response path');
        assert.equal(engine.pendingChain?.plainBlockId, original.id, 'its verification is still owed');
        // The verification waits behind an idle gate that sleeps 25 ms at a
        // time; the keystroke that follows ends the sleep instead of waiting
        // it out (background-scheduler.js).
        if (k > 0) waits.push(engine.lastLock.lockedAtEpochMs - engine.lastLock.entryAtEpochMs);
      }
      waits.sort((a, b) => a - b);
      assert.ok(waits[waits.length >> 1] < 12, `keystrokes waited for the chain: ${waits.join(', ')} ms`);
      await drain(engine);
      assert.equal(engine.pendingChain, null, 'the verification is done once the typing stops');
      // one that adds a line is verified before it is answered
      const at = engine.getSource().indexOf('PlainWord4');
      const wrap = await engine.edit(at, at, 'several more words that push the paragraph over into another line of text ');
      assert.notEqual(wrap.stats.chainVerdict, 'verify');
      await drain(engine);
      const incremental = signature(engine);
      const finalSource = engine.getSource();
      await engine.close();
      const fresh = new CheckpointEngine({ workDir: path.join(root, 'fresh') });
      try {
        await fresh.open(finalSource);
        await drain(fresh);
        assert.deepEqual(signature(fresh), incremental, 'the result is that of a fresh engine on the final text');
      } finally {
        await fresh.close();
      }
    } finally {
      await engine.close().catch(() => {});
      rmSync(root, { recursive: true, force: true });
    }
  });
