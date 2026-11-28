// A completed replay is only a seed for a fresh compile when the aux
// changed solely in the terminal physical count or the page field of a
// known label. Do not import TeX commands, link targets or label values.
export function paginationAuxChange(before, after, from, to) {
  if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to) || from < 1 || to < 1 || from === to ||
      typeof before !== 'string' || typeof after !== 'string' ||
      before.length > 1024 * 1024 || after.length > 1024 * 1024) return false;
  const oldLines = before.split('\n');
  const newLines = after.split('\n');
  if (oldLines.length !== newLines.length) return false;
  const last = oldLines.length - (oldLines.at(-1) === '' ? 2 : 1);
  const end = (pages) => `\\gdef \\@abspage@last{${pages}}`;
  const cr = oldLines[last]?.endsWith('\r') ? '\r' : '';
  if (oldLines[last] !== end(from) + cr || newLines[last] !== end(to) + cr) return false;
  const label = /^(\\newlabel\{[^{}]+\}\{\{[^{}]*\}\{)([1-9]\d*)(\}.*\}\r?)$/;
  for (let i = 0; i < last; i++) {
    if (oldLines[i] === newLines[i]) continue;
    const prior = label.exec(oldLines[i]);
    const next = label.exec(newLines[i]);
    if (!prior || !next || prior[1] !== next[1] || prior[3] !== next[3]) return false;
  }
  return true;
}

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
