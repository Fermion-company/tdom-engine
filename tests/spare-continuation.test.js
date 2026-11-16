// A keystroke's job runs in a spare continuation forked ahead of it
// (daemon.lua SPARE, tdomfork.c): the spare has read the pages the last job
// read and loaded the fonts the last job had to load. What the job typesets
// must be what an ordinary fork typesets, and a block that is the first to
// use a font must stop loading it at every keystroke.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { CheckpointEngine } from '../engine/checkpoint/engine-v3.js';
import { drain } from '../tools/harness.mjs';

const texReady = spawnSync('lualatex', ['--version']).status === 0;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const DOC = String.raw`\documentclass[a4paper,11pt]{ltjsarticle}
\usepackage{amsmath}
\begin{document}
Lead paragraph of plain words, and a second sentence of plain words.

FontMarker abcd uses \LaTeX{} and {\scriptsize small letters} and \textbf{bold letters} for the first time here.

Tail paragraph one, plain words again.

Tail paragraph two, \textbf{bold} again and plain words.
\end{document}
`;

// a galley as what it prints: every run with its font named, not numbered
const printed = (galley) => JSON.stringify([
  galley.w, galley.h, galley.d,
  (galley.items ?? []).map((item) => ({
    ...item,
    runs: item.runs?.map((run) => (run.f == null ? run : {
      ...run, f: `${galley.fonts?.[run.f]?.name}@${galley.fonts?.[run.f]?.size}`,
    })),
  })),
]);

async function openEngine(root, name, env) {
  const docDir = path.join(root, name);
  mkdirSync(docDir, { recursive: true });
  writeFileSync(path.join(docDir, 'main.tex'), DOC);
  const before = { ...process.env };
  Object.assign(process.env, env);
  const engine = new CheckpointEngine({
    workDir: path.join(root, `${name}-work`), docDir, overlayDir: path.join(root, `${name}-overlay`),
  });
  engine.canonical.schedule = () => {};
  try {
    await engine.open(DOC, 'main.tex');
  } finally {
    for (const key of Object.keys(env)) {
      if (before[key] === undefined) delete process.env[key];
      else process.env[key] = before[key];
    }
  }
  await drain(engine, 120_000);
  return engine;
}

test('a keystroke typeset in a spare continuation prints what an ordinary fork prints, and stops loading its fonts',
  { skip: (!texReady && 'lualatex not installed') || (process.platform !== 'darwin' && 'spare continuations need macOS page queries') },
  async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'tdom-spare-'));
    const spared = await openEngine(root, 'spared', {});
    const plain = await openEngine(root, 'plain', { TDOM_NO_SPARES: '1' });
    try {
      let text = DOC;
      const blockOf = (engine) => engine.blocks.find((block) => block.text.includes('FontMarker'));
      const edit = async (at, del, insert) => {
        const [a, b] = await Promise.all([
          spared.edit(at, at + del, insert),
          plain.edit(at, at + del, insert),
        ]);
        text = text.slice(0, at) + insert + text.slice(at + del);
        assert.equal(printed(blockOf(spared).galley), printed(blockOf(plain).galley), `after ${JSON.stringify(insert)}`);
        assert.equal(a.stats.pageCount, b.stats.pageCount);
        return blockOf(spared).galley;
      };
      const marker = text.indexOf('FontMarker abcd') + 'FontMarker a'.length;
      // the first keystroke is an ordinary fork: it loads the block's fonts itself
      const first = await edit(marker, 0, 'x');
      assert.equal(first.spare, undefined, 'no spare before the first keystroke');
      assert.ok(first.fontLoads > 0, `the block is the first user of fonts (${first.fontLoads})`);
      assert.equal(blockOf(plain).galley.fontLoads, first.fontLoads);
      // from then on the spare has them before the job arrives
      let ahead = null;
      for (let k = 0; k < 6; k++) {
        await sleep(250);
        const galley = await edit(marker + 1 + k, 0, 'y');
        if (galley.spare?.fonts > 0) ahead = galley;
      }
      assert.ok(ahead, 'a later keystroke ran in a spare that had loaded the fonts');
      assert.equal(ahead.spare.fonts, first.fontLoads, 'all of them');
      assert.equal(ahead.fontLoads, 0, 'the job itself loaded none');
      assert.ok(blockOf(plain).galley.fontLoads > 0, 'an ordinary fork still loads them at every keystroke');
      // a font used for the first time in front of the others: the spare's
      // fonts come in another order than an ordinary fork's, the print is the same
      await sleep(250);
      const head = text.indexOf('FontMarker');
      await edit(head, 0, String.raw`\textit{slanted} `);
      await sleep(250);
      const after = await edit(head + String.raw`\textit{sl`.length, 0, 'z');
      await sleep(250);
      const settled = await edit(head + String.raw`\textit{slz`.length, 0, 'z');
      assert.ok(settled.spare, 'still in a spare');
      assert.equal(settled.fontLoads, 0, `the new font is loaded ahead too (${after.fontLoads} then ${settled.fontLoads})`);
      await drain(spared, 120_000);
      await drain(plain, 120_000);
      for (let i = 0; i < spared.blocks.length; i++) {
        assert.equal(printed(spared.blocks[i].galley), printed(plain.blocks[i].galley), `block ${i} once settled`);
      }
    } finally {
      await spared.close();
      await plain.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

// A Japanese paragraph with a footnote, a label, bold, a formula and an
// active character: what a spare typesets ahead (daemon.lua warm_text) must
// leave every keystroke's galley as an ordinary fork prints it.
const JA_DOC = String.raw`\documentclass{ltjsarticle}
\catcode126=13 \def~{\textasciitilde}
\begin{document}
\section{はじめに}\label{sec:a}
最初の段落です。日本語の文章が続きます。

WarmMarker 和文と English が混じる段落で、\textbf{太字}と$x^2+y$と脚注\footnote{脚注の文 foot}と~と節~\ref{sec:a}を含みます。日本語の文章が続きます。

後ろの段落です。
\end{document}
`;

test('a Japanese paragraph typed in a spare that typeset it ahead prints what an ordinary fork prints',
  { skip: (!texReady && 'lualatex not installed') || (process.platform !== 'darwin' && 'spare continuations need macOS page queries') },
  async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'tdom-spare-ja-'));
    const open = async (name, env) => {
      const docDir = path.join(root, name);
      mkdirSync(docDir, { recursive: true });
      writeFileSync(path.join(docDir, 'main.tex'), JA_DOC);
      const before = { ...process.env };
      Object.assign(process.env, env);
      const engine = new CheckpointEngine({ workDir: path.join(root, `${name}-work`), docDir, overlayDir: path.join(root, `${name}-overlay`) });
      engine.canonical.schedule = () => {};
      try { await engine.open(JA_DOC, 'main.tex'); } finally {
        for (const key of Object.keys(env)) { if (before[key] === undefined) delete process.env[key]; else process.env[key] = before[key]; }
      }
      await drain(engine, 120_000);
      return engine;
    };
    const warmed = await open('warmed', {});
    const plain = await open('plain', { TDOM_NO_SPARES: '1' });
    try {
      const blockOf = (engine) => engine.blocks.find((block) => block.text.includes('WarmMarker'));
      let at = JA_DOC.indexOf('混じる') + 2;
      let ranWarm = false;
      for (let k = 0; k < 6; k++) {
        if (k) await sleep(300);
        await Promise.all([warmed.edit(at, at, 'あ'), plain.edit(at, at, 'あ')]);
        at += 1;
        assert.equal(printed(blockOf(warmed).galley), printed(blockOf(plain).galley), `keystroke ${k}`);
        ranWarm ||= !!blockOf(warmed).galley.spare;
      }
      assert.ok(ranWarm, 'the keystrokes ran in spares');
      await drain(warmed, 120_000);
      await drain(plain, 120_000);
      for (let i = 0; i < warmed.blocks.length; i++) {
        assert.equal(printed(warmed.blocks[i].galley), printed(plain.blocks[i].galley), `block ${i} once settled`);
        assert.equal(warmed.blocks[i].stateVec, plain.blocks[i].stateVec, `block ${i} exit state`);
      }
    } finally {
      await warmed.close();
      await plain.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

