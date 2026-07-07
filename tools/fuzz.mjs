// fuzz.mjs — the edit fuzzer.
//
// Drives seeded random edit sequences through the incremental machinery and
// checks THE defining equation after every burst: the drained engine state
// must equal a fresh engine opened on the same source, block for block
// (galleyHash + stateVec — valid across engines since identity became
// deterministic, docs/10 §10.5). Incremental bugs are edit-order dependent;
// this is the only net that catches them systematically.
//
// The equation is scoped to compilable sources (docs/10 §10.9): an edit that
// breaks a block's TeX outright (LuaLaTeX emergency-stops — no ground truth)
// freezes the block; such bursts are skipped and reverted, which exercises
// the heal path instead. The structural discard class (splitting envs whose
// split needs the real output routine) is deterministic on both engines and
// stays inside the comparison.
//
// Usage: node tools/fuzz.mjs [file.tex] [--seed=N] [--bursts=N] [--edits=N]
//   defaults: corpus/06-refs-heavy.tex, seed 1, 6 bursts × 4 edits
//   Reproduce any failure by re-running with the printed seed.

// Audit runs keep TWO engines alive during comparison (incremental + fresh);
// every resident checkpoint is a live lualatex process, so the default
// interactive budget (64) × 2 engines on a package-heavy document exhausts
// a 16GB machine (OOM kill wave). Sparse grids only cost ms-level replay.
process.env.TDOM_MAX_CHECKPOINTS ||= '12';
// The equation compares provisional state only — canonical full compiles
// (~1GB each on package-heavy docs, × 2 engines) would OOM a 7GB hosted
// CI runner for output nobody reads.
process.env.TDOM_NO_CANONICAL ||= '1';
// Same for the RENDER tier: exact preview chunks never enter the equation,
// but its resident fork HOLDS pin up to 8 extra lualatex processes per
// engine — ~500MB each on Linux (Lua GC dirties every COW page).
process.env.TDOM_NO_RENDER ||= '1';
process.env.TDOM_RENDER_HOLD_MAX ||= '0';

import { readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { CheckpointEngine } from '../engine/checkpoint/engine-v3.js';
import { drain, signature, rng } from './harness.mjs';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const args = process.argv.slice(2);
const texFile = args.find((a) => !a.startsWith('--')) ?? path.join(ROOT, 'corpus', '06-refs-heavy.tex');
const SEED = Number((args.find((a) => a.startsWith('--seed=')) ?? '--seed=1').slice(7));
const BURSTS = Number((args.find((a) => a.startsWith('--bursts=')) ?? '--bursts=6').slice(9));
const EDITS = Number((args.find((a) => a.startsWith('--edits=')) ?? '--edits=4').slice(8));
// --cut=STRING truncates the body before the first occurrence of STRING —
// memory-bounded runners fuzz one section-suite copy of a repetitive stress
// document instead of all three (same environment classes, a third of the
// engine armies' working set)
const CUT = (args.find((a) => a.startsWith('--cut=')) ?? '').slice(6);
// --compare=final keeps only ONE engine army alive at a time: the fresh
// engine boots after the incremental one is snapshotted and closed. Any
// per-burst divergence still lands in the final signature — detection is
// intact, diagnosis is coarser — and peak memory halves (memory-bound
// runners: each resident lualatex holds ~470MB of dirtied heap on Linux).
const FINAL_ONLY = args.includes('--compare=final');

let source = readFileSync(path.resolve(texFile), 'utf8');
if (CUT) {
  const at = source.indexOf(CUT);
  if (at < 0) {
    console.error(`--cut marker not found: ${CUT}`);
    process.exit(2);
  }
  source = source.slice(0, at) + '\n\\end{document}\n';
  console.log(`cut at ${JSON.stringify(CUT)} — ${source.length} chars remain`);
}
// package-heavy documents defer ~50 first rescues to the async pump at
// boot; on a 2-core CI runner they take well past the default 3 minutes
const DRAIN_MS = 20 * 60_000;
const rand = rng(SEED);
const pick = (arr) => arr[Math.floor(rand() * arr.length)];

const WORDS = ['alpha', 'beta', '議論', 'かなり', 'note', 'x+y', '42', 'ε'];
const SNIPPETS = [
  '\n\n\\section{Fuzzed}\n\n',
  ' \\emph{fz} ',
  '\n\n\\begin{equation}\n  q^2 = p\n\\end{equation}\n\n',
  '\n\nInserted fuzz paragraph with several plain words in it.\n\n',
];

/** A random source edit that keeps the document body well-formed-ish:
 * operate only on plain-text stretches (no backslash/brace in the window). */
function randomEdit(src) {
  const bodyStart = src.indexOf('\\begin{document}') + '\\begin{document}'.length;
  const bodyEnd = src.indexOf('\\end{document}');
  for (let tries = 0; tries < 200; tries++) {
    const at = bodyStart + Math.floor(rand() * Math.max(1, bodyEnd - bodyStart));
    const win = src.slice(Math.max(bodyStart, at - 24), Math.min(bodyEnd, at + 24));
    if (/[\\{}$%&]/.test(win)) continue;
    const kind = rand();
    if (kind < 0.45) return { start: at, end: at, text: pick(WORDS) }; // insert
    if (kind < 0.7) {
      const len = 1 + Math.floor(rand() * 12);
      return { start: at, end: Math.min(bodyEnd, at + len), text: '' }; // delete
    }
    if (kind < 0.9) {
      const len = 1 + Math.floor(rand() * 6);
      return { start: at, end: Math.min(bodyEnd, at + len), text: pick(WORDS) }; // replace
    }
    return { start: at, end: at, text: pick(SNIPPETS) }; // structural insert
  }
  return null;
}

const workA = path.join(os.tmpdir(), `tdom-fuzz-a-${process.pid}`);
const workB = path.join(os.tmpdir(), `tdom-fuzz-b-${process.pid}`);
rmSync(workA, { recursive: true, force: true });

console.log(`fuzz: ${path.basename(texFile)} seed=${SEED} ${BURSTS} bursts × ${EDITS} edits`);
const eng = new CheckpointEngine({ workDir: workA, docDir: path.dirname(path.resolve(texFile)) });
let failed = false;
try {
  await eng.open(source);
  await drain(eng, DRAIN_MS);
  // Baseline freezes: blocks whose exact compile fails already at boot
  // (e.g. splitting envs whose split needs the real output routine — the
  // dormant absorb can't make progress and the run discards). Both engines
  // reach the same kept galley deterministically, so the equation still
  // holds for them; only freezes INTRODUCED by a burst mean "transiently
  // broken source" and skip the comparison.
  // Freezes that gate the equation are BROKEN-TEX freezes (no ground truth
  // exists). The structural discard class (splitting env whose split needs
  // the real output routine — deterministic on both engines) is tolerated:
  // if it ever DID diverge, the signature comparison itself fails loudly.
  const DISCARD_RE = /discarded runaway material/;
  const gating = () => eng.frozenBlocks().filter((f) => !DISCARD_RE.test(f.reason));
  // keyed by text, not id: an edit re-mints the block id, but a reverted
  // block returns to its baseline text
  const baseFrozen = new Set(gating().map((f) => f.text));
  const allBase = eng.frozenBlocks();
  if (allBase.length) {
    console.log(`baseline frozen at boot (tolerated): ${allBase.map((f) => f.id).join(',')}`);
  }
  const applied = [];
  for (let b = 0; b < BURSTS && !failed; b++) {
    const burstEdits = [];
    for (let e = 0; e < EDITS; e++) {
      const src = eng.getSource();
      const ed = randomEdit(src);
      if (!ed) continue;
      applied.push(ed);
      burstEdits.push({ ...ed, removed: src.slice(ed.start, ed.end) });
      await eng.edit(ed.start, ed.end, ed.text);
    }
    await drain(eng, DRAIN_MS);
    // Transiently broken TeX (an edit landed inside tikz coordinates, an
    // unclosed conditional, …): real LuaLaTeX emergency-stops on such a
    // source — there is NO ground truth, and the two paths freeze
    // differently by design (incremental keeps the last good galley and its
    // exit so numbering doesn't churn; a fresh boot has no history). Skip
    // the equation, then REVERT the burst like a user fixing their error —
    // the heal path itself is exercised and the next burst compares again.
    const newFrozen = gating().filter((f) => !baseFrozen.has(f.text)).map((f) => f.id);
    if (newFrozen.length) {
      console.log(
        `burst ${b + 1}: SKIPPED — source transiently broken (new frozen: ${newFrozen.join(',')}); reverting the burst`
      );
      for (const ed of burstEdits.reverse()) {
        await eng.edit(ed.start, ed.start + ed.text.length, ed.removed);
      }
      await drain(eng, DRAIN_MS);
      const still = gating().filter((f) => !baseFrozen.has(f.text)).map((f) => f.id);
      if (still.length) {
        failed = true;
        console.log(`burst ${b + 1}: FAILED — frozen blocks survived the revert: ${still.join(',')}`);
        console.log(`  reproduce: node tools/fuzz.mjs ${texFile} --seed=${SEED} --bursts=${b + 1} --edits=${EDITS}`);
      }
      continue;
    }
    if (FINAL_ONLY) {
      console.log(`burst ${b + 1}: applied (comparison deferred to the end)`);
      continue;
    }
    // THE equation: incremental result == fresh engine on the same source
    rmSync(workB, { recursive: true, force: true });
    const fresh = new CheckpointEngine({ workDir: workB, docDir: path.dirname(path.resolve(texFile)) });
    try {
      await fresh.open(eng.getSource());
      await drain(fresh, DRAIN_MS);
      const a = signature(eng);
      const c = signature(fresh);
      const mismatches = [];
      for (let i = 0; i < Math.max(a.length, c.length); i++) {
        if (a[i] !== c[i]) mismatches.push(i);
      }
      const pagesOk = eng.pages.length === fresh.pages.length;
      if (mismatches.length || !pagesOk) {
        failed = true;
        console.log(
          `burst ${b + 1}: FAILED — blocks ${mismatches.length ? mismatches.join(',') : 'ok'}; ` +
            `pages ${eng.pages.length}/${fresh.pages.length}`
        );
        for (const i of mismatches.slice(0, 4)) {
          console.log(`  #${i} inc=${a[i]?.slice(0, 60)}`);
          console.log(`      scr=${c[i]?.slice(0, 60)}`);
        }
        console.log(`  reproduce: node tools/fuzz.mjs ${texFile} --seed=${SEED} --bursts=${b + 1} --edits=${EDITS}`);
      } else {
        console.log(`burst ${b + 1}: OK (${a.length} blocks, ${eng.pages.length} pages, ${applied.length} edits so far)`);
      }
    } finally {
      await fresh.close();
    }
  }
  if (FINAL_ONLY && !failed) {
    // snapshot, release the first army, then boot the fresh one
    const a = signature(eng);
    const pagesA = eng.pages.length;
    const finalSrc = eng.getSource();
    await eng.close();
    rmSync(workB, { recursive: true, force: true });
    const fresh = new CheckpointEngine({ workDir: workB, docDir: path.dirname(path.resolve(texFile)) });
    try {
      await fresh.open(finalSrc);
      await drain(fresh, DRAIN_MS);
      const c = signature(fresh);
      const mismatches = [];
      for (let i = 0; i < Math.max(a.length, c.length); i++) {
        if (a[i] !== c[i]) mismatches.push(i);
      }
      const pagesOk = pagesA === fresh.pages.length;
      if (mismatches.length || !pagesOk) {
        failed = true;
        console.log(
          `final: FAILED — blocks ${mismatches.length ? mismatches.join(',') : 'ok'}; ` +
            `pages ${pagesA}/${fresh.pages.length}`
        );
        for (const i of mismatches.slice(0, 4)) {
          console.log(`  #${i} inc=${a[i]?.slice(0, 60)}`);
          console.log(`      scr=${c[i]?.slice(0, 60)}`);
        }
        console.log(`  reproduce: node tools/fuzz.mjs ${texFile} --seed=${SEED} --bursts=${BURSTS} --edits=${EDITS}`);
      } else {
        console.log(`final: OK (${a.length} blocks, ${pagesA} pages, ${applied.length} edits)`);
      }
    } finally {
      await fresh.close();
    }
  }
} finally {
  await eng.close();
  rmSync(workA, { recursive: true, force: true });
  rmSync(workB, { recursive: true, force: true });
}
console.log(failed ? 'fuzz: DIVERGED' : 'fuzz: EQUATION HOLDS');
process.exit(failed ? 1 : 0);
