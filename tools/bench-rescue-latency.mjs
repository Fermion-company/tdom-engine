// One engine, real protocol/Poppler timings, and the viewer's actual atomic
// transactions with ready image/font shells. This does NOT measure browser
// decode, layout or paint; use web/app.js __tdomStageTrace for those stages.
// Usage: node tools/bench-rescue-latency.mjs file.tex --lines=112,139 --keys=10
import cp from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import { provisionalViewer } from '../tests/helpers/provisional-viewer.js';
import { drain, percentile } from './harness.mjs';

const args = process.argv.slice(2);
const input = args.find(arg => !arg.startsWith('--'));
if (!input) throw new Error('Usage: node tools/bench-rescue-latency.mjs file.tex --lines=112,139 --keys=10');
const file = path.resolve(input);
const option = (name, fallback) => args.find(arg => arg.startsWith(`--${name}=`))?.split('=')[1] ?? fallback;
const lines = option('lines', '112,139').split(',').map(Number);
const keys = Number(option('keys', '10'));
const burstKeys = Number(option('burst-keys', '67'));
if (!lines.every(n => Number.isInteger(n) && n > 0) || !Number.isInteger(keys) || keys < 1 ||
    !Number.isInteger(burstKeys) || burstKeys < 1) throw new Error('Invalid lines/keys');
if (!(Number(process.env.TDOM_MAX_CHECKPOINTS) > 0 && Number(process.env.TDOM_MAX_CHECKPOINTS) <= 8)) {
  throw new Error('Set TDOM_MAX_CHECKPOINTS=8; run only one engine at a time.');
}
const source = readFileSync(file, 'utf8');
const work = mkdtempSync(path.join(os.tmpdir(), 'tdom-rescue-latency-'));
let events = null, started = 0, counts = null;
const trace = (kind, detail = {}) => {
  if (events) events.push({ t: +(performance.now() - started).toFixed(2), kind, ...detail });
};
const originalTimeout = globalThis.setTimeout;
globalThis.setTimeout = (callback, ms, ...parameters) => {
  const stack = events && args.includes('--trace') ? new Error().stack : '';
  const caller = stack?.split('\n').find(line => /checkpoint\/(?:rescue-scheduling|render-pump|isolated-render|util\/fs|engine-v3)\.js/.test(line));
  if (!caller) return originalTimeout(callback, ms, ...parameters);
  const recording = events, at = performance.now();
  trace('wait', { ms, caller: caller.trim() });
  return originalTimeout((...values) => {
    if (events === recording) trace('wake', { ms: performance.now() - at, caller: caller.trim() });
    callback(...values);
  }, ms, ...parameters);
};
const originalExec = cp.execFile;
cp.execFile = function (command, argv, ...rest) {
  const at = performance.now();
  const name = path.basename(command);
  if (counts) counts[name] = (counts[name] ?? 0) + 1;
  trace('exec', { name, page: name === 'pdftocairo' ? argv[2] : undefined });
  const child = originalExec.call(this, command, argv, ...rest);
  child.on('exit', code => trace('exec-end', { name, code, ms: performance.now() - at }));
  return child;
};
cp.execFile[Symbol.for('nodejs.util.promisify.custom')] = (...parameters) => {
  let child;
  const promise = new Promise((resolve, reject) => {
    child = cp.execFile(...parameters, (error, stdout, stderr) => error
      ? reject(Object.assign(error, { stdout, stderr })) : resolve({ stdout, stderr }));
  });
  promise.child = child;
  return promise;
};
syncBuiltinESMExports();
const { CheckpointEngine } = await import('../engine/checkpoint/engine-v3.js');
const { Peer } = await import('../engine/checkpoint/peer.js');
const send = Peer.prototype.send;
Peer.prototype.send = function (line) {
  const command = line.split(' ')[0];
  if (['JOB', 'STEP', 'ISO', 'RENDER', 'CAPTURE'].includes(command)) {
    if (counts) counts[command] = (counts[command] ?? 0) + 1;
    trace('send', { command, id: line.split(' ')[1], pid: this.pid });
  }
  return send.call(this, line);
};
const engine = new CheckpointEngine({ workDir: work, docDir: path.dirname(file) });
const message = engine._onMessage.bind(engine);
engine._onMessage = (peer, report) => {
  if (['GALLEY', 'CKPT', 'DONE', 'FORKED'].includes(report.kind)) {
    trace(report.kind, { id: report.id, pid: report.pid ?? peer.pid });
  }
  return message(peer, report);
};
let viewer, commits = [], targetId, paintedTarget;
function targetKeys() {
  const block = engine.blocks.find(b => b.id === targetId);
  return new Set([targetId, ...(block?.galley?.items ?? []).map(item => item.chunk).filter(Boolean)]);
}
function targetPixels() {
  return createHash('sha256').update(JSON.stringify([...targetKeys()].sort().map(key => engine.chunks.get(key)?.svg ?? null))).digest('hex');
}
function publish(report) {
  trace('publish', { rev: engine.srcRev, pages: report.patches?.filter(p => p.type === 'replace-page').map(p => p.displayList.page) });
  if (!viewer) return;
  viewer.appliedSrcRev = engine.srcRev;
  const previous = new Map([...viewer.pageDivs].map(([n, page]) => [n, page.paper]));
  viewer.stageProvisionalPatches(report.patches ?? [], true, engine.pages.length);
  const changed = [...viewer.pageDivs].filter(([n, page]) => page.paper !== previous.get(n)).map(([n]) => n);
  const pixels = targetPixels();
  const keys = targetKeys();
  const targetChanged = changed.some(n => [].concat(viewer.pageDivs.get(n).paper).some(dl =>
    dl?.commands?.some(command => keys.has(command.src))));
  if (targetChanged && pixels !== paintedTarget) {
    paintedTarget = pixels;
    const commit = { t: performance.now() - started, rev: engine.srcRev, pages: changed };
    commits.push(commit);
    trace('transaction', commit);
  }
}
engine.onAsyncPatches = publish;
engine.onDeferredUpdate = publish;
engine.onCanonical = info => trace('canonical', { rev: info.rev, id: info.id });
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const summary = values => {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  return { n: sorted.length, p50: percentile(sorted, 50), p95: percentile(sorted, 95), min: sorted[0], max: sorted.at(-1) };
};
const snapshot = () => createHash('sha256').update(JSON.stringify({
  blocks: engine.blocks.map(b => [b.galleyHash, b.stateVec]),
  chunks: [...engine.chunks].sort(([a], [b]) => a.localeCompare(b)).map(([id, chunk]) => [id, chunk.svg]),
})).digest('hex');
try {
  await engine.open(source);
  await drain(engine);
  await engine.renderTask;
  if (engine.mode !== 'structured') throw new Error(engine.diagnostics.join('; '));
  await engine.canonical.ensure(engine.getSource(), engine.srcRev);
  await drain(engine);
  await engine.renderTask;
  viewer = provisionalViewer(engine.getDisplayLists(), engine.canonical.info().pageCount);
  console.log(JSON.stringify({ kind: 'boot', file, work, mode: engine.mode, policy: engine.previewPolicy,
    measurement: 'ready-resource viewer transaction; excludes network/image decode/layout/paint',
    blocks: engine.blocks.map(b => ({ id: b.id, startLine: source.slice(0, b.start).split('\n').length,
      endLine: source.slice(0, b.end).split('\n').length, rescued: b.rescued })), signature: snapshot() }));
  for (const line of lines) {
    for (const burst of [false, true]) {
      let pos = engine.getSource().split('\n').slice(0, line).join('\n').length;
      await engine.warmEditOffset(pos);
      await drain(engine);
      await engine.renderTask;
      await sleep(1000);
      targetId = engine.blocks.find(b => b.start <= pos && b.end >= pos)?.id;
      paintedTarget = targetPixels();
      viewer = provisionalViewer(engine.getDisplayLists(), engine.pages.length);
      events = []; counts = {}; commits = []; started = performance.now();
      const cpu = process.cpuUsage(), threadCpu = process.threadCpuUsage?.();
      let peakPeers = 0, peakCheckpoints = 0, peakRss = 0;
      const monitor = setInterval(() => {
        peakPeers = Math.max(peakPeers, engine.peers.size);
        peakCheckpoints = Math.max(peakCheckpoints, engine.checkpoints.size);
        peakRss = Math.max(peakRss, process.memoryUsage().rss);
      }, 25);
      const edits = [], count = burst ? burstKeys : keys, interval = burst ? 150 : 2600;
      try {
        for (let key = 0; key < count; key++) {
          await sleep(Math.max(0, started + key * interval - performance.now()));
          const at = performance.now() - started;
          trace('edit', { key });
          const report = await engine.edit(pos, pos, burst ? 'い' : 'あ');
          pos++;
          trace('edit-return', { key, ms: performance.now() - started - at });
          publish(report);
          edits.push({ at, rev: engine.srcRev });
        }
        await sleep(2000);
      } finally { clearInterval(monitor); }
      const usage = process.cpuUsage(cpu);
      const threadUsage = threadCpu && process.threadCpuUsage(threadCpu);
      const samples = edits.map(edit => commits.find(c => c.rev === edit.rev && c.t >= edit.at)?.t - edit.at);
      const typingMs = (count - 1) * interval;
      const updates = commits.filter(c => c.t <= typingMs).length;
      console.log(JSON.stringify({ kind: burst ? 'burst' : 'singles', line, edits, latencyMs: burst ? null : summary(samples),
        updatesDuringTyping: updates, updatesPerSec: typingMs ? updates / (typingMs / 1000) : null,
        firstUpdateAfterLastKeyMs: commits.find(c => c.t > edits.at(-1).at)?.t - edits.at(-1).at,
        cpuMs: { user: usage.user / 1000, system: usage.system / 1000 },
        mainThreadCpuMs: threadUsage && { user: threadUsage.user / 1000, system: threadUsage.system / 1000 },
        jobs: counts, peakPeers, peakCheckpoints, nodePeakRssMiB: peakRss / 1048576,
        commits, events: args.includes('--trace') ? events : undefined, diagnostics: engine.diagnostics.slice(-10) }));
      events = null; counts = null;
      await drain(engine);
      await engine.renderTask;
      console.log(JSON.stringify({ kind: 'settled', line, burst, signature: snapshot() }));
    }
  }
} finally {
  events = null;
  await engine.close();
  if (!args.includes('--keep')) rmSync(work, { recursive: true, force: true });
}
