import { buildPages } from './pagebuilder.js';
import { buildStream } from './stream.js';
import { sameUnitSeq } from './util/galley.js';

export const EMPTY_UNITS = [];

export function paginateNow({ blocks, geometry, chunks, fidelityEpoch, pageRun }) {
  rebuildUnits(blocks, chunks, fidelityEpoch);
  const prev = pageRun;
  const seq = blocks.map((b) => b.units ?? EMPTY_UNITS);
  // memo: repeated paginations inside one update (toc pass, offset
  // check, async repaints) are free when no block's units changed
  if (prev && prev.geoRef === geometry && sameUnitSeq(prev.seq, seq)) {
    return { pages: prev.pages, pageRun: prev };
  }
  const stream = [];
  const offsets = new Array(seq.length);
  for (let i = 0; i < seq.length; i++) {
    offsets[i] = stream.length;
    const u = seq[i];
    for (let j = 0; j < u.length; j++) stream.push(u[j]);
  }
  let incr = null;
  if (prev && prev.geoRef === geometry) {
    // common prefix/suffix of the per-block unit arrays: the builder
    // resumes before the first divergence and resyncs in the suffix
    const old = prev.seq;
    let p = 0;
    while (p < old.length && p < seq.length && old[p] === seq[p]) p++;
    let s = 0;
    while (s < old.length - p && s < seq.length - p && old[old.length - 1 - s] === seq[seq.length - 1 - s]) s++;
    const dirtyFromSi = p < offsets.length ? offsets[p] : stream.length;
    const suffixStartNew = seq.length - s < offsets.length ? offsets[seq.length - s] : stream.length;
    const suffixStartOld =
      old.length - s < prev.offsets.length ? prev.offsets[old.length - s] : prev.streamLen;
    incr = {
      prevRun: prev.run,
      dirtyFromSi,
      suffixStartNew,
      suffixShift: suffixStartNew - suffixStartOld,
    };
  }
  const pages = buildPages(stream, geometry, incr);
  return {
    pages,
    pageRun: {
      geoRef: geometry,
      seq,
      offsets,
      streamLen: stream.length,
      run: pages.__run,
      pages,
    },
  };
}

export function rebuildUnits(blocks, chunks, fidelityEpoch) {
  for (const block of blocks) {
    // the sig carries chunk VERSION and FRESHNESS (stale chunks are
    // displayed too — see buildStream — so a stale→fresh flip must
    // rebuild) plus the fidelity epoch (font-tier demotions)
    const chunkSig = (key) => {
      const c = chunks.get(key);
      return c ? `${c.v}${c.forGalley === block.galleyHash ? 'F' : 'S'}` : '0';
    };
    const floatVs = (block.galley?.floats ?? [])
      .map((f) => chunkSig(block.id + '#' + f.n))
      .join(',');
    const insVs = (block.galley?.items ?? [])
      .filter((it) => it.k === 'ins')
      .map((_, k) => chunkSig(`${block.id}@fn${k}`))
      .join(',');
    const sig = `${block.galleyHash}|${chunkSig(block.id)}|${floatVs}|${insVs}|${fidelityEpoch}`;
    if (!block.units || block.unitsSig !== sig) {
      block.units = buildStream(block, chunks);
      block.unitsSig = sig;
    }
  }
}
