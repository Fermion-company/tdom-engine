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

test('absorbed page ejects do not accumulate dead cycles along the lineage', opts, async () => {
  // The dormant absorb never ships, so every fire is a dead cycle, and
  // LuaTeX ignores a tex.deadcycles assignment. Without TeX's own reset each
  // \clearpage (two fires) counted toward \maxdeadcycles=200 across the fork
  // lineage, and past ~100 pages every later eject died with "Output loop".
  // A small \maxdeadcycles reproduces that within a few pages.
  const workDir = mkdtempSync(path.join(tmpdir(), 'tdom-dead-cycles-'));
  const engine = new CheckpointEngine({ workDir });
  try {
    const pages = Array.from({ length: 6 }, (_, i) => `Page ${i + 1}.\n\\clearpage`).join('\n\n');
    await engine.open(`\\documentclass{article}
\\begin{document}
\\maxdeadcycles=5

${pages}
\\end{document}
`);
    const pageBlocks = engine.blocks.filter((candidate) => /^Page \d/.test(candidate.text));
    assert.equal(pageBlocks.length, 6);
    for (const block of pageBlocks) {
      assert.equal(block.closure?.native, true, `${block.text.split('\n')[0]} certifies natively`);
      assert.equal(block.galley?.tdomDeferred, undefined);
    }

    const at = engine.getSource().indexOf('Page 6.');
    await engine.edit(at + 'Page 6'.length, at + 'Page 6'.length, ' again');
    const edited = engine.blocks.find((candidate) => candidate.text.startsWith('Page 6 again.'));
    assert.equal(edited?.closure?.native, true, 'an edit deep in the lineage still certifies natively');
  } finally {
    await engine.close();
    rmSync(workDir, { recursive: true, force: true });
  }
});
