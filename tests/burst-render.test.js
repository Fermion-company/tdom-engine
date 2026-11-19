// Typing faster than an exact picture is made (docs/10 §10.4f): while the
// keys come quickly and the page shows the block composed, a keystroke sends
// no RENDER of its own; the picture is made once when the typing pauses, or
// at once for a galley the page could not compose. What the page shows at
// every keystroke, and at the end, must be what it showed before.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { CheckpointEngine } from '../engine/checkpoint/engine-v3.js';
import {
  BURST_GAP_MS, BURST_PAUSE_MS, deferredRenderQuietMs, typedInBurst,
} from '../engine/checkpoint/render-pump.js';
import { diffBlocks } from '../engine/segmenter.js';
import { drain, signature } from '../tools/harness.mjs';

test('a keystroke belongs to a burst only while the keys come quickly and the block was last shown composed', () => {
  const composed = { galleyHash: 'g1', composedFor: 'g1' };
  assert.equal(typedInBurst({ editGapMs: 150 }, composed), true);
  assert.equal(typedInBurst({ editGapMs: BURST_GAP_MS }, composed), true);
  assert.equal(typedInBurst({ editGapMs: BURST_GAP_MS + 1 }, composed), false, 'slow enough for a picture beside every key');
  assert.equal(typedInBurst({ editGapMs: null }, composed), false, 'the first edit has no key before it');
  assert.equal(typedInBurst({ editGapMs: 150 }, { galleyHash: 'g2', composedFor: 'g1' }), false,
    'its last galley was not shown composed');
  assert.equal(typedInBurst({ editGapMs: 150 }, { galleyHash: 'g1' }), false);
  assert.equal(typedInBurst({ editGapMs: 150 }, { galleyHash: null, composedFor: null }), false, 'a block without a galley');
  assert.equal(typedInBurst({ editGapMs: 150 }, undefined), false);
  // an editor open on the paper (the viewer read a picture's glyph places a moment ago) gets a picture per key
  assert.equal(typedInBurst({ editGapMs: 150, paperEditorUntil: 5_000 }, composed, 4_000), false);
  assert.equal(typedInBurst({ editGapMs: 150, paperEditorUntil: 5_000 }, composed, 5_000), true, 'once that read is old');
  assert.ok(BURST_PAUSE_MS > BURST_GAP_MS, 'the pause is longer than any gap inside a burst');
});

test('a picture left for the pause waits only while the page shows the galley composed', () => {
  assert.equal(deferredRenderQuietMs({ galleyHash: 'g2', composedFor: 'g2' }), BURST_PAUSE_MS);
  assert.equal(deferredRenderQuietMs({ galleyHash: 'g2', composedFor: 'g1' }), 0, 'the page shows an earlier galley: render now');
  assert.equal(deferredRenderQuietMs({ galleyHash: 'g2' }), 0);
  assert.equal(deferredRenderQuietMs({ galleyHash: null, composedFor: null }), 0);
  assert.equal(deferredRenderQuietMs(undefined), 0);
  const composed = { galleyHash: 'g2', composedFor: 'g2' };
  assert.equal(deferredRenderQuietMs(composed, { paperEditorUntil: 5_000 }, 4_000), 0, 'an editor is open on the paper');
  assert.equal(deferredRenderQuietMs(composed, { paperEditorUntil: 5_000 }, 5_000), BURST_PAUSE_MS);
  assert.equal(deferredRenderQuietMs(composed, {}), BURST_PAUSE_MS);
});

test('an edited block keeps the mark of its composed galley only when it was edited in place', () => {
  const block = (id, hash, text) => ({ id, hash, text, start: 0, end: text.length, galley: { items: [] }, galleyHash: 'h' + id,
    composedFor: 'h' + id });
  const seg = (hash, text) => ({ hash, text, start: 0, end: text.length });
  let n = 0;
  const inPlace = diffBlocks([block('A', 'a', 'para'), block('B', 'b', 'tail')], [seg('a2', 'para!'), seg('b', 'tail')], () => ++n);
  assert.equal(inPlace.blocks[0].id, 'A');
  assert.equal(inPlace.blocks[0].composedFor, 'hA');
  assert.equal(inPlace.blocks[1].composedFor, 'hB', 'an unchanged block is the same object');
  const merged = diffBlocks([block('A', 'a', 'para'), block('B', 'b', 'tail')], [seg('ab', 'para\ntail')], () => ++n);
  assert.equal(merged.blocks[0].composedFor, null, 'two blocks in one: not the galley that was shown');
  const split = diffBlocks([block('A', 'a', 'para\ntail')], [seg('a1', 'para'), seg('a2', 'tail')], () => ++n);
  assert.equal(split.blocks[0].composedFor, null);
});

const texReady = spawnSync('lualatex', ['--version']).status === 0;

const SOURCE = String.raw`\documentclass{article}
\begin{document}
Lead paragraph.

MarkerWord holds $x^2+y^2=z^2$ and $\frac{1}{2}$ and $\sqrt{a+b}$ between words of ordinary text that run on.

Tail paragraph.
\end{document}
`;

test('a burst beside a formula sends one RENDER at its start and one when it pauses; every key is on the page composed',
  { skip: !texReady && 'lualatex not installed' }, async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'tdom-burst-render-'));
    const engine = new CheckpointEngine({ workDir: path.join(root, 'work') });
    const own = (patches, id) => patches.filter((patch) => patch.type === 'replace-page')
      .flatMap((patch) => patch.displayList.commands.filter((command) => command.src === id));
    try {
      await engine.open(SOURCE);
      await drain(engine);
      await engine.renderTask;
      const block = () => engine.blocks.find((b) => b.text.includes('MarkerWord'));
      const id = block().id;
      const picture = engine.chunks.get(id);
      assert.equal(picture?.forGalley, block().galleyHash, 'the paragraph has its exact picture');
      assert.equal(picture.anchored, true);
      const type = async (text, { pause }) => {
        // (the engine reads the gap between keystrokes off its own clock)
        engine.lastEditAt = pause ? 0 : Date.now();
        const at = engine.getSource().indexOf(' holds');
        return engine.edit(at, at, text);
      };

      // the first key after a pause: its RENDER leaves beside its JOB, as before
      const first = await type('a', { pause: true });
      assert.ok(block().galley.tdomEarlyRender, 'the first keystroke sent its RENDER');
      assert.ok(!block().renderDeferred);
      assert.equal(engine.renderStats.burstSkipped ?? 0, 0);
      assert.equal(block().composedFor, block().galleyHash, 'and was shown composed');
      assert.ok(own(first.patches, id).some((command) => command.op === 'chunk' && command.part && command.held));

      // the keys that follow quickly send none, and each is on the page with its answer
      let typed = 'a';
      for (const letter of 'bcdefg') {
        const report = await type(letter, { pause: false });
        typed += letter;
        const current = block();
        assert.ok(!current.galley.tdomEarlyRender, `no RENDER beside the JOB of "${letter}"`);
        assert.equal(current.renderDeferred, true);
        assert.equal(current.composedFor, current.galleyHash, 'shown composed');
        const commands = own(report.patches, id);
        const glyphs = commands.filter((command) => command.op === 'glyphs');
        const chunks = commands.filter((command) => command.op === 'chunk');
        assert.ok(glyphs.map((command) => command.text).join('').includes(`MarkerWord${typed}`), `"${typed}" is drawn`);
        assert.ok(!glyphs.some((command) => command.math), 'no formula is left to the browser');
        assert.ok(chunks.length > 0 && chunks.every((command) => command.part && command.held && !command.st),
          JSON.stringify(chunks.slice(0, 2)));
        assert.ok(!commands.some((command) => command.op === 'pending-exact' || command.op === 'canon'));
      }
      assert.equal(engine.renderStats.burstSkipped, 6);
      assert.equal(engine.renderStats.afterBurst ?? 0, 0, 'nothing was rendered for them while the keys came');
      assert.notEqual(engine.chunks.get(id)?.forGalley, block().galleyHash, 'the last key has no picture of its own yet');

      // the typing pauses: the last text gets its own picture, once
      await engine.renderTask;
      await drain(engine);
      const until = Date.now() + 20_000;
      while (Date.now() < until && engine.chunks.get(id)?.forGalley !== block().galleyHash) await new Promise((r) => setTimeout(r, 50));
      assert.equal(engine.chunks.get(id)?.forGalley, block().galleyHash, 'the final text has its own picture');
      assert.equal(engine.renderStats.afterBurst, 1, JSON.stringify(engine.renderStats));
      assert.equal(block().renderDeferred, false);
      const shown = engine.pages.flatMap((page) => page.dl?.commands ?? []).filter((command) => command.src === id);
      assert.ok(shown.some((command) => command.op === 'chunk' && !command.part && !command.held && Array.isArray(command.show)),
        'the page shows the line through its own picture');

      // a viewer that only asks for canonical pixels of some page changes nothing
      await type('p', { pause: true });
      engine.noteDisplayDemand();
      await type('q', { pause: false });
      assert.equal(block().renderDeferred, true, 'a key of a burst');
      // an editor opens on the paper (the viewer reads a picture's glyph
      // places): from then on the keys of a burst send their RENDER again
      const skipped = engine.renderStats.burstSkipped;
      engine.notePaperEditor();
      await type('r', { pause: false });
      assert.ok(!block().renderDeferred, 'no key is left without its RENDER while the editor is open');
      assert.equal(engine.renderStats.burstSkipped, skipped);
      engine.paperEditorUntil = 0; // that read is old
      await engine.renderTask;
      await drain(engine);

      // a slow key after that is rendered beside its JOB again
      await type('h', { pause: true });
      assert.ok(block().galley.tdomEarlyRender, 'a key after the pause sends its RENDER');
      assert.ok(!block().renderDeferred);
      await engine.renderTask;
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

test('a key of a burst the page cannot compose is rendered at once, not at the pause',
  { skip: !texReady && 'lualatex not installed' }, async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'tdom-burst-fallback-'));
    const engine = new CheckpointEngine({ workDir: path.join(root, 'work') });
    try {
      await engine.open(SOURCE);
      await drain(engine);
      await engine.renderTask;
      const block = () => engine.blocks.find((b) => b.text.includes('MarkerWord'));
      const id = block().id;
      assert.equal(engine.chunks.get(id)?.forGalley, block().galleyHash);

      engine.lastEditAt = 0;
      let at = engine.getSource().indexOf(' holds');
      await engine.edit(at, at, 'a');
      engine.lastEditAt = Date.now();
      at = engine.getSource().indexOf(' holds');
      await engine.edit(at, at, 'b');
      assert.equal(block().renderDeferred, true, 'a key of the burst');

      // a letter no formula of the document has drawn, typed into a formula:
      // no run of the picture in hand is the new one, and no outline of it is known
      engine.lastEditAt = Date.now();
      const inside = engine.getSource().indexOf('x^2');
      const started = Date.now();
      const report = await engine.edit(inside, inside + 1, 'Q');
      const current = block();
      assert.ok(!current.galley.tdomEarlyRender, 'the keystroke itself sent none: it looked like the keys before it');
      assert.equal(current.renderDeferred, true);
      assert.notEqual(current.composedFor, current.galleyHash, 'the page could not compose it');
      assert.equal(deferredRenderQuietMs(current), 0);
      const commands = report.patches.filter((patch) => patch.type === 'replace-page')
        .flatMap((patch) => patch.displayList.commands.filter((command) => command.src === id));
      assert.ok(!commands.some((command) => command.part), 'nothing is composed from other ink');

      const hash = current.galleyHash;
      while (Date.now() - started < 20_000 && engine.chunks.get(id)?.forGalley !== hash) await new Promise((r) => setTimeout(r, 5));
      assert.equal(engine.chunks.get(id)?.forGalley, hash, 'its picture landed');
      assert.equal(engine.renderStats.afterBurst, 1);
      assert.equal(block().renderDeferred, false);
      await engine.renderTask;
      await drain(engine);
    } finally {
      await engine.close().catch(() => {});
      rmSync(root, { recursive: true, force: true });
    }
  });
