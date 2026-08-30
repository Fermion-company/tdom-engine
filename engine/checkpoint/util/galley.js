import { fnv1a } from '../../hash.js';

/** Stable, lineage-independent identity of one TeX font instance. */
function stableFontKey(meta) {
  return 'F' + fnv1a(`${meta.file || ''}|${meta.name || ''}|${meta.size || 0}`);
}

/** Visit every glyph run in a harvested item tree (boxes, floats, inserts). */
function walkItemRuns(items, fn) {
  if (!items) return;
  for (const it of items) {
    if (it.runs) {
      for (const r of it.runs) fn(r);
    }
    if (it.items) walkItemRuns(it.items, fn);
  }
}

function parseVec(json) {
  try {
    return JSON.parse(json ?? '[]');
  } catch {
    return [];
  }
}

const SP_PER_BP = 65781.76;

/** Full trailing glue spec for a \lastskip primer (dimensions in sp). */
function trailingGlueSpec(galley, widthSp) {
  const fallback = {
    widthSp: Math.round(widthSp ?? 0),
    stretchSp: 0,
    shrinkSp: 0,
    stretchOrder: 0,
    shrinkOrder: 0,
  };
  const tail = galley?.items?.at?.(-1);
  if (!tail || tail.k !== 'glue') return fallback;
  const tailWidthSp = Math.round((tail.a ?? 0) * SP_PER_BP);
  if (Math.abs(tailWidthSp - fallback.widthSp) > 2) return fallback;
  return {
    widthSp: fallback.widthSp,
    stretchSp: Math.round((tail.st ?? 0) * SP_PER_BP),
    shrinkSp: Math.round((tail.sh ?? 0) * SP_PER_BP),
    stretchOrder: tail.sto ?? 0,
    shrinkOrder: tail.sho ?? 0,
  };
}

// stateVec layout:
// [...counters, tdom@twocolumn, tdom@columnwidth, tdom@pd, tdom@nobreak, tdom@ls]
function vecCountersEqual(aJson, bJson) {
  const a = parseVec(aJson);
  const b = parseVec(bJson);
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length - 3; i++) if (a[i] !== b[i]) return false;
  return true;
}

function vecLocalsEqual(aJson, bJson) {
  const a = parseVec(aJson);
  const b = parseVec(bJson);
  if (a.length !== b.length) return false;
  for (let i = Math.max(0, a.length - 3); i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/**
 * True when the block's galley plausibly already reflects the label's
 * current value (cheap check: the rendered text contains the value and no
 * unresolved ?? marker for it).
 */
function resolvedInGalley(block, key, labelTable) {
  // Exact bookkeeping, not text matching: every galley records the label
  // values that were injected when it was typeset (tdomRefVals, from
  // #jobBlock/#isoCompile). The ref is resolved iff the recorded value
  // equals the live one. The old substring-over-rendered-text heuristic
  // false-positived whenever the new value (almost always a small integer)
  // happened to appear ANYWHERE in the block — e.g. a block reading
  // "section 3 … equation (2)" was deemed resolved for an equation label
  // moving 2→3, and kept its stale (2) forever (corpus/06 fuzz seed 1).
  const rv = block.galley?.tdomRefVals;
  if (!rv || !Object.prototype.hasOwnProperty.call(rv, key)) return false;
  return rv[key] === labelTable.get(key);
}

function sameUnitSeq(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function push2(list, kind, key, blockId) {
  let entry = list.find((e) => e.kind === kind && e.key === key);
  if (!entry) {
    entry = { kind, key, affected: [] };
    list.push(entry);
  }
  if (!entry.affected.includes('blk-' + blockId)) entry.affected.push('blk-' + blockId);
}

export {
  walkItemRuns,
  parseVec,
  vecCountersEqual,
  vecLocalsEqual,
  sameUnitSeq,
  push2,
  resolvedInGalley,
  stableFontKey,
  trailingGlueSpec,
};
