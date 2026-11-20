// The host sends a caret warm after every keystroke. Typing in a paragraph
// with a formula, the paragraph is without the pixels of its newest text at
// that moment: the warm must ask for its render and typeset nothing, since
// the checkpoints around the caret's block stand (engine-v3.js
// warmEditOffset). It used to walk, and the next keystroke waited for the
// block the walk was in.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { CheckpointEngine } from '../engine/checkpoint/engine-v3.js';
import { drain } from '../tools/harness.mjs';

const texReady = spawnSync('lualatex', ['--version']).status === 0;

const DOC = String.raw`\documentclass{article}
\usepackage{amsmath}
\begin{document}
Lead paragraph of plain words.

MathMarker abcd with $a_1 \le a_2$ and $\frac{n(n-1)}{2}$ comparisons in the text of the paragraph.

\section{A heading after it}

Tail paragraph of plain words, and one more sentence of them.
\end{document}
`;

test('a caret warm right after a keystroke in a paragraph with a formula asks for its render and typesets nothing',
  { skip: !texReady && 'lualatex not installed' }, async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'tdom-caret-warm-'));
    const docDir = path.join(root, 'doc');
    mkdirSync(docDir);
    writeFileSync(path.join(docDir, 'main.tex'), DOC);
    const engine = new CheckpointEngine({ workDir: path.join(root, 'work'), docDir, overlayDir: path.join(root, 'overlay') });
    engine.canonical.schedule = () => {};
    try {
      await engine.open(DOC, 'main.tex');
      await drain(engine, 120_000);
      const at = DOC.indexOf('MathMarker a') + 'MathMarker a'.length;
      const index = engine.blocks.findIndex((block) => block.text.includes('MathMarker'));
      assert.ok(index >= 0);
      assert.equal((await engine.warmEditOffset(at)).status, 'ready');
      await drain(engine, 120_000);
      await engine.edit(at, at, 'x');
      const block = engine.blocks[index];
      const stale = engine.chunkTargetsOf(block).some((chunk) => engine.chunks.get(chunk.key)?.forGalley !== block.galleyHash);
      // every JOB or STEP a checkpoint is sent from here on
      const jobs = [];
      for (const ck of engine.checkpoints.values()) {
        const original = ck.send.bind(ck);
        ck.send = (line) => { if (/^(JOB|STEP) /.test(line)) jobs.push(line.split(' ')[1]); return original(line); };
      }
      const warm = await engine.warmEditOffset(at + 1);
      assert.equal(warm.status, 'ready');
      assert.equal(warm.replayed, 0, 'no block was replayed');
      assert.deepEqual(jobs, [], 'the warm sent no job');
      // (the picture of a one-line edit can land before the warm is asked: then there was nothing to decide)
      if (stale) {
        await drain(engine, 120_000);
        const now = engine.blocks[index];
        assert.ok(engine.chunkTargetsOf(now).every((chunk) => engine.chunks.get(chunk.key)?.forGalley === now.galleyHash),
          'the paragraph got the pixels of its newest text');
      }
    } finally {
      await engine.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
