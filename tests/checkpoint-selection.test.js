import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { checkpointBudgetFor, checkpointKeepSet, nextTypesetCost, gridMissingBoundaries } from '../engine/checkpoint/checkpoint-selection.js';
import {
  checkpointIndicesForPeers,
  distinctCheckpointPeerCount,
  enforceCheckpointCap,
  retireOffGrid,
  sharedCheckpointBudget,
} from '../engine/checkpoint/checkpoint-retirement.js';
import { ShippingChain } from '../engine/checkpoint/shipping.js';

test('measured-cost checkpoint selection brackets unknown expensive blocks', () => {
  const blocks = Array.from({ length: 51 }, () => ({ typesetCostMs: 2 }));
  blocks[10].typesetCostMs = 500;
  blocks[24].typesetCostMs = 650;
  blocks[36].typesetCostMs = 4300;
  const keep = checkpointKeepSet(blocks, 8);
  assert.equal(keep.size, 8);
  assert.equal(keep.has(24), true, 'input boundary for a heavy graphical block');
  assert.equal(keep.has(25), true, 'ordinary prose after the graphical block skips it');
  assert.equal(keep.has(36), true, 'input boundary for a repeated user macro');
  assert.equal(keep.has(37), true, 'ordinary prose after the repeated macro skips it');
  assert.equal(keep.has(10), true, 'the third expensive block retains its input boundary');
  assert.equal(keep.has(11), true, 'the third expensive block retains its output boundary');
  assert.equal(keep.has(50), true, 'the final block keeps its own input boundary');
});

test('tail coverage is stable while measured costs are still arriving', () => {
  const blocks = Array.from({ length: 25 }, () => ({}));
  const early = checkpointKeepSet(blocks, 8);
  for (let i = 0; i < blocks.length; i++) blocks[i].typesetCostMs = i < 4 ? 20 - i : 2;
  const measured = checkpointKeepSet(blocks, 8);

  assert.equal(early.size, 8);
  assert.equal(measured.size, 8);
  assert.equal(early.has(24), true);
  assert.equal(measured.has(24), true);
  for (const limit of [1, 2, 3]) {
    const keep = checkpointKeepSet(blocks, limit);
    assert.equal(keep.size, limit, `budget ${limit} remains hard`);
    if (limit > 1) assert.equal(keep.has(24), true);
  }
});

test('tail coverage has explicit priority when the budget cannot keep every hot bracket', () => {
  const constrained = Array.from({ length: 10 }, () => ({ typesetCostMs: 1 }));
  constrained[4].typesetCostMs = 100;
  assert.deepEqual([...checkpointKeepSet(constrained, 2)].sort((a, b) => a - b), [0, 9]);
  assert.deepEqual([...checkpointKeepSet(constrained, 3)].sort((a, b) => a - b), [0, 4, 9]);

  const rootHeavy = Array.from({ length: 30 }, () => ({ typesetCostMs: 1 }));
  rootHeavy[0].typesetCostMs = 5000;
  rootHeavy[5].typesetCostMs = 4000;
  rootHeavy[10].typesetCostMs = 3000;
  rootHeavy[20].typesetCostMs = 2000;
  assert.deepEqual(
    [...checkpointKeepSet(rootHeavy, 8)].sort((a, b) => a - b),
    [0, 1, 5, 6, 10, 11, 20, 29]
  );
});

test('small documents retain every available boundary', () => {
  assert.deepEqual(
    [...checkpointKeepSet([{ typesetCostMs: 10 }, { typesetCostMs: 20 }], 8)],
    [0, 1, 2]
  );
});

test('terminal page flushes retain the last visible page and its exact neighbors', () => {
  const blocks = [
    ...Array.from({ length: 210 }, () => ({ text: 'Ordinary text.', typesetCostMs: 2 })),
    { text: 'Earlier page.\\newpage % page boundary', typesetCostMs: 2 },
    { text: '\\section{Last page}', typesetCostMs: 2 },
    { text: '\\par\\medskip', typesetCostMs: 2 },
    { text: '\\begin{tcolorbox}Editable body.\\end{tcolorbox}', typesetCostMs: 2 },
    { text: '\\par\\medskip % input boundary', typesetCostMs: 2 },
    { text: '\\clearpage', typesetCostMs: 2 },
  ];
  const keep = checkpointKeepSet(blocks, 8);
  assert.equal(keep.size, 8);
  assert.ok(keep.has(211), 'the final heading and box share a nearby replay frontier');
  assert.ok(!keep.has(215), 'a flush after all visible ink does not consume the tail slot');
});

test('ordinary blocks retain coverage instead of spending every slot on similar early costs', () => {
  for (const measuredCount of [8, 224]) {
    const blocks = Array.from({ length: 224 }, (_, index) =>
      index < measuredCount ? { typesetCostMs: index < 3 ? 30 : 20 } : {});
    const keep = [...checkpointKeepSet(blocks, 8)].sort((a, b) => a - b);
    assert.equal(keep.length, 8);
    const gaps = keep.slice(1).map((boundary, index) => boundary - keep[index]);
    assert.ok(Math.max(...gaps) <= 50, `measured ${measuredCount}: coverage ${keep.join(',')}`);
  }
});


test('unmaterialized cost boundaries retain available checkpoints until replacements arrive', () => {
  const checkpoints = new Map();
  const retired = [];
  const peer = index => ({ send: message => {
    assert.equal(message, 'DIE\n');
    retired.push(index);
  } });
  for (let index = 0; index <= 8; index++) checkpoints.set(index, peer(index));
  const state = { checkpoints, keep: new Set([0, 25, 50, 75, 100, 125, 150, 175]),
    editHold: [], renderHold: new Map(), dyingPids: new Set() };
  retireOffGrid({ ...state, idx: 7 });
  assert.ok(checkpoints.has(7), 'an available fallback survives a desired frontier that does not exist');
  enforceCheckpointCap(state);
  assert.equal(checkpoints.size, 8);
  checkpoints.set(25, peer(25));
  enforceCheckpointCap(state);
  assert.equal(checkpoints.size, 8);
  assert.ok(checkpoints.has(0));
  assert.ok(checkpoints.has(25));
  assert.equal(retired.length, 2);
});

test('temporary edit and render owners do not displace distant coverage frontiers', () => {
  for (const owner of ['edit', 'render']) {
    const retired = [];
    const checkpoints = new Map([0, 1, 26, 54, 90, 124, 155, 188, 219, 221, 222]
      .map(index => [index, { send: () => retired.push(index) }]));
    const pins = [1, 221, 222];
    const state = { checkpoints, keep: new Set([0, 12, 44, 78, 113, 149, 185, 219]),
      editHold: owner === 'edit' ? pins : [],
      renderHold: new Map(owner === 'render' ? pins.map(index => [index, `b${index}`]) : []),
      dyingPids: new Set() };
    retireOffGrid({ ...state, idx: 26 });
    enforceCheckpointCap(state);
    assert.ok(checkpoints.has(26), `${owner} pins must not force the next cold edit back to root`);
    assert.equal(checkpoints.size, state.keep.size + pins.length);
    assert.deepEqual(retired, []);
  }
});

test('shared budget reclaims resident coverage before reducing shipping locality', () => {
  const peers = Array.from({ length: 16 }, (_, index) => ({ pid: index + 1, send() {} }));
  const checkpoints = new Map(peers.map((peer, index) => [index, peer]));
  const budget = sharedCheckpointBudget({
    maxCheckpoints: 8,
    checkpoints,
    shippingEnabled: true,
  });
  assert.equal(budget.residentLimit, 12);
  assert.equal(budget.shippingLimit, 1, 'an unreclaimed resident tree safely shrinks shipping to its root');

  const retired = [];
  for (const [index, peer] of checkpoints) peer.send = () => retired.push(index);
  enforceCheckpointCap({
    checkpoints,
    keep: new Set([0, 2, 4, 6, 8, 10, 12, 15]),
    editHold: [14, 15],
    renderHold: new Map([[13, 'math']]),
    activeHold: [12],
    maxPeers: budget.residentLimit,
    dyingPids: new Set(),
  });
  assert.equal(distinctCheckpointPeerCount(checkpoints), 10,
    'mandatory peers already at desired boundaries also satisfy that coverage');
  assert.ok(checkpoints.has(0));
  assert.ok(checkpoints.has(12));
  assert.ok(checkpoints.has(13));
  assert.ok(checkpoints.has(14));
  assert.ok(checkpoints.has(15));
  assert.equal(retired.length, 6);
  assert.equal(sharedCheckpointBudget({
    maxCheckpoints: 8,
    checkpoints,
    shippingEnabled: true,
  }).shippingLimit, 3);
});

test('mandatory root, job input, and continuation consume capacity outside the coverage plan', () => {
  const checkpoints = new Map(Array.from({ length: 11 }, (_, index) => [index, {
    pid: 200 + index,
    send() {},
  }]));
  enforceCheckpointCap({
    checkpoints,
    keep: new Set([1, 2, 3, 4, 5, 6, 7, 8]),
    editHold: [0, 9, 10],
    coveragePins: [],
    renderHold: new Map(),
    maxPeers: 6,
    dyingPids: new Set(),
  });
  assert.equal(distinctCheckpointPeerCount(checkpoints), 6);
  assert.ok(checkpoints.has(0), 'root is mandatory even outside the measured skeleton');
  assert.ok(checkpoints.has(9), 'current JOB input is mandatory');
  assert.ok(checkpoints.has(10), 'generated continuation is mandatory');
  assert.deepEqual([...checkpoints.keys()].filter(index => index > 0 && index < 9), [1, 2, 3]);
});

test('shared budget counts peer aliases once and reserves unmaterialized resident forks', () => {
  const root = { pid: 101, send() {} };
  const next = { pid: 102, send() {} };
  const checkpoints = new Map([[0, root], [1, root], [2, next]]);
  const activeResidentRenders = new Map([['rr@1', { peer: next, index: 2 }]]);
  const pending = sharedCheckpointBudget({
    maxCheckpoints: 8,
    checkpoints,
    shippingEnabled: true,
    currentJob: { ckptIdx: 3, pid: 103 },
    activeResidentRenders,
  });
  assert.equal(distinctCheckpointPeerCount(checkpoints), 2);
  assert.equal(pending.residentReservations, 2);
  assert.equal(pending.residentLimit, 10);
  assert.equal(pending.shippingLimit, 3);

  checkpoints.set(3, { pid: 103, send() {} });
  const materialized = sharedCheckpointBudget({
    maxCheckpoints: 8,
    checkpoints,
    shippingEnabled: true,
    currentJob: { ckptIdx: 3, pid: 103 },
    activeResidentRenders,
  });
  assert.equal(materialized.residentReservations, 1, 'the same JOB child is not counted twice after CKPT');

  const small = sharedCheckpointBudget({
    maxCheckpoints: 2,
    checkpoints: new Map([[0, root]]),
    shippingEnabled: true,
  });
  assert.deepEqual(
    { residentLimit: small.residentLimit, shippingLimit: small.shippingLimit },
    { residentLimit: 1, shippingLimit: 2 },
    'small budgets retain both roots and spend only the remaining shipping checkpoint slot'
  );

  let deaths = 0;
  root.send = () => deaths++;
  retireOffGrid({
    idx: 1,
    keep: new Set([2]),
    checkpoints,
    editHold: [],
    renderHold: new Map(),
    block: null,
    dyingPids: new Set(),
  });
  assert.equal(deaths, 1);
  assert.equal(checkpoints.has(0), false);
  assert.equal(checkpoints.has(1), false);
});

test('an active render follows its peer when an edit rekeys the checkpoint boundary', () => {
  const owner = { pid: 301, send() {} };
  const other = { pid: 302, send() {} };
  const checkpoints = new Map([[3, other], [7, owner]]);
  const active = new Map([['rr@1', { peer: owner, index: 4 }]]);
  const indices = checkpointIndicesForPeers(
    checkpoints,
    [...active.values()].map(item => item.peer)
  );
  assert.deepEqual(indices, [7]);

  enforceCheckpointCap({
    checkpoints,
    keep: new Set([3]),
    editHold: [],
    renderHold: new Map(),
    activeHold: indices,
    maxPeers: 1,
    dyingPids: new Set(),
  });
  assert.deepEqual([...checkpoints.keys()], [7], 'the current owner peer wins over its stale index');
});

test('shipping keeps root, certified base, then the local frontier as its budget shrinks', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'tdom-shipping-budget-'));
  let limit = 3;
  const chain = new ShippingChain({ workDir: dir, checkpointBudget: () => limit });
  const retired = [];
  const peer = page => ({ alive: true, pid: 0, send: () => retired.push(page) });
  try {
    chain.wavePrefixPage = 5;
    for (const page of [0, 4, 5, 8, 9]) chain.checkpoints.set(page, peer(page));
    chain.trimCheckpoints();
    assert.deepEqual([...chain.checkpoints.keys()], [0, 5, 9]);
    assert.deepEqual(retired.sort((a, b) => a - b), [4, 8]);

    limit = 2;
    chain.trimCheckpoints();
    assert.deepEqual([...chain.checkpoints.keys()], [0, 5], 'the old base survives before the frontier');

    const rootPeer = chain.checkpoints.get(0);
    chain.checkpoints.set(1, rootPeer);
    assert.equal(chain.info().checkpointCount, 2, 'two indices for one process consume one logical slot');
    limit = 1;
    chain.trimCheckpoints();
    assert.deepEqual([...chain.checkpoints.keys()].sort((a, b) => a - b), [0, 1, 5],
      'root aliases and the certified base survive a transient one-slot allowance');
    assert.equal(chain.info().checkpointCount, 2);
  } finally {
    await chain.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the resident budget scales with the document up to the ceiling', () => {
  // a short note keeps every boundary
  assert.equal(checkpointBudgetFor(10, { ceiling: 32 }), 11);
  // ~20 pages: still every boundary while the ceiling allows
  assert.equal(checkpointBudgetFor(31, { ceiling: 32 }), 32);
  assert.equal(checkpointBudgetFor(40, { ceiling: 32 }), 32);
  // a 316-page book: the host ceiling is the memory knob
  assert.equal(checkpointBudgetFor(640, { ceiling: 32 }), 32);
  assert.equal(checkpointBudgetFor(640, { ceiling: 64 }), 64);
  assert.equal(checkpointBudgetFor(640, { ceiling: 2 }), 2);
  assert.equal(checkpointBudgetFor(0, { ceiling: 8 }), 1);
  // Once canonical proves the physical size, one coverage slot per page and
  // the root are enough; the page bound never increases the block budget.
  assert.equal(checkpointBudgetFor(15, { ceiling: 12, pageCount: 3 }), 4);
  assert.equal(checkpointBudgetFor(24, { ceiling: 12, pageCount: 5 }), 6);
  assert.equal(checkpointBudgetFor(5, { ceiling: 12, pageCount: 30 }), 6);
  assert.equal(checkpointBudgetFor(640, { ceiling: 12, pageCount: 316 }), 12);
});

test('a larger budget spreads coverage over the whole document instead of bracketing every hot block', () => {
  // a jlreq-like book: prose with a boxed exercise every few blocks
  const blocks = Array.from({ length: 640 }, (_, index) => ({ typesetCostMs: index % 7 === 3 ? 400 : 120 }));
  for (const limit of [12, 16, 32]) {
    const keep = [...checkpointKeepSet(blocks, limit)].sort((a, b) => a - b);
    assert.equal(keep.length, limit);
    const gaps = keep.slice(1).map((boundary, index) => boundary - keep[index]);
    gaps.push(640 - keep.at(-1));
    const bound = Math.ceil(640 / (limit / 2)) + 8;
    assert.ok(Math.max(...gaps) <= bound, `limit ${limit}: widest gap ${Math.max(...gaps)} > ${bound} (${keep.join(',')})`);
  }
});

test('the skeleton cost of a block is its minimum sample: slow outliers change nothing', () => {
  assert.equal(nextTypesetCost(0, 180), 180, 'first sample is stored');
  assert.equal(nextTypesetCost(undefined, 180), 180);
  assert.equal(nextTypesetCost(180, 6700), null, 'a swap or fork stall is not a cost');
  assert.equal(nextTypesetCost(180, 180), null);
  assert.equal(nextTypesetCost(180, 120), 120, 'a cheaper sample refines the estimate');
  assert.equal(nextTypesetCost(180, NaN), null);
  assert.equal(nextTypesetCost(180, -1), null);
});

test('the grid pass only chases boundaries whose nearest resident replay is a real share of a segment', () => {
  const blocks = Array.from({ length: 120 }, (_, i) => ({ id: 'b' + i, typesetCostMs: i === 60 ? 3000 : 100 }));
  const keep = new Set([0, 30, 60, 61, 90, 119]);
  const held = (ids) => new Map(ids.map((idx) => [idx, { pid: idx }]));
  // every boundary held: nothing to do
  assert.deepEqual(gridMissingBoundaries(blocks, keep, held([0, 30, 60, 61, 90, 119]), 6), []);
  // one block of drift (100 ms against a ~2.4 s segment) is served by the neighbour, on either side
  assert.deepEqual(gridMissingBoundaries(blocks, keep, held([0, 29, 60, 61, 89, 119]), 6), []);
  assert.deepEqual(gridMissingBoundaries(blocks, keep, held([0, 32, 60, 61, 92, 119]), 6), []);
  // the output boundary of the hot block is not served by its input boundary
  assert.deepEqual(gridMissingBoundaries(blocks, keep, held([0, 30, 60, 90, 119]), 6), [61]);
  // a boundary far from any resident one is missing; root and the end never are
  assert.deepEqual(gridMissingBoundaries(blocks, new Set([0, 30, 90, 120]), held([0, 90]), 4), [30]);
});
