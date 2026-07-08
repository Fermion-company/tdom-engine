import { fnv1a } from '../hash.js';
import { segmentBody, documentBounds, diffBlocks } from '../segmenter.js';
import { classifyDocument } from './safety.js';
import { firstDirtyIndex } from './update-helpers.js';
import { preserveCheckpointSuffix } from './checkpoint-preservation.js';

export async function prepareUpdate(engine, { editLabel, timer, callbacks }) {
  const { opaqueUpdate, bootRoot, scheduleStructuredReprobe, expandIncludes, unindexBlock } = callbacks;
  const text = engine.store.get(engine.file);
  const diagnostics = [];

  const bounds = documentBounds(text);
  const preamble = text.slice(bounds.preamble.start, bounds.preamble.end);
  const preHash = fnv1a(preamble);

  // ---- safety gate -----------------------------------------------------
  // Structured is a privilege, not a default: page-mechanism-hostile
  // constructs and previously-failed preambles take the opaque path,
  // where the display is the canonical LuaLaTeX output itself.
  const gate = classifyDocument(preamble, text.slice(bounds.body.start, bounds.body.end));
  if (!gate.safe) {
    return { response: opaqueUpdate(editLabel, timer, gate.reasons.map((r) => `safety gate: ${r}`)) };
  }
  if (engine.opaqueStickyPre === preHash) {
    // dynamically demoted on this exact preamble — don't pay a doomed
    // boot per keystroke; a preamble edit (or reopen) retries structured
    return { response: opaqueUpdate(editLabel, timer, engine.modeReasons) };
  }
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
      b.galley = null;
      b.units = null;
    }
  }
  timer.lap('boot');

  const oldBlocks = engine.blocks;
  let segs = segmentBody(text.slice(bounds.body.start, bounds.body.end), bounds.body.start);
  segs = expandIncludes(segs, 0);
  const diff = diffBlocks(engine.blocks, segs, () => engine.idSeq++);
  engine.blocks = diff.blocks;
  for (const id of diff.removed) unindexBlock(id);
  const dirtySource = new Set(diff.dirty);
  timer.lap('segment');

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
