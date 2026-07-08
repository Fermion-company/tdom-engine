import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, renameSync } from 'node:fs';
import path from 'node:path';
import { fnv1a } from '../hash.js';
import { waitForPdf } from './util/fs.js';

const execFileP = promisify(execFile);

export async function runForkIsoCompile(engine, { ck0, block, jobdir, pdf, isoTex, awaitRender }) {
  // fork path: the ISO child chdir's to the jobdir, its lazily-opened
  // PDF (\jobname = driver) and state.json land there, and DONE fires
  // from finish_pdffile like the RENDER protocol
  const isoId = `iso@${fnv1a(jobdir + ':' + Date.now())}`;
  const body = Buffer.from(isoTex, 'utf8');
  engine.renderPids ??= new Map();
  engine.renderPids.set(isoId, 0); // armed: FORKED fills the pid
  const done = awaitRender('render:' + isoId, Number(process.env.TDOM_ISO_TIMEOUT || 120_000));
  // fail fast when the child dies without finishing (broken TeX
  // emergency-stops in the fork exactly like cold lualatex would):
  // poll the forked pid instead of running out the long timeout
  const poll = setInterval(() => {
    const pid = engine.renderPids.get(isoId);
    if (pid) {
      try {
        process.kill(pid, 0);
      } catch {
        engine._reject('render:' + isoId, new Error(`iso child exited for ${block.id}`));
      }
    }
  }, 200);
  let forked = false;
  try {
    ck0.send(`ISO ${isoId} ${jobdir} ${body.length}\n`);
    ck0.sendRaw(body);
    await done;
    if (!existsSync(pdf)) {
      // belt-and-braces: if the child's PDF still opened against the
      // root's workDir (cwd wandered before the re-chdir hook landed),
      // claim it — the pump is serial and nothing else ships there
      // (canonical is sandboxed in workDir/canonical)
      const stray = path.join(engine.workDir, 'driver.pdf');
      await waitForPdf(stray).catch(() => {});
      if (existsSync(stray)) {
        try { renameSync(stray, pdf); } catch { /* raced away */ }
      }
    }
    await waitForPdf(pdf).catch(() => {});
    forked = true;
  } catch {
    // a child that actually forked and failed IS the verdict — the
    // missing-artifact check below classifies it exactly like a cold
    // failure. Only an infra miss (peer gone before FORKED) retries
    // cold with a full standalone compile.
    forked = (engine.renderPids.get(isoId) ?? 0) !== 0;
    const pid = engine.renderPids.get(isoId);
    if (pid) {
      try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
    }
  } finally {
    clearInterval(poll);
    engine.renderPids.delete(isoId);
  }
  return forked;
}

export async function runColdIsoCompile(engine, jobdir) {
  // cold path: no resident root — pay the full standalone compile.
  // Tracked so teardown/close can reap in-flight isolated compiles;
  // edits do NOT kill these — with stale-first rescues they already run
  // off the hot path, and a finished compile is a cache entry worth
  // keeping. nice(1): isolated compiles must lose CPU contests against
  // the resident fork jobs that answer keystrokes
  const run = execFileP('nice', ['-n', '15', 'lualatex', '-interaction=nonstopmode', 'iso.tex'], {
    cwd: jobdir,
    timeout: 120_000,
    // doc-relative assets (\includegraphics, \includepdf …) resolve the
    // same way the canonical compile resolves them
    env: {
      ...process.env,
      TEXINPUTS: `${engine.docDir}:${process.env.TEXINPUTS || ''}`,
      LUAINPUTS: `${engine.docDir}:${process.env.LUAINPUTS || ''}`,
    },
  });
  engine.isoChildren.add(run.child);
  await run.catch(() => {});
  engine.isoChildren.delete(run.child);
}
