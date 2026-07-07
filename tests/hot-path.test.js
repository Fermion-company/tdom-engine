// Edit hot-path invariants (docs/10): bounded foreground, checkpoint-suffix
// preservation, deferred chain work, and the defining equation of the whole
// incremental design — "any edit sequence converges to exactly what a fresh
// engine computes from the final source". These fork real lualatex processes;
// skipped without a TeX installation.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { CheckpointEngine } from '../engine/checkpoint/engine-v3.js';

const WORK = fileURLToPath(new URL('../.tdom-hotpath-test', import.meta.url));
const WORK2 = fileURLToPath(new URL('../.tdom-hotpath-test-scratch', import.meta.url));

const available = await promisify(execFile)('lualatex', ['--version'], { timeout: 15_000 }).then(
  () => true,
  () => false
);
const opts = available ? {} : { skip: 'lualatex not installed' };

const para = (s) =>
  `${s} paragraph with enough plain words to make a couple of real lines ` +
  `of typeset material for the measurement to mean something at all.`;

function makeDoc() {
  const L = [];
  L.push('\\documentclass{article}');
  L.push('\\usepackage{amsmath}');
  L.push('\\begin{document}');
  L.push('');
  L.push('\\newcommand{\\foo}{alpha-value}');
  L.push('');
  L.push('\\section{Alpha}\\label{sec:alpha}');
  L.push('');
  L.push(para('Opening alpha'));
  L.push('');
  L.push(para('Second alpha crossref to Section~\\ref{sec:gamma} ahead in'));
  L.push('');
  L.push('\\begin{equation}\\label{eq:one}');
  L.push('  a^2 + b^2 = c^2');
  L.push('\\end{equation}');
  L.push('');
  L.push(para('Macro user says \\foo{} inline in a normal'));
  L.push('');
  L.push('\\section{Beta}\\label{sec:beta}');
  L.push('');
  L.push(para('MIDWORD beta one'));
  L.push('');
  L.push(para('Beta two'));
  L.push('');
  L.push(para('Beta three'));
  L.push('');
  L.push('\\section{Gamma}\\label{sec:gamma}');
  L.push('');
  L.push(para('Gamma one refers to~\\eqref{eq:one} inside'));
  L.push('');
  L.push(para('Gamma two'));
  L.push('');
  L.push('\\section{Delta}\\label{sec:delta}');
  L.push('');
  for (let k = 0; k < 6; k++) {
    L.push(para(`Delta filler ${k}`));
    L.push('');
  }
  L.push('\\section{Epsilon}\\label{sec:eps}');
  L.push('');
  L.push(para('Epsilon one'));
  L.push('');
  L.push(para('TAILWORD epsilon final'));
  L.push('');
  L.push('\\end{document}');
  L.push('');
  return L.join('\n');
}

/** Wait until the engine has nothing left to do (chain work, rescues). */
async function drain(eng, timeoutMs = 120_000) {
  const t0 = Date.now();
  for (;;) {
    await eng.bgTask?.catch?.(() => {});
    // rescuePumping: an in-flight async rescue is invisible to
    // rescueQueue.size alone (the pump dequeues before compiling)
    const busy =
      eng.pendingChain || eng.bgActive || eng.rescuePumping || (eng.rescueQueue?.size ?? 0) > 0;
    if (!busy) {
      await new Promise((r) => setTimeout(r, 400));
      if (
        !eng.pendingChain &&
        !eng.bgActive &&
        !eng.rescuePumping &&
        (eng.rescueQueue?.size ?? 0) === 0
      )
        return;
    } else {
      await new Promise((r) => setTimeout(r, 100));
    }
    if (Date.now() - t0 > timeoutMs) {
      throw new Error(
        `drain timeout (pendingChain=${JSON.stringify(eng.pendingChain)} rescues=${eng.rescueQueue?.size})`
      );
    }
  }
}

/** Lineage-independent identity of the whole document state. */
const signature = (eng) => eng.blocks.map((b) => `${b.galleyHash}|${b.stateVec}`);

let eng;
before(async () => {
  if (!available) return;
  rmSync(WORK, { recursive: true, force: true });
  rmSync(WORK2, { recursive: true, force: true });
  eng = new CheckpointEngine({ workDir: WORK });
  await eng.open(makeDoc());
  await drain(eng);
});
after(async () => {
  if (eng) await eng.close();
});

test('steady-state keystrokes stay fork-once (edit-locus pin)', opts, async () => {
  const src = () => eng.getSource();
  let worstBlocks = 0;
  let worstWall = 0;
  for (let k = 0; k < 6; k++) {
    const cur = k % 2 === 0 ? 'MIDWORD' : 'MIDWORX';
    const next = k % 2 === 0 ? 'MIDWORX' : 'MIDWORD';
    const p = src().indexOf(cur);
    assert.ok(p >= 0, `token ${cur} present`);
    const t0 = performance.now();
    const r = await eng.edit(p, p + cur.length, next);
    worstWall = Math.max(worstWall, performance.now() - t0);
    worstBlocks = Math.max(worstBlocks, r.stats.blocksTypeset);
    assert.equal(r.stats.chainVerdict, 'clean', 'a plain word edit must not queue chain work');
  }
  assert.ok(worstBlocks <= 4, `edited + verification only (got ${worstBlocks})`);
  assert.ok(worstWall < 1500, `steady-state keystroke took ${worstWall.toFixed(0)}ms`);
  await drain(eng);
});

test('a tail edit right after a mid edit is NOT charged the distance', opts, async () => {
  const src = eng.getSource();
  const mid = src.indexOf('MIDWORD');
  assert.ok(mid >= 0);
  await eng.edit(mid, mid + 'MIDWORD'.length, 'MIDWORQ');
  // immediately — the old design would replay every block from mid to tail
  const tail = eng.getSource().indexOf('TAILWORD');
  assert.ok(tail >= 0);
  const r = await eng.edit(tail, tail + 'TAILWORD'.length, 'TAILWORQ');
  assert.ok(
    r.stats.blocksTypeset <= 6,
    `tail edit must resume from its own checkpoint (typeset ${r.stats.blocksTypeset} blocks)`
  );
  // an edit in the LAST block hits end-of-document instead of a clean
  // verification block — that is convergence too, as long as nothing is
  // deferred
  assert.ok(
    r.stats.chainVerdict === 'clean' ||
      (r.stats.chainVerdict === 'walked' && !r.stats.chainPending),
    `no deferred work for a plain tail edit (got ${r.stats.chainVerdict})`
  );
  // revert both
  const t2 = eng.getSource().indexOf('TAILWORQ');
  await eng.edit(t2, t2 + 8, 'TAILWORD');
  const m2 = eng.getSource().indexOf('MIDWORQ');
  await eng.edit(m2, m2 + 7, 'MIDWORD');
  await drain(eng);
});

test('a null edit pair leaves the document identity untouched', opts, async () => {
  const before = signature(eng);
  const pos = eng.getSource().indexOf('Delta filler 3');
  await eng.edit(pos, pos, 'Z');
  await eng.edit(pos, pos + 1, '');
  await drain(eng);
  assert.deepEqual(signature(eng), before, 'insert+revert must be a no-op');
});

test('section insert: fast response, async renumbering to convergence', opts, async () => {
  const pos = eng.getSource().indexOf('\\section{Gamma}');
  const t0 = performance.now();
  const r = await eng.edit(pos, pos, '\\section{Inserted}\\label{sec:ins}\n\n' + para('Inserted body') + '\n\n');
  const wall = performance.now() - t0;
  assert.ok(r.stats.blocksTypeset <= 8, `bounded foreground (typeset ${r.stats.blocksTypeset})`);
  assert.ok(wall < 3000, `section insert response took ${wall.toFixed(0)}ms`);
  assert.ok(
    r.stats.chainVerdict === 'counters' || r.stats.chainVerdict === 'leak',
    `moving counters must defer chain work (got ${r.stats.chainVerdict})`
  );
  await drain(eng);
  const labels = eng.getDOM().labels;
  assert.equal(labels['sec:ins'], '3');
  assert.equal(labels['sec:gamma'], '4', 'later sections renumbered after convergence');
  assert.equal(labels['sec:eps'], '6');
});

test('definition edit: suffix rebuilt off the hot path', opts, async () => {
  const src = eng.getSource();
  const pos = src.indexOf('alpha-value');
  const t0 = performance.now();
  const r = await eng.edit(pos, pos + 'alpha-value'.length, 'beta-value');
  const wall = performance.now() - t0;
  assert.equal(r.stats.chainVerdict, 'leak', 'a \\newcommand edit forfeits the suffix');
  assert.ok(wall < 3000, `definition edit response took ${wall.toFixed(0)}ms`);
  await drain(eng);
  // the macro user block must now typeset the new expansion
  const user = eng.blocks.find((b) => /\\foo\{\}/.test(b.text));
  assert.ok(user?.galley, 'macro user block present');
  // join with '' — runs split at every kern, so words arrive in pieces
  let text = '';
  for (const it of user.galley.items ?? []) {
    for (const run of it.runs ?? []) text += run.t ?? '';
  }
  assert.match(text, /beta/, 'downstream block reflects the new definition');
});

test('THE defining equation: incremental result equals a fresh engine', opts, async () => {
  await drain(eng);
  const finalSrc = eng.getSource();
  const scratch = new CheckpointEngine({ workDir: WORK2 });
  try {
    await scratch.open(finalSrc);
    await drain(scratch);
    assert.equal(eng.blocks.length, scratch.blocks.length, 'same segmentation');
    const a = signature(eng);
    const b = signature(scratch);
    const mismatches = [];
    for (let i = 0; i < a.length; i++) {
      if (a[i] !== b[i]) mismatches.push(`#${i} ${eng.blocks[i].id}`);
    }
    assert.deepEqual(mismatches, [], 'every block identical to from-scratch');
    assert.equal(eng.pages.length, scratch.pages.length, 'same page count');
  } finally {
    await scratch.close();
  }
});

test('idle engine holds no deferred work and a bounded process set', opts, async () => {
  await drain(eng);
  assert.equal(eng.pendingChain, null);
  assert.equal(eng.bgActive, false);
  assert.equal(eng.rescueQueue.size, 0);
  assert.ok(
    eng.checkpoints.size <= eng.maxCheckpoints + 16,
    `checkpoint processes bounded (${eng.checkpoints.size})`
  );
});

// Broken-TeX freeze semantics (docs/10 §10.9). The breakage class that
// freezes is the one that KILLS the typesetting child (found by the fuzzer
// on seed 21: a broken color name inside a tikz node cascades into a pgf
// emergency stop — real LuaLaTeX produces no PDF at all for such a source).
// Milder breakage (an unclosed conditional…) recovers at the job boundary
// and never reaches this path.
const tikzDoc = (fill) =>
  [
    '\\documentclass{article}',
    '\\usepackage{tikz}',
    '\\definecolor{softgreen}{RGB}{200,240,200}',
    '\\begin{document}',
    '',
    '\\section{A}',
    '',
    para('Alpha one'),
    '',
    '\\begin{tikzpicture}',
    `\\node[draw,fill=${fill},minimum width=20mm] (a) {Node A};`,
    '\\end{tikzpicture}',
    '',
    para('Gamma three'),
    '',
    '\\end{document}',
    '',
  ].join('\n');

// The incremental path freezes the killed block at the last good galley AND
// the last good exit state, so pixels and downstream numbering stay exactly
// where they were — zero churn while the user is mid-edit — and the block
// heals on the next edit that fixes it.
test('broken block freezes at its last good galley, downstream untouched, heals on fix', opts, async () => {
  rmSync(WORK2, { recursive: true, force: true });
  const e = new CheckpointEngine({ workDir: WORK2 });
  try {
    await e.open(tikzDoc('softgreen'));
    await drain(e);
    const preSig = signature(e);
    const prePages = e.pages.length;
    const at = e.getSource().indexOf('fill=softgr') + 'fill=softgr'.length;
    await e.edit(at, at, 'XX'); // fill=softgrXXeen — undefined color, pgf dies
    await drain(e);
    const bi = e.blocks.findIndex((b) => b.text.includes('softgrXX'));
    assert.ok(bi > 0, 'broken block found');
    assert.ok(e.frozenBlockIds().includes(e.blocks[bi].id), 'block reported frozen');
    // the freeze is total stasis: same pixels, same exit state, no
    // downstream wave — the document identity is byte-identical
    assert.deepEqual(signature(e), preSig, 'signature unchanged under freeze');
    assert.equal(e.pages.length, prePages, 'pagination unchanged under freeze');
    // heal: fix the color — the engine reconverges to the exact
    // pre-breakage state and the frozen mark leaves with the new galley
    const cut = e.getSource().indexOf('softgrXX');
    await e.edit(cut + 'softgr'.length, cut + 'softgrXX'.length, '');
    await drain(e);
    assert.deepEqual(signature(e), preSig, 'healed back to the exact pre-edit state');
    assert.deepEqual(e.frozenBlockIds(), [], 'no frozen blocks after heal');
  } finally {
    await e.close();
  }
});

// The scratch side of the same coin: a fresh boot on a broken source has no
// last-good galley to freeze — the block renders empty and passes the entry
// state through. That exit is deliberately DIFFERENT from the incremental
// freeze above (which keeps pre-breakage counters): real LuaLaTeX produces
// no output at all for such a source, so there is no ground truth, and the
// incremental==scratch equation is scoped to compilable sources (the fuzzer
// skips and reverts when it sees tdomFrozen). This test pins the fresh-boot
// half: empty freeze, engine alive, state passthrough.
test('fresh boot on a broken source: empty freeze, engine alive', opts, async () => {
  rmSync(WORK2, { recursive: true, force: true });
  const scratch = new CheckpointEngine({ workDir: WORK2 });
  try {
    await scratch.open(tikzDoc('softgrXXeen'));
    await drain(scratch);
    const bi = scratch.blocks.findIndex((b) => b.text.includes('softgrXX'));
    assert.ok(bi > 0, 'broken block found');
    const b = scratch.blocks[bi];
    assert.equal(b.galley?.tdomFrozen, true, 'block frozen');
    assert.equal(b.galley?.items?.length ?? 0, 0, 'frozen empty (no history to show)');
    assert.equal(b.stateVec, scratch.blocks[bi - 1].stateVec, 'exit = entry passthrough');
    assert.ok(scratch.pages.length > 0, 'document still paginates');
    // every other block is fully typeset — the failure is local
    assert.equal(scratch.blocks.filter((k) => !k.galley).length, 0, 'no galley holes elsewhere');
  } finally {
    await scratch.close();
  }
});

// A backward reference whose label moves to a value that ALREADY appears in
// the referring block's rendered text ("section 3 … equation (2)" with the
// equation moving 2→3). The old resolved-check matched substrings of the
// rendered text and skipped the retypeset, freezing the stale "(2)" forever
// (found by the fuzzer: corpus/06 seed 1, burst 2). resolvedInGalley now
// compares the exact values injected at typeset time (galley.tdomRefVals).
test('backward ref updates when the label moves to a value already visible in the block', opts, async () => {
  const refsDoc = readFileSync(
    fileURLToPath(new URL('../corpus/06-refs-heavy.tex', import.meta.url)),
    'utf8'
  );
  rmSync(WORK2, { recursive: true, force: true });
  const e = new CheckpointEngine({ workDir: WORK2 });
  try {
    await e.open(refsDoc);
    await drain(e);
    // a new numbered equation ahead of e:y/e:z renumbers both; the Alpha
    // block (which renders \eqref{e:z} AND the digit 3 via \ref{s:c}) must
    // re-render with the new (3)
    const anchor = 'resolve only through the label table.';
    const at = e.getSource().indexOf(anchor) + anchor.length;
    await e.edit(at, at, '\n\n\\begin{equation}\n  q^2 = p\n\\end{equation}\n');
    await drain(e);
    const scratch = new CheckpointEngine({ workDir: WORK2 + '-scratch' });
    try {
      await scratch.open(e.getSource());
      await drain(scratch);
      assert.equal(e.blocks.length, scratch.blocks.length, 'same segmentation');
      const a = signature(e);
      const b = signature(scratch);
      const mismatches = [];
      for (let i = 0; i < a.length; i++) {
        if (a[i] !== b[i]) mismatches.push(`#${i} ${e.blocks[i].id}`);
      }
      assert.deepEqual(mismatches, [], 'every block identical to from-scratch');
    } finally {
      await scratch.close();
      rmSync(WORK2 + '-scratch', { recursive: true, force: true });
    }
  } finally {
    await e.close();
  }
});
