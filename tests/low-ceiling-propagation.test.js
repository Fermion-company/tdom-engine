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
