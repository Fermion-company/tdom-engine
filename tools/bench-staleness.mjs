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
if (!(seconds > 0) || !(Number(process.env.TDOM_MAX_CHECKPOINTS) > 0 && Number(process.env.TDOM_MAX_CHECKPOINTS) <= 8)) {
  throw new Error('Use --seconds=N and TDOM_MAX_CHECKPOINTS=8 (one engine at a time).');
}
const source = readFileSync(file, 'utf8');
const root = mkdtempSync(path.join(tmpdir(), 'tdom-staleness-'));
const engine = new CheckpointEngine({ workDir: path.join(root, 'engine'), docDir: path.dirname(file) });
const marks = [...new Set([15, 45, 90, seconds].filter((n) => n <= seconds))].sort((a, b) => a - b);
const snapshots = [];
const canonical = [];
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

function capture(stage) {
  const text = engine.getDisplayLists().map((page) => page.commands
    .filter((command) => command.op === 'glyphs').map((command) => command.text).join('')).join('\n');
  snapshots.push({ stage, elapsedMs: Math.round(performance.now() - started), chars, equations,
    pages: engine.pages.length, pendingChain: Boolean(engine.pendingChain), canonicalRev: engine.canonical.last?.rev,
    source: engine.getSource(), refs: references(text) });
}

try {
  try {
    await engine.open(source);
    await drain(engine);
    await engine.canonical.settle();
    started = performance.now();
    engine.onCanonical = (info) => canonical.push({ elapsedMs: Math.round(performance.now() - started),
      rev: info.rev, id: info.id });
    console.log(JSON.stringify({ bootPages: engine.pages.length, blocks: engine.blocks.length }));
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
    await drain(engine);
    capture('drained');
  } finally {
    await engine.close();
  }
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
    const wrong = Object.entries(truth).filter(([section, number]) => snapshot.refs[section] !== number);
    const { source: omitted, ...measured } = snapshot;
    console.log(JSON.stringify({ ...measured, wrong: wrong.length, of: 12,
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
