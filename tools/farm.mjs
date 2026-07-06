// farm.mjs — the corpus differential farm (docs/ROADMAP.md Phase 0).
//
// For every corpus entry: structured docs run the verify-layout referee
// ("pseudo PDF == real PDF" at glyph-baseline level, chunk windows counted
// as covered); opaque entries assert the safety gate demotes. Aggregates a
// metrics table and exits non-zero on any unexpected outcome, so this can
// gate CI and every phase of the roadmap.
//
// Usage: node tools/farm.mjs [--full] [--json=path]
//   --full   include the slow entries (ja stress doc)
//   --json   also write the machine-readable results

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { rmSync } from 'node:fs';
import { CheckpointEngine } from '../engine/checkpoint/engine-v3.js';

const execFileP = promisify(execFile);
const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const CORPUS = path.join(ROOT, 'corpus');
const args = process.argv.slice(2);
const FULL = args.includes('--full');
const JSON_OUT = (args.find((a) => a.startsWith('--json=')) ?? '').slice(7);

const manifest = JSON.parse(readFileSync(path.join(CORPUS, 'manifest.json'), 'utf8'));
const entries = [...manifest.docs, ...(FULL ? manifest.full : [])];

async function runOpaqueCheck(texPath) {
  const work = path.join(os.tmpdir(), `tdom-farm-opq-${process.pid}`);
  rmSync(work, { recursive: true, force: true });
  const eng = new CheckpointEngine({ workDir: work, docDir: path.dirname(texPath) });
  try {
    const r = await eng.open(readFileSync(texPath, 'utf8'));
    return { mode: r.mode, reasons: r.modeReasons ?? [] };
  } finally {
    await eng.close();
    rmSync(work, { recursive: true, force: true });
  }
}

async function runReferee(texPath) {
  const t0 = Date.now();
  const r = await execFileP('node', [path.join(ROOT, 'tools', 'verify-layout.mjs'), texPath], {
    timeout: 900_000,
    maxBuffer: 32 * 1024 * 1024,
  }).catch((err) => ({ stdout: err.stdout ?? '', stderr: err.stderr ?? '', failed: true }));
  const out = (r.stdout || '') + (r.stderr || '');
  const pages = out.match(/pages: engine=(\d+) real=(\d+)/);
  const total = out.match(/total: (\d+)\/(\d+) lines matched/);
  return {
    ok: !r.failed,
    secs: (Date.now() - t0) / 1000,
    enginePages: pages ? Number(pages[1]) : null,
    realPages: pages ? Number(pages[2]) : null,
    matched: total ? Number(total[1]) : null,
    lines: total ? Number(total[2]) : null,
    tail: out.trim().split('\n').slice(-1)[0],
    out,
  };
}

const results = [];
let unexpected = 0;
for (const entry of entries) {
  const texPath = path.resolve(CORPUS, entry.file);
  const name = path.basename(entry.file);
  if (!existsSync(texPath)) {
    console.log(`SKIP ${name}: missing`);
    continue;
  }
  process.stdout.write(`${name} … `);
  if (entry.expect === 'opaque') {
    const r = await runOpaqueCheck(texPath);
    const ok = r.mode === 'opaque';
    if (!ok) unexpected++;
    results.push({ name, expect: 'opaque', mode: r.mode, ok });
    console.log(ok ? `OK (opaque: ${r.reasons.join('; ')})` : `UNEXPECTED mode=${r.mode}`);
    continue;
  }
  const r = await runReferee(texPath);
  const pagesOk = r.enginePages !== null && r.enginePages === r.realPages;
  const rate = r.lines ? r.matched / r.lines : 0;
  const ok = r.ok;
  const tolerated = !ok && entry.knownDiverged;
  if (!ok && !tolerated) unexpected++;
  results.push({
    name,
    expect: 'structured',
    ok,
    tolerated,
    pagesOk,
    enginePages: r.enginePages,
    realPages: r.realPages,
    matched: r.matched,
    lines: r.lines,
    matchRate: Math.round(rate * 1000) / 1000,
    secs: Math.round(r.secs * 10) / 10,
  });
  console.log(
    `${ok ? 'IDENTICAL' : tolerated ? 'DIVERGED (known)' : 'DIVERGED'} ` +
      `pages=${r.enginePages}/${r.realPages} lines=${r.matched}/${r.lines} ${r.secs.toFixed(0)}s`
  );
  if (!ok && !tolerated) {
    console.log(r.out.split('\n').filter((l) => /DIVERGED|MISMATCH|miss /.test(l)).slice(0, 12).join('\n'));
  }
}

const structured = results.filter((r) => r.expect === 'structured' && r.lines);
const totLines = structured.reduce((s, r) => s + r.lines, 0);
const totMatched = structured.reduce((s, r) => s + r.matched, 0);
console.log(
  `\nfarm: ${results.length} docs — identical ${results.filter((r) => r.ok).length}, ` +
    `known-diverged ${results.filter((r) => r.tolerated).length}, unexpected ${unexpected}; ` +
    `line match ${totMatched}/${totLines} (${((100 * totMatched) / Math.max(1, totLines)).toFixed(2)}%)`
);
if (JSON_OUT) writeFileSync(JSON_OUT, JSON.stringify({ when: new Date().toISOString(), results }, null, 2));
process.exit(unexpected ? 1 : 0);
