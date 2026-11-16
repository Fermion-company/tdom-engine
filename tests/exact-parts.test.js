// A line with a formula in it is shown, until its own exact pixels land,
// with its text drawn by the glyph layer and each run that needs exact
// pixels cut out of the picture made for the block's previous galley
// (exact-parts.js, stream.js). The picture's glyphs are first put where the
// galley says they are (render-chunks.js anchorGlyphs).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { CheckpointEngine } from '../engine/checkpoint/engine-v3.js';
import { exactRunIndices } from '../engine/checkpoint/fidelity.js';
import { composeExactLines, exactRunKey } from '../engine/checkpoint/exact-parts.js';
import { anchorGlyphs } from '../engine/checkpoint/render-chunks.js';
import { drain, signature } from '../tools/harness.mjs';

const PROFILE = {
  schema: 2, engine: 'luahbtex', version: 124, revision: 0, outputMode: 1,
  capture: 'resident-post-linebreak', emptyRuleSubtype: 3, format: 'f',
};
const FONTS = new Map([
  ['text', { tier: 'native', family: 'f-text' }],
  ['math', { tier: 'twin', mth: true, family: 'f-math' }],
]);
const text = (t, x, w) => ({ t, f: 'text', s: 10, x, w, dy: 0, gh: 7, gd: 2, c: '#000000' });
const math = (t, x, w, dy = 0) => ({ t, f: 'math', s: 10, x, w, dy, gh: 5, gd: 1, c: '#000000', m: 1 });
const rule = (x, w, h, dy, extra = {}) => ({
  rule: true, rv: 2, rs: 0, rw: Math.round(w * 65781), rh: Math.round(h * 65781), rd: 0, ri: 0, rl: 0, rr: 0,
  rdir: 'TLT', ra: '', x, dy, w, h, c: '#000000', ...extra,
});
const line = (runs, h = 8, d = 2) => ({ k: 'box', h, d, runs });
const fidelityOf = (galley) => ({
  itemFlags: galley.items.map((item) => (item.k === 'box' && item.runs.some((run) => run.m) ? 1 : 0)),
  exactRuns: galley.items.map((item) => (item.k === 'box' && item.runs.some((run) => run.m)
    ? exactRunIndices(item, FONTS, PROFILE) : undefined)),
});

test('the runs of a line that need exact pixels are told from the ones the glyph layer draws', () => {
  const item = line([
    text('ab', 0, 10), math('x', 12, 5), math('2', 17, 3, -4), text('cd', 22, 10),
    rule(40, 6, 0.4, -3), // a positive rule: drawn as a rectangle
    rule(50, 0, 8, -6), // a strut: no area, the backend may still paint it
    rule(60, 6, 0.4, -3, { rw: -1073741824 }), // a running width, as a fraction bar has
    { ...rule(70, 0, 0, 0), rs: 3 }, // LuaTeX-ja's empty rule: layout only
  ]);
  assert.deepEqual(exactRunIndices(item, FONTS, PROFILE), [1, 2, 5, 6]);
  assert.deepEqual(exactRunIndices(line([text('plain', 0, 20)]), FONTS, PROFILE), []);
  assert.equal(exactRunIndices(line([math('x', 0, 0)]), FONTS, PROFILE), null, 'a run without width cannot be cut out');
  assert.deepEqual(exactRunIndices(line([{ ...text('', 0, 5) }]), FONTS, PROFILE), [0], 'an unaddressable glyph');
});

test('every exact run is found in the painted galley, wherever its line and its place are now', () => {
  // painted: "ab x^2 + y cd" on its second line
  const painted = { items: [
    line([text('first', 0, 30)]),
    { k: 'glue', a: 4 },
    line([text('ab', 0, 10), math('x', 12, 5), math('2', 17, 3, -4), math('+', 22, 6), math('y', 30, 5), text('cd', 37, 10)]),
  ] };
  // now: a character typed in front, the glue of the formula stretched, the line first in the galley
  const now = { items: [
    line([text('zab', 0, 15), math('x', 17, 5), math('2', 22, 3, -4), math('+', 27.5, 6), math('y', 36, 5), text('cd', 43, 10)]),
    { k: 'glue', a: 4 },
    line([text('first', 0, 30)]),
  ] };
  const lines = composeExactLines(now, fidelityOf(now), painted, fidelityOf(painted));
  assert.deepEqual([...lines.keys()], [0]);
  const { runs, parts } = lines.get(0);
  assert.deepEqual(runs.map((run) => run.t), ['zab', 'cd'], 'the text stays with the glyph layer');
  // the painted line's baseline: 10 (first line) + 4 (glue) + 8 (its height)
  assert.deepEqual(parts, [
    { x: 17, w: 5, top: -5, h: 6, sx: 12, sy: 22 - 5 },
    { x: 22, w: 3, top: -9, h: 6, sx: 17, sy: 22 - 4 - 5 },
    { x: 27.5, w: 6, top: -5, h: 6, sx: 22, sy: 22 - 5 },
    { x: 36, w: 5, top: -5, h: 6, sx: 30, sy: 22 - 5 },
  ]);

  // a keystroke inside the formula: one run has no twin, so nothing is composed
  const edited = { items: [line([text('ab', 0, 10), math('x', 12, 5), math('3', 17, 3, -4)])] };
  assert.equal(composeExactLines(edited, fidelityOf(edited), painted, fidelityOf(painted)), null);
  // the same ink wanted twice comes from the one place it is
  const twice = { items: [line([math('y', 0, 5), text('and', 7, 15), math('y', 24, 5)])] };
  assert.deepEqual(composeExactLines(twice, fidelityOf(twice), painted, fidelityOf(painted)).get(0).parts.map((part) => part.sx), [30, 30]);
  // a formula left alone is taken run after run where it was, not from a twin elsewhere
  const paintedTwo = { items: [line([math('a', 0, 5), math('b', 6, 5), text('or', 13, 10), math('c', 25, 5), math('b', 31, 5)])] };
  const nowTwo = { items: [line([text('x', 0, 5), math('c', 7, 5), math('b', 13, 5)])] };
  assert.deepEqual(composeExactLines(nowTwo, fidelityOf(nowTwo), paintedTwo, fidelityOf(paintedTwo)).get(0).parts.map((part) => part.sx), [25, 31]);
  assert.notEqual(exactRunKey(math('x', 0, 5)), exactRunKey(math('x', 0, 5, -4)), 'a raised run is other ink');
  // no exact line at all: nothing to compose
  const plain = { items: [line([text('plain', 0, 20)])] };
  assert.equal(composeExactLines(plain, fidelityOf(plain), painted, fidelityOf(painted)), null);
});

test('the glyphs of a picture are put where the galley says, or the picture is left alone', () => {
  const galley = { items: [
    line([text('ab', 5, 10), math('x', 17, 5, -2)]),
    { k: 'glue', a: 3 },
    line([text('c', 0, 5)]),
  ] };
  const use = (x, y) => `<use xlink:href="#glyph-0-1" x="${x}" y="${y}"/>`;
  // pad 100: "a" belongs at 105, "b" keeps its distance to it, "x" at 117 raised by 2, "c" at 100 on the second baseline (10 + 3 + 8)
  const svg = `<svg><g>${use(105.4, 8.3)}${use(110.37, 8.3)}${use(117.2, 6.3)}</g><path d="M 0 0"/>${use(100.5, 21.3)}</svg>`;
  const { svg: moved, anchored } = anchorGlyphs(svg, galley, 100);
  assert.equal(anchored, true);
  assert.deepEqual([...moved.matchAll(/x="([\d.]+)" y="([\d.]+)"/g)].map((m) => [Number(m[1]), Number(m[2])]),
    [[105, 8], [109.97, 8], [117, 6], [100, 21]]);
  assert.match(moved, /<path d="M 0 0"\/>/, 'what is not a glyph stays');
  // one glyph more or less than the galley has: not this galley's picture
  assert.deepEqual(anchorGlyphs(svg.replace(use(100.5, 21.3), ''), galley, 100), { svg: svg.replace(use(100.5, 21.3), ''), anchored: false });
  // a glyph far from its place: the order is not the galley's
  assert.equal(anchorGlyphs(svg.replace('x="117.2"', 'x="119.2"'), galley, 100).anchored, false);
  // graphics move text in ways the runs do not record
  assert.equal(anchorGlyphs(svg, { ...galley, gfx: true }, 100).anchored, false);
});

const texReady = spawnSync('lualatex', ['--version']).status === 0;

test('a keystroke beside a formula is on the page with its answer, the formula cut out of the picture in hand',
  { skip: !texReady && 'lualatex not installed' }, async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'tdom-exact-parts-'));
    const source = String.raw`\documentclass{article}
\begin{document}
Lead paragraph.

MarkerWord holds $x^2+y^2=z^2$ and $\frac{1}{2}$ between words of ordinary text that run on.

Tail paragraph.
\end{document}
`;
    const engine = new CheckpointEngine({ workDir: path.join(root, 'work') });
    const own = (patches, id) => patches.filter((patch) => patch.type === 'replace-page')
      .flatMap((patch) => patch.displayList.commands.filter((command) => command.src === id));
    try {
      await engine.open(source);
      await drain(engine);
      await engine.renderTask;
      const block = () => engine.blocks.find((b) => b.text.includes('MarkerWord'));
      const picture = engine.chunks.get(block().id);
      assert.equal(picture?.forGalley, block().galleyHash, 'the paragraph has its exact picture');
      assert.equal(picture.anchored, true, 'with its glyphs where the galley says');
      const late = [];
      engine.onAsyncPatches = (partial) => late.push(...own(partial.patches, block().id));

      const at = engine.getSource().indexOf('MarkerWord') + 'MarkerWord'.length;
      const report = await engine.edit(at, at, 'Q');
      const commands = own(report.patches, block().id);
      const glyphs = commands.filter((command) => command.op === 'glyphs');
      const chunks = commands.filter((command) => command.op === 'chunk');
      // (font kerns split a word into several runs)
      assert.ok(glyphs.map((command) => command.text).join('').includes('MarkerWordQ'), 'the typed character is drawn');
      assert.ok(!glyphs.some((command) => command.math), 'no formula is left to the browser');
      assert.ok(chunks.length > 0 && chunks.every((command) => command.part && command.held && !command.st),
        JSON.stringify(chunks.slice(0, 2)));
      assert.ok(chunks.every((command) => command.cw === Math.round(picture.wBp * 100) / 100 && command.cv === picture.v),
        'every cut-out looks into the picture in hand');
      assert.ok(!commands.some((command) => command.op === 'pending-exact' || command.op === 'canon'));

      // its own pixels land: the line is the picture again, whole
      await engine.renderTask;
      await drain(engine);
      const landed = late.filter((command) => command.op === 'chunk');
      assert.ok(landed.length > 0 && landed.every((command) => !command.part && !command.held && !command.st),
        JSON.stringify(landed.slice(0, 2)));
      assert.equal(engine.chunks.get(block().id).forGalley, block().galleyHash);

      // a keystroke inside the formula has no twin for the changed run: the block waits as before
      const inside = engine.getSource().indexOf('x^2') + 2;
      const changed = await engine.edit(inside, inside + 1, '3');
      assert.ok(!own(changed.patches, block().id).some((command) => command.part), 'nothing is composed from other ink');
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
