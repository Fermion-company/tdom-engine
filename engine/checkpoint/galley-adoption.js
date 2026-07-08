import { fnv1a } from '../hash.js';

export function adoptGalleyBlock(block, galley, { counters, chunks, headingRe, applyFidelity }) {
  block.galley = galley;
  block.galleyHash = fnv1a(
    JSON.stringify([galley.items, galley.floats, galley.w, galley.h, galley.d, galley.events])
  );
  if (galley.tdomIsoChunks) {
    // rescued block: the isolated run's print-identical pixels are the
    // chunks — registered here so forGalley matches the adopted hash
    for (const c of galley.tdomIsoChunks) {
      const prev = chunks.get(c.key);
      chunks.set(c.key, {
        svg: c.svg,
        wBp: c.wBp,
        hBp: c.hBp,
        v: (prev?.v ?? 0) + 1,
        forGalley: block.galleyHash,
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
  // exit state = tracked counters + cross-block layout state (prevdepth,
  // \if@nobreak) — any change forces the convergence chain onward
  block.stateVec = JSON.stringify([
    ...counters.map((c) => galley.state?.[c] ?? 0),
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
}
