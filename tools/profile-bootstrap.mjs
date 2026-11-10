// Isolate the resident bootstrap; no canonical compile or HTTP server.
// TDOM_MAX_CHECKPOINTS=8 TDOM_TRACE_JOB=1 node tools/profile-bootstrap.mjs file.tex output.json
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { performance } from 'node:perf_hooks';
import { CheckpointEngine } from '../engine/checkpoint/engine-v3.js';
import { Peer } from '../engine/checkpoint/peer.js';

if (process.env.TDOM_MAX_CHECKPOINTS !== '8') throw new Error('Set TDOM_MAX_CHECKPOINTS=8');
process.env.TDOM_TRACE_JOB = '1';
const source = path.resolve(process.argv[2]);
const output = path.resolve(process.argv[3]);
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'tdom-bootstrap-profile-'));
const engine = new CheckpointEngine({ workDir: work, docDir: path.dirname(source) });
// Measure resident work alone, including its normal render/retirement policy.
engine.canonical.schedule = () => {};
const rows = [];
const jobs = new Map();
const started = performance.now();
let lastCheckpoint = null;
let maxPeers = 0;
let retired = 0;
let renderRequests = 0;
const renders = new Map();
let safetyError = null;
const send = Peer.prototype.send;
Peer.prototype.send = function (line) {
  const m = /^(JOB|STEP) (\S+) (\d+) /.exec(line);
  if (m) {
    const now = performance.now();
    const row = { index: Number(m[3]) - 1, id: m[2], command: m[1], sentAt: now,
      betweenJobsMs: lastCheckpoint === null ? 0 : now - lastCheckpoint };
    jobs.set(m[2], row);
    rows.push(row);
  }
  if (line.startsWith('DIE')) retired++;
  if (/^(RENDER|CAPTURE) /.test(line)) {
    renderRequests++;
    const parts = line.trim().split(' ');
    renders.set(parts[4], { command: parts[0], sentAt: performance.now() });
  }
  return send.call(this, line);
};
const message = engine._onMessage.bind(engine);
engine._onMessage = (peer, msg) => {
  const now = performance.now();
  const row = jobs.get(msg.id);
  if (msg.kind === 'FORKED' && row) row.forkAndConnectMs = now - row.sentAt;
  if (msg.kind === 'GALLEY' && row) Object.assign(row, msg.json.tm, { galleyMs: now - row.sentAt });
  if (msg.kind === 'DONE' && renders.has(msg.id)) renders.get(msg.id).ms = now - renders.get(msg.id).sentAt;
  if (msg.kind === 'CKPT') {
    const current = rows.at(-1);
    if (current && current.index + 1 === msg.idx) {
      current.jobMs = now - current.sentAt;
      current.gcMs = msg.gcMs;
      current.completedAt = now;
    }
    lastCheckpoint = now;
  }
  message(peer, msg);
  maxPeers = Math.max(maxPeers, engine.peers.size);
  if (engine.peers.size > 30 && !safetyError) {
    safetyError = new Error('resident process safety ceiling exceeded');
    void engine.close();
  }
};
const reject = engine._reject.bind(engine);
engine._reject = (key, error) => {
  if (key.startsWith('galley:')) {
    const row = jobs.get(key.slice(7));
    if (row && row.completedAt == null) {
      row.completedAt = performance.now();
      row.jobMs = row.completedAt - row.sentAt;
      row.error = error.message;
      lastCheckpoint = row.completedAt;
    }
  }
  return reject(key, error);
};
const progress = setInterval(() => console.log(JSON.stringify({ elapsedMs: Math.round(performance.now() - started),
  progress: engine.progress, peers: engine.peers.size })), 10_000);
try {
  const report = await engine.open(fs.readFileSync(source, 'utf8'), path.basename(source), { canonicalBaseline: false });
  if (safetyError) throw safetyError;
  if (report.mode !== 'structured') throw new Error(JSON.stringify(report.modeReasons));
  const totalMs = performance.now() - started;
  const sum = key => rows.reduce((n, row) => n + (Number(row[key]) || 0), 0);
  const totals = Object.fromEntries(['jobMs', 'typeset', 'harvest', 'gcMs', 'forkAndConnectMs', 'betweenJobsMs'].map(key => [key, sum(key)]));
  const result = { source, ceiling: engine.checkpointCeiling, budget: engine.maxCheckpoints,
    blocks: engine.blocks.length, jobs: rows.length, totalMs,
    totals, perBlock: Object.fromEntries(Object.entries(totals).map(([k, v]) => [k, v / Math.max(1, engine.blocks.length)])),
    settled: { updating: !!engine.updating, warming: !!engine.warming, shipBooting: !!engine.shipBooting,
      progress: engine.progress },
    maxPeers, retained: engine.checkpoints.size, retired, renderRequests,
    renders: [...renders.values()],
    failures: rows.filter(row => row.error).length,
    blocksProfile: engine.blocks.map(block => ({ id: block.id, file: block.file, start: block.start,
      typesetCostMs: block.typesetCostMs, deferred: !!block.galley?.tdomDeferred })), report, rows };
  fs.writeFileSync(output, JSON.stringify(result, null, 2));
  console.log(JSON.stringify({ ...result, rows: undefined, blocksProfile: undefined, report: undefined }));
} finally {
  clearInterval(progress);
  await engine.close();
  Peer.prototype.send = send;
  fs.rmSync(work, { recursive: true, force: true });
}
