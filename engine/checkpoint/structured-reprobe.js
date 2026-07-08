export function scheduleStructuredReprobe(engine, preHash, update) {
  if (engine.reprobedPre === preHash) return; // one shot per preamble
  engine.reprobedPre = preHash;
  const t = setTimeout(() => {
    if (engine.closed || engine.mode !== 'opaque') return;
    if (engine.opaqueStickyPre !== preHash) return; // preamble moved on
    engine.diagnostics.push('opaque self-heal: re-probing the structured boot');
    engine.opaqueStickyPre = null;
    update({ editLabel: 'structured-reprobe' }).catch(() => {});
  }, Number(process.env.TDOM_REPROBE_MS || 20_000));
  t.unref?.(); // never keep the process alive for a reprobe
}
