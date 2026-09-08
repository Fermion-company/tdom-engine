/**
 * Reserve the first post-edit window for the complete replay PDF.  The
 * checkpoint chain, cold block renders and header work remain behind this
 * window. The current foreground's exact-render cohort has its own short
 * debounce because its complete pixels can satisfy direct editing sooner.
 *
 * The guard is intentionally a little longer than the wave cutoff: the
 * browser still needs a small interval to strict-open the PDF and render
 * the visible pages before the atomic switch.  Documents without a live,
 * validated shipping baseline retain their existing fallback cadence.
 */
export function shippingPriorityQuietMs(engine, fallbackMs = 0) {
  const fallback = finiteNonNegative(fallbackMs, 0);
  const chain = engine?.shipping;
  const baselineReady = chain?.baselineReady === true ||
    (chain?.baselinePages !== undefined && chain.baselinePages !== null);
  const eligible =
    engine?.mode === 'structured' &&
    chain &&
    baselineReady &&
    !chain.disposed &&
    engine.shipDisabledFor !== engine.preHash;
  if (!eligible) return fallback;

  const cutoff = finiteNonNegative(process.env.TDOM_SHIP_WAVE_CUTOFF, 700);
  const configured = process.env.TDOM_SHIP_PRIORITY_QUIET_MS;
  const defaultPriority = Math.max(900, cutoff + 50);
  const priority = configured == null
    ? defaultPriority
    : finiteNonNegative(configured, defaultPriority);
  return Math.max(fallback, priority);
}

function finiteNonNegative(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}
