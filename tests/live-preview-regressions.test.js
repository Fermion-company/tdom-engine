import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildDisplayList } from '../engine/checkpoint/display-list.js';
import { buildStream } from '../engine/checkpoint/stream.js';
import { prepareIsoCompileJob } from '../engine/checkpoint/iso-context.js';
import { needsRescue } from '../engine/checkpoint/rescue-classifier.js';

const geometry = {
  oddsidemargin: 0,
  topmargin: 0,
  headheight: 0,
  headsep: 0,
  textwidth: 420,
  textheight: 600,
  footskip: 30,
  topskip: { w: 10 },
};

const lineBox = (text, extra = {}) => ({
  k: 'box',
  h: 10,
  d: 2,
  w: 300,
  runs: text ? [{ f: 1, t: text, x: 0, dy: 0, s: 10 }] : [],
  ...extra,
});

test('a stale graphical block reveals current prose, including mixed math lines, but keeps math-only pixels', () => {
  const block = {
    id: 'b1',
    galleyHash: 'new-galley',
    galley: {
      gfx: true,
      w: 300,
      items: [
        lineBox('検左側の区間'),
        lineBox('本文\uE000x', { x: 1, xb: 1 }),
        lineBox('\uE000x', { x: 1, xb: 1 }),
      ],
      floats: [],
    },
    fidelity: {
      blockExact: true,
      canonicalOnly: false,
      noBridge: true,
      exactLines: 2,
      itemFlags: [0, 7, 3],
      floats: new Map(),
      ins: new Map(),
    },
  };
  const chunks = new Map([['b1', { forGalley: 'old-galley', wBp: 300, hBp: 24, v: 1 }]]);
  const boxes = buildStream(block, chunks).filter((entry) => entry.t === 'box');

  assert.equal(boxes[0].u.ln.gfxChunk, null);
  assert.equal(boxes[0].u.ln.runs[0].t, '検左側の区間');
  assert.equal(boxes[1].u.ln.gfxChunk, null);
  assert.equal(boxes[1].u.ln.runs[0].t, '本文\uE000x');
  assert.equal(boxes[2].u.ln.gfxChunk?.stale, 1);
  assert.equal(boxes[2].u.ln.runs[0].t, '\uE000x', 'run geometry remains only as chunk hit metadata');
});

test('a fresh exact chunk still replaces every line of a graphical block', () => {
  const block = {
    id: 'b1',
    galleyHash: 'new-galley',
    galley: { gfx: true, w: 300, items: [lineBox('左側の区間')], floats: [] },
    fidelity: {
      blockExact: true,
      canonicalOnly: false,
      noBridge: true,
      itemFlags: [0],
      floats: new Map(),
      ins: new Map(),
    },
  };
  const chunks = new Map([['b1', { forGalley: 'new-galley', wBp: 300, hBp: 12, v: 2 }]]);
  const box = buildStream(block, chunks).find((entry) => entry.t === 'box');

  assert.equal(box.u.ln.gfxChunk?.stale, undefined);
  assert.equal(box.u.ln.runs[0].t, '左側の区間', 'fresh chunk keeps source geometry for hit testing');
});

test('zero-area TeX rules remain invisible in the SVG display list', () => {
  const page = {
    number: 1,
    draw: [{
      y: 20,
      u: {
        blockId: 'b1',
        li: 0,
        h: 10,
        d: 0,
        ln: {
          boxH: 10,
          runs: [
            { rule: true, x: 0, dy: -10, w: 0, h: 10 },
            { rule: true, x: 1, dy: -10, w: 4, h: 0 },
            { rule: true, x: 2, dy: -1, w: 4, h: 1 },
          ],
        },
      },
    }],
  };
  const display = buildDisplayList(page, {
    geometry,
    chunks: new Map(),
    hf: new Map(),
    hfSig: null,
    fonts: new Map(),
    twinMetrics: {},
  });
  const rules = display.commands.filter((command) => command.op === 'rule');
  assert.deepEqual(rules.map(({ w, h }) => ({ w, h })), [{ w: 4, h: 1 }]);
});

test('breakable custom tcolorbox rescue skips the incompatible fork path', () => {
  const checkpoint0 = { name: 'loaded-preamble-checkpoint' };
  const block = {
    id: 'b1',
    text: '\\begin{pointbox}{注意}本文\\end{pointbox}',
    pageOffset: 140,
  };
  const source = String.raw`\documentclass{article}
\usepackage[most]{tcolorbox}
\newtcolorbox{pointbox}[1]{enhanced,breakable,title={#1}}
\begin{document}
\begin{pointbox}{注意}本文\end{pointbox}
\end{document}`;
  const prepared = prepareIsoCompileJob({
    block,
    idx: 0,
    forceCold: false,
    checkpoints: new Map([[0, checkpoint0]]),
    isoForkBroken: new Set(),
    blocks: [block],
    counters: [],
    text: source,
    workDir: '/tmp/tdom-live-preview-regression',
    labelTable: new Map(),
    geometry,
    needsRescue: () => true,
    breakableRe: () => /\\begin\{pointbox\}/,
  });
  assert.equal(prepared.splitMode, true);
  assert.equal(prepared.ck0, null, 'split-capable boxes must use a fresh real output routine');
});

test('multiline custom tcolorbox definitions are classified as breakable rescues', () => {
  const source = String.raw`\documentclass{article}
\usepackage[most]{tcolorbox}
\newtcolorbox{plainbox}{enhanced,colback=white}
\newtcolorbox{pointbox}[1]{
  enhanced,breakable,
  title={#1}
}
\begin{document}
\begin{pointbox}{注意}本文\end{pointbox}
\end{document}`;
  const result = needsRescue('\\begin{pointbox}{注意}本文\\end{pointbox}', {
    preHash: 'preamble-1',
    breakableFor: null,
    breakableRe: null,
    source: () => source,
  });
  assert.equal(result.needs, true);
  assert.equal(result.breakableRe.test('\\begin{plainbox}'), false);
});

test('ordinary isolated rescue still reuses the loaded preamble checkpoint', () => {
  const checkpoint0 = { name: 'loaded-preamble-checkpoint' };
  const block = { id: 'b1', text: 'ordinary paragraph', pageOffset: 20 };
  const source = '\\documentclass{article}\\begin{document}ordinary paragraph\\end{document}';
  const prepared = prepareIsoCompileJob({
    block,
    idx: 0,
    forceCold: false,
    checkpoints: new Map([[0, checkpoint0]]),
    isoForkBroken: new Set(),
    blocks: [block],
    counters: [],
    text: source,
    workDir: '/tmp/tdom-live-preview-regression',
    labelTable: new Map(),
    geometry,
    needsRescue: () => false,
    breakableRe: () => null,
  });
  assert.equal(prepared.splitMode, false);
  assert.equal(prepared.ck0, checkpoint0);
});
