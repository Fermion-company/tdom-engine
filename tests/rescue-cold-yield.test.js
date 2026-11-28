import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

let available = true;
try {
  execFileSync('lualatex', ['--version'], { stdio: 'ignore' });
} catch {
  available = false;
}
const opts = available ? {} : { skip: 'lualatex not installed' };

const CHILD = fileURLToPath(new URL('./helpers/rescue-cold-yield-child.mjs', import.meta.url));
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const BEAT_GAP_MS = 30_000;
const HARD_MS = 600_000;

/**
 * Runs the scenario in its own process: a starved event loop also starves
 * this runner's timers, so only another process can call the hang. Resolves
 * with the child's events; a child whose heartbeat stops (or that outlives the
 * hard limit) is killed and reported as stalled.
 */
function runChild() {
  return new Promise((resolve) => {
    // its own process group: a kill takes the engine's lualatex processes too
    const child = spawn(process.execPath, [CHILD, ROOT], { stdio: ['ignore', 'pipe', 'pipe'], detached: true });
    const events = [];
    let buf = '';
    let stderr = '';
    let stalled = null;
    let beatTimer = null;
    const kill = (why) => {
      stalled = why;
      try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
    };
    const armBeat = () => {
      clearTimeout(beatTimer);
      beatTimer = setTimeout(() => kill(`no heartbeat for ${BEAT_GAP_MS / 1000} s after the second keystroke`), BEAT_GAP_MS);
    };
    child.stdout.on('data', (data) => {
      buf += data;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        let ev;
        try { ev = JSON.parse(line); } catch { continue; }
        if (ev.event === 'second keystroke returned' || ev.event === 'beat') armBeat();
        if (ev.event === 'done') clearTimeout(beatTimer);
        if (ev.event !== 'beat') events.push(ev);
      }
    });
    child.stderr.on('data', (data) => { stderr = (stderr + data).slice(-4000); });
    const hard = setTimeout(() => kill(`still running after ${HARD_MS / 1000} s`), HARD_MS);
    child.on('exit', (code) => {
      clearTimeout(hard);
      clearTimeout(beatTimer);
      if (stalled) rmSync(path.join(ROOT, '.tdom-v3-test-cold-yield'), { recursive: true, force: true });
      resolve({ code, events, stalled, stderr });
    });
  });
}

test('a focused rescue never holds the event loop while a cold resume is owed only for its block (tex64-internal #121)', opts, async () => {
  const run = await runChild();
  const of = (name) => run.events.find((ev) => ev.event === name);
  assert.equal(run.stalled, null, `${run.stalled}: ${JSON.stringify(run.events)}\n${run.stderr}`);
  assert.equal(of('error'), undefined, of('error')?.message);
  assert.equal(run.code, 0, run.stderr);
  // the reproduction reached the state of the stall
  const state = of('second keystroke returned');
  assert.equal(state.verdict, 'cold');
  assert.deepEqual(state.coldDirty, [state.id], 'the cold resume is owed only for the columns');
  assert.equal(state.chain, 'cold', 'the cold walk has not run yet');
  assert.ok(state.focus && state.queued, 'the columns\' rescue is queued and on the keystroke\'s page');
  const done = of('done');
  assert.ok(done.settled, `everything settled: ${JSON.stringify(done)}`);
  assert.ok(done.maxGapMs < 10_000, `timers kept running (longest gap ${done.maxGapMs} ms)`);
  assert.deepEqual(done.coldDirty, []);
  assert.equal(done.chain, null);
  assert.equal(done.queue, 0);
  assert.ok(done.text && done.rescued && !done.preview && !done.stale, `the columns show their exact result: ${JSON.stringify(done)}`);
  assert.ok(done.aborted <= 2, `the adoption gave way ${done.aborted} times`);
});
