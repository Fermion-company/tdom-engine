// Continuous three-locus typing, compared with independent two-pass paper.
// node tools/gen-long-doc.mjs 12 > /tmp/long.tex
// TDOM_MAX_CHECKPOINTS=8 node tools/bench-staleness.mjs /tmp/long.tex
// Snapshots are captured without pausing typing; truth compiles run only
// after the engine closes, so they cannot distort the measured workload.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { CheckpointEngine } from '../engine/checkpoint/engine-v3.js';
import { drain, percentile } from './harness.mjs';

const exec = promisify(execFile);
const file = path.resolve(process.argv[2]);
const seconds = Number(process.argv.find((arg) => arg.startsWith('--seconds='))?.split('=')[1] ?? 150);
const out = process.argv.find(arg => arg.startsWith('--out='))?.slice(6);
if (!(seconds > 0) || ![8, 12].includes(Number(process.env.TDOM_MAX_CHECKPOINTS))) {
  throw new Error('Use --seconds=N and TDOM_MAX_CHECKPOINTS=8 or 12 (one engine at a time).');
}
const source = readFileSync(file, 'utf8');
const root = mkdtempSync(path.join(tmpdir(), 'tdom-staleness-'));
const engine = new CheckpointEngine({ workDir: path.join(root, 'engine'), docDir: path.dirname(file) });
const marks = [...new Set([15, 45, 90, seconds].filter((n) => n <= seconds))].sort((a, b) => a - b);
const snapshots = [];
const canonical = [];
const frames = [], jobs = [], chunkPdfs = new Map();
let observer;
let chars = 0;
let equations = 0;
let started;
const sites = [0.25, 0.55, 0.85].map((fraction) => ({
  at: source.indexOf('。', Math.floor(source.length * fraction)), keys: 0, walls: [],
}));
if (sites.some((site) => site.at < 0)) throw new Error('Expected the generated Japanese long document.');

function references(text) {
  return Object.fromEntries([...text.replace(/\s/g, '').matchAll(/式([0-9?]+)は第(\d+)節の基準式である/g)]
    .map((match) => [match[2], match[1]]));
}

// This fixture has exactly one numbered equation per label, in source order.
// Independent two-pass compiles below verify this oracle at every snapshot.
function expected(source) {
  return Object.fromEntries([...source.matchAll(/\\label\{([^}]+)\}/g)].map((m, i) => [m[1], String(i + 1)]));
}

function observe() {
  const refs = {}, eqs = {}, equationState = {};
  for (const page of engine.getDisplayLists()) {
    Object.assign(refs, references(page.commands.filter(c => c.op === 'glyphs').map(c => c.text).join('')));
    for (const block of engine.blocks) {
      const label = block.text.match(/\\begin\{equation\}\\label\{([^}]+)\}/)?.[1];
      if (!label) continue;
      const pixels = engine.chunks.get(block.id);
      equationState[label] = { value: block.galley?.labels?.find(l => l.k === label)?.v,
        hash: block.galleyHash, chunkHash: pixels?.forGalley, queued: engine.renderWant.has(block.id),
        isolated: engine.isoRenderPending?.has(block.id) ?? false };
      const commands = page.commands.filter(c => c.src === block.id);
      if (!commands.length) continue;
      const chunkCommand = commands.find(c => c.op === 'chunk');
      if (chunkCommand) {
        const chunk = engine.chunks.get(chunkCommand.chunk);
        const key = `${chunkCommand.chunk}:${chunkCommand.cv}`;
        if (chunk?.v === chunkCommand.cv && (chunk.editPdf || chunk.editGlyphs)) {
          if (!chunkPdfs.has(key)) chunkPdfs.set(key, { pdf: chunk.editPdf, page: chunk.editPage ?? 1,
            glyphs: chunk.editGlyphs, x: chunk.editX ?? 0, y: chunk.editY ?? 0, w: chunk.wBp, h: chunk.hBp });
          eqs[label] = { chunk: key };
        } else eqs[label] = null;
      } else {
        const text = commands.filter(c => c.op === 'glyphs').map(c => c.text).join('').replace(/\s/g, '');
        eqs[label] = text.match(/\((\d+)\)$/)?.[1] ?? null;
      }
    }
  }
  const work = engine.pendingChain;
  const frame = { ms: Math.round(performance.now() - started), refs, eqs, equationState, expected: expected(engine.getSource()),
    work: work ? { kind: work.kind, phase: work.phase, from: work.from, through: work.through,
      age: Date.now() - work.queuedAt, labels: [...work.labels] } : null,
    checkpoints: [...engine.checkpoints.keys()], progress: engine.progress, bgAbort: engine.bgAbort };
  frames.push(frame);
  return frame;
}

const onMessage = engine._onMessage.bind(engine);
engine._onMessage = (peer, message) => {
  if (started && message.kind === 'GALLEY') jobs.push({ ms: Math.round(performance.now() - started),
    idx: engine.currentJob?.ckptIdx - 1, background: engine.bgActive, kind: engine.pendingChain?.kind,
    phase: engine.pendingChain?.phase, from: engine.pendingChain?.from });
  return onMessage(peer, message);
};

function capture(stage) {
  const text = engine.getDisplayLists().map((page) => page.commands
    .filter((command) => command.op === 'glyphs').map((command) => command.text).join('')).join('\n');
  snapshots.push({ stage, elapsedMs: Math.round(performance.now() - started), chars, equations,
    pages: engine.pages.length, pendingChain: Boolean(engine.pendingChain), canonicalRev: engine.canonical.last?.rev,
    source: engine.getSource(), refs: references(text), frame: observe() });
  console.log(JSON.stringify({ stage, elapsedMs: snapshots.at(-1).elapsedMs, equations,
    refs: snapshots.at(-1).refs, work: frames.at(-1).work }));
}

try {
  try {
    await engine.open(source);
    await drain(engine);
    await engine.canonical.settle();
    if (engine.mode !== 'structured' || !engine.pages.length) throw new Error(`Resident boot failed: ${engine.diagnostics.join('; ')}`);
    started = performance.now();
    observe();
    observer = setInterval(observe, 25);
    engine.onCanonical = (info) => canonical.push({ elapsedMs: Math.round(performance.now() - started),
      rev: info.rev, id: info.id });
    console.log(JSON.stringify({ bootPages: engine.pages.length, blocks: engine.blocks.length,
      sampleMs: 25, delayAfterEditMs: 120,
      surface: 'resident display lists and exact chunk PDFs; initial canonical numbers retained without resident pixels; browser paint excluded' }));
    let key = 0;
    while (performance.now() - started < seconds * 1000) {
      const site = sites[key++ % sites.length];
      site.keys++;
      let text = 'あいうえお'[site.keys % 5];
      if (site.keys % 100 === 0) {
        text = `\n\n\\begin{equation}\\label{eq:typed-${++equations}}x=${equations}\\end{equation}\n\n`;
      } else if (site.keys % 30 === 0) text = '\n\n';
      else chars++;
      const at = site.at;
      const start = performance.now();
      await engine.edit(at, at, text);
      site.walls.push(performance.now() - start);
      for (const other of sites) if (other.at >= at) other.at += text.length;
      while (marks.length && performance.now() - started >= marks[0] * 1000) capture(`${marks.shift()}s`);
      await new Promise((resolve) => setTimeout(resolve, 120));
    }
    while (marks.length) capture(`${marks.shift()}s`);
    const stoppedAt = performance.now();
    await drain(engine);
    capture('drained');
    console.log(JSON.stringify({ drainMs: Math.round(performance.now() - stoppedAt) }));
  } finally {
    clearInterval(observer);
    await engine.close();
  }
  // Decode the exact PDFs behind the displayed chunk versions after typing.
  const chunkNumbers = {};
  for (const [key, chunk] of chunkPdfs) {
    let text;
    if (chunk.glyphs) {
      text = (await chunk.glyphs).filter(g => g.left >= chunk.x - 1 && g.right <= chunk.x + chunk.w + 1 &&
        g.baseline >= chunk.y && g.baseline <= chunk.y + chunk.h + 1).map(g => g.text).join('');
    } else {
      const pdf = path.join(root, 'observed.pdf');
      writeFileSync(pdf, chunk.pdf);
      const { stdout } = await exec('pdftotext', ['-f', String(chunk.page), '-l', String(chunk.page), pdf, '-']);
      text = stdout;
    }
    chunkNumbers[key] = text.replace(/\s/g, '').match(/\((\d+)\)$/)?.[1] ?? null;
  }
  const episodes = [], active = new Map();
  // The settled canonical paper is the initial last-good image. A block
  // without resident math pixels keeps that number; a newly inserted block
  // has no old number. Keep missing pixels separate from wrong numbers.
  const paintedEquations = { ...expected(source) };
  let missingEquations = 0;
  for (const frame of frames) {
    const values = Object.fromEntries(Object.entries(frame.refs).map(([s, v]) => [`ref:eq:bench-${s}`, v]));
    for (const [label, value] of Object.entries(frame.eqs)) {
      const number = value?.chunk ? chunkNumbers[value.chunk] : value;
      if (number != null) paintedEquations[label] = number;
      if (paintedEquations[label] == null) { missingEquations++; continue; }
      values[`equation:${label}`] = paintedEquations[label];
    }
    frame.paintedEquations = { ...paintedEquations };
    for (const [key, value] of Object.entries(values)) {
      const want = frame.expected[key.slice(key.indexOf(':') + 1)];
      if (value !== want) {
        if (!active.has(key)) active.set(key, { key, startMs: frame.ms, initial: value, expected: want });
      } else if (active.has(key)) {
        episodes.push({ ...active.get(key), endMs: frame.ms, durationMs: frame.ms - active.get(key).startMs });
        active.delete(key);
      }
    }
  }
  for (const entry of active.values()) episodes.push({ ...entry, durationMs: frames.at(-1).ms - entry.startMs, open: true });
  for (const kind of ['ref', 'equation']) {
    const durations = episodes.filter(e => e.key.startsWith(`${kind}:`)).map(e => e.durationMs).sort((a, b) => a - b);
    console.log(JSON.stringify({ kind, episodes: durations.length, p90StalenessMs: percentile(durations, 90),
      maxStalenessMs: percentile(durations, 100), unresolved: episodes.filter(e => e.open && e.key.startsWith(`${kind}:`)).length }));
  }
  if (out) writeFileSync(out, JSON.stringify({ ceiling: Number(process.env.TDOM_MAX_CHECKPOINTS), frames, jobs,
    episodes, chunkNumbers, snapshots, missingEquationSamples: missingEquations }));
  for (const [index, snapshot] of snapshots.entries()) {
    const dir = path.join(root, `truth-${index}`);
    mkdirSync(dir);
    const tex = path.join(dir, 'main.tex');
    writeFileSync(tex, snapshot.source);
    for (let pass = 0; pass < 2; pass++) {
      await exec('lualatex', ['-interaction=nonstopmode', '-halt-on-error', 'main.tex'],
        { cwd: dir, timeout: 180_000, maxBuffer: 32 * 1024 * 1024 });
    }
    const { stdout } = await exec('pdftotext', [path.join(dir, 'main.pdf'), '-'], { maxBuffer: 16 * 1024 * 1024 });
    const truth = references(stdout);
    if (Object.keys(truth).length !== 12) throw new Error(`Truth has ${Object.keys(truth).length} references, expected 12.`);
    for (const [section, number] of Object.entries(truth)) {
      if (expected(snapshot.source)[`eq:bench-${section}`] !== number) throw new Error('Fixture numbering oracle disagrees with TeX');
    }
    const wrong = Object.entries(truth).filter(([section, number]) => snapshot.refs[section] !== number);
    const { source: omitted, frame, ...measured } = snapshot;
    const equationWrong = Object.entries(frame.paintedEquations).filter(([label, value]) => value !== frame.expected[label]).length;
    console.log(JSON.stringify({ ...measured, wrong: wrong.length, of: 12,
      equationWrong, equationCount: Object.keys(frame.eqs).length,
      missing: Object.keys(truth).filter((section) => snapshot.refs[section] === undefined).length }));
  }
  console.log(JSON.stringify({ canonical, latency: sites.map((site, index) => {
    site.walls.sort((a, b) => a - b);
    return { locus: index + 1, keys: site.keys,
      p50: percentile(site.walls, 50), p95: percentile(site.walls, 95), max: percentile(site.walls, 100) };
  }) }));
} finally {
  rmSync(root, { recursive: true, force: true });
}
