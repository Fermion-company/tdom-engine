import { mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { waitForPdf } from './util/fs.js';
import { cropRenderTargets } from './render-chunks.js';

async function runShipCommand(engine, {
  block,
  idx,
  ck,
  requestId,
  command,
  body,
  awaitRender,
  renderIsolated,
}) {
  // Renders are latency work, not correctness work (canonical always wins):
  // give up quickly on a spinning child rather than parking a pump lane.
  engine.renderPids ??= new Map();
  engine.renderPids.set(requestId, 0); // armed: FORKED will fill the pid
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
  }
}

export async function renderResidentBlock(
  engine,
  { block, idx, ck, targets, forGalley, awaitRender, renderIsolated, asyncRepaginate, chunkTargets, releaseRenderHold }
) {
  const inflightKey = block.id + ':' + forGalley;
  engine.rendering ??= new Set();
  if (engine.rendering.has(inflightKey)) return;
  engine.rendering.add(inflightKey);
  const jobdir = path.join(engine.workDir, `render-${block.id}-${forGalley}`);
  try {
    mkdirSync(jobdir, { recursive: true });
    const pdf = path.join(jobdir, 'driver.pdf');
    rmSync(pdf, { force: true });
    const body = Buffer.from(block.text, 'utf8');
    engine.renderStats ??= { captureHits: 0, captureMisses: 0, retypesets: 0 };

    let shippedCapture = false;
    const captureToken = block.galley?.capture;
    const captureCk = captureToken ? engine.checkpoints.get(idx + 1) : null;
    if (captureToken && captureCk) {
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
          awaitRender,
          renderIsolated,
        });
        shippedCapture = true;
        engine.renderStats.captureHits++;
        if (block.galley?.capture === captureToken) delete block.galley.capture;
      } catch (err) {
        if (!err?.tdomCaptureMiss) throw err;
        engine.renderStats.captureMisses++;
        if (block.galley?.capture === captureToken) delete block.galley.capture;
      }
    } else if (captureToken) {
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
        awaitRender,
        renderIsolated,
      });
    }
    // DONE fires from finish_pdffile, but the child's stdio buffers reach
    // the disk only on _exit — wait until the file is complete (%%EOF)
    await waitForPdf(pdf);
    await cropRenderTargets({ jobdir, pdf, targets, chunks: engine.chunks, forGalley, prefix: 'chunk' });
    if (block.galleyHash === forGalley) asyncRepaginate();
  } finally {
    engine.rendering.delete(inflightKey);
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
