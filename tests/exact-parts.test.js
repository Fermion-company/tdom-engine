// A line with a formula in it is shown, until its own exact pixels land,
// with its text drawn by the glyph layer and each run that needs exact
// pixels cut out of the picture made for the block's previous galley
// (exact-parts.js, stream.js). The picture's glyphs are first put where the
// galley says they are (render-chunks.js anchorGlyphs).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import vm from 'node:vm';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { CheckpointEngine } from '../engine/checkpoint/engine-v3.js';
import { exactRunIndices } from '../engine/checkpoint/fidelity.js';
import { composeExactLines, exactRunKey } from '../engine/checkpoint/exact-parts.js';
import { anchorGlyphs } from '../engine/checkpoint/render-chunks.js';
import { buildStream } from '../engine/checkpoint/stream.js';
import { buildDisplayList } from '../engine/checkpoint/display-list.js';
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

// The block's own picture is in: the line is that picture for editing and
// geometry, shown only where its exact runs are; the text is drawn by the
// glyph layer, as it was while the picture was on its way (stream.js
// `reveal`, display-list.js `show` and `ov`).
test('a line whose own picture is in shows the picture at its exact runs only, the text drawn over as ink', () => {
  const galley = { w: 200, backend: PROFILE, closure: 'native', items: [
    line([text('plain', 0, 30)]),
    { k: 'glue', a: 4 },
    line([text('ab', 0, 10), math('x', 12, 5), math('2', 17, 3, -4), text('cd', 22, 10)]),
  ] };
  const block = (extra = {}) => ({ id: 'b1', galley, galleyHash: 'g1', needsRender: true,
    fidelity: { ...fidelityOf(galley), level: 2, exactLines: 1 }, ...extra });
  const chunksWith = (chunk) => { const chunks = new Map([['b1', chunk]]); chunks.outlines = new Map(); return chunks; };
  const picture = { svg: '<svg/>', v: 3, wBp: 224, logicalWBp: 200, xBp: -12, hBp: 24, forGalley: 'g1', anchored: true };
  const page = (stream) => ({ number: 1, draw: stream.filter((entry) => entry.t === 'box').reduce((draw, entry) => {
    const y = (draw.at(-1)?.next ?? 0) + entry.u.h;
    draw.push({ u: entry.u, y, next: y + entry.u.d + 4 });
    return draw;
  }, []) });
  const geometry = { oddsidemargin: 0, topmargin: 0, headheight: 0, headsep: 0, textwidth: 200, textheight: 600 };
  const list = (stream) => buildDisplayList(page(stream), { geometry, chunks: chunksWith(picture), hf: null, hfSig: '', fonts: FONTS, twinMetrics: {} });

  const stream = buildStream(block(), chunksWith(picture));
  const units = stream.filter((entry) => entry.t === 'box').map((entry) => entry.u);
  assert.equal(units[0].ln.gfxChunk, null, 'a line with nothing exact is glyphs, as ever');
  assert.equal(units[0].ln.reveal, undefined);
  assert.ok(units[1].ln.gfxChunk && !units[1].ln.parts, 'the exact line is its picture, not cut-outs');
  assert.deepEqual(units[1].ln.reveal.runs.map((run) => run.t), ['ab', 'cd']);
  assert.equal(units[1].ln.reveal.parts.length, 2);

  const commands = list(stream).commands;
  const window = commands.find((command) => command.op === 'chunk');
  assert.ok(window && !window.part && !window.held && !window.st);
  // x: margin 72 + the run's place - 0.75; y: from the line's baseline (72 + 22), the box of its glyphs with 2 above and below
  assert.deepEqual(window.show, [[72 + 12 - 0.75, 94 - 5 - 2, 5 + 1.5, 6 + 4], [72 + 17 - 0.75, 94 - 4 - 5 - 2, 3 + 1.5, 6 + 4]]);
  const over = commands.filter((command) => command.ov);
  // (the runs of the line that look alike go as one command, each at its own place)
  assert.deepEqual(over.map((command) => [command.op, command.text, command.x, command.runs]),
    [['glyphs', 'abcd', 72, [[72, 'ab'], [94, 'cd']]]]);
  assert.equal(over[0].w, 32, 'from the first run\'s left edge to the last one\'s right');
  assert.ok(!over.some((command) => command.math));
  const plain = commands.filter((command) => command.op === 'glyphs' && !command.ov);
  assert.deepEqual(plain.map((command) => command.text), ['plain'], 'the other line is ordinary glyphs');
  assert.ok(commands.some((command) => command.op === 'sourcebox' && command.src === 'b1'), 'the hit surface of the exact line stays');
  assert.ok(commands.indexOf(commands.find((command) => command.op === 'sourcebox')) < commands.indexOf(over[0]), 'the text is drawn over it');

  // a picture whose glyphs were not put where the galley says, a block of graphics, a rescued one: the line whole, as before
  for (const [name, stale] of [
    ['not anchored', buildStream(block(), chunksWith({ ...picture, anchored: false }))],
    ['graphics', buildStream(block({ gfx: true }), chunksWith(picture))],
    ['rescued', buildStream(block({ rescued: true }), chunksWith(picture))],
  ]) {
    const exact = stale.filter((entry) => entry.t === 'box').map((entry) => entry.u).filter((unit) => unit.ln.gfxChunk);
    assert.ok(exact.length > 0 && exact.every((unit) => !unit.ln.reveal), name);
    const whole = list(stale).commands;
    assert.ok(!whole.some((command) => command.ov) && whole.filter((command) => command.op === 'chunk').every((command) => !command.show), name);
  }
});

test('the viewer shows such a picture through its openings and gives the text drawn over it no part in editing', () => {
  const app = readFileSync(new URL('../web/app.js', import.meta.url), 'utf8');
  const cut = (from, to) => app.slice(app.indexOf(from), app.indexOf(to, app.indexOf(from) + from.length));
  const svgStart = app.indexOf('function svgFor(');
  const viewer = { geometry: { paperwidth: 600, paperheight: 800 }, escapeXml: (value) => String(value).replace(/</g, '&lt;'),
    readyFonts: new Set(['f-text']), FONT_FAMILY: { regular: 'serif' } };
  vm.createContext(viewer);
  // (svgFor joins the pieces svgParts makes)
  vm.runInContext(cut('function furnitureBandOf', 'const furnitureLists') +
    cut('const OVER_TEXT_ATTRS', '/** Unified SVG page') +
    app.slice(svgStart, app.indexOf('\n}\n', app.indexOf('function svgParts(')) + 3) +
    '\nthis.clip = chunkShowClip; this.svg = svgFor;', viewer);

  const window = { op: 'chunk', x: 60, y: 100, w: 240, h: 20 };
  assert.equal(viewer.clip(window), '', 'no openings named: the whole window');
  assert.equal(viewer.clip({ ...window, show: [[84, 105, 6, 10], [300, 90, 30, 10]] }),
    // each opening walked round, then back along the corners they were entered by; kept inside the window
    'clip-path:polygon(10% 25%,12.5% 25%,12.5% 75%,10% 75%,10% 25%,100% 0%,100% 0%,100% 0%,100% 0%,100% 0%,100% 0%,10% 25%);');
  assert.equal(viewer.clip({ ...window, show: [] }), 'clip-path:polygon(0 0,0 0,0 0);', 'nothing to show');
  assert.equal(viewer.clip({ ...window, show: [[84, 105, 6]] }), '', 'a box that is none: the whole window rather than a wrong one');

  const page = viewer.svg({ page: 1, commands: [
    { op: 'sourcebox', x: 72, y: 100, w: 200, h: 12, line: 1, ink: 1, math: 1, src: 'b1' },
    { op: 'glyphs', fam: 'f-text', size: 10, x: 72, y: 110, text: 'ab<d', w: 32, gh: 7, gd: 2, src: 'b1', line: 1, ov: 1,
      runs: [[72, 'ab'], [94, '<d']] },
    { op: 'glyphs', fam: 'f-text', size: 10, x: 72, y: 130, text: 'plain', w: 30, gh: 7, gd: 2, src: 'b1', line: 2 },
  ] });
  const texts = [...page.matchAll(/<text [^>]*>.*?<\/text>/g)].map((match) => match[0]);
  assert.equal(texts.length, 2);
  assert.match(texts[0], /data-ov="1" pointer-events="none"/);
  assert.doesNotMatch(texts[0], /data-src|data-line/, 'not a node the editing code finds by its source');
  assert.match(texts[0], /<text y="110" font-size="10"[^>]*><tspan x="72">ab<\/tspan><tspan x="94">&lt;d<\/tspan><\/text>$/,
    'one element, each run at its own place');
  assert.match(texts[1], /data-src="b1" data-line="2"/);
  assert.doesNotMatch(texts[1], /pointer-events/);
  assert.match(page, /class="tdom-source-hit"[^>]*data-src="b1"/, 'the line is still found by its hit box');
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

      // its own pixels land: the line is its picture again (one window, the
      // current source's), shown only where the formulas are; the text stays
      // as the glyph layer drew it
      await engine.renderTask;
      await drain(engine);
      const landed = late.filter((command) => command.op === 'chunk');
      assert.ok(landed.length > 0 && landed.every((command) => !command.part && !command.held && !command.st),
        JSON.stringify(landed.slice(0, 2)));
      assert.equal(engine.chunks.get(block().id).forGalley, block().galleyHash);
      const window = landed.at(-1);
      assert.ok(Array.isArray(window.show) && window.show.length >= 2, 'openings for the formulas');
      for (const [x, y, w, h] of window.show) {
        assert.ok(w > 0 && h > 0 && x >= window.x - 0.01 && x + w <= window.x + window.w + 0.01, 'an opening lies in its window');
        assert.ok(y + h > window.y && y < window.y + window.h);
      }
      const drawn = late.filter((command) => command.op === 'glyphs');
      assert.ok(drawn.some((command) => command.ov === 1), 'the text of the line is drawn over, as ink');
      assert.ok(drawn.filter((command) => command.ov).map((command) => command.text).join('').includes('MarkerWordQ'));
      assert.ok(!drawn.some((command) => command.math), 'and no formula is left to the browser');
      assert.ok(late.some((command) => command.op === 'sourcebox'), 'editing still goes by the line\'s hit box and picture');

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
