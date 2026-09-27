import { fnv1a } from '../hash.js';
import { instrumentEditRegions } from '../edit-regions.js';

export function adoptGalleyBlock(block, galley, { counters, chunks, headingRe, applyFidelity }) {
  const reusedStaleGalley = !!galley.tdomStale;
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
  block.stateVec = JSON.stringify([
    ...counters.map((c) => galley.state?.[c] ?? 0),
    galley.state?.['tdom@twocolumn'] ?? 0,
    galley.state?.['tdom@columnwidth'] ?? 0,
    galley.state?.['tdom@pd'] ?? 0,
    galley.state?.['tdom@nobreak'] ?? 0,
    galley.state?.['tdom@ls'] ?? 0,
  ]);
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
  block.units = null;
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
