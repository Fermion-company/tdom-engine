/**
 * Anchor lineage on a stale base (docs/08 §8.2c).
 *
 * While an author keeps typing, no canonical compile is ever the exact
 * compile of the current source revision, so the live anchor path never
 * finds a base and the paper stays at the last Build. A generation that
 * lands for an older revision R is still an exact base for every block
 * that is byte-for-byte what it was at R (the ledger the server kept for R),
 * and for a block edited since R when the server kept that block's resident
 * witness from just before its first edit after R (the pre-edit witness).
 * This builds the lineage the next keystroke continues: untouched blocks
 * join through the ledger, prepared blocks continue from their witness and
 * the plan repaints every line changed since R.
 */
export function buildStaleBaseLineage({ certificate, ledger, witnesses, srcRev, documentEpoch }) {
  if (!certificate?.id || !(ledger instanceof Map) || !Number.isInteger(certificate.rev)) return null;
  if (!Number.isInteger(srcRev) || srcRev <= certificate.rev) return null;
  const blocks = new Map();
  const skipped = [];
  const seen = new Set();
  const ordered = [...(Array.isArray(witnesses) ? witnesses : [])]
    .filter((w) => w && Number.isInteger(w.srcRev) && w.srcRev > certificate.rev && w.srcRev <= srcRev)
    .sort((a, b) => a.srcRev - b.srcRev);
  for (const witness of ordered) {
    const blockId = witness.blockId ?? witness.snapshot?.blockId;
    if (!blockId || seen.has(blockId)) continue;
    seen.add(blockId); // only the first edit after R saw the block as R typeset it
    const snapshot = witness.snapshot;
    const entry = ledger.get(String(blockId));
    const admitted = Boolean(snapshot) && witness.documentEpoch === documentEpoch &&
      Boolean(entry) && entry.structuralStateVec !== null &&
      entry.hash === (snapshot.blockHash ?? null) &&
      entry.galleyHash === (snapshot.galleyHash ?? null) &&
      entry.structuralStateVec === snapshot.structuralStateVec;
    if (!admitted) {
      skipped.push({ blockId, reason: !snapshot ? 'no-witness' : !entry ? 'not-in-ledger'
        : entry.structuralStateVec === null ? 'cold-at-base' : witness.documentEpoch !== documentEpoch ? 'epoch' : 'witness-mismatch' });
      continue;
    }
    blocks.set(blockId, {
      baseSnapshot: { ...snapshot, certificate: { ...certificate } },
      changedLines: [],
      pages: null,
      visualCut: false,
    });
  }
  return {
    blockId: null,
    baseGeneration: certificate.id,
    baseRev: certificate.rev,
    lastSrcRev: srcRev,
    baseSnapshot: null,
    changedLines: [],
    ledger,
    blocks,
    stale: { baseRev: certificate.rev, srcRev, prepared: [...blocks.keys()], skipped },
  };
}

/** Insert into a bounded insertion-ordered ring. */
export function ringSet(ring, key, value, max = 64) {
  ring.delete(key);
  ring.set(key, value);
  while (ring.size > max) ring.delete(ring.keys().next().value);
  return ring;
}
