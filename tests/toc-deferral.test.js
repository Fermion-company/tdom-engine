// An edit that moves headings to other pages changes the table of contents.
// When none of the edit's pages shows the table of contents, the keystroke
// is answered without typesetting it again: the settle pass does that once
// the typing is quiet (update-typeset-phase.js, chain-pass.js
// chainAfterPass). The end state must be the one a fresh engine gives.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { CheckpointEngine } from '../engine/checkpoint/engine-v3.js';
import { drain, signature } from '../tools/harness.mjs';

const texReady = spawnSync('lualatex', ['--version']).status === 0;

const paragraph = (n) => `Paragraph ${n} of the section, long enough to fill a few lines of the page with ordinary words that ` +
  'carry on for a while so that the page fills up and the next heading has to move along with the text.';
const section = (s) => [`\\section{Section ${s}}`, ...Array.from({ length: 6 }, (_, i) => paragraph(`${s}.${i + 1}`))].join('\n\n');
const SOURCE = ['\\documentclass{article}', '\\begin{document}', '\\tableofcontents', '\\clearpage',
  ...Array.from({ length: 6 }, (_, i) => section(i + 1)), '\\end{document}', ''].join('\n\n');

test('an edit that moves headings to other pages leaves the table of contents to the settle pass, and ends as a fresh engine does',
  { skip: !texReady && 'lualatex not installed' }, async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'tdom-toc-defer-'));
    const engine = new CheckpointEngine({ workDir: path.join(root, 'work') });
    try {
      await engine.open(SOURCE);
      await drain(engine);
      const toc = engine.blocks.find((block) => block.consumesToc);
      assert.ok(toc?.galley, 'the table of contents is typeset');
      const tocBefore = JSON.stringify(toc.galley.items);
      // a long paragraph in section 2: every heading after it moves on
      const at = engine.getSource().indexOf('Paragraph 2.3');
      const report = await engine.edit(at, at, Array.from({ length: 12 }, (_, i) => paragraph(`new ${i}`)).join('\n\n') + '\n\n');
      assert.equal(engine.blocks.find((block) => block.id === toc.id).galley.items.length > 0, true);
      assert.ok(!report.dirtySemanticNodes.includes('blk-' + toc.id), 'the table of contents was not typeset with the edit');
      assert.equal(engine.tocOwed, true, 'it is owed to the settle pass');
      assert.notEqual(engine.pendingChain?.from, toc && engine.blocks.indexOf(engine.blocks.find((block) => block.id === toc.id)),
        'and not queued in front of the paragraph typed in while the typing goes on');
      // the typing goes on in a later paragraph: still shown before the paragraph after it is verified
      // (the caret warmed there first, as the host does: twelve new paragraphs left no checkpoint near it)
      assert.equal((await engine.warmEditOffset(engine.getSource().indexOf('Paragraph 4.2'))).status, 'ready');
      assert.equal(engine.tocOwed, true, 'the warm did not settle it');
      for (let k = 0; k < 3; k++) {
        const word = engine.getSource().indexOf('Paragraph 4.2') + 'Paragraph 4.2'.length;
        const keystroke = await engine.edit(word, word, 'x');
        assert.equal(keystroke.stats.chainVerdict, 'verify', JSON.stringify(keystroke.stats));
        assert.equal(keystroke.stats.blocksTypeset, 1, 'the paragraph after it is not on the response path');
        assert.equal(engine.tocOwed, true, 'the table of contents is still owed while the typing goes on');
      }
      await drain(engine);
      assert.equal(engine.tocOwed, false);
      const tocAfter = JSON.stringify(engine.blocks.find((block) => block.id === toc.id).galley.items);
      assert.notEqual(tocAfter, tocBefore, 'once quiet, the table of contents shows the new page numbers');
      const incremental = signature(engine);
      const text = engine.getSource();
      const fresh = new CheckpointEngine({ workDir: path.join(root, 'fresh') });
      try {
        await fresh.open(text);
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
