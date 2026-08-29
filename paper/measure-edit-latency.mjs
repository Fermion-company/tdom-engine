// measure-edit-latency.mjs — bounded measurement run for the TDOM paper.
//
// Machine-safety: ONE engine at a time, TDOM_MAX_CHECKPOINTS=8,
// TDOM_NO_CANONICAL=1 TDOM_NO_RENDER=1 (both are async tiers that never sit
// on the edit hot path; disabling them keeps this run ~1.5GB like the
// sanctioned hot-path/farm pair). Documents are plain-article English so the
// run stays clear of the deep-lineage luatexja wall.
//
// Per document size (S/M/L):
//   - cold full compile (2 × lualatex) wall time  — the baseline users pay today
//   - engine boot time, block/page counts, resident RSS
//   - keystroke latency at three loci (25% / 60% / 92%): p50/p95/max of the
//     synchronous edit() round trip, plus typeset-only time
//   - worst cases: section insertion (counters verdict) and a body
//     \newcommand definition edit (leak verdict → deferred rebuild)
//
// Usage: TDOM_MAX_CHECKPOINTS=8 TDOM_NO_CANONICAL=1 TDOM_NO_RENDER=1 \
//          node paper/measure-edit-latency.mjs [outJson]

import { writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { CheckpointEngine } from '../engine/checkpoint/engine-v3.js';
import { drain, percentile } from '../tools/harness.mjs';

const run = promisify(execFile);
const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const OUT = process.argv[2] ?? path.join(ROOT, 'paper', 'measurements.json');

const para = (tag, i) =>
  `${tag} paragraph ${i} with enough plain running words to produce a few ` +
  `real typeset lines of ordinary body text, so that the measurement below ` +
  `reflects genuine line breaking work rather than trivial content.`;

function genDoc(sections) {
  const L = [];
  L.push('\\documentclass[11pt]{article}');
  L.push('\\usepackage{amsmath}');
  L.push('\\begin{document}');
  L.push('');
  L.push('\\newcommand{\\keyterm}{renderable}');
  L.push('');
  for (let s = 1; s <= sections; s++) {
    L.push(`\\section{Topic ${s}}\\label{sec:s${s}}`);
    L.push('');
    for (let p = 1; p <= 4; p++) {
      let body = para(`Section ${s}`, p);
      if (p === 2) body += ` The running term is \\keyterm{} here.`;
      if (p === 3 && s > 1) body += ` See also Section~\\ref{sec:s${s - 1}} and~\\eqref{eq:e${s - 1}}.`;
      L.push(body);
      L.push('');
    }
    L.push(`\\begin{equation}\\label{eq:e${s}}`);
    L.push(`  f_{${s}}(x) = x^{${s}} + ${s}x + 1`);
    L.push('\\end{equation}');
    L.push('');
  }
  L.push('\\end{document}');
  L.push('');
  let src = L.join('\n');
  // plant three unique typing loci inside paragraphs at ~25/60/92%
  for (const [tok, frac] of [['LOCUSAAA', 0.25], ['LOCUSBBB', 0.6], ['LOCUSCCC', 0.92]]) {
    const at = src.indexOf('genuine', Math.floor(src.length * frac));
    if (at > 0) src = src.slice(0, at) + tok + ' ' + src.slice(at);
  }
  return src;
}

async function residentRssMB() {
  try {
    const { stdout } = await run('ps', ['-axo', 'rss=,command=']);
    let kb = 0;
    for (const line of stdout.split('\n')) if (/lualatex/.test(line)) kb += Number(line.trim().split(/\s+/)[0]) || 0;
    return Math.round(kb / 1024);
  } catch {
    return -1;
  }
}

async function coldCompile(src, label) {
  const dir = path.join(os.tmpdir(), `tdom-paper-cold-${label}-${process.pid}`);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'main.tex'), src);
  const t0 = performance.now();
  let pages = 0;
  for (let pass = 0; pass < 2; pass++) {
    const { stdout } = await run('lualatex', ['-interaction=nonstopmode', 'main.tex'], {
      cwd: dir, timeout: 300_000, maxBuffer: 64 * 1024 * 1024,
    }).catch((e) => ({ stdout: String(e.stdout ?? '') }));
    const m = /Output written on .*\((\d+) pages?/.exec(stdout);
    if (m) pages = Number(m[1]);
  }
  const ms = performance.now() - t0;
  rmSync(dir, { recursive: true, force: true });
  return { ms: Math.round(ms), pages };
}

async function typeAt(eng, token, keys = 12, gapMs = 50) {
  const walls = [], typesets = [], blocks = [];
  const base = eng.getSource().indexOf(token);
  if (base < 0) throw new Error(`locus ${token} missing`);
  let pos = base + token.length;
  const t0pos = pos;
  for (let k = 0; k < keys; k++) {
    const ch = 'abcdefghijkl'[k % 12];
    const t = performance.now();
    const r = await eng.edit(pos, pos, ch);
    walls.push(performance.now() - t);
    typesets.push(r.stats.typesetMs ?? 0);
    blocks.push(r.stats.blocksTypeset ?? 0);
    pos += 1;
    await new Promise((s) => setTimeout(s, gapMs));
  }
  await eng.edit(t0pos, pos, '');
  await drain(eng);
  // 初回打鍵(カーソル移動直後: checkpointグリッドからの再生を払う)と
  // 定常打鍵(編集位置ピン確立後)は構造が異なるので分離して報告する。
  const firstMs = walls[0];
  const rest = walls.slice(1).sort((a, b) => a - b);
  const restTs = typesets.slice(1).sort((a, b) => a - b);
  return {
    firstMs: +firstMs.toFixed(1),
    p50: +percentile(rest, 50).toFixed(1),
    p95: +percentile(rest, 95).toFixed(1),
    max: +percentile(rest, 100).toFixed(1),
    typesetP50: +percentile(restTs, 50).toFixed(1),
    typesetP95: +percentile(restTs, 95).toFixed(1),
    worstBlocks: Math.max(...blocks),
  };
}

async function benchDoc(label, sections) {
  console.log(`\n=== ${label}: ${sections} sections ===`);
  const src = genDoc(sections);
  const cold = await coldCompile(src, label);
  console.log(`cold full compile (2 passes): ${cold.ms}ms, ${cold.pages} pages`);

  const work = path.join(os.tmpdir(), `tdom-paper-bench-${label}-${process.pid}`);
  rmSync(work, { recursive: true, force: true });
  const eng = new CheckpointEngine({ workDir: work });
  const res = { label, sections, cold };
  try {
    const t0 = performance.now();
    await eng.open(src);
    await drain(eng);
    res.bootMs = Math.round(performance.now() - t0);
    res.blocks = eng.blocks.length;
    res.pages = eng.pages.length;
    res.checkpoints = eng.checkpoints.size;
    res.rssMB = await residentRssMB();
    console.log(`boot ${res.bootMs}ms, blocks=${res.blocks}, pages=${res.pages}, ckpts=${res.checkpoints}, rss=${res.rssMB}MB`);

    res.typing = {};
    for (const [name, tok] of [['prose25', 'LOCUSAAA'], ['mid60', 'LOCUSBBB'], ['tail92', 'LOCUSCCC']]) {
      res.typing[name] = await typeAt(eng, tok, 30);
      console.log(`typing ${name}: first=${res.typing[name].firstMs}ms steady p50=${res.typing[name].p50}ms p95=${res.typing[name].p95}ms max=${res.typing[name].max}ms (typeset p95=${res.typing[name].typesetP95}ms)`);
    }

    { // section insertion (counters verdict)
      const s = eng.getSource();
      const at = s.indexOf('\n\\section{', Math.floor(s.length * 0.55));
      const ins = '\n\\section{Inserted}\\label{sec:ins}\n\n' + para('Inserted', 1) + '\n';
      const t = performance.now();
      const r = await eng.edit(at, at, ins);
      res.sectionInsert = { wallMs: +(performance.now() - t).toFixed(1), verdict: r.stats.chainVerdict, blocksTypeset: r.stats.blocksTypeset };
      console.log(`section insert: ${res.sectionInsert.wallMs}ms verdict=${res.sectionInsert.verdict} blocks=${res.sectionInsert.blocksTypeset}`);
      await drain(eng);
      await eng.edit(at, at + ins.length, '');
      await drain(eng);
    }

    { // definition edit (leak verdict → deferred rebuild)
      const s = eng.getSource();
      const at = s.indexOf('{renderable}');
      const t = performance.now();
      const r = await eng.edit(at + 1, at + 1 + 'renderable'.length, 'renderably');
      res.defEdit = { wallMs: +(performance.now() - t).toFixed(1), verdict: r.stats.chainVerdict, blocksTypeset: r.stats.blocksTypeset };
      console.log(`definition edit: ${res.defEdit.wallMs}ms verdict=${res.defEdit.verdict} blocks=${res.defEdit.blocksTypeset}`);
      await drain(eng);
      const s2 = eng.getSource();
      const at2 = s2.indexOf('{renderably}');
      await eng.edit(at2 + 1, at2 + 1 + 'renderably'.length, 'renderable');
      await drain(eng);
    }
    res.rssAfterMB = await residentRssMB();
  } finally {
    await eng.close().catch(() => {});
    rmSync(work, { recursive: true, force: true });
  }
  return res;
}

// 規模は引数で上書き可能: node measure-edit-latency.mjs out.json 8,40,60
const sizeArg = (process.argv[3] ?? '8,40,60').split(',').map(Number);
const labels = ['S', 'M', 'L', 'XL'];
const all = { date: new Date().toISOString(), host: os.cpus()[0]?.model ?? 'unknown', memGB: Math.round(os.totalmem() / 2 ** 30), docs: [] };
for (let i = 0; i < sizeArg.length; i++) {
  all.docs.push(await benchDoc(labels[i], sizeArg[i]));
  writeFileSync(OUT, JSON.stringify(all, null, 2)); // 文書ごとに逐次保存
}
console.log(`\nwrote ${OUT}`);
