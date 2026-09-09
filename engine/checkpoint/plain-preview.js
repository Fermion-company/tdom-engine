import { classifyResidentEdit } from './resident-edit-admission.js';
import { SAFE_GLYPH } from './fidelity.js';

const empty = value => value == null || (Array.isArray(value) && value.length === 0);

// A stable visual boundary permits an earlier preview, not suffix authority.
// TeX hooks can mutate state absent from the report, so verification remains
// mandatory and runs through the existing interruptible settle pass.
export function plainPreviewWitness(block) {
  const g = block?.galley;
  if (!g || g.closure !== 'native' || g.tdomSourceCatcodesSafe !== true ||
      block.closure?.native !== true || block.closure?.closed !== true ||
      block.nativeClosureRequired !== true || block.fidelity?.level !== SAFE_GLYPH ||
      block.needsRender || block.gfx || block.rescued || g.gfx ||
      g.tdomFrozen || g.tdomStale || g.tdomDeferred || g.tdomPendingPaint || g.tdomIsoChunks ||
      !Array.isArray(g.items) || !g.state || typeof block.stateVec !== 'string' ||
      ![g.floats, g.events, g.labels, g.refs, g.toclines].every(empty)) return null;
  const layout = [];
  let glyphs = false;
  for (const it of g.items) {
    let values;
    if (it.k === 'box') {
      if (!empty(it.fm) || it.chunk != null || it.full || it.x || it.xb || !Array.isArray(it.runs)) return null;
      glyphs ||= it.runs.some(run => !run.rule && !!run.t);
      values = [it.w, it.h, it.d];
    } else if (it.k === 'glue') values = [it.a, it.st, it.sto, it.sh, it.sho, it.sub];
    else if (it.k === 'kern') values = [it.a];
    else if (it.k === 'pen') values = [it.v];
    else return null;
    values = values.map(v => v ?? 0);
    if (!values.every(v => typeof v === 'number' && Number.isFinite(v))) return null;
    layout.push([it.k, ...values]);
  }
  if (!glyphs || ![g.w, g.h, g.d].every(Number.isFinite)) return null;
  return JSON.stringify([block.stateVec, g.state, g.w, g.h, g.d, layout]);
}

export function classifyPlainPreviewEdit(engine, options) {
  if (engine.previewPolicy !== 'structured') return null;
  const pending = engine.pendingChain;
  const id = options.dirtySource.size === 1 ? [...options.dirtySource][0] : null;
  const idx = engine.blocks.findIndex(b => b.id === id);
  // Scope this latency path to prose immediately before exact graphics.
  if (idx < 0 || !engine.blocks[idx + 1]?.gfx) return null;
  if (pending && (pending.kind !== 'settle' || pending.phase !== 'blocks' ||
      pending.plainBlockId !== id || pending.from <= idx || pending.labels.size)) return null;
  const admitted = classifyResidentEdit({ ...engine, pendingChain: null }, options);
  if (admitted.kind !== 'probe') return null;
  const old = options.oldBlocks.find(b => b.id === id);
  const witness = plainPreviewWitness(old);
  return witness ? { blockId: id, witness, galley: old.galley, stateVec: old.stateVec } : null;
}

export function canDeferPlainVerification(admission, before, block) {
  return !!admission && admission.blockId === block.id && before === admission.witness &&
    plainPreviewWitness(block) === admission.witness;
}
