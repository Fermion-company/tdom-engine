import { mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import path from 'node:path';
import { prepareIsoCompileJob } from './iso-context.js';
import { readIsoCompileResult } from './iso-result.js';
import { runColdIsoCompile, runForkIsoCompile } from './iso-runner.js';

export async function isoCompile(
  engine,
  { block, idx, why, forceCold, rescueCacheKey, needsRescue, awaitRender, isoCompileCold }
) {
  // doomed-compile memo: the rescue key carries every input the compile
  // depends on, so a failure repeats deterministically — rethrow instead
  // of paying the full preamble load per chain pass over a broken block
  const negKey = rescueCacheKey(block, idx);
  const neg = engine.isoFailCache.get(negKey);
  if (neg) throw new Error(neg);
  const text = engine.store.get(engine.file);
  const { ck0, labelSnap, jobdir, pdf, statePath, splitMode, strut, entryOff, isoTex } =
    prepareIsoCompileJob({
      block,
      idx,
      forceCold,
      checkpoints: engine.checkpoints,
      isoForkBroken: engine.isoForkBroken,
      blocks: engine.blocks,
      counters: engine.counters,
      text,
      workDir: engine.workDir,
      labelTable: engine.labelTable,
      geometry: engine.geometry,
      needsRescue,
      breakableRe: () => engine._breakableRe,
    });
  mkdirSync(jobdir, { recursive: true });
  rmSync(pdf, { force: true });
  rmSync(statePath, { force: true });
  writeFileSync(path.join(jobdir, 'iso.tex'), isoTex);
  if (ck0) {
    const forked = await runForkIsoCompile(engine, {
      ck0,
      block,
      jobdir,
      pdf,
      isoTex,
      awaitRender,
    });
    if (!forked) return isoCompileCold();
  } else {
    await runColdIsoCompile(engine, jobdir);
  }
  if (ck0 && (!existsSync(pdf) || !existsSync(statePath))) {
    // the FORK died without producing the artifacts. Some environments
    // (tcolorbox-class) are incompatible with the fork's inherited
    // dormant state in ways a cold compile is not — remember that for
    // this block and retry cold, whose verdict is final.
    engine.isoForkBroken.add(block.id);
    return isoCompileCold();
  }
  if (!existsSync(pdf) || !existsSync(statePath)) {
    const msg = `isolated rescue failed for ${block.id} (${why})`;
    if (engine.isoFailCache.size > 200) engine.isoFailCache.clear();
    engine.isoFailCache.set(negKey, msg);
    throw new Error(msg);
  }
  return readIsoCompileResult(engine, {
    block,
    jobdir,
    pdf,
    statePath,
    ck0,
    why,
    negKey,
    splitMode,
    strut,
    entryOff,
    labelSnap,
    isoCompileCold,
  });
}
