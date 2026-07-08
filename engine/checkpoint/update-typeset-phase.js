import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { hasDefinitionEdit } from './update-helpers.js';
import { flushVanishedLabels, labelReferenceCandidates, pushLabelDependencies } from './reference-deps.js';
import { push2, resolvedInGalley, vecLocalsEqual } from './util/galley.js';

export async function runUpdateTypesetPhase(engine, {
  oldBlocks,
  diff,
  dirtySource,
  firstDirty,
  timer,
  defRe,
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
  let i = nearestCheckpoint(Math.min(firstDirty, engine.blocks.length));
  while (i < engine.blocks.length) {
    // /status liveness marker: which block the foreground pass is on —
    // a long boot walk shows movement instead of silence
    engine.progress = { phase: 'typeset', at: i + 1, total: engine.blocks.length };
    const block = engine.blocks[i];
    const before = { hash: block.galleyHash, state: block.stateVec, hadGalley: !!block.galley };
    const t0 = performance.now();
    const galley = await typesetBlock(i);
    forkMs += performance.now() - t0;
    typesetCount++;
    const wasClean = before.hadGalley && !dirtySource.has(block.id);
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
    if (i <= firstDirty) continue; // replay ramp up to the edited region
    if (!wasClean) {
      // an EDITED block that reproduced its galley AND exit state exactly
      // (stale-first rescue reuse, comment-only change) moved nothing:
      // converge without paying a verification job
      if (!changed && before.hadGalley && !engine.blocks.slice(i).some((b) => !b.galley)) {
        verdict = 'clean';
        break;
      }
      continue; // still consuming the edited/new region
    }
    if (!changed) {
      // convergence: exit state and galley reproduced exactly. Galley-less
      // blocks ahead (boot/reboot fill) still need a walk; moved-label
      // dependents are handled by the backward-reference pass below.
      const holes = engine.blocks.slice(i).some((b) => !b.galley);
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

  // verdict dispatch: anything beyond the foreground bound is DEFERRED
  if (verdict === 'counters' || verdict === 'leak') {
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
  engine._typesetResult = { dirtyBlocks, depDirty, changedLabels, typesetCount, forkMs, fgStop, verdict };
}
