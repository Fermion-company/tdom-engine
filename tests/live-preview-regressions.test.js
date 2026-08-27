import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildDisplayList } from '../engine/checkpoint/display-list.js';
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
