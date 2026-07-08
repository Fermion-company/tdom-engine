export function shippingLabelSeed(pages, blockLabelIdx, labelTable, shipLabelOverrides) {
  const blockPage = new Map();
  for (const page of pages) {
    for (const d of page.draw ?? []) {
      const bid = d.u?.blockId;
      if (bid && !blockPage.has(bid)) blockPage.set(bid, page.number);
    }
  }
  const labelPage = new Map();
  for (const [bid, keys] of blockLabelIdx) {
    for (const k of keys) {
      if (!labelPage.has(k)) labelPage.set(k, blockPage.get(bid) ?? 1);
    }
  }
  const labelSeed = [...labelTable].map(([k, v]) => [
    k,
    [shipLabelOverrides.get(k) ?? v, labelPage.get(k) ?? 1],
  ]);
  for (const [k, v] of shipLabelOverrides) {
    if (!labelTable.has(k)) labelSeed.push([k, [v, labelPage.get(k) ?? 1]]);
  }
  return labelSeed;
}
