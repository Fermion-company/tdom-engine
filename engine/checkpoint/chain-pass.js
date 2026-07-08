import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { resolvedInGalley } from './util/galley.js';

/**
 * The deferred chain pass. 'settle': re-typeset forward from the stop
 * point until a clean block reproduces its galley AND exit state exactly
 * (the moving counters have been chased to convergence). 'rebuild': same
 * walk but to the end of the document — after a definition edit or an
 * untracked-state leak no early convergence can be trusted. Both are
 * resumable: bgAbort (set by the next edit) exits between blocks with
 * work.from advanced, and the pass re-runs after that edit's own
 * foreground. Changed galleys stream to the client through the async
 * patch channel; stale galleys stay on screen meanwhile (old-but-clean
 * beats fast-but-wrong, and canonical owns the final pixels regardless).
 */
export async function runChainPass(engine, callbacks) {
  const {
    nearestCheckpoint,
    typesetBlock,
    adoptGalley,
    queueRender,
    asyncRepaginate,
    chainAfterPass,
    enforceCheckpointCap,
  } = callbacks;
  const work = engine.pendingChain;
  if (!work) return;
  engine.bgActive = true;
  try {
    if (work.phase === 'blocks') {
      let sinceRepaint = 0;
      let j = nearestCheckpoint(Math.min(work.from, engine.blocks.length));
      while (j < engine.blocks.length) {
        if (engine.bgAbort) {
          work.from = Math.min(work.from, j);
          return;
        }
        engine.progress = { phase: 'chain', at: j + 1, total: engine.blocks.length };
        const block = engine.blocks[j];
        const before = { hash: block.galleyHash, state: block.stateVec, hadGalley: !!block.galley };
        let galley;
        try {
          galley = await typesetBlock(j);
        } catch {
          work.from = Math.min(work.from, j);
          return; // killed by an incoming edit — resume afterwards
        }
        adoptGalley(block, galley);
        for (const l of galley.labels ?? []) {
          if (engine.labelTable.get(l.k) !== l.v) {
            work.labels.add(l.k);
            engine.labelTable.set(l.k, l.v);
          }
          if (l.h != null) engine.hrefTable.set(l.k, l.h);
        }
        const changed = block.galleyHash !== before.hash || block.stateVec !== before.state;
        if (changed) {
          if (block.needsRender) queueRender(block.id);
          if (++sinceRepaint >= 8) {
            asyncRepaginate();
            sinceRepaint = 0;
          }
        }
        j++;
        work.from = Math.max(work.from, j);
        if (
          work.kind === 'settle' &&
          before.hadGalley &&
          !changed &&
          !engine.blocks.slice(j).some((b) => !b.galley)
        ) {
          break; // exit state converged — the untouched suffix is exact
        }
      }
      if (sinceRepaint) asyncRepaginate();
      work.phase = 'after';
    }
    if (engine.bgAbort) return;
    await chainAfterPass(work);
    if (engine.bgAbort) return;
    if (engine.pendingChain === work) engine.pendingChain = null;
  } finally {
    engine.bgActive = false;
    engine.progress = null;
    // the settle/rebuild/after walks left checkpoints at every block they
    // re-typeset — collapse back to the grid
    enforceCheckpointCap();
  }
}

/**
 * Post-settle dependency passes — the async twins of the foreground's
 * inline backward-reference and toc sections, run once the suffix state
 * has stopped moving. Abortable and re-entrant (work.phase = 'after').
 */
export async function chainAfterPass(engine, work, callbacks) {
  const { nearestCheckpoint, retypesetChain, paginateNow, computeToc, queueMovedOffsets, asyncRepaginate } =
    callbacks;
  const changedLabels = work.labels;
  if (changedLabels.size) {
    const candidates = new Set();
    for (const k of changedLabels) {
      for (const bid of engine.refIndex.get(k) ?? []) candidates.add(bid);
    }
    for (let c = 0; c < engine.blocks.length && candidates.size; c++) {
      if (engine.bgAbort) return;
      const block = engine.blocks[c];
      if (!candidates.has(block.id)) continue;
      candidates.delete(block.id);
      const hit = (block.galley?.refs ?? []).some(
        (k) => changedLabels.has(k) && !resolvedInGalley(block, k, engine.labelTable)
      );
      if (!hit) continue;
      const n = await retypesetChain(nearestCheckpoint(c), c, () => {}, () => engine.bgAbort);
      if (n < 0) return;
    }
  }
  for (let pass = 0; pass < 3; pass++) {
    if (engine.bgAbort) return;
    const prov = paginateNow();
    const toc = computeToc(prov);
    if (toc.hash === engine.tocHash) break;
    engine.tocHash = toc.hash;
    for (const [ext, content] of Object.entries(toc.contents)) {
      writeFileSync(path.join(engine.workDir, `driver.${ext}`), content);
    }
    let anyConsumer = false;
    for (let c = 0; c < engine.blocks.length; c++) {
      if (engine.bgAbort) return;
      const block = engine.blocks[c];
      if (!block.consumesToc) continue;
      anyConsumer = true;
      const n = await retypesetChain(nearestCheckpoint(c), c, () => {}, () => engine.bgAbort);
      if (n < 0) return;
    }
    if (!anyConsumer) break;
  }
  queueMovedOffsets();
  asyncRepaginate();
}
