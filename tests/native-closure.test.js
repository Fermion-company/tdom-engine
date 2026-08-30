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

test('a recovered native TeX error holds the last successful galley', opts, async () => {
  const workDir = mkdtempSync(path.join(tmpdir(), 'tdom-native-closure-'));
  const engine = new CheckpointEngine({ workDir });
  try {
    await engine.open(String.raw`\documentclass{article}
\begin{document}
Good output.
\end{document}
`);
    const block = engine.blocks.find((candidate) => candidate.text.includes('Good output'));
    const goodHash = block.galleyHash;
    const at = engine.getSource().indexOf('Good output');
    const badText = String.raw`\DefinitelyUndefined{bad}`;
    await engine.edit(at, at + 'Good output'.length, badText);
    const deferred = engine.blocks.find((candidate) => candidate.id === block.id);
    assert.equal(deferred.galleyHash, goodHash, 'native recovery output is never adopted');
    assert.equal(deferred.galley?.tdomDeferred, true, 'last good galley is explicitly held');
    assert.equal(deferred.closure?.reason, 'native-error', 'LuaLaTeX is the semantic closure authority');

    const fixAt = engine.getSource().indexOf(badText);
    await engine.edit(fixAt, fixAt + badText.length, 'Good output again');
    const healed = engine.blocks.find((candidate) => candidate.id === block.id);
    assert.equal(healed.closure?.native, true, 'successful native certificate replaces the hold');
    assert.equal(healed.galley?.tdomDeferred, undefined);
    assert.notEqual(healed.galleyHash, goodHash, 'fresh successful layout is adopted');
  } finally {
    await engine.close();
    rmSync(workDir, { recursive: true, force: true });
  }
});
