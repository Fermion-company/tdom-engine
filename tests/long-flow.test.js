// A document that runs longer than \maxdimen of material without a page
// break of its own (about 23 pages of an 11 pt text). The resident TeX keeps
// every block on one dormant page of that height; its running total has to
// be put back to nothing after every block (daemon.lua reset_page_so_far),
// or the page builder fires in the middle of a paragraph and the layout gets
// a page break the document does not have.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { CheckpointEngine } from '../engine/checkpoint/engine-v3.js';
import { drain } from '../tools/harness.mjs';

const texReady = spawnSync('lualatex', ['--version']).status === 0;

// 60 blocks of 400 pt each: 24,000 pt, one and a half times \maxdimen
const BLOCKS = 60;
const SOURCE = [
  String.raw`\documentclass{article}`,
  String.raw`\begin{document}`,
  ...Array.from({ length: BLOCKS }, (_, i) => `\\noindent\\rule{2pt}{400pt} Tall block ${i + 1}.\n`),
  String.raw`\end{document}`,
  '',
].join('\n');

const ejects = (engine) => engine.blocks
  .filter((block) => (block.galley?.items ?? []).some((item) => item.k === 'eject'))
  .map((block) => block.text.match(/Tall block (\d+)/)?.[1]);

async function layout(root, name) {
  const engine = new CheckpointEngine({ workDir: path.join(root, name) });
  try {
    await engine.open(SOURCE);
    await drain(engine, 120_000);
    return { blocks: engine.blocks.length, pages: engine.pages.length, ejects: ejects(engine) };
  } finally {
    await engine.close();
  }
}

test('a flow longer than \\maxdimen is paginated as LuaLaTeX paginates it: no page break of the engine\'s own',
  { skip: !texReady && 'lualatex not installed' }, async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'tdom-long-flow-'));
    try {
      // what LuaLaTeX itself makes of it
      writeFileSync(path.join(root, 'real.tex'), SOURCE);
      spawnSync('lualatex', ['-interaction=batchmode', 'real.tex'], { cwd: root });
      const realPages = Number(readFileSync(path.join(root, 'real.log'), 'utf8').match(/Output written on [^(]*\((\d+) pages?/)?.[1]);
      assert.ok(realPages >= BLOCKS / 2, `LuaLaTeX made ${realPages} pages`);

      const resident = await layout(root, 'work');
      assert.equal(resident.blocks, BLOCKS);
      assert.deepEqual(resident.ejects, [], 'no block carries a page break the document does not have');
      assert.equal(resident.pages, realPages, 'the same number of pages as LuaLaTeX');

      // without the reset, the dormant page's total reaches \maxdimen on the
      // way and the builder fires: this is what the reset is there for
      process.env.TDOM_NO_PAGE_RESET = '1';
      try {
        const unreset = await layout(root, 'work-unreset');
        assert.ok(unreset.ejects.length > 0, 'without the reset a block past \\maxdimen gets an eject');
        assert.ok(Number(unreset.ejects[0]) > 30, `the first one where the total passes \\maxdimen (block ${unreset.ejects[0]})`);
      } finally {
        delete process.env.TDOM_NO_PAGE_RESET;
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
