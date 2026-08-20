// Infrastructure failures in the resident tree (fork() failure, a job that
// nothing ever answers) must ESCALATE to the update-level full rebuild —
// not freeze the block, which used to leave every later edit of that block
// stuck at canonical latency (observed live in the TeX64 embedding, 2026-08).
// A lineage that answers nothing at all (children fork but never reply)
// may freeze the block on the way, but must end healed through the rebuild
// — and the suspect checkpoint is retired so later edits never re-feed it.
//
// Fault injection: the daemon understands 'FAULT FORKFAIL|SILENT|WEDGE <n>'.
// These tests fork real lualatex processes; skipped without a TeX install.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

// short job timeout so the timeout-shaped faults don't cost 12s each;
// must be set before the engine module (module-scope const) is imported
process.env.TDOM_JOB_TIMEOUT = process.env.TDOM_JOB_TIMEOUT || '1500';
process.env.TDOM_MAX_CHECKPOINTS = process.env.TDOM_MAX_CHECKPOINTS || '8';
const { CheckpointEngine } = await import('../engine/checkpoint/engine-v3.js');

const DEMO = readFileSync(fileURLToPath(new URL('../samples/demo-lua.tex', import.meta.url)), 'utf8');
const WORK = fileURLToPath(new URL('../.tdom-infra-test', import.meta.url));

const available = await promisify(execFile)('lualatex', ['--version'], { timeout: 15_000 }).then(
  () => true,
  () => false
);
const opts = available ? { timeout: 120_000 } : { skip: 'lualatex not installed' };

let eng;
let source;
before(async () => {
  if (!available) return;
  rmSync(WORK, { recursive: true, force: true });
  eng = new CheckpointEngine({ workDir: WORK });
  await eng.open(DEMO);
  source = eng.getSource();
});
after(async () => {
  if (eng) await eng.close();
});

const armFault = async (kind, n) => {
  for (const peer of eng.peers) peer.send(`FAULT ${kind} ${n}\n`);
  await new Promise((r) => setTimeout(r, 200)); // let the daemons process it
};
// wait out background chain/render work so the next edit's jobs run in the
// FOREGROUND against the armed peers (otherwise the edit can coalesce into a
// pending background pass and dodge the fault)
const settle = async () => {
  for (let i = 0; i < 150; i++) {
    await (eng.bgTask?.catch?.(() => {}) ?? null);
    await (eng.renderTask?.catch?.(() => {}) ?? null);
    if (!eng.pendingChain && !eng.bgActive && eng.renderWant.size === 0) return;
    await new Promise((r) => setTimeout(r, 200));
  }
};
// each report DRAINS engine.diagnostics into stats.diagnostics — inspect the report
const reportDiag = (report, needle) =>
  (report.stats?.diagnostics ?? []).filter((d) => d.includes(needle)).length;
const editAppend = async (marker) => {
  // insert INSIDE the body — after \end{document} would be a no-op edit
  const at = source.indexOf('\\end{document}');
  assert.ok(at > 0, 'demo document has a body');
  const text = `${marker}\n\n`;
  const report = await eng.edit(at, at, text);
  source = eng.getSource();
  return report;
};

// NB: the full-rebuild retry reboots the root; the response records it in
// stats.rebooted, and stats.diagnostics carries the drained engine log.

test('fork failure escalates to a full rebuild and heals', opts, async () => {
  await settle();
  await armFault('FORKFAIL', 99);
  const t0 = Date.now();
  const report = await editAppend('FORKFAIL RECOVERY MARKER');
  const took = Date.now() - t0;
  assert.equal(eng.mode, 'structured');
  assert.ok(source.includes('FORKFAIL RECOVERY MARKER'));
  assert.equal(report.stats?.rebooted, true, 'the full-rebuild retry ran');
  // FORKFAIL is reported instantly — no job-timeout burn before the rebuild
  assert.ok(took < 30_000, `healed in ${took}ms`);
  assert.ok((report.patches?.length ?? 0) >= 1, 'rebuilt pages were patched');
});

test('a job nothing answers (no child announced) escalates and heals', opts, async () => {
  await settle();
  await armFault('SILENT', 99);
  const t0 = Date.now();
  const report = await editAppend('SILENT RECOVERY MARKER');
  const took = Date.now() - t0;
  assert.equal(eng.mode, 'structured');
  assert.ok(source.includes('SILENT RECOVERY MARKER'));
  assert.equal(report.stats?.rebooted, true, 'the full-rebuild retry ran');
  // the silent job must actually burn its (shortened) timeout first
  assert.ok(took > 1_200, `the silent wait was real (${took}ms)`);
  assert.ok(took < 60_000, `healed in ${took}ms`);
  assert.ok((report.patches?.length ?? 0) >= 1);
});

test('a fully wedged lineage ends healed, not permanently frozen', opts, async () => {
  await settle();
  await armFault('WEDGE', 99);
  const report1 = await editAppend('WEDGE MARKER one');
  assert.equal(eng.mode, 'structured');
  // the ladder may freeze the block on the way, but a lineage that answers
  // NOTHING (in-chain, rescue, then the frozen block's state job) must end
  // in the full rebuild — never in a permanent per-block freeze that eats
  // every later edit of the region
  assert.equal(report1.stats?.rebooted, true, 'the lineage wedge was rebuilt away');
  assert.ok(source.includes('WEDGE MARKER one'));

  // and the next edit runs normally on the fresh tree
  const t0 = Date.now();
  const report2 = await editAppend('WEDGE MARKER two');
  const took = Date.now() - t0;
  assert.equal(eng.mode, 'structured');
  assert.ok(source.includes('WEDGE MARKER two'));
  assert.ok(!report2.stats?.rebooted, 'no rebuild needed any more');
  assert.ok(took < 5_000, `normal edit again (${took}ms)`);
  assert.ok((report2.patches?.length ?? 0) >= 1, 'the region typesets again');
});
