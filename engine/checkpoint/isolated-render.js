import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import path from 'node:path';
import { documentBounds } from '../segmenter.js';
import { waitForPdf } from './util/fs.js';
import { cropRenderTargets } from './render-chunks.js';
import { buildIsolatedRenderSource } from './isolated-render-source.js';

const execFileP = promisify(execFile);

export function queueIsolatedRender(engine, block, idx, renderBlock) {
  if (engine.closed) return Promise.resolve();
  // isolated renders are FULL lualatex runs of the document preamble —
  // dozens in parallel overload the machine, hit the 90s timeout and
  // leave truncated PDFs ('Invalid XRef'). Serialize them; each result
  // is cached by galley hash so the queue drains once per content.
  // Dedup per block BEFORE queueing: during a typing session the idle
  // gate stays shut, and the same block used to be enqueued once per
  // trigger — the whole backlog then drained as serial full-preamble
  // compiles when the user finally paused.
  engine.isoRenderPending ??= new Set();
  if (engine.isoRenderPending.has(block.id)) return engine.isoRenderQueue;
  engine.isoRenderPending.add(block.id);
  engine.isoRenderQueue = (engine.isoRenderQueue ?? Promise.resolve()).then(() =>
    renderBlock(block, idx)
      .catch((err) => {
        engine.diagnostics.push(`render ${block.id}: ${err?.message ?? err}`);
      })
      .finally(() => {
        engine.isoRenderPending.delete(block.id);
      })
  );
  return engine.isoRenderQueue;
}

/**
 * Isolated renders are the LOWEST-priority work in the system: a full
 * preamble compile (~minutes on package-heavy documents) per gfx block,
 * purely to upgrade the provisional preview's block chunks. The canonical
 * layer already guarantees exact final pixels, so these must never
 * compete with typing (rescue queue), the canonical compile, or an edit
 * burst — CPU saturation here slows the resident fork jobs by orders of
 * magnitude.
 */
async function renderIdleGate(engine) {
  for (;;) {
    if (engine.closed) return false;
    const busy =
      engine.rescueQueue.size > 0 ||
      engine.canonical.info().inFlight ||
      Date.now() - (engine.lastEditAt ?? 0) < 3000;
    if (!busy) return true;
    await new Promise((r) => setTimeout(r, 500));
  }
}

export async function renderIsolatedBlock(engine, { block, idx, chunkTargets, asyncRepaginate }) {
  if (!(await renderIdleGate(engine)) || engine.closed) return;
  // the idle gate can hold this job for minutes — the index captured at
  // queue time is stale after any insertion/deletion above the block, and
  // blocks[idx-1] would then be a DIFFERENT block's exit state (wrong
  // counters/prevdepth typeset into the exact chunk). Re-locate it.
  idx = engine.blocks.indexOf(block);
  if (!block.galley || idx < 0) return; // superseded (reboot nulls galleys)
  const forGalley = block.galleyHash;
  // a full-preamble compile is minutes on package-heavy documents: never
  // pay it when every chunk is already fresh (idle-gate wait races)
  if (!chunkTargets(block).some((t) => engine.chunks.get(t.key)?.forGalley !== forGalley)) {
    return;
  }
  const inflightKey = 'iso:' + block.id + ':' + forGalley;
  engine.rendering ??= new Set();
  if (engine.rendering.has(inflightKey)) return;
  engine.rendering.add(inflightKey);
  try {
    // entry counters = the previous block's REAL exit vector (captured
    // from TeX by the galley report); zeros at the document start
    const entry = {};
    const prevVec = idx > 0 ? JSON.parse(engine.blocks[idx - 1].stateVec ?? '[]') : [];
    engine.counters.forEach((c, i) => {
      entry[c] = prevVec[i] ?? 0;
    });
    // cross-block layout state from the previous block's REAL exit vector:
    // [..counters.., tdom@pd, tdom@nobreak, tdom@ls] — prevdepth reproduces
    // the exact leading interline glue, @nobreak the post-heading \everypar
    const prevPd = idx > 0 && prevVec.length >= 3 ? prevVec[prevVec.length - 3] : -65536000;
    const prevNobreak = idx > 0 && prevVec.length >= 2 ? prevVec[prevVec.length - 2] === 1 : false;
    const text = engine.store.get(engine.file);
    const bounds = documentBounds(text);
    const isoTex = buildIsolatedRenderSource({
      preamble: text.slice(bounds.preamble.start, bounds.preamble.end),
      labelTable: engine.labelTable,
      geometry: engine.geometry,
      hrefTable: engine.hrefTable,
      entry,
      prevPd,
      prevNobreak,
      blockText: block.text,
    });
    const jobdir = path.join(engine.workDir, `render-${block.id}-${forGalley}`);
    try {
      mkdirSync(jobdir, { recursive: true });
      rmSync(path.join(jobdir, 'iso.pdf'), { force: true });
      writeFileSync(path.join(jobdir, 'iso.tex'), isoTex);
      // lowest-priority CPU: see #isoCompile. Register the child so
      // closeEngine can SIGKILL it — an abandoned run otherwise burns a
      // core for up to its 90s timeout after the server exits.
      const run = execFileP('nice', ['-n', '15', 'lualatex', '-interaction=nonstopmode', 'iso.tex'], {
        cwd: jobdir,
        timeout: 90_000,
      });
      if (run.child) engine.isoChildren.add(run.child);
      await run.catch(() => {}).finally(() => {
        if (run.child) engine.isoChildren.delete(run.child);
      });
      const pdf = path.join(jobdir, 'iso.pdf');
      if (!existsSync(pdf)) throw new Error('isolated render produced no PDF');
      await waitForPdf(pdf); // %%EOF flushed before pdftocairo reads it
      // same page map as the resident RENDER path: galley, floats, feet
      const targets = chunkTargets(block).filter(
        (t) => engine.chunks.get(t.key)?.forGalley !== forGalley
      );
      await cropRenderTargets({ jobdir, pdf, targets, chunks: engine.chunks, forGalley, prefix: 'iso' });
      if (block.galleyHash === forGalley) asyncRepaginate();
    } finally {
      // failure paths used to leak the whole job dir (PDF + SVGs) on disk
      rmSync(jobdir, { recursive: true, force: true });
    }
  } finally {
    engine.rendering.delete(inflightKey);
  }
}
