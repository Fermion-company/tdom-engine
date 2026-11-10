import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { CheckpointEngine } from '../engine/checkpoint/engine-v3.js';
import { drain } from '../tools/harness.mjs';

const source = String.raw`\documentclass{scrartcl}
\title{First page title}\author{Author}\date{}
\begin{document}
\maketitle

FirstPageWitness.

\begin{tabular}{ll}
A3 & ordinary % EDIT:table-cell
\\
\end{tabular}

\clearpage
\section{Second page}
SecondPageWitness stays on its own page.
\end{document}`;

for (const cold of [false, true]) {
  test(`isolated title preserves physical page slots through a cell edit (${cold ? 'cold' : 'fork'})`, async () => {
    const previous = process.env.TDOM_ISO_COLD;
    if (cold) process.env.TDOM_ISO_COLD = '1';
    else delete process.env.TDOM_ISO_COLD;
    const root = mkdtempSync(path.join(tmpdir(), 'tdom-page-slots-'));
    const engine = new CheckpointEngine({ workDir: root });
    // Control the authority boundary explicitly; no timer race with the
    // canonical compile may hide an incorrectly addressed provisional page.
    engine.canonical.schedule = () => {};
    try {
      await engine.open(source);
      await drain(engine);
      await engine.renderTask;
      assert.equal(engine.mode, 'structured');
      const canonical = await engine.canonical.ensure(source, engine.srcRev);
      const texts = await engine.canonical.pageTexts(canonical.id);
      assert.equal(texts.length, 2);
      assert.match(texts[0], /FirstPageWitness/);
      assert.match(texts[1], /SecondPageWitness/);
      await drain(engine);
      await engine.renderTask;

      const title = engine.blocks.find(block => block.text.includes('\\maketitle'));
      const first = engine.blocks.find(block => block.text.includes('FirstPageWitness'));
      const second = engine.blocks.find(block => block.text.includes('SecondPageWitness'));
      assert.ok(title.rescued, 'the fixture exercises isolated output');
      assert.ok(title.galley.items.some(item => item.k === 'eject' && item.v === -10001),
        'clearpage keeps the special-output discard/float-flush signal');

      const frames = [];
      const record = () => frames.push(structuredClone(engine.getDisplayLists()));
      record();
      const secondPage = frames[0][1];
      engine.onAsyncPatches = record;
      engine.onDeferredUpdate = record;
      const at = source.indexOf('% EDIT:table-cell');
      const report = await engine.edit(at, at, 'ZQX7 ');
      record();
      await drain(engine);
      await engine.renderTask;
      record();

      assert.equal(engine.canonical.info().rev, 1, 'every recorded edit frame precedes canonical');
      assert.ok(report.patches.some(patch => patch.page === 1));
      for (const pages of frames) {
        assert.deepEqual(pages.map(page => page.page), [1, 2], 'no phantom page or shifted address');
        const owners = pages.map(page => new Set(page.commands.map(command => command.src)));
        assert.ok(owners[0].has(title.id) && owners[0].has(first.id));
        assert.ok(!owners[1].has(title.id) && !owners[1].has(first.id));
        assert.ok(owners[1].has(second.id) && !owners[0].has(second.id));
        assert.deepEqual(pages[1], secondPage, 'the untouched page retains its exact display list');
      }
    } finally {
      await engine.close();
      rmSync(root, { recursive: true, force: true });
      if (previous === undefined) delete process.env.TDOM_ISO_COLD;
      else process.env.TDOM_ISO_COLD = previous;
    }
  });
}
