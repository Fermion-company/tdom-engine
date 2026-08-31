import { fnv1a } from '../hash.js';
import { segmentBody, documentBounds, diffBlocks } from '../segmenter.js';
import { classifyPreamble, classifyBodyBlock, bodyUsesColumnSwitch } from './safety.js';
import { classifyStructuralAliases } from './structural-aliases.js';
import { firstDirtyIndex } from './update-helpers.js';
import { preserveCheckpointSuffix } from './checkpoint-preservation.js';
import { sourceClosure } from './closure.js';

export async function prepareUpdate(engine, { editLabel, timer, callbacks }) {
  const { opaqueUpdate, deferClosureUpdate, bootRoot, scheduleStructuredReprobe, expandIncludes, unindexBlock } = callbacks;
  const text = engine.store.get(engine.file);
  const diagnostics = [];

  const bounds = documentBounds(text);
  const preamble = text.slice(bounds.preamble.start, bounds.preamble.end);
  const preHash = fnv1a(preamble);

  // Keep both the old page tree and its block boundaries while the user is
  // in an unambiguously unfinished construct. In particular, an unclosed
  // environment makes the segmenter absorb every following paragraph; if
  // that temporary segmentation were committed, "hold last good" would
  // still make the document tail disappear. The source store advances, but
  // no TeX path or layout identity advances until the closing syntax lands.
  if (engine.blocks.length) {
    const preClosure = sourceClosure(preamble);
    if (!preClosure.closed) {
      timer.lap('closure');
      return { response: deferClosureUpdate(editLabel, timer, { ...preClosure, scope: 'preamble' }) };
    }
  }

  // ---- safety gate, preamble half --------------------------------------
  // Structured is a privilege, not a default: page-mechanism-hostile
  // constructs take the opaque path, where the display is the canonical
  // LuaLaTeX output itself. Memoized per preamble hash — while the user
  // types in the body this costs one hash compare, not a full regex sweep.
  if (engine.preGate?.preHash !== preHash) {
    engine.preGate = { preHash, gate: classifyPreamble(preamble) };
  }
  engine.previewPolicy = engine.preGate.gate.previewPolicy ?? 'structured';
  engine.previewReasons = engine.preGate.gate.previewReasons ?? [];
  // ---- segmentation + diff ---------------------------------------------
  // Independent of the resident boot, so it runs even for opaque documents.
  // Besides feeding the body safety gate, these blocks carry direct-edit
  // source spans over the exact canonical pages.  Previously an unsafe
  // preamble returned above this point, leaving opaque
  // papers with zero editable regions despite the UI calling them editable.
  const oldBlocks = engine.blocks;
  let segs = segmentBody(text.slice(bounds.body.start, bounds.body.end), bounds.body.start);
  segs = expandIncludes(segs, 0);
  // Macro wrappers can hide output-routine environments from both the raw
  // segmenter and block rescue classifier. Analyse the expanded project body
  // before granting structured display; an exact canonical page is the only
  // honest surface when a locally-defined structural alias is actually used.
  const structuralGate = classifyStructuralAliases(
    preamble,
    segs.map((seg) => seg.text).join('\n\n')
  );
  if (engine.blocks.length) {
    for (const seg of segs) {
      const closure = sourceClosure(seg.text);
      if (!closure.closed) {
        timer.lap('closure');
        return {
          response: deferClosureUpdate(editLabel, timer, {
            ...closure,
            scope: seg.file ?? engine.file,
            sourceAt: (seg.sourceStart ?? seg.start) + closure.at,
          }),
        };
      }
    }
  }
  const diff = diffBlocks(engine.blocks, segs, () => engine.idSeq++);
  engine.blocks = diff.blocks;
  // Block indices and carried cost profiles may have moved. Rebuild the
  // sparse resident skeleton once for this source generation; subsequent
  // JOBs reuse it unless a genuinely hotter block changes the top set.
  engine.checkpointKeepCache = null;
  if (engine.blocks.some((block) => bodyUsesColumnSwitch(block.text))) {
    engine.previewPolicy = 'canonical-anchor';
    engine.previewReasons = [...new Set([...engine.previewReasons, 'body column switch'])];
  }
  for (const id of diff.removed) {
    unindexBlock(id);
    engine.unsafeBodyBlocks.delete(id);
    // a removed block's per-block state must die with it — chunks in
    // particular hold full SVG strings and used to accumulate forever
    engine.poisoned.delete(id);
    engine.fidelityDemoted.delete(id);
    engine.isoForkBroken.delete(id);
    engine.renderWant.delete(id);
    engine.rescueQueue.delete(id);
    for (const key of engine.chunks.keys()) {
      if (key === id || key.startsWith(id + '#') || key.startsWith(id + '@')) {
        engine.chunks.delete(key);
      }
    }
  }
  const dirtySource = new Set(diff.dirty);

  if (!engine.preGate.gate.safe) {
    return {
      response: opaqueUpdate(editLabel, timer, engine.preGate.gate.reasons.map((r) => `safety gate: ${r}`)),
    };
  }
  if (!structuralGate.safe) {
    return {
      response: opaqueUpdate(editLabel, timer, structuralGate.reasons.map((r) => `safety gate: ${r}`)),
    };
  }
  if (engine.opaqueStickyPre === preHash) {
    // dynamically demoted on this exact preamble — don't pay a doomed
    // boot per keystroke; a preamble edit (or reopen) retries structured
    return { response: opaqueUpdate(editLabel, timer, engine.modeReasons) };
  }

  // ---- safety gate, body half (incremental) ----------------------------
  // Only blocks whose text changed are re-scanned; the verdict for clean
  // blocks persists. This also closes the old gate's include blindness:
  // \input'ed content arrives here as expanded blocks and is scanned like
  // any other block, where the old whole-body scan saw only the main file.
  for (const b of engine.blocks) {
    if (!dirtySource.has(b.id)) continue;
    const why = classifyBodyBlock(b.text);
    if (why) engine.unsafeBodyBlocks.set(b.id, why);
    else engine.unsafeBodyBlocks.delete(b.id);
  }
  if (engine.unsafeBodyBlocks.size) {
    const reasons = [...new Set(engine.unsafeBodyBlocks.values())].map((r) => `safety gate: ${r}`);
    return { response: opaqueUpdate(editLabel, timer, reasons) };
  }
  timer.lap('segment');

  // ---- structured re-enable + boot -------------------------------------
  if (engine.mode === 'opaque') {
    engine.mode = 'structured';
    engine.modeReasons = [];
    engine.preHash = null; // the resident tree was torn down — force a boot
    engine.canonical.pressure = 'authority'; // provisional carries the display again
    engine.diagnostics.push('safety gate: structured layer re-enabled');
  }

  let rebooted = false;
  if (preHash !== engine.preHash) {
    if (process.env.TDOM_DEBUG_BOOT) {
      console.error(
        `[tdom-debug] preHash mismatch: have=${engine.preHash} want=${preHash} ` +
          `preambleLen=${preamble.length} bodyStart=${bounds.body.start} edit=${editLabel}`
      );
    }
    // Structure-changing edit: the honest full-rebuild path. A preamble
    // the daemon cannot boot (unknown packages breaking the driver shims,
    // TeX errors before \begin{document} …) is not an error state: the
    // document demotes to opaque and the canonical layer keeps rendering.
    engine.progress = { phase: 'boot' }; // /status: preamble reload running
    try {
      await bootRoot();
    } catch (err) {
      engine.opaqueStickyPre = preHash;
      scheduleStructuredReprobe(preHash);
      return { response: opaqueUpdate(editLabel, timer, [`structured boot failed: ${err.message}`]) };
    }
    engine.preHash = preHash;
    rebooted = true;
    for (const b of engine.blocks) {
      // A preamble edit needs an honest replay from block zero, but it must
      // not erase the last good provisional display while that replay is in
      // flight.  In particular, \title/\author/\date edits reboot the root;
      // \maketitle then takes the asynchronous exact-rescue path.  Clearing
      // its galley here replaced the whole title block with an empty
      // placeholder until the isolated compile landed.  Keep every old
      // galley as the stale-first display and mark every block dirty instead:
      // the foreground walk still re-typesets the complete document against
      // the new preamble, while rescue-only blocks can hold their clean old
      // pixels and swap in the new ones atomically.
      dirtySource.add(b.id);
      b.units = null;
    }
  }
  timer.lap('boot');

  const firstDirty = firstDirtyIndex(oldBlocks, engine.blocks, dirtySource, diff);
  // Checkpoint-suffix preservation (docs/10 §I2): boundaries outside the
  // edited window survive the edit. Prefix boundaries are exact; suffix
  // boundaries move by the window's index delta and are marked
  // volatile-stale — a job forked from one re-seeds counters/\prevdepth/
  // \if@nobreak from the orchestrator's stateVec (#volatilePrelude). Only
  // boundaries INSIDE the window die. Whether the suffix may be TRUSTED
  // is decided after the foreground walk (verdict): definition edits and
  // untracked-state leaks still kill and rebuild it, off the hot path.
  ({
    checkpoints: engine.checkpoints,
    renderHold: engine.renderHold,
    editHold: engine.editHold,
  } = preserveCheckpointSuffix({
    checkpoints: engine.checkpoints,
    renderHold: engine.renderHold,
    editHold: engine.editHold,
    pendingChain: engine.pendingChain,
    bounds: diff.bounds,
    dyingPids: engine.dyingPids,
  }));

  return { text, diagnostics, oldBlocks, diff, dirtySource, firstDirty, rebooted };
}
