// A block's units (what the page builder lays out; the identity of every
// page they stand on) are kept when the galley adopted is the one they were
// made from. Walks that typeset blocks again without changing them (to
// rebuild checkpoints after a keystroke, after opening) used to leave other
// units in every block they passed, and the next keystroke paginated all
// their pages again (galley-adoption.js unitsStillHold).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { adoptGalleyBlock } from '../engine/checkpoint/galley-adoption.js';
import { CheckpointEngine } from '../engine/checkpoint/engine-v3.js';
import { drain } from '../tools/harness.mjs';

const line = (text) => ({ k: 'box', w: 300, h: 8, d: 2, runs: [{ t: text, f: 'f1', x: 0 }] });
const galleyOf = (text, extra = {}) => ({
  items: [line(text), { k: 'glue', a: 3 }, line(`${text} again`)], floats: [], w: 300, h: 21, d: 2, events: [],
  backend: { name: 'luatex', version: 1 }, state: {}, ...extra,
});
const fidelityOf = (exactLines = 0) => ({
  level: exactLines ? 'exact-preview' : 'safe-glyph', exact: exactLines > 0, blockExact: false, canonicalOnly: false, noBridge: false,
  itemFlags: [exactLines ? 1 : 0, 0, 0], exactRuns: [], floats: new Map(), ins: new Map(), lines: 2, exactLines,
});
// adoption as the engine runs it, with a fidelity gate that answers `fidelity()`
const adopter = (chunks, fidelity) => (block, galley) => adoptGalleyBlock(block, galley, {
  counters: [], chunks, headingRe: /^\\section/,
  applyFidelity: (b) => {
    const fid = fidelity();
    b.fidelity = fid;
    b.needsRender = !b.rescued && !fid.canonicalOnly && fid.exact;
    b.units = null;
  },
});
// (what units.js leaves on a block it has built units for)
const built = (block) => (block.units = [{ t: 'box', blockId: block.id, for: block.galleyHash }]);

test('units are kept when the galley adopted is the one they were made from, and only then', () => {
  const chunks = new Map();
  let exactLines = 0;
  const adopt = adopter(chunks, () => fidelityOf(exactLines));
  const block = { id: 'b1', text: 'Some text.', hash: 'h1' };
  adopt(block, galleyOf('one'));
  assert.equal(block.units, null, 'a first galley: nothing to keep');
  const units = built(block);
  const hash = block.galleyHash;

  // the same boxes again, in another object (a walk passed over the block)
  adopt(block, galleyOf('one'));
  assert.equal(block.galleyHash, hash);
  assert.equal(block.units, units, 'the same units, not equal ones');
  // …any number of times
  adopt(block, galleyOf('one'));
  assert.equal(block.units, units);

  // other boxes
  adopt(block, galleyOf('two'));
  assert.equal(block.units, null);
  let kept = built(block);
  adopt(block, galleyOf('two'));
  assert.equal(block.units, kept);

  // the same boxes read with another fidelity (a font tier changed)
  exactLines = 1;
  adopt(block, galleyOf('two'));
  assert.equal(block.units, null, 'another fidelity lays the block out anew');
  kept = built(block);
  // …now a block that needs exact pixels and has none yet: nothing earlier to stand in, the units hold
  adopt(block, galleyOf('two'));
  assert.equal(block.units, kept);
  // its own pixels are in: the units hold, and no earlier galley is held any more
  chunks.set('b1', { forGalley: block.galleyHash, anchored: true });
  adopt(block, galleyOf('two'));
  assert.equal(block.units, kept);
  assert.equal(block.exactHistory, null, 'as buildStream leaves it for a block whose own pixels are in');
  // its pixels are those of an earlier galley: the stream decides anew what stands in
  chunks.set('b1', { forGalley: 'another-galley', anchored: true });
  adopt(block, galleyOf('two'));
  assert.equal(block.units, null);
  kept = built(block);
  chunks.delete('b1');
  adopt(block, galleyOf('two'));
  assert.equal(block.units, kept);
  // a picture put together for it is still there
  chunks.set('b1~s', { forGalley: block.galleyHash });
  adopt(block, galleyOf('two'));
  assert.equal(block.units, null);
  chunks.delete('b1~s');
  kept = built(block);

  // another backend, by what it says
  adopt(block, galleyOf('two', { backend: { name: 'luatex', version: 1 } }));
  assert.equal(block.units, kept, 'the same backend in another object');
  adopt(block, galleyOf('two', { backend: { name: 'luatex', version: 2 } }));
  assert.equal(block.units, null);
  kept = built(block);
  adopt(block, galleyOf('two', { backend: { name: 'luatex', version: 2 } }));
  assert.equal(block.units, kept);

  // a galley still waiting for its paint, a cold preview, a stale stand-in: laid out anew
  for (const extra of [{ tdomPendingPaint: true }, { tdomColdPreview: { iso: true } }, { tdomStale: true }]) {
    built(block);
    adopt(block, galleyOf('two', { backend: { name: 'luatex', version: 2 }, ...extra }));
    assert.equal(block.units, null, JSON.stringify(extra));
    // …and so is the galley after it
    built(block);
    adopt(block, galleyOf('two', { backend: { name: 'luatex', version: 2 } }));
    if (!extra.tdomStale) assert.equal(block.units, null, `after ${JSON.stringify(extra)}`);
  }
});

const texReady = spawnSync('lualatex', ['--version']).status === 0;

const PARAGRAPHS = 90;
const SOURCE = [
  String.raw`\documentclass{article}`,
  String.raw`\begin{document}`,
  ...Array.from({ length: PARAGRAPHS }, (_, i) =>
    `Paragraph ${i + 1} marker${i + 1}x. ${'These are ordinary words that fill a few lines of the page so that the document runs over several pages. '.repeat(3)}\n`),
  String.raw`\end{document}`,
  '',
].join('\n');

test('a keystroke after the engine has walked the document again replaces the page it is on, not the pages after it',
  { skip: !texReady && 'lualatex not installed' }, async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'tdom-units-kept-'));
    const engine = new CheckpointEngine({ workDir: path.join(root, 'work') });
    engine.canonical.schedule = () => {};
    const replacedBy = async (edit) => {
      const before = engine.pages;
      await edit();
      assert.equal(engine.pages.length, before.length);
      return engine.pages.map((page, i) => (page === before[i] ? 0 : page.number)).filter(Boolean);
    };
    const settle = async () => {
      await drain(engine, 120_000);
      await engine.renderTask;
      await new Promise((resolve) => setTimeout(resolve, 300));
      await drain(engine, 120_000);
    };
    try {
      await engine.open(SOURCE);
      await settle();
      assert.ok(engine.pages.length >= 6, `${engine.pages.length} pages`);
      const middle = Math.floor(PARAGRAPHS / 2);
      // (each letter goes in after the one before it)
      let caret = engine.getSource().indexOf(`marker${middle}x`) + `marker${middle}`.length;
      assert.ok(caret > 1000);
      const type = (letter) => engine.edit(caret, caret++, letter);
      const own = () => {
        const id = engine.blocks.find((block) => block.text.includes(`marker${middle}`)).id;
        return engine.pages.filter((page) => (page.draw ?? []).some((d) => d.u?.blockId === id)).map((page) => page.number);
      };
      // The snapshot's entry of a block is kept through such a walk too: a
      // galley adopted again with the same labels and references is the same
      // core, and nothing of the entry is rebuilt (inspector.js sameGalleyParts).
      const entries = engine.getDOM().blocks;
      // the first key after opening (the walk that built the chain has passed every block)
      const first = await replacedBy(() => type('a'));
      assert.deepEqual(first, own(), `the first keystroke replaced pages ${first.join(',')}; the paragraph is on ${own().join(',')}`);
      for (const letter of 'bcd') {
        const pages = await replacedBy(() => type(letter));
        assert.deepEqual(pages, own());
      }
      // the typing pauses: the engine walks on from the paragraph to rebuild what follows it
      await settle();
      {
        const now = engine.getDOM().blocks;
        const edited = engine.blocks.findIndex((block) => block.text.includes(`marker${middle}`));
        let same = 0;
        for (let i = 0; i < edited; i++) if (now[i] === entries[i]) same++;
        assert.equal(same, edited, 'the blocks before the paragraph keep their entries, object for object');
        const { domEntriesDifferInPlaceOnly } = await import('../engine/checkpoint/inspector.js');
        for (let i = edited + 1; i < now.length; i++) {
          assert.ok(now[i] === entries[i] || domEntriesDifferInPlaceOnly(entries[i], now[i]), `the entry of block ${i} differs in more than its place`);
        }
      }
      const afterRest = await replacedBy(() => type('e'));
      assert.deepEqual(afterRest, own(), `the first keystroke after a rest replaced pages ${afterRest.join(',')}`);
      // and the pages are what a fresh engine makes of the same text
      await settle();
      const shown = engine.pages.map((page) => (page.draw ?? []).map((d) => `${d.u?.blockId ? engine.blocks.findIndex((b) => b.id === d.u.blockId) : '-'}@${Math.round(d.y * 100)}`).join(' '));
      const source = engine.getSource();
      await engine.close();
      const fresh = new CheckpointEngine({ workDir: path.join(root, 'fresh') });
      fresh.canonical.schedule = () => {};
      try {
        await fresh.open(source);
        await drain(fresh, 120_000);
        const want = fresh.pages.map((page) => (page.draw ?? []).map((d) => `${d.u?.blockId ? fresh.blocks.findIndex((b) => b.id === d.u.blockId) : '-'}@${Math.round(d.y * 100)}`).join(' '));
        assert.deepEqual(shown, want, 'every line of every page stands where a fresh engine puts it');
      } finally {
        await fresh.close();
      }
    } finally {
      await engine.close().catch(() => {});
      rmSync(root, { recursive: true, force: true });
    }
  });
