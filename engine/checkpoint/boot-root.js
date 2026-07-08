import { spawn } from 'node:child_process';
import { writeFileSync, existsSync, rmSync } from 'node:fs';
import path from 'node:path';
import { documentBounds } from '../segmenter.js';
import { scanCounterDefs, texErrorFrom } from './util/tex.js';

export async function bootRoot(
  engine,
  { ensureShim, ensureServer, driverSource, awaitReady, reject, baseCounters, bootTimeout }
) {
  await ensureShim();
  await ensureServer();
  // tear down any previous tree — DIE for the well-behaved residents plus
  // SIGKILL by pid, because a child stuck in a TeX loop never reads DIE
  for (const peer of engine.peers) {
    peer.send('DIE\n');
    if (peer.pid) {
      try { process.kill(peer.pid, 'SIGKILL'); } catch { /* already gone */ }
    }
  }
  engine.checkpoints.clear();
  if (engine.root) {
    try { engine.root.kill('SIGKILL'); } catch { /* gone */ }
    engine.root = null;
  }
  engine.fonts.clear();

  const text = engine.store.get(engine.file);
  const bounds = documentBounds(text);
  const preamble = text.slice(bounds.preamble.start, bounds.preamble.end);
  engine.counters = [...baseCounters, ...scanCounterDefs(preamble)];
  // \pagestyle set in the preamble runs before the driver shims exist —
  // scan for it; otherwise book-family classes default to 'headings'
  const psMatch = preamble.match(/^[^%\n]*\\pagestyle\s*\{(\w+)\}/m);
  engine.initialStyle = psMatch
    ? psMatch[1]
    : /\\documentclass[^{]*\{[^}]*(book|report)[^}]*\}/.test(preamble)
      ? 'headings'
      : 'plain';
  engine.hf = new Map();
  engine.hfSig = null;
  writeFileSync(path.join(engine.workDir, 'driver.tex'), driverSource(preamble));

  // The aux family is a BYPRODUCT of the previous process tree, not state:
  // everything persistent lives in the orchestrator (labelTable, hrefTable,
  // #computeToc regenerates driver.toc after the first pagination). A tree
  // that died mid-write (SIGKILL, crash, power) leaves truncated/NUL-ridden
  // files behind, and \begin{document} reading them kills the boot ("Text
  // line contains an invalid character") — demoting a perfectly good
  // document to opaque. Boot from a clean slate, always.
  for (const ext of ['aux', 'toc', 'lof', 'lot', 'loa', 'lol', 'idx', 'out', 'nav', 'snm', 'vrb']) {
    rmSync(path.join(engine.workDir, `driver.${ext}`), { force: true });
  }
  rmSync(path.join(engine.workDir, 'driver.pdf'), { force: true });
  const ckptReady = awaitReady('ckpt:0', bootTimeout);
  const geoReady = awaitReady('geo', bootTimeout);
  engine.root = spawn(
    'lualatex',
    ['--shell-escape', '-interaction=nonstopmode', 'driver.tex'],
    {
      cwd: engine.workDir,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        TEXINPUTS: `${engine.docDir}:${process.env.TEXINPUTS || ''}`,
        LUAINPUTS: `${engine.docDir}:${process.env.LUAINPUTS || ''}`,
      },
    }
  );
  let rootLog = '';
  engine.root.stdout.on('data', (d) => { rootLog += d; if (rootLog.length > 65536) rootLog = rootLog.slice(-32768); });
  engine.root.stderr.on('data', (d) => { rootLog += d; });
  const rootRef = engine.root;
  engine.root.on('exit', () => {
    if (engine.root !== rootRef) return; // a superseded root dying is expected
    engine.rootLog = rootLog;
    // a dead root can never announce ckpt:0 — fail the boot immediately
    // (a broken preamble in nonstopmode still prompts on missing files
    // and emergency-stops on EOF)
    const err = new Error('lualatex exited during preamble: ' + texErrorFrom(rootLog));
    reject('ckpt:0', err);
    reject('geo', err);
    engine.checkpoints.clear();
  });
  engine.rootLogRef = () => rootLog;

  await Promise.all([ckptReady, geoReady]).catch((err) => {
    throw new Error(`preamble build failed — ${texErrorFrom(rootLog) || err.message}`);
  });
  // hyperref (and friends) write PDF objects during \begin{document},
  // which opens the shared output file at the root — checkpoint children
  // can then no longer ship their own tight pages. Fall back to isolated
  // per-block compiles for the exact-render tier in that case.
  engine.pdfOpenedAtRoot = existsSync(path.join(engine.workDir, 'driver.pdf'));
}
