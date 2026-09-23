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

function readGroup(text, at) {
  while (at < text.length && /\s/.test(text[at])) at++;
  if (text[at] !== '{') return null;
  let depth = 0;
  for (let i = at; i < text.length; i++) {
    const c = text[i];
    if (c === '\\') { i++; continue; }
    if (c === '{') depth++;
    else if (c === '}' && --depth === 0) return { value: text.slice(at + 1, i), end: i + 1 };
  }
  return null;
}

/**
 * Every value a canonical aux writes for each label, in write order.
 * beamer writes the same overlay label once per slide it is active on and
 * again for each \againframe (tex64-internal #76). Such a label has no
 * single promised value mid-run: TeX consumed the last one, while a replay
 * reports each definition as it happens.
 */
export function auxLabelValues(aux) {
  const values = new Map();
  const text = String(aux ?? '');
  const re = /\\newlabel\s*(?=\{)/g;
  let m;
  while ((m = re.exec(text))) {
    const key = readGroup(text, re.lastIndex);
    const record = key ? readGroup(text, key.end) : null;
    const first = record ? readGroup(record.value, 0) : null;
    if (!first) continue;
    const list = values.get(key.value) ?? [];
    list.push(first.value);
    values.set(key.value, list);
    re.lastIndex = record.end;
  }
  return values;
}
