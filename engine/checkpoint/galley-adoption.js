import { fnv1a } from '../hash.js';
import { instrumentEditRegions } from '../edit-regions.js';
import { synthChunkKey } from './exact-synth.js';

// A block's units (units.js: what the page builder lays out, the identity
// of every page they stand on) were thrown away whenever a galley was
// adopted, also when it was the galley they were made from: a walk that
// typesets blocks again to rebuild checkpoints, or to verify a keystroke,
// gets the same boxes back. The next pagination then saw other units in
// every such block and built their pages again: after the background walk
// that follows a keystroke, the first key of the next burst paginated 92
// pages of a 191-page single file and built their display lists (167 ms in
// the engine; the keys after it take 1 ms), 184 pages on the first key
// after opening.
// The units are kept when everything stream.js makes them from is what it
// was: the same galley by its hash, the same fidelity, the same pictures to
// draw from. TDOM_REBUILD_UNITS_ALWAYS=1: thrown away on every adoption.
const KEEP_UNITS = !process.env.TDOM_REBUILD_UNITS_ALWAYS;
const fidelityText = (fidelity) => JSON.stringify(fidelity, (_key, value) => (value instanceof Map ? [...value] : value));
function unitsStillHold(was, block, galley, chunks) {
  if (!KEEP_UNITS || was.hash == null || was.hash !== block.galleyHash) return false;
  if (was.rescued !== block.rescued || was.gfx !== block.gfx || was.needsRender !== block.needsRender) return false;
  const prev = was.galley;
  // (the backend is a record of the job's own: by what it says)
  if (!prev || galley.tdomPendingPaint || prev.tdomPendingPaint || galley.tdomColdPreview || prev.tdomColdPreview ||
      (galley.backend !== prev.backend && JSON.stringify(galley.backend ?? null) !== JSON.stringify(prev.backend ?? null))) return false;
  const picture = chunks?.get(block.id);
  // (a block whose pixels are behind is laid out from an earlier galley, or
  // put together from it: stream.js decides that anew each time)
  if (block.needsRender && !block.rescued && picture && picture.forGalley !== block.galleyHash) return false;
  if (chunks?.has(synthChunkKey(block.id))) return false;
  if (was.fidelity !== block.fidelity && fidelityText(was.fidelity) !== fidelityText(block.fidelity)) return false;
  // (what buildStream does first for a block whose own pixels are in)
  if (picture?.forGalley === block.galleyHash && block.exactHistory) block.exactHistory = null;
  return true;
}

/** The exit state a block records for a galley (the stateVec layout in util/galley.js). */
export function exitStateVec(galley, counters) {
  return JSON.stringify([
    ...counters.map((c) => galley.state?.[c] ?? 0),
    galley.state?.['tdom@twocolumn'] ?? 0,
    galley.state?.['tdom@columnwidth'] ?? 0,
    galley.state?.['tdom@pd'] ?? 0,
    galley.state?.['tdom@nobreak'] ?? 0,
    galley.state?.['tdom@ls'] ?? 0,
  ]);
}

export function adoptGalleyBlock(block, galley, { counters, chunks, headingRe, applyFidelity }) {
  const reusedStaleGalley = !!galley.tdomStale;
  // (a rescue's own chunks, or a galley carried over stale, are laid out anew)
  const was = block.units && !reusedStaleGalley && !galley.tdomIsoChunks
    ? { units: block.units, hash: block.galleyHash, galley: block.galley, fidelity: block.fidelity,
      rescued: block.rescued, gfx: block.gfx, needsRender: block.needsRender }
    : null;
  holdExactGalley(block, galley, chunks);
  block.galley = galley;
  const identity = [galley.items, galley.floats, galley.w, galley.h, galley.d, galley.events];
  // PDF literals/resources are not glyph runs: changing only a gradient or
  // underlay must invalidate its exact chunk even when every box is identical.
  if (galley.gfx) {
    if (!reusedStaleGalley) galley.tdomPaintSourceHash = block.hash;
    identity.push(galley.tdomPaintSourceHash);
  }
  // A cold preview (docs/10 §10.4b) paints graphics from another lineage's
  // state (a \tcbset between its checkpoint and the block): the galley that
  // replaces it must not keep those pixels. Glyph and math chunks carry on.
  if (galley.gfx && galley.tdomColdPreview) identity.push('cold-preview');
  block.galleyHash = fnv1a(JSON.stringify(identity));
  if (galley.tdomIsoChunks) {
    // Isolated rescue bypasses buildJobBlockBody, which normally records
    // editable source spans. Its real PDF still contains editable prose
    // and math (for example the paragraph immediately before a new page).
    block.editRegions = instrumentEditRegions(block.text).regions;
    // rescued block: the isolated run's print-identical pixels are the
    // chunks — registered here so forGalley matches the adopted hash
    for (const c of galley.tdomIsoChunks) {
      const prev = chunks.get(c.key);
      // A rescue re-adopted with the pixels it already had (the walk that
      // verifies a keystroke passes over the code box after the paragraph
      // and takes its result from the cache) is the same chunk, not a new
      // version of it: a new version made the viewer fetch and decode the
      // picture again on every keystroke (202 KB for one box), and the
      // server read its glyph positions from the PDF again.
      if (prev && prev.svg === c.svg && prev.wBp === c.wBp && prev.logicalWBp === c.logicalWBp &&
          prev.xBp === c.xBp && prev.hBp === c.hBp && prev.editPdf === c.editPdf && prev.editPage === c.editPage &&
          prev.editX === c.editX && prev.editY === c.editY) {
        prev.forGalley = block.galleyHash;
        continue;
      }
      chunks.set(c.key, {
        svg: c.svg,
        wBp: c.wBp,
        logicalWBp: c.logicalWBp,
        xBp: c.xBp,
        hBp: c.hBp,
        v: (prev?.v ?? 0) + 1,
        forGalley: block.galleyHash,
        editPdf: c.editPdf,
        editPage: c.editPage,
        editX: c.editX,
        editY: c.editY,
      });
    }
    delete galley.tdomIsoChunks;
    block.rescued = true;
  } else if (galley.tdomStale) {
    // stale-first rescue: the previous (rescued) galley is being reused
    // verbatim — its chunks are already registered under the same hash
    delete galley.tdomStale;
    block.rescued = true;
  } else {
    block.rescued = false;
  }
  // exit state = tracked counters + active column layout + cross-block
  // paragraph state. Column fields deliberately sit BEFORE the final three
  // locals so existing tail readers keep their stable offsets.
  block.stateVec = exitStateVec(galley, counters);
  block.gfx = !!galley.gfx;
  // fonts were registered by #normalizeGalleyFonts BEFORE the fidelity
  // gate reads their tiers
  applyFidelity(block, galley);
  block.consumesToc = /\\(tableofcontents|listoffigures|listoftables)\b/.test(block.text);
  block.kind = headingRe.test(block.text)
    ? 'heading'
    : block.gfx
      ? 'graphics'
      : 'paragraph';
  block.units = was && unitsStillHold(was, block, galley, chunks) ? was.units : null;
  if (!reusedStaleGalley) block.sourceChanged = false;
}

/**
 * The galleys a block painted exactly before its current one (hash ->
 * { galley, fidelity }, newest last). While the current galley's exact pixels are still
 * being rendered, the page lays the block out from the newest of these whose
 * RENDER has landed (stream.js exactFallback): its lines and its pixels agree,
 * only its text is a keystroke or two behind. Without it a box typed into
 * continuously stayed blocked until the typing stopped (tex64-internal #103).
 * Only blocks with a single main chunk (no floats or footnotes, whose chunks
 * are keyed by position) qualify: a box, and a paragraph with inline math; page events and toc lines are read by index
 * from the current galley, so stream.js uses a held galley only while those
 * are identical. A block whose own pixels are fresh drops its history.
 */
export const EXACT_HISTORY = 2;
function holdExactGalley(block, galley, chunks) {
  const prev = block.galley;
  const hash = block.galleyHash;
  if (prev === galley) return;
  if (!prev || !hash) {
    // a reboot dropped the galleys: nothing earlier stands in any more
    block.exactHistory = null;
    return;
  }
  // (its fidelity rides along: per-line exact flags index its own items)
  const entry = { galley: prev, fidelity: block.fidelity };
  if (chunks?.get(block.id)?.forGalley === hash && exactFallbackEligible(prev) && block.needsRender &&
      !block.fidelity?.canonicalOnly) {
    // the previous galley painted: it is the newest one with pixels
    block.exactHistory = new Map([[hash, entry]]);
    return;
  }
  if (!block.exactHistory?.size) return;
  // an unpainted intermediate galley joins only while an older painted one
  // is held: its own early RENDER may still land (engine-v3 #landHeldRender).
  // One that cannot stand in itself (a cold preview) just does not join:
  // the painted one still stands in for the galleys after it.
  if (!exactFallbackEligible(prev)) return;
  block.exactHistory.delete(hash);
  block.exactHistory.set(hash, entry);
  // the painted galley stays; the oldest unpainted one makes room
  const painted = chunks?.get(block.id)?.forGalley;
  while (block.exactHistory.size > EXACT_HISTORY + 1) {
    const oldest = [...block.exactHistory.keys()].find((key) => key !== painted);
    block.exactHistory.delete(oldest);
  }
}

export function exactFallbackEligible(galley) {
  // (not a cold preview: its pixels come from another lineage's state, the
  // rule adoptGalleyBlock's 'cold-preview' identity keeps)
  return !!galley && !galley.tdomColdPreview && !galley.tdomStale && !galley.tdomIsoChunks &&
    !galley.floats?.length && !(galley.items ?? []).some((it) => it.k === 'ins' || it.chunk);
}

/** A held galley stands in for the current one only with the same page
 * events and toc lines (stream.js resolves both by index). */
export function exactFallbackCompatible(held, current) {
  return !!held && !!current &&
    JSON.stringify(held.events ?? []) === JSON.stringify(current.events ?? []) &&
    JSON.stringify(held.toclines ?? []) === JSON.stringify(current.toclines ?? []);
}
