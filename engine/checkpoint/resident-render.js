import { mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { waitForPdf } from './util/fs.js';
import { cropRenderTargets } from './render-chunks.js';
import { buildLastskipPrimer } from './job-body.js';

async function runShipCommand(engine, {
  block,
  idx,
  ck,
  requestId,
  command,
  body,
  checkpointIndex,
  awaitRender,
  renderIsolated,
  hold = false,
}) {
  // Renders are latency work, not correctness work (canonical always wins):
  // give up quickly on a spinning child rather than parking a pump lane.
  engine.renderPids ??= new Map();
  engine.activeResidentRenderCheckpoints ??= new Map();
  engine.renderPids.set(requestId, 0); // armed: FORKED will fill the pid
  engine.activeResidentRenderCheckpoints.set(requestId, { peer: ck, index: checkpointIndex });
  if (hold) (engine.heldRenderIds ??= new Map()).set(requestId, block.id);
  const done = awaitRender('render:' + requestId, Number(process.env.TDOM_RENDER_TIMEOUT || 20_000));
  ck.send(command);
  if (body) ck.sendRaw(body);
  try {
    await done;
  } catch (err) {
    if (/timeout/.test(String(err?.message))) {
      // Deep-lineage luatexja wall: kill a wedged child and let canonical or
      // the isolated queue provide the pixels.  Do not retry a timed-out
      // capture through RENDER: that would occupy the lane twice.
      const pid = engine.renderPids.get(requestId);
      if (pid) {
        try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
      }
      renderIsolated(block, idx);
    }
    throw err;
  } finally {
    engine.renderPids.delete(requestId);
    engine.activeResidentRenderCheckpoints.delete(requestId);
    if (hold) engine.heldRenderIds?.delete(requestId);
  }
}

/**
 * Send a resident RENDER of `body` from `ck` and return without waiting for
 * it: a cold preview's block (docs/10 §10.4b) ships beside the preview's own
 * JOB, and the render pump later crops that PDF for the adopted galley
 * (`renderResidentBlock`'s `early`) instead of typesetting the block again.
 * `discard` kills an unused child and removes its directory.
 */
export function startResidentRender(engine, { block, ck, checkpointIndex, body, awaitRender }) {
  const requestId = `rr@${++engine.renderSeq}`;
  const jobdir = path.join(engine.workDir, `render-${block.id}-early${engine.renderSeq}`);
  mkdirSync(jobdir, { recursive: true });
  const pdf = path.join(jobdir, 'driver.pdf');
  rmSync(pdf, { force: true });
  const early = { requestId, jobdir, pdf, text: block.text, used: false, discarded: false, startedAt: Date.now() };
  early.done = runShipCommand(engine, {
    block,
    idx: checkpointIndex,
    ck,
    requestId,
    command: `RENDER ${block.id} ${encodeURIComponent(jobdir)} ${body.length} ${requestId}\n`,
    body,
    checkpointIndex,
    awaitRender,
    // a late or failed early render leaves the block to the ordinary pump
    renderIsolated: () => {},
  }).then(() => waitForPdf(pdf));
  early.done.catch((err) => { early.failure = err; });
  early.discard = () => {
    if (early.discarded || early.used) return;
    early.discarded = true;
    const pid = engine.renderPids?.get(requestId);
    if (pid > 0) {
      try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
    } else if (pid === 0) {
      engine.cancelledRenderIds?.add(requestId); // killed when FORKED arrives
    }
    const err = new Error(`early render of ${block.id} unused`);
    err.tdomSuperseded = true;
    engine._reject('render:' + requestId, err);
    rmSync(jobdir, { recursive: true, force: true });
  };
  return early;
}

export async function renderResidentBlock(
  engine,
  {
    block, idx, ck, checkpointIndex = idx, prelude = null, targets, forGalley,
    awaitRender, renderIsolated, asyncRepaginate, chunkTargets, releaseRenderHold, early = null, hold = false,
  }
) {
  const inflightKey = block.id + ':' + forGalley;
  engine.rendering ??= new Set();
  if (engine.rendering.has(inflightKey)) return;
  engine.rendering.add(inflightKey);
  const jobdir = path.join(engine.workDir, `render-${block.id}-${forGalley}`);
  // where one exact render's time goes (/status render.timings)
  const t0 = Date.now();
  const timing = { block: block.id, previewPeer: prelude !== null, at: t0 };
  try {
    mkdirSync(jobdir, { recursive: true });
    let pdf = path.join(jobdir, 'driver.pdf');
    rmSync(pdf, { force: true });
    // A cold preview's RENDER already went out beside its JOB (same peer,
    // same prelude, same text): crop its PDF. One pre-empted by a later edit
    // re-queues the block like any resident render; one that failed
    // otherwise falls back to the RENDER below.
    let shippedEarly = false;
    if (early && !early.used && !early.discarded && !early.failure && early.text === block.text) {
      early.used = true;
      try {
        await early.done;
        pdf = early.pdf;
        shippedEarly = true;
        timing.earlyMs = t0 - early.startedAt;
      } catch (err) {
        rmSync(early.jobdir, { recursive: true, force: true });
        if (err?.tdomSuperseded) throw err;
      }
    }
    // A fallback RENDER/CAPTURE ships the block as it is NOW: only while that
    // is still the galley this render is named for. A held early render
    // (#103) may fail long after a newer keystroke replaced it; its own
    // text's pixels are not what the block's current source would ship.
    if (!shippedEarly && (engine.blocks[idx] !== block || block.galleyHash !== forGalley ||
        (early && early.text !== block.text))) {
      const err = new Error(`resident render of ${block.id} superseded while its early render ran`);
      err.tdomSuperseded = true;
      throw err;
    }
    // a cold preview's checkpoint is not the block's own: its JOB prelude
    // re-seeds the entry state (and already ends with the primer). Otherwise
    // the prelude the galley's JOB used (label definitions and the primer;
    // docs/10 §10.4c), else the primer alone.
    const body = Buffer.from(
      (prelude ?? block.galley?.tdomRenderPrelude ??
        ((engine.defsPatch?.touches(block.text) ? engine.defsPatch.prelude : '') +
          buildLastskipPrimer(block, idx, engine.blocks))) + block.text, 'utf8');
    engine.renderStats ??= { captureHits: 0, captureMisses: 0, retypesets: 0 };

    let shippedCapture = shippedEarly;
    const captureToken = block.galley?.capture;
    const captureCk = captureToken ? engine.checkpoints.get(idx + 1) : null;
    if (!shippedEarly && captureToken && captureCk && targets.length === 1 &&
        !block.galley?.floats?.length &&
        !block.galley?.items?.some(item => item.k === 'ins' || item.k === 'eject')) {
      try {
        const requestId = `rr@${++engine.renderSeq}`;
        await runShipCommand(engine, {
          block,
          idx,
          ck: captureCk,
          requestId,
          command:
            `CAPTURE ${block.id} ${captureToken} ${encodeURIComponent(jobdir)} ${requestId}\n`,
          body: null,
          checkpointIndex: idx + 1,
          awaitRender,
          renderIsolated,
          hold,
        });
        shippedCapture = true;
        engine.renderStats.captureHits++;
        if (block.galley?.capture === captureToken) delete block.galley.capture;
      } catch (err) {
        if (!err?.tdomCaptureMiss) throw err;
        engine.renderStats.captureMisses++;
        if (block.galley?.capture === captureToken) delete block.galley.capture;
      }
    } else if (captureToken && !shippedEarly) {
      // The sparse checkpoint grid retired the post-block owner before the
      // pump reached it. This is expected on cold/long documents.
      engine.renderStats.captureMisses++;
      if (block.galley?.capture === captureToken) delete block.galley.capture;
    }

    if (!shippedCapture) {
      if (!ck) {
        // Capture raced with sparse-checkpoint retirement and there is no
        // pre-block resident state left for RENDER either.
        renderIsolated(block, idx);
        return;
      }
      engine.renderStats.retypesets++;
      const requestId = `rr@${++engine.renderSeq}`;
      // Universal fallback: use the state BEFORE this block and execute its
      // source exactly as the original implementation did.
      await runShipCommand(engine, {
        block,
        idx,
        ck,
        requestId,
        command: `RENDER ${block.id} ${encodeURIComponent(jobdir)} ${body.length} ${requestId}\n`,
        body,
        checkpointIndex,
        awaitRender,
        renderIsolated,
        hold,
      });
    }
    timing.doneMs = Date.now() - t0;
    // DONE fires from finish_pdffile, but the child's stdio buffers reach
    // the disk only on _exit — wait until the file is complete (%%EOF)
    await waitForPdf(pdf);
    timing.pdfMs = Date.now() - t0;
    // the RENDER child wrote its padding file next to the PDF it shipped
    // Crop beside the live map: a render of a galley a newer keystroke has
    // replaced (a held one, #103) may land after the newer galley's own
    // pixels, and must never overwrite them.
    const staged = new Map(targets.map((target) => [target.key, engine.chunks.get(target.key)]));
    await cropRenderTargets({
      jobdir: shippedEarly ? early.jobdir : jobdir, pdf, targets, chunks: staged, forGalley, prefix: 'chunk',
    });
    timing.cropMs = Date.now() - t0;
    const live = engine.blocks.find((b) => b.id === block.id);
    const landing = supersededLanding(live, engine.chunks, forGalley);
    if (landing !== 'none') {
      for (const target of targets) {
        if (landing === 'held' && target.key !== block.id) continue;
        const chunk = staged.get(target.key);
        if (!chunk) continue;
        chunk.v = Math.max(chunk.v ?? 0, (engine.chunks.get(target.key)?.v ?? 0) + 1);
        engine.chunks.set(target.key, chunk);
      }
    }
    if (landing === 'current' || landing === 'held') asyncRepaginate();
    timing.publishedMs = Date.now() - t0;
    engine.renderTimings ??= [];
    engine.renderTimings.push(timing);
    if (engine.renderTimings.length > 40) engine.renderTimings.shift();
  } finally {
    engine.rendering.delete(inflightKey);
    if (early?.used) rmSync(early.jobdir, { recursive: true, force: true });
    // the job dir held one PDF + page SVGs whose useful content now lives
    // in engine.chunks — every edit to a gfx block minted a new dir and
    // nothing ever removed them (observed: hundreds of dirs, 10s of MB)
    rmSync(jobdir, { recursive: true, force: true });
    // fresh chunks (or a superseding edit) end the checkpoint's reprieve
    if (
      engine.blocks[idx] !== block ||
      !chunkTargets(block).some((t) => engine.chunks.get(t.key)?.forGalley !== block.galleyHash)
    ) {
      releaseRenderHold(idx);
    }
  }
}

/**
 * What a render of `forGalley` may still paint once it lands: 'current' (the
 * block's galley), 'held' (an earlier galley the page lays the block out
 * from while the current one renders; stream.js, #103), 'stale' (a galley
 * nobody displays, registered as before, as stale pixels) or 'none' (the
 * block's own newer pixels are in: never overwrite them).
 */
export function supersededLanding(live, chunks, forGalley) {
  if (!live) return 'none'; // the block is gone: nothing to paint
  if (live.galleyHash === forGalley) return 'current';
  const current = chunks.get(live.id)?.forGalley;
  if (current === live.galleyHash) return 'none';
  if (live.exactHistory?.has(forGalley)) {
    const order = [...live.exactHistory.keys()];
    return current != null && order.indexOf(current) > order.indexOf(forGalley) ? 'none' : 'held';
  }
  // the page shows a held galley's pixels: an unrelated older render must
  // not take them away
  if (current != null && live.exactHistory?.has(current)) return 'none';
  return 'stale';
}
