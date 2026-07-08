export function canonicalCropMetrics(geo) {
  return {
    top: 72 + (geo.topmargin ?? 0) + (geo.headheight ?? 0) + (geo.headsep ?? 0),
    left: 72 + (geo.oddsidemargin ?? 0),
  };
}

export function canonicalBlockBands(pages, topOffset) {
  // block -> its vertical band, only when the block sits on ONE page
  // (page-spanning galleys cannot be one chunk box)
  const bands = new Map();
  for (const page of pages) {
    for (const d of page.draw ?? []) {
      const bid = d.u?.blockId;
      if (!bid) continue;
      const top = topOffset + d.y - (d.u.ln?.boxH ?? d.u.h ?? 0);
      const cur = bands.get(bid);
      if (!cur) bands.set(bid, { page: page.number, top });
      else if (cur.page !== page.number) cur.split = true;
      else cur.top = Math.min(cur.top, top);
    }
  }
  return bands;
}

export function leadingGalleySkip(galley) {
  // chunk coordinates start at the galley TOP (leading glue included in
  // the shipped vpack) — rewind the first drawn box by the leading skips
  let lead = 0;
  for (const it of galley.items ?? []) {
    if (it.k === 'box') break;
    if (it.k === 'glue' || it.k === 'kern') lead += it.a ?? 0;
  }
  return lead;
}
