/**
 * Chunk pages the RENDER protocol ships for one block: page 1 = the
 * galley (needed when ANY line requires exact pixels), 2..1+F = float
 * boxes in order, 2+F..1+F+N = footnote insert bodies in order — the
 * same page map the daemon's tdom_ship/tdom_ship_floats produce.
 * Rescued blocks carry their own print-identical chunks and never
 * appear here (needsRender is false).
 */
export function chunkTargets(block) {
  const galley = block.galley;
  if (!galley) return [];
  const fid = block.fidelity;
  const targets = [];
  if (block.gfx || fid?.blockExact || (fid?.exactLines ?? 0) > 0) {
    targets.push({ key: block.id, page: 1, w: galley.w, h: galley.h + galley.d });
  }
  const floats = galley.floats ?? [];
  floats.forEach((f, i) => {
    if (f.gfx || fid?.floats?.get(f.n)?.exact) {
      targets.push({ key: block.id + '#' + f.n, page: 2 + i, w: f.w, h: (f.h ?? 0) + (f.d ?? 0) });
    }
  });
  let k = 0;
  for (const it of galley.items ?? []) {
    if (it.k !== 'ins') continue;
    if (fid?.ins?.get(k)?.exact) {
      let w = 0;
      for (const sub of it.items ?? []) {
        if (sub.k === 'box' && (sub.w ?? 0) > w) w = sub.w;
      }
      targets.push({
        key: `${block.id}@fn${k}`,
        page: 2 + floats.length + k,
        w: w || galley.w || 1,
        h: it.hc ?? (it.h ?? 0) + (it.d ?? 0),
      });
    }
    k++;
  }
  return targets;
}
