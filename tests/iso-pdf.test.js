import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readIsoPageKeys } from '../engine/checkpoint/iso-page-cache.js';
import { CheckpointEngine } from '../engine/checkpoint/engine-v3.js';
import { Peer } from '../engine/checkpoint/peer.js';
import { drain } from '../tools/harness.mjs';

const run = promisify(execFile);

test('actual PDF keys invalidate changed counters, references, width and font', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'tdom-pdf-key-'));
  const compile = async ({ counter = 1, label = 'A', width = 300, size = 10 } = {}) => {
    writeFileSync(path.join(dir, 'main.tex'), String.raw`\documentclass{article}
\usepackage[paperwidth=400pt,paperheight=600pt,textwidth=${width}pt,textheight=450pt]{geometry}
\newcounter{sample}\setcounter{sample}{${counter}}
\makeatletter\def\r@demo{{${label}}{1}}\makeatother
\begin{document}\fontsize{${size}}{14}\selectfont
Counter \arabic{sample}; reference \ref{demo}.
${'This repeated prose must wrap at the selected column width. '.repeat(12)}
\newpage Unchanged second page.\end{document}`);
    await run('lualatex', ['-interaction=nonstopmode', '-halt-on-error', 'main.tex'], { cwd: dir, timeout: 30000 });
    return readIsoPageKeys(path.join(dir, 'main.pdf'), 2);
  };
  try {
    const before = await compile();
    assert.ok(before, 'qpdf must parse the fixture');
    assert.deepEqual(await compile(), before);
    for (const change of [{ counter: 2 }, { label: 'B' }, { width: 240 }, { size: 12 }]) {
      const after = await compile(change);
      assert.ok(after);
      assert.notEqual(after[0], before[0], JSON.stringify(change));
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('ISO DONE exposes a flushed complete PDF; cached SVGs equal fresh conversion', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'tdom-iso-done-'));
  const names = ['TDOM_ISO_REAL_FORK', 'TDOM_SHIP', 'TDOM_ISO_PAGE_CACHE_VERIFY', 'TDOM_MAX_CHECKPOINTS'];
  const previous = Object.fromEntries(names.map(k => [k, process.env[k]]));
  Object.assign(process.env, { TDOM_ISO_REAL_FORK: '1', TDOM_SHIP: '0',
    TDOM_ISO_PAGE_CACHE_VERIFY: '1', TDOM_MAX_CHECKPOINTS: '8' });
  const engine = new CheckpointEngine({ workDir: dir });
  const jobs = new Map(), completed = [];
  const send = Peer.prototype.send, message = engine._onMessage.bind(engine);
  Peer.prototype.send = function (line) {
    if (this.engine === engine && line.startsWith('ISO ')) {
      const [, id, jobdir] = line.split(' ');
      jobs.set(id, decodeURIComponent(jobdir));
    }
    return send.call(this, line);
  };
  engine._onMessage = (peer, report) => {
    if (report.kind === 'DONE' && jobs.has(report.id)) {
      let complete = false;
      try { complete = readFileSync(path.join(jobs.get(report.id), 'driver.pdf')).subarray(-32).includes('%%EOF'); }
      catch { /* assertion below includes failed notifications */ }
      completed.push(complete);
    }
    return message(peer, report);
  };
  try {
    const text = String.raw`\documentclass{article}
\usepackage[textheight=180pt]{geometry}\usepackage{multicol}
\begin{document}\begin{multicols}{2}\section{Heading}
${('A paragraph containing ordinary text repeated across narrow columns. '.repeat(6) + '\n\n').repeat(6)}
\end{multicols}\end{document}`;
    await engine.open(text);
    await drain(engine);
    const pos = engine.getSource().indexOf('A paragraph');
    for (let n = 0; n < 2; n++) {
      await engine.edit(pos, pos, 'a');
      await drain(engine);
    }
    assert.ok(completed.length >= 3);
    assert.ok(completed.every(Boolean), 'PDF EOF must already be visible at DONE');
    assert.ok(engine.isoPageCache.stats.hits > 0);
    assert.ok(!engine.diagnostics.some(s => /cache differs|isolated rescue/.test(s)), engine.diagnostics.join('\n'));
  } finally {
    await engine.close();
    Peer.prototype.send = send;
    for (const [k, v] of Object.entries(previous)) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
    rmSync(dir, { recursive: true, force: true });
  }
});
