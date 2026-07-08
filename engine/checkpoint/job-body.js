import { braceImbalance, labelDefBody, startsAddvspace } from './util/tex.js';

export function buildJobBlockBody({
  block,
  idx,
  blocks,
  ck,
  override,
  labelTable,
  hrefTable,
  geometry,
  volatilePrelude,
}) {
  let body;
  let jobId;
  let refSnapshot = null;
  if (override) {
    // raw job (rescue continuation): caller supplies the exact body
    body = Buffer.from(override.body, 'utf8');
    jobId = override.id;
  } else {
    // Labels are defined in descendant lineages only; when resuming from an
    // ancestor snapshot, forward-referenced values must be injected so this
    // block sees the document-wide truth. A freshly EDITED block has no
    // galley yet (diffBlocks re-minted it), so its refs must come from the
    // new text itself — otherwise editing any \ref-bearing paragraph froze
    // its references at '??' until some label happened to move (found by
    // the Phase-0 fuzzer, corpus/06 seed 7).
    const refKeys = new Set(block.galley?.refs ?? []);
    const REF_USE_RE = /\\(?:ref|eqref|pageref|vref|vpageref|autoref|nameref|cref|Cref)\*?\s*\{([^}]+)\}/g;
    for (const m of block.text.matchAll(REF_USE_RE)) {
      for (const k of m[1].split(',')) refKeys.add(k.trim());
    }
    const CITE_USE_RE = /\\[cC]ite[a-zA-Z]*\*?\s*(?:\[[^\]]*\]\s*)*\{([^}]+)\}/g;
    for (const m of block.text.matchAll(CITE_USE_RE)) {
      for (const k of m[1].split(',')) refKeys.add('cite:' + k.trim());
    }
    // record the exact values injected below: resolvedInGalley compares
    // them against the live table instead of guessing from rendered text
    refSnapshot = {};
    for (const key of refKeys) refSnapshot[key] = labelTable.get(key);
    const defs = [];
    for (const key of refKeys) {
      const val = labelTable.get(key);
      const cs = key.startsWith('cite:') ? `b@${key.slice(5)}` : `r@${key}`;
      if (val === undefined) {
        // vanished label: neutralize stale definitions in this lineage
        defs.push(`\\global\\expandafter\\let\\csname ${cs}\\endcsname\\relax`);
      } else if (key.startsWith('cite:')) {
        defs.push(`\\global\\@namedef{${cs}}{${val}}`);
      } else {
        defs.push(`\\global\\@namedef{${cs}}${labelDefBody(key, val, geometry?.hyperref === 1, hrefTable?.get(key))}`);
      }
    }
    // \lastskip primer: this block is typeset on a freshly-seeded page, so
    // \lastskip is 0 — but in a continuous run the previous block's trailing
    // \addvspace would still be present, and this block's leading \addvspace
    // MAXes against it. Re-establish \lastskip from the previous block's
    // exit tdom@ls (sp) so the merge is exact; the daemon marks the primer
    // and drops it from the harvest (it is already in the previous galley).
    // Prime ONLY when this block opens with an \addvspace-emitting construct
    // (sectioning, list/box environment, \vspace…) that MERGES against
    // \lastskip. A plain paragraph keeps \lastskip untouched and adds its own
    // material, so a primer there would just sit as extra height.
    let primer = '';
    if (idx > 0 && startsAddvspace(block.text)) {
      const pv = JSON.parse(blocks[idx - 1].stateVec ?? '[]');
      const ls = pv.length ? pv[pv.length - 1] : 0;
      if (ls) primer = `\\directlua{tdom_prime_lastskip(${Math.round(ls)})}`;
    }
    const volatilePre = ck.vstale && idx > 0 ? volatilePrelude(idx) : '';
    const prelude =
      volatilePre + (defs.length ? `\\makeatletter ${defs.join(' ')}\\makeatother\n` : '') + primer;
    // Mid-typing safety: an unclosed brace makes a \long macro argument
    // scan past the injected \par/report tokens to EOF and kills the child
    // (the old \vbox wrapper stopped it structurally). Auto-close the
    // imbalance — the source is transiently invalid anyway, and the exact
    // path resumes on the next balanced keystroke.
    const guard = '}'.repeat(Math.max(0, braceImbalance(block.text)));
    body = Buffer.from(prelude + block.text + guard, 'utf8');
    jobId = block.id;
  }
  return { body, jobId, refSnapshot };
}
