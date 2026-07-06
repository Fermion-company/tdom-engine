// bench-typing.mjs — keystroke-latency benchmark (docs/ROADMAP.md Phase 0,
// goal condition B: keystroke → page update p95 ≤ 100ms incl. huge blocks).
//
// Simulates REAL typing (every keystroke yields never-seen block text) at
// three loci — plain prose, math-adjacent, document tail — and reports
// per-keystroke engine latency percentiles plus verdict/page-dirty counts.
//
// Usage: node tools/bench-typing.mjs [file.tex] [--keys=N]
//   default: samples/stress-test-ja.tex, 10 keys per locus

import { readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { CheckpointEngine } from '../engine/checkpoint/engine-v3.js';
import { drain, percentile } from './harness.mjs';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const args = process.argv.slice(2);
const texFile = args.find((a) => !a.startsWith('--')) ?? path.join(ROOT, 'samples', 'stress-test-ja.tex');
const KEYS = Number((args.find((a) => a.startsWith('--keys=')) ?? '--keys=10').slice(7));

const source = readFileSync(path.resolve(texFile), 'utf8');
const work = path.join(os.tmpdir(), `tdom-bench-${process.pid}`);
rmSync(work, { recursive: true, force: true });

const CHARS = 'あいうえおかきくけこさしすせそ'.split('');

function loci(src) {
  const out = [];
  const prose = src.indexOf('。', Math.floor(src.length * 0.25));
  if (prose > 0) out.push(['prose 25%', prose]);
  const math = src.indexOf('$', Math.floor(src.length * 0.4));
  const mathDot = math > 0 ? src.indexOf('。', math) : -1;
  if (mathDot > 0) out.push(['math-adjacent', mathDot]);
  const tail = src.indexOf('。', Math.floor(src.length * 0.92));
  if (tail > 0) out.push(['tail 92%', tail]);
  if (!out.length) out.push(['mid', Math.floor(src.length / 2)]);
  return out;
}

const eng = new CheckpointEngine({ workDir: work, docDir: path.dirname(path.resolve(texFile)) });
try {
  console.log(`bench: ${path.basename(texFile)} — booting…`);
  const t0 = Date.now();
  await eng.open(source);
  await drain(eng);
  console.log(`boot ${(Date.now() - t0) / 1000 | 0}s, blocks=${eng.blocks.length}, pages=${eng.pages.length}`);

  for (const [label, basePos] of loci(eng.getSource())) {
    const walls = [];
    const typesets = [];
    let pos = basePos;
    let worstVerdict = 'clean';
    for (let k = 0; k < KEYS; k++) {
      const ch = CHARS[k % CHARS.length];
      const t = performance.now();
      const r = await eng.edit(pos, pos, ch);
      walls.push(performance.now() - t);
      typesets.push(r.stats.typesetMs ?? 0);
      if (r.stats.chainVerdict && r.stats.chainVerdict !== 'clean' && r.stats.chainVerdict !== 'walked') {
        worstVerdict = r.stats.chainVerdict;
      }
      pos += ch.length;
      await new Promise((s) => setTimeout(s, 120));
    }
    await eng.edit(basePos, pos, ''); // remove the typed run
    await drain(eng);
    walls.sort((a, b) => a - b);
    typesets.sort((a, b) => a - b);
    console.log(
      `${label}: p50=${percentile(walls, 50).toFixed(0)}ms p95=${percentile(walls, 95).toFixed(0)}ms ` +
        `max=${percentile(walls, 100).toFixed(0)}ms (typeset p95=${percentile(typesets, 95).toFixed(0)}ms) ` +
        `verdicts=${worstVerdict}`
    );
  }
} finally {
  await eng.close();
  rmSync(work, { recursive: true, force: true });
}
