import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { CheckpointEngine } from '../engine/checkpoint/engine-v3.js';

const available = await promisify(execFile)('lualatex', ['--version'], { timeout: 15_000 }).then(
  () => true,
  () => false
);
const opts = available ? {} : { skip: 'lualatex not installed' };

const SOURCE = String.raw`\documentclass{article}
\title{Old title}
\author{Old author}
\date{Old date}
\begin{document}
\maketitle
Body.
\end{document}
`;

const waitForRescues = async (engine) => {
  const deadline = Date.now() + 15_000;
  while (engine.rescuePumping || engine.rescueQueue.size) {
    assert.ok(Date.now() < deadline, 'maketitle exact rescue should settle');
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
};

const titleDisplay = (engine) => {
  const block = engine.blocks.find((candidate) => candidate.text.includes('\\maketitle'));
  assert.ok(block, 'maketitle block exists');
  const chunks = engine
    .getDisplayLists()
    .flatMap((page) => page.commands.filter((command) => command.op === 'chunk' && command.src === block.id));
  return {
    blockId: block.id,
    galleyItems: block.galley?.items?.length ?? 0,
    chunks,
  };
};

test('maketitle stays visible while title metadata reboots and refreshes', opts, async () => {
  const workDir = mkdtempSync(path.join(tmpdir(), 'tdom-maketitle-'));
  const engine = new CheckpointEngine({ workDir });
  try {
    await engine.open(SOURCE);
    await waitForRescues(engine);
    const initial = titleDisplay(engine);
    assert.ok(initial.galleyItems > 0, 'settled title has real layout items');
    assert.equal(initial.chunks.length, 1, 'settled title is shown by one exact chunk');
    const initialVersion = initial.chunks[0].cv;

    for (const [oldText, newText] of [
      ['Old title', 'New title'],
      ['Old author', 'New author'],
      ['Old date', 'New date'],
    ]) {
      const at = engine.getSource().indexOf(oldText);
      assert.ok(at >= 0, `metadata text ${oldText} exists`);
      const result = await engine.edit(at, at + oldText.length, newText);
      assert.equal(result.stats.rebooted, true, 'metadata edit honestly reboots the preamble');

      const immediate = titleDisplay(engine);
      assert.equal(immediate.blockId, initial.blockId, 'maketitle keeps stable block identity');
      assert.ok(immediate.galleyItems > 0, 'last good maketitle layout never becomes empty');
      assert.equal(immediate.chunks.length, 1, 'last good maketitle pixels remain on screen');
    }

    await waitForRescues(engine);
    const settled = titleDisplay(engine);
    assert.ok(settled.galleyItems > 0, 'refreshed title remains laid out');
    assert.equal(settled.chunks.length, 1, 'refreshed title keeps one exact chunk');
    assert.ok(settled.chunks[0].cv > initialVersion, 'fresh title pixels replace the held chunk');
  } finally {
    await engine.close();
    rmSync(workDir, { recursive: true, force: true });
  }
});

test('two-column maketitle keeps a resident probe behind the exact page surface', opts, async () => {
  const workDir = mkdtempSync(path.join(tmpdir(), 'tdom-maketitle-opaque-'));
  const engine = new CheckpointEngine({ workDir });
  try {
    await engine.open(SOURCE.replace('{article}', '[twocolumn]{article}'));
    assert.equal(engine.mode, 'structured', 'two-column paper retains the resident LuaLaTeX probe');
    assert.equal(engine.previewPolicy, 'canonical-anchor', 'physical pages remain canonical-addressed');
    const pending = [];
    const completed = [];
    engine.onDocumentResetPending = (event) => pending.push(event);
    engine.onDocumentResetComplete = (event) => completed.push(event);

    const at = engine.getSource().indexOf('Old title');
    await engine.edit(at, at + 'Old title'.length, 'New title');
    assert.match(engine.getSource(), /\\title\{New title\}/, 'the metadata edit is applied');
    assert.deepEqual(pending, [], 'the already-presented exact generation is not hidden');
    assert.deepEqual(completed, [], 'no unmatched reset lifecycle is emitted');
  } finally {
    await engine.close();
    rmSync(workDir, { recursive: true, force: true });
  }
});
