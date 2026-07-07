// Shared helpers for the audit tools (farm / fuzz / bench).

/** Wait until the engine has nothing left to do (chain work, rescues). */
export async function drain(eng, timeoutMs = 180_000) {
  const t0 = Date.now();
  for (;;) {
    await eng.bgTask?.catch?.(() => {});
    await (eng.hfTask ?? Promise.resolve())?.catch?.(() => {});
    // rescuePumping: the pump dequeues BEFORE awaiting the compile, so an
    // in-flight async rescue is invisible to rescueQueue.size alone
    const busy =
      eng.pendingChain || eng.bgActive || eng.rescuePumping || (eng.rescueQueue?.size ?? 0) > 0;
    if (!busy) {
      await new Promise((r) => setTimeout(r, 400));
      if (
        !eng.pendingChain &&
        !eng.bgActive &&
        !eng.rescuePumping &&
        (eng.rescueQueue?.size ?? 0) === 0
      )
        return;
    } else {
      await new Promise((r) => setTimeout(r, 100));
    }
    if (Date.now() - t0 > timeoutMs) {
      throw new Error(
        `drain timeout (pendingChain=${JSON.stringify(eng.pendingChain)} rescues=${eng.rescueQueue?.size})`
      );
    }
  }
}

/**
 * Lineage-independent identity of the whole document state — valid across
 * engines since galley hashes became deterministic (docs/10 §10.5).
 */
export function signature(eng) {
  return eng.blocks.map((b) => `${b.galleyHash}|${b.stateVec}`);
}

/** Deterministic PRNG (mulberry32) so every fuzz run is reproducible. */
export function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function percentile(sorted, p) {
  if (!sorted.length) return 0;
  const i = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[i];
}
