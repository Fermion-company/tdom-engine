import { fnv1a } from '../hash.js';
import { instrumentEditRegions } from '../edit-regions.js';

export function adoptGalleyBlock(block, galley, { counters, chunks, headingRe, applyFidelity }) {
  const reusedStaleGalley = !!galley.tdomStale;
  block.galley = galley;
  const identity = [galley.items, galley.floats, galley.w, galley.h, galley.d, galley.events];
  // PDF literals/resources are not glyph runs: changing only a gradient or
  // underlay must invalidate its exact chunk even when every box is identical.
  if (galley.gfx) {
    if (!reusedStaleGalley) galley.tdomPaintSourceHash = block.hash;
    identity.push(galley.tdomPaintSourceHash);
  }
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
