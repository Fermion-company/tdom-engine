import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { hasDefinitionEdit } from './update-helpers.js';
import { flushVanishedLabels, labelReferenceCandidates, pushLabelDependencies } from './reference-deps.js';
import { push2, resolvedInGalley, vecLocalsEqual } from './util/galley.js';
import { canDeferPlainVerification } from './plain-preview.js';
import { chunkTargets } from './chunk-targets.js';

export async function runUpdateTypesetPhase(engine, {
  oldBlocks,
  diff,
  dirtySource,
  firstDirty,
  timer,
  defRe,
  plainPreviewAdmission = null,
  coldBudgetMs = 0,
  coldResume = false,
  callbacks,
}) {
  const {
    nearestCheckpoint,
    typesetBlock,
    adoptGalley,
    queueChainWork,
    retypesetChain,
    paginateNow,
    computeToc,
    queueMovedOffsets,
    coldPreview = null,
  } = callbacks;
  const dirtyBlocks = [];
  const depDirty = [];
  const changedLabels = new Set();
  let typesetCount = 0;
  let forkMs = 0;

  // Definition-bearing edits (docs/10 §I2b) forfeit suffix trust: scan the
  // changed window's old AND new text before deciding anything.
  const defEdit = hasDefinitionEdit(oldBlocks, engine.blocks, diff.bounds, defRe);

  // Bounded foreground walk (docs/10 §I1): typeset the edited region plus
  // its verification blocks, then STOP with a verdict — never walk the
  // document on the hot path. 'clean' keeps the preserved suffix as-is;
  // 'counters' hands the moving exit state to the async settle pass;
  // 'leak' (galley divergence past the budget, or a definition edit)
  // distrusts the suffix and hands it to the async rebuild pass.
  let verdict = null;
  let verifyGalleyBudget = 8; // layout-coupled clean blocks absorbed inline
  let verifyLocalBudget = 4; // \prevdepth/\lastskip ripple blocks absorbed inline
  // Highest index still missing a galley at walk start. The walk fills
  // galleys monotonically at its own index, so "any hole at >= i" is
  // exactly i <= lastNoGalley — the old per-iteration blocks.slice(i)
  // .some() scan was O(blocks²) on long walks (boot, paste, leak).
  let lastNoGalley = -1;
  for (let k = engine.blocks.length - 1; k >= 0; k--) {
    if (!engine.blocks[k].galley) {
      lastNoGalley = k;
      break;
    }
  }
  let lastDirty = firstDirty;
  for (let k = engine.blocks.length - 1; k >= 0; k--) {
    if (dirtySource.has(engine.blocks[k].id)) {
      lastDirty = k;
      break;
    }
  }
  // The page swaps atomically. A clean galley below the edited box is not
  // a usable stopping point while later exact pixels on that page are cold.
  let firstDisplay = firstDirty;
  let lastDisplay = lastDirty;
  if (engine.previewPolicy === 'structured' && engine.foregroundRenderIds) {
    for (let k = 0; k < engine.blocks.length; k++) {
      const block = engine.blocks[k];
      if (!engine.foregroundRenderIds.has(block.id) || !block.needsRender) continue;
      if (!chunkTargets(block).some(target => engine.chunks.get(target.key)?.forGalley !== block.galleyHash)) continue;
      // RENDER can use a retained input directly; it needs no foreground
      // replay merely because its exact pixels have not been requested yet.
      if (engine.checkpoints.has(k) && (engine.blocks.length + 1 <= engine.maxCheckpoints ||
          engine.editHold.includes(k) || engine.renderHold.has(k))) continue;
      firstDisplay = Math.min(firstDisplay, k);
      lastDisplay = Math.max(lastDisplay, k);
    }
  }
  const replayToken = {};
  let i = nearestCheckpoint(Math.min(firstDisplay, engine.blocks.length));
  // a walk that threw left its preview running
  engine.coldPreviewActive?.cancel();
  engine.coldPreviewActive = null;
  // Cold preview (docs/10 §10.4b): when the clean prefix between the nearest
  // checkpoint and the one edited block is expected to take a while to
  // replay, typeset that block right away in a fork of the same checkpoint,
  // beside the walk. The walk then stops cold once the preview is in (or at
  // the budget) and shows it, instead of leaving the old text on the page
  // until the resume walk arrives. Not while other blocks on the page still
  // need exact pixels: the page cannot paint before the walk reaches them.
  let preview = null;
  const costTo = (from) => {
    let ms = 0;
    for (let k = from; k < firstDirty; k++) ms += Number(engine.blocks[k].typesetCostMs) || 0;
    return ms;
  };
  if (coldPreview && coldBudgetMs > 0 && !defEdit && dirtySource.size === 1 &&
      firstDirty < engine.blocks.length && dirtySource.has(engine.blocks[firstDirty].id) && i < firstDirty &&
      firstDisplay === firstDirty && lastDisplay === lastDirty) {
    const estimateMs = costTo(i);
    if (estimateMs > (engine.coldPreviewFromMs ?? 500)) {
      const block = engine.blocks[firstDirty];
      const startedAt = performance.now();
      let started = null;
      try {
        started = coldPreview(firstDirty, i);
      } catch (err) {
        engine.diagnostics?.push(`cold preview of ${block.id}: ${err?.message ?? err}`);
      }
      if (started) {
        preview = { block, text: block.text, estimateMs: Math.round(estimateMs), galley: undefined, readyMs: null };
        preview.cancel = started.cancel;
        preview.release = started.release;
        engine.coldPreviewActive = started;
        preview.compile = started.galley.catch(() => null).then((galley) => {
          preview.galley = galley;
          preview.readyMs = Math.round(performance.now() - startedAt);
          return galley;
        });
      }
    }
  }
  const walkStartedAt = performance.now();
  let typesetDirty = false; // a source-dirty or galley-less block is behind the walk
  while (i < engine.blocks.length) {
    // /status liveness marker: which block the foreground pass is on —
    // a long boot walk shows movement instead of silence
    engine.progress = { phase: 'typeset', at: i + 1, total: engine.blocks.length };
    const block = engine.blocks[i];
    // a cold preview is no witness of the block's own typeset (§10.4b)
    const before = { hash: block.galley?.tdomColdPreview ? null : block.galleyHash, state: block.stateVec, hadGalley: !!block.galley };
    // The edited source block carries the old galley but not its closure;
    // that certificate was checked on oldBlocks before the walk.
    const plainBefore = plainPreviewAdmission?.blockId === block.id &&
      block.galley === plainPreviewAdmission.galley && block.stateVec === plainPreviewAdmission.stateVec
      ? plainPreviewAdmission.witness : null;
    const t0 = performance.now();
    const galley = await typesetBlock(i, i < firstDirty ? replayToken : null);
    forkMs += performance.now() - t0;
    typesetCount++;
    const wasClean = before.hadGalley && !dirtySource.has(block.id);
    if (!wasClean) typesetDirty = true;
    adoptGalley(block, galley);
    // track label movements
    for (const l of galley.labels ?? []) {
      if (engine.labelTable.get(l.k) !== l.v) {
        changedLabels.add(l.k);
        engine.labelTable.set(l.k, l.v);
      }
      if (l.h != null) engine.hrefTable.set(l.k, l.h);
    }
    const changed = block.galleyHash !== before.hash || block.stateVec !== before.state;
    if (changed || !wasClean) {
      dirtyBlocks.push(block.id);
      if (wasClean) {
        push2(depDirty, changedLabels.size ? 'label' : 'counter', 'chain', block.id);
      }
    }
    i++;
    // Cold prefix (docs/10 §10.4a): this block was a clean replay on the way
    // to a source-dirty block that is still ahead. Past the budget, stop at
    // this completed boundary instead of holding the keystroke for the whole
    // sparse replay; the chain pass resumes from here and re-runs the update.
    // A cold resume stops only once it has typeset one of its own blocks: its
    // walk may start before the boundary the chain pass reached (an exact
    // neighbour whose input boundary is not held, a block another walk already
    // typeset), and a stop there re-queues the same blocks with no progress.
    if (coldBudgetMs > 0 && wasClean && !changed && i <= lastDirty && (!coldResume || typesetDirty) &&
        (performance.now() - walkStartedAt > coldBudgetMs ||
          // a preview in hand ends the walk unless the rest is short
          (preview?.galley && costTo(i) > (engine.coldPreviewFromMs ?? 500) / 2))) {
      verdict = 'cold';
      break;
    }
    // External project updates can dirty disjoint blocks in one source
    // snapshot (for example an included chapter plus the generated .bbl at
    // the end). Never accept an intermediate clean block as convergence
    // while a later source-dirty block is still waiting.
    if (i <= lastDisplay) continue;
    if (!wasClean) {
      if (!defEdit && changed && i > lastNoGalley && i < engine.blocks.length &&
          dirtyBlocks.length === 1 && dirtyBlocks[0] === block.id && !changedLabels.size &&
          canDeferPlainVerification(plainPreviewAdmission, plainBefore, block)) {
        verdict = 'verify';
        break;
      }
      // an EDITED block that reproduced its galley AND exit state exactly
      // (stale-first rescue reuse, comment-only change) moved nothing:
      // converge without paying a verification job
      if (!changed && before.hadGalley && i > lastNoGalley) {
        verdict = 'clean';
        break;
      }
      continue; // still consuming the edited/new region
    }
    if (!changed) {
      // convergence: exit state and galley reproduced exactly. Galley-less
      // blocks ahead (boot/reboot fill) still need a walk; moved-label
      // dependents are handled by the backward-reference pass below.
      const holes = i <= lastNoGalley;
      if (!holes) {
        verdict = 'clean';
        break;
      }
      continue;
    }
    if (block.galleyHash !== before.hash) {
      // real layout coupling (\addvspace max-merge, @nobreak …) extends
      // the edited region — within a budget. A long cascade means an
      // untracked state (font switch, macro) is flowing downstream.
      if (verifyGalleyBudget-- > 0) continue;
      verdict = 'leak';
      break;
    }
    // galley identical, exit state moved: counters and/or the local tail
    if (vecLocalsEqual(before.state, block.stateVec)) {
      verdict = 'counters';
      break;
    }
    if (verifyLocalBudget-- > 0) continue; // let \prevdepth ripples settle
    verdict = 'counters';
    break;
  }
  if (defEdit && verdict) verdict = 'leak';
  const fgStop = i;
  const walkMs = Math.round(performance.now() - walkStartedAt);

  // A cold stop leaves every source-dirty block at or past the boundary with
  // a galley older than its text. Remember them: the resume walk targets the
  // first one, and any walk that re-typesets one drops it again (adoptGalley).
  let cold = null;
  if (verdict === 'cold' && preview && fgStop < firstDirty && engine.blocks[firstDirty] === preview.block &&
      preview.block.text === preview.text) {
    // A budget stop can come before the preview: wait a bounded while for
    // it, then show it. The block stays source-dirty below (coldDirty), so
    // the resume walk still typesets it in its own lineage and replaces it.
    let timer = null;
    const galley = preview.galley !== undefined ? preview.galley : await Promise.race([
      preview.compile,
      new Promise((resolve) => { timer = setTimeout(() => resolve(null), engine.coldPreviewWaitMs ?? 1000); }),
    ]);
    clearTimeout(timer);
    if (galley && engine.blocks[firstDirty] === preview.block && preview.block.text === preview.text) {
      // Downstream blocks were typeset against the old exit state: keep it
      // on the block, so the walk that typesets it natively compares against
      // what they assumed and carries a moved counter on (§10.4).
      const exitState = preview.block.stateVec;
      adoptGalley(preview.block, galley);
      preview.block.stateVec = exitState;
      if (!dirtyBlocks.includes(preview.block.id)) dirtyBlocks.push(preview.block.id);
      engine.coldPreviews = (engine.coldPreviews ?? 0) + 1;
      preview.adopted = true;
      // glyph-only: no RENDER will want the checkpoint it forked
      if (!preview.block.needsRender) preview.release();
    }
  }
  // the walk reached the block itself, or the preview came too late
  if (preview && !preview.adopted) preview.cancel();
  engine.coldPreviewActive = null;
  if (verdict === 'cold') {
    const pending = [];
    for (let k = fgStop; k < engine.blocks.length; k++) {
      const block = engine.blocks[k];
      if (dirtySource.has(block.id) || !block.galley) pending.push(block.id);
    }
    for (const id of pending) engine.coldDirty.add(id);
    cold = {
      pending,
      from: fgStop,
      preview: preview ? {
        block: preview.block.id, adopted: !!preview.adopted, estimateMs: preview.estimateMs,
        readyMs: preview.readyMs, walkMs,
      } : null,
    };
    engine.coldTrace = { stopAt: performance.now() };
    queueChainWork('cold', fgStop, changedLabels);
  }

  // verdict dispatch: anything beyond the foreground bound is DEFERRED
  if (verdict === 'counters' || verdict === 'leak' || verdict === 'verify') {
    if (verdict === 'leak') {
      // the suffix lineage can no longer be trusted — kill it; the async
      // rebuild re-typesets serially from the stop point
      for (const [idx, peer] of [...engine.checkpoints]) {
        if (idx > fgStop) {
          peer.send('DIE\n');
          if (peer.pid) engine.dyingPids?.add(peer.pid);
          engine.checkpoints.delete(idx);
        }
      }
      for (const idx of [...engine.renderHold.keys()]) {
        if (idx > fgStop) engine.renderHold.delete(idx);
      }
    }
    queueChainWork(verdict === 'leak' ? 'rebuild' : 'settle', fgStop, changedLabels);
    if (verdict === 'verify') engine.pendingChain.plainBlockId = plainPreviewAdmission.blockId;
  }

  flushVanishedLabels(engine.vanishedLabels, engine.labelCount, engine.labelTable, changedLabels);

  // Backward references: a label defined LATER in the chain (new figure,
  // renamed equation...) can be referenced by EARLIER blocks, which the
  // forward pass never revisits. Retypeset those ref-users explicitly —
  // candidates come from the ref index, not a full block scan. With chain
  // work pending, labels are still moving: the async pass runs this after
  // the suffix settles (#chainAfterPass) instead.
  if (changedLabels.size && !engine.pendingChain) {
    const candidates = labelReferenceCandidates(changedLabels, engine.refIndex);
    for (let c = 0; c < engine.blocks.length && candidates.size; c++) {
      const block = engine.blocks[c];
      if (!candidates.has(block.id)) continue;
      candidates.delete(block.id);
      const hit = (block.galley?.refs ?? []).some(
        (k) => changedLabels.has(k) && !resolvedInGalley(block, k, engine.labelTable)
      );
      if (!hit) continue;
      const from = nearestCheckpoint(c);
      await retypesetChain(from, c, (j, changed) => {
        typesetCount++;
        if (j === c && changed) {
          dirtyBlocks.push(block.id);
          for (const k of block.galley.refs ?? []) {
            if (changedLabels.has(k)) push2(depDirty, 'label', k, block.id);
          }
        } else if (j > c && changed) {
          dirtyBlocks.push(engine.blocks[j].id);
        }
      });
    }
  }
  timer.lap('typeset');

  pushLabelDependencies(depDirty, changedLabels, engine.refIndex);

  // ---- live table of contents -----------------------------------------
  // Provisional pagination gives page numbers; if the toc data moved,
  // retypeset the \tableofcontents blocks with the fresh toc file.
  // Fixed point: the toc block's own height shifts page numbers, which
  // shift the toc — iterate like latex reruns would, but per block.
  // Deferred to #chainAfterPass while chain work is pending (page numbers
  // are still moving until the suffix settles).
  for (let pass = 0; pass < 3 && !engine.pendingChain; pass++) {
    const prov = paginateNow();
    const toc = computeToc(prov);
    if (toc.hash === engine.tocHash) break;
    engine.tocHash = toc.hash;
    for (const [ext, content] of Object.entries(toc.contents)) {
      writeFileSync(path.join(engine.workDir, `driver.${ext}`), content);
    }
    let anyConsumer = false;
    for (let c = 0; c < engine.blocks.length; c++) {
      const block = engine.blocks[c];
      if (!block.consumesToc) continue;
      anyConsumer = true;
      const from = nearestCheckpoint(c);
      await retypesetChain(from, c, (j, changed) => {
        typesetCount++;
        if (changed && j >= c) {
          dirtyBlocks.push(engine.blocks[j].id);
          if (j === c) push2(depDirty, 'toc', 'contents', block.id);
        }
      });
    }
    if (!anyConsumer) break;
  }
  timer.lap('toc');

  // ---- page-context-sensitive rescues ---------------------------------
  // A rescued environment that reads \pagegoal-\pagetotal (mdframed,
  // breakable tcolorbox …) splits by its position ON the page. An edit
  // near the top of the document moves EVERY later block's offset, so
  // walking re-rescue chains here would be O(document) on the hot path
  // (measured: 2 minutes for a one-character edit). Instead: update the
  // offsets, queue the affected rescues, and let the async exact
  // pipeline iterate to the fixed point — the stale galleys stay on
  // screen meanwhile, and canonical guarantees the final pixels.
  queueMovedOffsets();
  timer.lap('pagectx');
  engine._typesetResult = { dirtyBlocks, depDirty, changedLabels, typesetCount, forkMs, fgStop, verdict, cold };
}
