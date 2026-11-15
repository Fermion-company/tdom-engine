import { classifyResidentEdit } from './resident-edit-admission.js';
import { SAFE_GLYPH } from './fidelity.js';
import { discoverEditRegions } from '../edit-regions.js';

// What a keystroke of prose never contains: anything TeX reads as syntax.
const PROSE_BARRIER = /[\\$%{}&#^_~\r\n]/;
// A neighbour is worth keeping off the response path from this cost on (ms
// of its own typesetting; exact graphics always are). This bounds only the
// preview that is painted without waiting for TeX (classifyResidentEdit's
// probe). A prose keystroke defers whatever the neighbour costs: typesetting
// it again is one more job on the response path, and a job is never cheap
// (fork, harvest and transfer cost as much as the paragraph itself). A plain
// article of three-line paragraphs answered in 35.5 ms with the neighbour
// verified first and in 23.2 ms without (median of 27 keystrokes).
const HEAVY_NEIGHBOUR_MS = 6;

/**
 * Whether `block` differs from `oldBlock` by one stretch of ordinary
 * characters typed into (or deleted from) printed prose: the stretch lies
 * inside one text region of the direct-edit analysis (edit-regions.js: spans
 * that can be replaced without touching the surrounding LaTeX syntax), and
 * every region of the paragraph is otherwise where and what it was. Unlike
 * classifyResidentEdit this needs no edit context, so it also holds for a
 * paragraph of an included file and for one that carries commands elsewhere.
 * Returns the characters that came and went, or null.
 */
export function proseKeystroke(oldBlock, block) {
  const before = oldBlock?.text;
  const after = block?.text;
  if (typeof before !== 'string' || typeof after !== 'string' || before === after) return null;
  const limit = Math.min(before.length, after.length);
  let prefix = 0;
  while (prefix < limit && before.charCodeAt(prefix) === after.charCodeAt(prefix)) prefix++;
  let suffix = 0;
  while (suffix < limit - prefix &&
      before.charCodeAt(before.length - 1 - suffix) === after.charCodeAt(after.length - 1 - suffix)) suffix++;
  const removedEnd = before.length - suffix;
  const removed = before.slice(prefix, removedEnd);
  const inserted = after.slice(prefix, after.length - suffix);
  if (PROSE_BARRIER.test(removed) || PROSE_BARRIER.test(inserted)) return null;
  const delta = after.length - before.length;
  const oldRegions = discoverEditRegions(before);
  const regions = discoverEditRegions(after);
  if (oldRegions.length !== regions.length) return null;
  let held = false;
  for (let i = 0; i < regions.length; i++) {
    const was = oldRegions[i];
    const now = regions[i];
    if (was.kind !== now.kind) return null;
    if (was.contentEnd < prefix) {
      // wholly before the change
      if (was.contentStart !== now.contentStart || was.contentEnd !== now.contentEnd || was.value !== now.value) return null;
    } else if (was.contentStart > removedEnd) {
      // wholly after it
      if (was.contentStart + delta !== now.contentStart || was.contentEnd + delta !== now.contentEnd ||
          was.value !== now.value) return null;
    } else {
      // the one region the change is in
      // (not at its very first character: a command in front of the region
      // may be reading that character as its argument)
      if (held || was.kind !== 'text' || was.contentStart >= prefix || was.contentEnd < removedEnd ||
          was.contentStart !== now.contentStart || was.contentEnd + delta !== now.contentEnd) return null;
      held = true;
    }
  }
  return held ? { inserted, removed } : null;
}

// An ordinary-looking character that is active where the block starts (a
// babel shorthand, a document's own \\catcode 13) runs a macro when typed.
const touchesActive = (active, text) => {
  if (!active || !text) return false;
  if (active === '?') return true;
  for (const char of text) if (active.includes(char)) return true;
  return false;
};


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
      g.tdomFrozen || g.tdomStale || g.tdomDeferred || g.tdomPendingPaint || g.tdomIsoChunks || g.tdomColdPreview ||
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

// The witness of a prose keystroke. It grants no paint of its own (the
// paragraph is shown the way it always is: glyphs, or its exact pixels when
// they land), only that the block after it need not be typeset again before
// the keystroke is answered. For that the paragraph has to leave TeX as it
// did before: the same exit state, and the same boxes, glue and penalties
// handed to the page, whatever is inside the boxes. So it also holds for a
// paragraph with commands and with lines that need exact pixels.
export function proseBoundaryWitness(block) {
  const g = block?.galley;
  if (!g || g.closure !== 'native' || block.closure?.native !== true || block.closure?.closed !== true ||
      block.nativeClosureRequired !== true || block.gfx || block.rescued || g.gfx ||
      g.tdomFrozen || g.tdomStale || g.tdomDeferred || g.tdomIsoChunks || g.tdomColdPreview ||
      !Array.isArray(g.items) || !g.state || typeof block.stateVec !== 'string' ||
      ![g.floats, g.events, g.labels, g.toclines].every(empty)) return null;
  const layout = [];
  for (const it of g.items) {
    let values;
    if (it.k === 'box') {
      if (!empty(it.fm)) return null;
      values = [it.w, it.h, it.d];
    } else if (it.k === 'glue') values = [it.a, it.st, it.sto, it.sh, it.sho, it.sub];
    else if (it.k === 'kern') values = [it.a];
    else if (it.k === 'pen') values = [it.v];
    else return null;
    values = values.map(v => v ?? 0);
    if (!values.every(v => typeof v === 'number' && Number.isFinite(v))) return null;
    layout.push([it.k, ...values]);
  }
  if (![g.w, g.h, g.d].every(Number.isFinite)) return null;
  return JSON.stringify(['prose', block.stateVec, g.state, g.w, g.h, g.d, layout]);
}

// TDOM_TRACE_PLAIN=1: why a keystroke was or was not answered before its
// neighbour was typeset again.
const tracePlain = process.env.TDOM_TRACE_PLAIN
  ? (why, detail = '') => { console.error('[plain]', why, detail); return null; }
  : () => null;

export function classifyPlainPreviewEdit(engine, options) {
  if (engine.previewPolicy !== 'structured') return tracePlain('policy', engine.previewPolicy);
  // (grid materialization is no pending verification: any other chain work
  // replaces it, engine #queueChainWork. Counted as one, it kept every
  // keystroke after a reflow on the slow path for as long as the typing
  // lasted, because the pass yields to each keystroke and stays queued.)
  const pending = engine.pendingChain?.kind === 'grid' ? null : engine.pendingChain;
  const id = options.dirtySource.size === 1 ? [...options.dirtySource][0] : null;
  const idx = engine.blocks.findIndex(b => b.id === id);
  const next = engine.blocks[idx + 1];
  if (idx < 0) return tracePlain('not-one-block', `${options.dirtySource.size} dirty`);
  if (!next) return tracePlain('last-block');
  if (pending && (pending.kind !== 'settle' || pending.phase !== 'blocks' ||
      pending.plainBlockId !== id || pending.from <= idx || pending.labels.size)) {
    return tracePlain('pending', `${pending.kind}/${pending.phase} from ${pending.from} plain ${pending.plainBlockId} labels ${pending.labels?.size}`);
  }
  const old = options.oldBlocks.find(b => b.id === id);
  const admitted = classifyResidentEdit({ ...engine, pendingChain: null }, options);
  // The probe's path stays scoped to a neighbour that is slow to typeset
  // again: exact graphics, or a block whose own typesetting was measured
  // heavy (a 35 ms box after the paragraph cost every keystroke in that
  // paragraph 35 ms of verification before anything was shown). Before any
  // other neighbour the same edit is judged as a prose keystroke.
  const probe = admitted.kind === 'probe' && (next.gfx || Number(next.typesetCostMs) >= HEAVY_NEIGHBOUR_MS);
  const prose = probe || options.rebooted ? null : proseKeystroke(old, engine.blocks[idx]);
  if (!probe && !prose) return tracePlain('not-prose', admitted.kind);
  if (prose && (touchesActive(old?.galley?.tdomActive, prose.removed) || touchesActive(old?.galley?.tdomActive, prose.inserted))) {
    return tracePlain('active-character');
  }
  const witness = prose ? proseBoundaryWitness(old) : plainPreviewWitness(old);
  if (!witness) return tracePlain('no-witness', prose ? 'prose' : 'plain');
  tracePlain('admitted', prose ? 'prose' : 'probe');
  return { blockId: id, witness, galley: old.galley, stateVec: old.stateVec, prose };
}

export function canDeferPlainVerification(admission, before, block) {
  if (!admission || admission.blockId !== block.id || before !== admission.witness) {
    if (admission) tracePlain('witness-before', admission.blockId !== block.id ? 'other block' : 'changed since admission');
    return false;
  }
  // the block as just typeset says which of its characters are active
  if (admission.prose && touchesActive(block.galley?.tdomActive, admission.prose.inserted)) {
    tracePlain('active-after');
    return false;
  }
  const same = (admission.prose ? proseBoundaryWitness(block) : plainPreviewWitness(block)) === admission.witness;
  if (!same) tracePlain('witness-after', 'the paragraph left TeX differently');
  return same;
}
