import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { CheckpointEngine } from '../engine/checkpoint/engine-v3.js';
import { runChainPass } from '../engine/checkpoint/chain-pass.js';
import { preserveCheckpointSuffix } from '../engine/checkpoint/checkpoint-preservation.js';
import { enforceCheckpointCap, retireOffGrid, propagationCheckpointHold } from '../engine/checkpoint/checkpoint-retirement.js';
import { scheduleBackground } from '../engine/checkpoint/background-scheduler.js';
import { queueRender } from '../engine/checkpoint/render-pump.js';
import { drain, signature } from '../tools/harness.mjs';

test('settle cannot converge in a clean island before a later pending frontier', async () => {
  const work = { kind: 'settle', from: 2, through: 7, phase: 'blocks', labels: new Set() };
  const engine = { pendingChain: work, blocks: Array.from({ length: 10 }, (_, id) =>
    ({ id, galley: {}, galleyHash: 'same', stateVec: 'same' })), labelTable: new Map() };
  const visited = [];
  await runChainPass(engine, {
    nearestCheckpoint: () => 0,
    typesetBlock: async i => { visited.push(i); return {}; },
    adoptGalley() {}, asyncRepaginate() {}, chainAfterPass() {}, enforceCheckpointCap() {},
  });
  assert.deepEqual(visited, [0, 1, 2, 3, 4, 5, 6, 7]);
  assert.equal(engine.pendingChain, null);
});

test('both propagation frontiers rekey, including a cold carry', () => {
  const carry = { from: 2, through: 7 };
  const pendingChain = { from: 2, through: 7, carry };
  preserveCheckpointSuffix({ checkpoints: new Map(), renderHold: new Map(), editHold: [], pendingChain,
    bounds: { prefixLen: 1, oldSuffixStart: 2, newSuffixStart: 4 } });
  assert.deepEqual(pendingChain, { from: 4, through: 9, carry: { from: 4, through: 9 } });
});

for (const killed of [false, true]) test(`interrupted prefix replay preserves the old frontier (${killed ? 'JOB killed' : 'boundary abort'})`, async () => {
  const work = { kind: 'settle', from: 8, through: 2, phase: 'blocks', labels: new Set() };
  const engine = { pendingChain: work, blocks: Array.from({ length: 10 }, (_, id) =>
    ({ id, galley: {}, galleyHash: 'same', stateVec: 'same' })), labelTable: new Map() };
  const visited = [];
  const callbacks = {
    nearestCheckpoint: () => 0,
    typesetBlock: async i => {
      if (i === 2) {
        engine.bgAbort = true;
        if (killed) throw new Error('keystroke');
      }
      visited.push(i);
      return {};
    },
    adoptGalley() {}, asyncRepaginate() {}, chainAfterPass() {}, enforceCheckpointCap() {}, pinBoundary() {},
  };
  await runChainPass(engine, callbacks);
  assert.equal(work.through, 8, 'replaying an already verified prefix cannot discard the old frontier');
  engine.bgAbort = false;
  callbacks.nearestCheckpoint = i => i;
  callbacks.typesetBlock = async i => { visited.push(i); return {}; };
  await runChainPass(engine, callbacks);
  assert.equal(visited.at(-1), 8, 'cannot converge before the old frontier');
  assert.equal(engine.pendingChain, null);
});

test('overdue propagation retains its frontier across nonstop edits at ceiling 8', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 100_000 });
  const keep = new Set([0, 8, 16, 24, 32, 40, 48, 60]);
  const peer = () => ({ send() {} });
  const engine = { blocks: Array.from({ length: 60 }, (_, id) =>
    ({ id, galley: {}, galleyHash: id < 19 ? 'new' : 'old', stateVec: id < 19 ? 'new' : 'old' })),
    checkpoints: new Map([...keep].map(i => [i, peer()])), editHold: [3, 4, 33, 34, 51, 52],
    renderHold: new Map(), renderWant: new Set(), labelTable: new Map(), hrefTable: new Map(),
    pendingChain: { kind: 'settle', from: 19, through: 59, phase: 'blocks', labels: new Set(), queuedAt: Date.now() },
    bgAbort: false, editPending: 0, diagnostics: [] };
  for (const i of engine.editHold) engine.checkpoints.set(i, peer());
  // Also exercise a finite 2 * ceiling budget, as used by shared ownership.
  const cap = (continuation = []) => enforceCheckpointCap({ ...engine, keep, maxPeers: 16,
    editHold: [0, ...engine.editHold, ...continuation], coveragePins: engine.editHold,
    activeHold: propagationCheckpointHold(engine.pendingChain) });
  let jobs = 0, passes = 0, completedAt;
  const callbacks = {
    nearestCheckpoint: target => Math.max(...[...engine.checkpoints.keys()].filter(i => i <= target)),
    typesetBlock: async i => {
      // Eight cheap jobs fit between keystrokes; the next in-flight JOB is killed.
      if (++jobs > 8) { engine.bgAbort = true; throw new Error('keystroke'); }
      assert.ok(engine.checkpoints.has(i), 'replay input is resident');
      engine.checkpoints.set(i + 1, peer());
      retireOffGrid({ ...engine, idx: i, keep,
        editHold: [...engine.editHold, ...propagationCheckpointHold(engine.pendingChain)] });
      cap([i + 1]);
      return { labels: [] };
    },
    adoptGalley: block => { block.galleyHash = block.stateVec = 'new'; },
    pinBoundary: idx => { engine.editHold = [...new Set([idx, ...engine.editHold])].slice(0, 8); },
    asyncRepaginate() {}, chainAfterPass() {}, enforceCheckpointCap: cap,
  };
  const scheduler = { locked: fn => fn(), enforceCheckpointCap: cap,
    runChainPass: () => { passes++; return runChainPass(engine, callbacks); } };
  for (let key = 0; key < 40 && engine.pendingChain; key++) {
    const locus = [2, 26, 49][key % 3];
    // prepareUpdate can fill all eight edit pins from the new page alone.
    engine.editHold = Array.from({ length: 8 }, (_, i) => locus + i);
    cap();
    engine.lastEditAt = Date.now();
    engine.bgAbort = false;
    jobs = 0;
    engine.updating = true;
    scheduleBackground(engine, [], scheduler);
    engine.updating = false;
    // Before the deadline every key interrupts the idle gate.
    if (key < 17) engine.bgAbort = true;
    t.mock.timers.tick(120);
    await engine.bgTask;
    if (!engine.pendingChain) completedAt = Date.now();
    assert.ok(new Set(engine.checkpoints.values()).size <= 16, 'no extra checkpoint allowance');
  }
  assert.ok(completedAt, `dependent tail starved after ${passes} admitted passes`);
  assert.ok(completedAt - 100_000 <= 3_000, `2 s deadline plus one sliced pass: ${completedAt - 100_000} ms`);
  assert.ok(engine.blocks.slice(19).every(b => b.galleyHash === 'new'), 'every dependent block updated');
});

test('propagation math keeps both render owners across a keystroke and rekey', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const work = { kind: 'settle', from: 0, through: 1, phase: 'blocks', labels: new Set(['equation']) };
  const block = { id: 'math', galley: {}, galleyHash: 'old', stateVec: 'old', needsRender: true };
  const engine = { pendingChain: work, blocks: [block], chunks: new Map(), labelTable: new Map(),
    renderWant: new Map(), renderBusy: new Map() };
  const callbacks = {
    nearestCheckpoint: i => i, typesetBlock: async () => ({ capture: 'c1' }),
    adoptGalley: () => { block.galleyHash = 'new'; },
    queueRender(id, options) { assert.equal(options.propagation, true); engine.renderWant.set(id, {}); },
    asyncRepaginate() {}, chainAfterPass() {}, enforceCheckpointCap() {},
  };
  const pass = runChainPass(engine, callbacks);
  for (let turn = 0; turn < 10 && !work.render; turn++) await Promise.resolve();
  assert.ok(work.render, 'math waits for the existing render pump');
  assert.deepEqual(new Set(propagationCheckpointHold(work)), new Set([0, 1]));
  engine.bgAbort = true;
  t.mock.timers.tick(5);
  await pass;
  preserveCheckpointSuffix({ pendingChain: work, checkpoints: new Map(), renderHold: new Map(), editHold: [],
    bounds: { prefixLen: 0, oldSuffixStart: 0, newSuffixStart: 2,
      boundaryMap: new Map([[0, { to: 2, exact: false }], [1, { to: 3, exact: false }]]) } });
  assert.equal(work.from, 3);
  assert.equal(work.render.from, 2);
  engine.bgAbort = false;
  callbacks.queueRender = () => engine.renderWant.clear();
  await runChainPass(engine, callbacks);
  assert.equal(work.render, undefined);
  assert.equal(engine.pendingChain, null);
});

test('propagation renders bypass the quiet gate and an active edit cohort without adding lanes', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 100_000 });
  const engine = { srcRev: 3, lastEditAt: Date.now(), renderWant: new Map(), renderPumping: 0,
    renderTask: Promise.resolve(), chunks: new Map(), diagnostics: [], buildLeasePreviewJobs: new Set(),
    canonical: { waitForBuildLease: async () => {} },
    interactiveRenderCohort: { rev: 3, active: new Set([{}]) },
    blocks: [{ id: 'equation', galley: {}, galleyHash: 'new', needsRender: true }] };
  const released = [];
  queueRender(engine, 'equation', { chunkTargets: () => [], releaseRenderHold: i => released.push(i) }, { propagation: true });
  await engine.renderTask;
  assert.deepEqual(released, [0], 'no idle-time advance was needed');
  assert.equal(engine.renderPumping, 0);
  assert.equal(engine.renderWant.size, 0);
});

for (const ceiling of [8, 12]) {
  test(`native merged equation propagation drains exactly at ceiling ${ceiling}`, { timeout: 180_000 }, async () => {
    const { stdout: source } = await promisify(execFile)(process.execPath,
      [fileURLToPath(new URL('../tools/gen-long-doc.mjs', import.meta.url)), '12']);
    const root = mkdtempSync(path.join(tmpdir(), 'tdom-low-ceiling-'));
    const engine = new CheckpointEngine({ workDir: path.join(root, 'edited') });
    engine.checkpointCeiling = engine.maxCheckpoints = ceiling;
    let finalSource, editedSignature;
    try {
      await engine.open(source);
      await drain(engine);
      assert.equal(engine.mode, 'structured');
      for (let round = 0; round < 2; round++) {
        for (const section of [3, 7, 11]) {
          const at = engine.getSource().indexOf(`これは第${section}節の段落3`);
          await engine.edit(at, at,
            `\\begin{equation}\\label{typed-${round}-${section}}x=1\\end{equation}\n\n`);
        }
        // Rotate the edit pins while the three counter changes are pending.
        for (let key = 0; key < 12; key++) {
          const at = engine.getSource().indexOf(`これは第${[3, 7, 11][key % 3]}節の段落3`);
          await engine.edit(at, at, 'あ');
        }
      }
      await drain(engine);
      finalSource = engine.getSource();
      const labels = [...finalSource.matchAll(/\\label\{([^}]+)\}/g)].map(m => m[1]);
      for (const [i, label] of labels.entries()) assert.equal(engine.labelTable.get(label), String(i + 1), label);
      for (const block of engine.blocks) {
        for (const [label, value] of Object.entries(block.galley?.tdomRefVals ?? {})) {
          assert.equal(value, engine.labelTable.get(label), `rendered reference ${label}`);
        }
      }
      assert.equal(engine.maxCheckpoints, ceiling);
      editedSignature = signature(engine);
    } finally {
      await engine.close();
      if (!editedSignature) rmSync(root, { recursive: true, force: true });
    }
    // Sequential: never run the edited and fresh resident trees together.
    const fresh = new CheckpointEngine({ workDir: path.join(root, 'fresh') });
    fresh.checkpointCeiling = fresh.maxCheckpoints = ceiling;
    try {
      await fresh.open(finalSource);
      await drain(fresh);
      assert.deepEqual(editedSignature, signature(fresh));
    } finally {
      await fresh.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
}
