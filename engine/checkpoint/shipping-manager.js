import path from 'node:path';
import { ShippingChain } from './shipping.js';

export function makeShippingChain(engine, queueShipBoot) {
  const chain = new ShippingChain({
    workDir: path.join(engine.workDir, 'ship'),
    docDir: engine.docDir,
  });
  chain.onPaged = ({ page, gen }) => {
    if (engine.shipStale || chain !== engine.shipping) return;
    engine.onShipPage?.({ page, gen, srcRev: engine.shipGenRev.get(gen) ?? 0 });
  };
  chain.onLabel = ({ key, val }) => {
    const known = engine.labelTable.get(key);
    const seeded = engine.shipLabelOverrides.get(key) ?? known;
    if (seeded !== undefined && String(seeded) !== String(val) && !engine.shipStale) {
      // backward effect: a label value the seeds promised has moved —
      // EARLIER pages may print stale numbers. Record the SHIP-observed
      // truth and reboot with corrected seeds (bounded: a divergence the
      // reseed cannot absorb must not loop). Until then the cold
      // canonical owns the display truth.
      engine.shipStale = true;
      engine.shipLabelOverrides.set(key, val);
      engine.diagnostics.push(`shipping: label ${key} diverged (${seeded} -> ${val}) — reseeding`);
      queueShipBoot();
    } else if (seeded === undefined) {
      engine.shipLabelOverrides.set(key, val);
    }
  };
  return chain;
}

export function queueShipBoot(engine, bootShipping) {
  if (!engine.shipping || engine.shipBootTimer) return;
  if (engine.shipBootTries >= 3) return; // stays cold-covered; a preamble
  // edit resets the budget (a genuinely divergent doc must not loop)
  const arm = () => {
    engine.shipBootTimer = setTimeout(() => {
      engine.shipBootTimer = null;
      // a stale-but-running run is a TRUTH HARVESTER: every divergent
      // label it reports lands in shipLabelOverrides, so ONE reboot with
      // the complete truth converges. Killing it at the first divergence
      // would relearn one label per boot and exhaust the budget.
      if (engine.shipping && !engine.shipping.done && engine.shipping.rootPeer?.alive && !engine.shipping.err) {
        arm();
        return;
      }
      bootShipping().catch(() => {});
    }, 800);
    engine.shipBootTimer.unref?.();
  };
  arm();
}

/** Hot-path hook: cheap (a unit diff + one socket line). */
export function shipUpdate(engine, text, queueShipBoot) {
  if (!engine.shipping || engine.mode !== 'structured') return;
  if (engine.shipBooting) return; // boot-end convergence will catch up
  if (
    engine.shipping.err?.message?.startsWith('pdf-opened-at-root') &&
    engine.shipBootedFor === engine.preHash &&
    engine.shipDisabledFor !== engine.preHash
  ) {
    // hyperref-class document: the per-page lazy-open scheme cannot work;
    // the cold canonical owns the display. Disabled PER PREAMBLE — a
    // preamble edit (or another document) gets a fresh chance.
    engine.shipDisabledFor = engine.preHash;
    engine.diagnostics.push('shipping disabled for this preamble: ' + engine.shipping.err.message);
  }
  if (engine.shipDisabledFor === engine.preHash) return;
  if (engine.shipBootedFor !== engine.preHash || engine.shipStale || engine.shipping.err) {
    queueShipBoot();
    return;
  }
  const r = engine.shipping.resume(text);
  if (r.mode === 'resumed') {
    engine.shipGenRev.set(engine.shipping.gen, engine.srcRev);
  } else if (r.mode === 'unchanged') {
    engine.shipGenRev.set(engine.shipping.gen, engine.srcRev);
  } else if (r.mode === 'reboot-needed') {
    queueShipBoot();
  }
}
