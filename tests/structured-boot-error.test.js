import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CheckpointEngine } from '../engine/checkpoint/engine-v3.js';
import { resetOpenState } from '../engine/checkpoint/open-state.js';
import { prepareUpdate } from '../engine/checkpoint/update-prepare.js';
import { ShimUnavailableError } from '../engine/checkpoint/forkshim.js';

test('shim failure is machine-readable, sticky while editing, and retried on the next open', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'tdom-boot-error-'));
  const engine = new CheckpointEngine({ workDir: dir });
  const source = String.raw`\documentclass{article}\begin{document}Hello.\end{document}`;
  let boots = 0, fail = true;
  const callbacks = {
    expandIncludes: blocks => blocks,
    unindexBlock() {},
    scheduleStructuredReprobe() {},
    opaqueUpdate(_label, _timer, reasons) {
      engine.mode = 'opaque'; engine.modeReasons = reasons; engine.preHash = null;
      return { mode: engine.mode };
    },
    async bootRoot() {
      boots++;
      if (fail) throw new ShimUnavailableError({ platform: 'darwin', arch: 'arm64', sourceHash: 'hash',
        attempts: [{ kind: 'compile', target: 'default', ok: false, error: 'cc not found' }] });
    },
  };
  const update = editLabel => prepareUpdate(engine, { editLabel, callbacks, timer: { lap() {} } });
  try {
    resetOpenState(engine, source, 'first.tex');
    await update('open');
    assert.equal(boots, 1);
    assert.equal(engine.mode, 'opaque');
    assert.deepEqual(JSON.parse(JSON.stringify(engine.structuredBootError)), {
      code: 'TDOM_SHIM_UNAVAILABLE', message: 'cc not found', platform: 'darwin', arch: 'arm64', sourceHash: 'hash',
      attempts: [{ kind: 'compile', target: 'default', ok: false, error: 'cc not found' }],
    });
    await update('edit');
    assert.equal(boots, 1);
    resetOpenState(engine, source, 'second.tex');
    assert.equal(engine.structuredBootError, null);
    fail = false;
    await update('open');
    assert.equal(boots, 2);
    assert.equal(engine.mode, 'structured');
    assert.equal(engine.structuredBootError, null);
  } finally {
    await engine.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
