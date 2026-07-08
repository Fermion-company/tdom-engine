import { mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { braceImbalance } from './util/tex.js';
import { waitForPdf } from './util/fs.js';
import { cropRenderTargets } from './render-chunks.js';

export async function renderResidentBlock(
  engine,
  { block, idx, ck, targets, forGalley, awaitRender, renderIsolated, asyncRepaginate, chunkTargets, releaseRenderHold }
) {
  const inflightKey = block.id + ':' + forGalley;
  engine.rendering ??= new Set();
  if (engine.rendering.has(inflightKey)) return;
  engine.rendering.add(inflightKey);
  try {
    const jobdir = path.join(engine.workDir, `render-${block.id}-${forGalley}`);
    mkdirSync(jobdir, { recursive: true });
    rmSync(path.join(jobdir, 'driver.pdf'), { force: true });
    const guard = '}'.repeat(Math.max(0, braceImbalance(block.text)));
    const body = Buffer.from(block.text + guard, 'utf8');
    // renders are latency work, not correctness work (canonical always
    // wins): give up quickly on a spinning child rather than parking a
    // pump lane on it
    engine.renderPids ??= new Map();
    engine.renderPids.set(block.id, 0); // armed: FORKED will fill the pid
    const done = awaitRender('render:' + block.id, Number(process.env.TDOM_RENDER_TIMEOUT || 20_000));
    ck.send(`RENDER ${block.id} ${jobdir} ${body.length}\n`);
    ck.sendRaw(body);
    try {
      await done;
    } catch (err) {
      if (/timeout/.test(String(err?.message))) {
        // deep-lineage luatexja wall: the forked render child spins in
        // luahbtex exactly like in-chain jobs do. Kill it (it never reads
        // its socket again) and let the canonical-crop pass supply the
        // exact pixels instead.
        const pid = engine.renderPids.get(block.id);
        if (pid) {
          try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
        }
        // exact pixels still arrive two ways: the canonical-crop pass, or
        // (for drifting documents it cannot serve) the idle-gated isolated
        // queue — a fresh process typesets wall blocks at normal speed
        renderIsolated(block, idx);
      }
      throw err;
    } finally {
      engine.renderPids.delete(block.id);
    }
    const pdf = path.join(jobdir, 'driver.pdf');
    // DONE fires from finish_pdffile, but the child's stdio buffers reach
    // the disk only on _exit — wait until the file is complete (%%EOF)
    await waitForPdf(pdf);
    await cropRenderTargets({ jobdir, pdf, targets, chunks: engine.chunks, forGalley, prefix: 'chunk' });
    if (block.galleyHash === forGalley) asyncRepaginate();
  } finally {
    engine.rendering.delete(inflightKey);
    // fresh chunks (or a superseding edit) end the checkpoint's reprieve
    if (
      engine.blocks[idx] !== block ||
      !chunkTargets(block).some((t) => engine.chunks.get(t.key)?.forGalley !== block.galleyHash)
    ) {
      releaseRenderHold(idx);
    }
  }
}
