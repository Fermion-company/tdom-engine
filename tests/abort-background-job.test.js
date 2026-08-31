import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';

import { abortBackgroundJob } from '../engine/checkpoint/abort-background-job.js';
import { handlePeerMessage } from '../engine/checkpoint/peer-message.js';

function fakeEngine(job) {
  const rejected = [];
  return {
    bgAbort: false,
    bgActive: true,
    currentJob: job,
    cancelledJobIds: new Set(),
    checkpoints: new Map(),
    waiters: new Map(),
    diagnostics: [],
    _reject(key, error) { rejected.push({ key, error }); },
    _fulfill() {},
    rejected,
  };
}

test('background pre-emption rejects both resident job waiters immediately', () => {
  const engine = fakeEngine({ galleyKey: 'galley:j1', ckptKey: 'ckpt:8', pid: 4321 });
  const killed = [];
  assert.equal(abortBackgroundJob(engine, undefined, {
    killProcess: (...args) => killed.push(args),
    setTimer: () => ({ unref() {} }),
  }), true);
  assert.equal(engine.bgAbort, true);
  assert.deepEqual(killed, [[4321, 'SIGKILL']]);
  assert.deepEqual(engine.rejected.map((x) => x.key), ['galley:j1', 'ckpt:8']);
  assert.ok(engine.rejected.every((x) => x.error.tdomAborted === true));
});

test('pre-emption remembers an unannounced child until FORKED can reap it', () => {
  const engine = fakeEngine({ galleyKey: 'galley:late', ckptKey: 'ckpt:9' });
  let timerFn = null;
  abortBackgroundJob(engine, undefined, {
    killProcess: () => assert.fail('there is no announced pid yet'),
    setTimer: (fn) => {
      timerFn = fn;
      return { unref() {} };
    },
  });
  assert.equal(engine.cancelledJobIds.has('late'), true);
  assert.equal(typeof timerFn, 'function');
});

test('FORKED for a pre-empted job is killed and not installed as the current child', async () => {
  const engine = fakeEngine({ galleyKey: 'galley:other', ckptKey: 'ckpt:9' });
  engine.cancelledJobIds.add('late');
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)']);
  try {
    handlePeerMessage(engine, {}, { kind: 'FORKED', id: 'late', pid: child.pid });
    assert.equal(engine.cancelledJobIds.has('late'), false);
    assert.equal(engine.currentJob.pid, undefined);
    const [code, signal] = await once(child, 'exit');
    assert.equal(code, null);
    assert.equal(signal, 'SIGKILL');
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }
});
