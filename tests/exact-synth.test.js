// A keystroke inside a formula: the formula's picture is put together from
// the outlines of glyphs in pictures already made (exact-synth.js), and the
// line is composed out of it until the real picture lands. The picture put
// together must draw what the real one draws, and nothing that cannot be
// drawn exactly may be put together.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { learnOutlines, synthesizeExactPicture, synthChunkKey } from '../engine/checkpoint/exact-synth.js';
import { buildStream, prepareUnpaintedFormula } from '../engine/checkpoint/stream.js';
import { CheckpointEngine } from '../engine/checkpoint/engine-v3.js';
import { drain } from '../tools/harness.mjs';

// A galley of one line: text, then the formula `xy` (one run) and a rule.
const galley = () => ({
  w: 200,
  items: [
    { k: 'box', h: 8, d: 2, runs: [
      { t: 'Ab', f: 'Ftext', s: 10, x: 0, dy: 0, w: 12, gh: 7, gd: 0, c: '#000000' },
      { t: 'xy', f: 'Fmath', s: 10, x: 20, dy: 0, w: 11, gh: 5, gd: 2, m: 1, gp: [0, 5.5], c: '#000000' },
      { rule: true, x: 40, dy: -3, w: 6, h: 0.4, c: '#000000' },
    ] },
  ],
});
const fidelity = { itemFlags: [1], exactRuns: [[1, 2]] };
// the converter's picture of it: one outline per glyph, one <use> per galley glyph in order
const PICTURE = '<svg><defs><g>' +
  '<g id="glyph-0-0"><path d="M 0 0 L 1 -7 Z"/></g><g id="glyph-0-1"><path d="M 0 0 L 2 -6 Z"/></g>' +
  '<g id="glyph-1-0"><path d="M 0 0 L 3 -5 Z"/></g><g id="glyph-1-1"><path d="M 0 2 L 4 -5 Z"/></g>' +
  '</g></defs><g><use xlink:href="#glyph-0-0" x="12" y="8"/><use xlink:href="#glyph-0-1" x="18" y="8"/>' +
  '<use xlink:href="#glyph-1-0" x="32" y="8"/><use xlink:href="#glyph-1-1" x="37.5" y="8"/></g></svg>';

test('formula glyphs are learned by font and slot, text glyphs are not', () => {
  const store = new Map();
  assert.equal(learnOutlines(PICTURE, galley(), store), 2);
  assert.deepEqual([...store.keys()], [`Fmath|${'x'.codePointAt(0)}`, `Fmath|${'y'.codePointAt(0)}`]);
  assert.equal(store.get(`Fmath|${'y'.codePointAt(0)}`), '<path d="M 0 2 L 4 -5 Z"/>');
  assert.equal(learnOutlines(PICTURE, galley(), store), 0, 'nothing new the second time');
});

test('a formula is put together where the galley puts its glyphs, and refused when one glyph is unknown', () => {
  const store = new Map();
  learnOutlines(PICTURE, galley(), store);
  const g = galley();
  // the keystroke made the run `yx`: other order, other places
  g.items[0].runs[1] = { ...g.items[0].runs[1], t: 'yx', x: 25, gp: [0, 4.75] };
  const picture = synthesizeExactPicture(g, fidelity, store, 10);
  assert.ok(picture);
  assert.equal(picture.xBp, -10);
  assert.equal(picture.logicalWBp, 200);
  assert.equal(picture.hBp, 10);
  const uses = [...picture.svg.matchAll(/<use xlink:href="#(glyph-s-\d+)" x="([^"]+)" y="([^"]+)"/g)]
    .map((m) => [m[1], Number(m[2]), Number(m[3])]);
  assert.deepEqual(uses.map((u) => u.slice(1)), [[35, 8], [39.75, 8]], 'pad + run x + glyph offset, on the baseline');
  const outline = (id) => picture.svg.match(new RegExp(`<g id="${id}">(.*?)</g>`))[1];
  assert.equal(outline(uses[0][0]), store.get(`Fmath|${'y'.codePointAt(0)}`));
  assert.equal(outline(uses[1][0]), store.get(`Fmath|${'x'.codePointAt(0)}`));
  assert.match(picture.svg, /<path fill="#000000" d="M 50 5 L 56 5 L 56 5.4 L 50 5.4 Z"\/>/, 'the rule as a filled box');
  assert.doesNotMatch(picture.svg, /glyph-0-0/, 'text is not in it');

  const unknown = galley();
  unknown.items[0].runs[1] = { ...unknown.items[0].runs[1], t: 'xz', gp: [0, 5.5] };
  assert.equal(synthesizeExactPicture(unknown, fidelity, store), null, 'z was never drawn');
  const noPositions = galley();
  delete noPositions.items[0].runs[1].gp;
  assert.equal(synthesizeExactPicture(noPositions, fidelity, store), null, 'a run without glyph positions');
  const text = galley();
  delete text.items[0].runs[1].m;
  assert.equal(synthesizeExactPicture(text, fidelity, store), null, 'an exact run that is not mathematics');
  const color = galley();
  color.items[0].runs[1].c = 'red" onload="x';
  assert.equal(synthesizeExactPicture(color, fidelity, store), null, 'a colour that is not #rrggbb');
});

test('a cold neighbouring formula uses verified outlines until its own picture arrives', () => {
  const block = { id: 'neighbor', needsRender: true, galleyHash: 'first', galley: galley(), fidelity };
  const chunks = new Map();
  chunks.outlines = new Map();
  assert.equal(prepareUnpaintedFormula(block, chunks), false);
  learnOutlines(PICTURE, block.galley, chunks.outlines);
  assert.equal(prepareUnpaintedFormula({ ...block, gfx: true }, chunks), false);
  assert.equal(prepareUnpaintedFormula({ ...block, sourceChanged: true }, chunks), false);
  block.units = ['cached'];
  assert.equal(prepareUnpaintedFormula(block, chunks), true);
  assert.equal(block.units, null);
  const key = synthChunkKey(block.id);
  const first = chunks.get(key);
  const line = buildStream(block, chunks).find(unit => unit.t === 'box').u.ln;
  assert.equal(line.partsChunk, key);
  assert.equal(line.parts.length, 2);
  assert.deepEqual(line.runs.map(run => run.t), ['Ab']);
  block.units = [line];
  assert.equal(prepareUnpaintedFormula(block, chunks), true);
  assert.deepEqual(block.units, [line], 'reusing ink preserves cached page layout');

  chunks.set(block.id, { forGalley: 'first', v: 1 });
  buildStream(block, chunks);
  assert.ok(!chunks.has(key), 'the real picture retires temporary ink');
  chunks.delete(block.id);
  block.galleyHash = 'second';
  block.galley.items[0].runs[1].t = 'yx';
  assert.equal(prepareUnpaintedFormula(block, chunks), true);
  const second = chunks.get(key);
  assert.notEqual(second.svg, first.svg);
  assert.ok(second.v > first.v, 'a browser must not reuse the retired image URL');
  block.galleyHash = 'unseen';
  block.galley.items[0].runs[1].t = 'xz';
  assert.equal(prepareUnpaintedFormula(block, chunks), false);
  assert.ok(!chunks.has(key));
  assert.ok(!buildStream(block, chunks).find(unit => unit.t === 'box').u.ln.parts);
});

const texReady = spawnSync('lualatex', ['--version']).status === 0;

const DOC = String.raw`\documentclass{article}
\begin{document}
Lead paragraph of plain words.

MathMarker here $x^2+y^2=z^2$ and $\frac{1}{2}$ and $\sqrt{a+b}$ in the text of the paragraph, which goes on for a while.

Tail paragraph of plain words.
\end{document}
`;

test('a keystroke inside a formula is shown from a picture put together at once; the real picture draws the same glyphs at the same places',
  { skip: !texReady && 'lualatex not installed' }, async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'tdom-exact-synth-'));
    const docDir = path.join(root, 'doc');
    mkdirSync(docDir);
    writeFileSync(path.join(docDir, 'main.tex'), DOC);
    const engine = new CheckpointEngine({ workDir: path.join(root, 'work'), docDir, overlayDir: path.join(root, 'overlay') });
    engine.canonical.schedule = () => {};
    const placements = (svg, pad) => {
      const cut = svg.indexOf('</defs>');
      const outlines = new Map([...svg.slice(0, cut).matchAll(/<g id="(glyph-[^"]+)">\s*([\s\S]*?)\s*<\/g>/g)].map((m) => [m[1], m[2]]));
      return [...svg.slice(cut).matchAll(/<use xlink:href="#(glyph-[^"]+)" x="([^"]+)" y="([^"]+)"/g)]
        .map((m) => `${(Number(m[2]) - pad).toFixed(3)},${Number(m[3]).toFixed(3)} ${outlines.get(m[1])}`);
    };
    try {
      await engine.open(DOC, 'main.tex');
      await drain(engine, 120_000);
      let block = engine.blocks.find((b) => b.text.includes('MathMarker'));
      await engine.warmEditOffset(block.start);
      await drain(engine, 120_000);
      assert.equal(engine.chunks.get(block.id)?.forGalley, block.galleyHash, 'the paragraph has its picture');
      assert.ok(engine.chunks.outlines.size > 0, 'its formula glyphs were learned');

      // `ab` inside the formula: a run the picture in hand does not hold
      const at = DOC.indexOf('y^2=');
      await engine.edit(at, at, 'ab');
      block = engine.blocks.find((b) => b.id === block.id);
      const hash = block.galleyHash;
      const built = engine.chunks.get(synthChunkKey(block.id));
      assert.ok(built, 'a picture was put together');
      assert.equal(built.forGalley, hash);
      const commands = engine.pages.flatMap((page) => page.dl?.commands ?? []).filter((cmd) => cmd.src === block.id);
      const shown = commands.filter((cmd) => cmd.op === 'chunk');
      assert.ok(shown.length > 0 && shown.every((cmd) => cmd.chunk === synthChunkKey(block.id) && cmd.part && cmd.held),
        'the formula is shown as windows on that picture');
      // (a word is split into runs at its kerns: look for the text's letters, not the word)
      const drawn = commands.filter((cmd) => cmd.op === 'glyphs').map((cmd) => cmd.text ?? '').join('');
      assert.ok(/paragraph/.test(drawn.replace(/\s+/g, '')) || drawn.length > 40, `the text around it is drawn as glyphs (${drawn.slice(0, 60)})`);
      assert.equal(engine.getChunkSVG(synthChunkKey(block.id)), built.svg, 'and is served');

      await drain(engine, 120_000);
      for (let i = 0; i < 40 && engine.chunks.get(block.id)?.forGalley !== hash; i++) await new Promise((r) => setTimeout(r, 250));
      const real = engine.chunks.get(block.id);
      assert.equal(real?.forGalley, hash, 'the real picture of that galley landed');
      // every glyph put together is in the real picture, at the same place, with the same outline
      const mine = placements(built.svg, -built.xBp);
      const theirs = new Set(placements(real.svg, -real.xBp));
      for (const glyph of mine) assert.ok(theirs.has(glyph), `real picture draws ${glyph.slice(0, 80)}`);
      assert.equal(engine.chunks.has(synthChunkKey(block.id)), false, 'the put-together picture is let go');
      const after = engine.pages.flatMap((page) => page.dl?.commands ?? []).filter((cmd) => cmd.src === block.id && cmd.op === 'chunk');
      assert.ok(after.length > 0 && after.every((cmd) => cmd.chunk === block.id), 'the page shows the real picture');
    } finally {
      await engine.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
