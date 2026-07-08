import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { cropSvg, cropSvgAt } from './util/svg.js';

const execFileP = promisify(execFile);

export async function readIsoCompileResult(
  engine,
  { block, jobdir, pdf, statePath, ck0, why, negKey, splitMode, strut, entryOff, labelSnap, isoCompileCold }
) {
  const st = JSON.parse(readFileSync(statePath, 'utf8'));
  if ((st.discarded ?? 0) > 0) {
    // the dormant absorb hit its runaway cap and THREW MATERIAL AWAY —
    // the galley would be silently empty/partial (found via stress
    // seed-21 burst 2: boxedtheorem/mdframed blocks stranded empty after
    // a broken window). In FORK mode this is the expected signal that
    // the env truly has to SPLIT at this offset: retry cold, where the
    // real output routine splits exactly as in print. In cold mode it is
    // final — fail; stale-first keeps the last good pixels, and once the
    // inputs return to sane values the rescue key changes back and the
    // cached good result re-adopts.
    if (!process.env.TDOM_ISO_KEEP) rmSync(jobdir, { recursive: true, force: true });
    if (ck0) return isoCompileCold();
    const msg = `isolated rescue discarded runaway material for ${block.id} (${why})`;
    if (engine.isoFailCache.size > 200) engine.isoFailCache.clear();
    engine.isoFailCache.set(negKey, msg);
    throw new Error(msg);
  }
  const ships = st.ships ?? 0;
  const geo = engine.geometry ?? {};
  const chunks = [];
  const items = [];
  // fires absorbed BEFORE the first ship are real page breaks whose
  // material (pre-body machinery) left with page 1 — e.g. the \clearpage
  // opening a landscape env. Without them the first chunk page glues
  // itself to the preceding text and overfills.
  if (ships > 0) {
    for (let k = 0; k < (st.preabsorbs ?? 0); k++) items.push({ k: 'eject', v: -10000 });
  }
  // real shipped pages (material taller than the page inside an
  // output-hijack env): one full-textheight chunk per page + a forced
  // break — the preview page sequence mirrors print exactly
  for (let k = 1; k <= ships; k++) {
    const svgPath = path.join(jobdir, `page-${k}.svg`);
    await execFileP('pdftocairo', ['-svg', '-f', String(k), '-l', String(k), pdf, svgPath], {
      timeout: 30_000,
    });
    const svg = readFileSync(svgPath, 'utf8');
    // A BLANK shipped page is a break, not content: with the real output
    // routine in place (\includepdf), the leading \clearpage ships the
    // near-empty current page — in the full document that position is
    // occupied by the PRECEDING blocks' material, so representing it as a
    // chunk would mint a phantom page. Keep the break, drop the box.
    const blank = !/<(path|image|text)\b/.test(svg);
    if (blank) {
      items.push({ k: 'eject', v: -10000 });
      continue;
    }
    const x0 = geo.oddsidemargin ?? 0;
    const y0 = (geo.topmargin ?? 0) + (geo.headheight ?? 0) + (geo.headsep ?? 0);
    const w = geo.textwidth ?? st.w;
    const key = `${block.id}@p${k}`;
    if (splitMode) {
      // a split box's shipped page is a REGULAR document page: page 1
      // carries the entry strut (the block starts mid-page — crop below
      // it and let the pagebuilder place the partial box at the block's
      // offset), later pages span the full text height. No full flag —
      // the preview stamps its normal page furniture.
      const cut = k === 1 ? strut : 0;
      const h = (geo.textheight ?? st.h) - cut;
      chunks.push({ key, svg: cropSvgAt(svg, x0, y0 + cut, w, h), wBp: w, hBp: h });
      items.push({ k: 'box', h, d: 0, chunk: key, coff: 0 });
      items.push({ k: 'eject', v: -10000 });
      continue;
    }
    const h = geo.textheight ?? st.h;
    chunks.push({ key, svg: cropSvgAt(svg, x0, y0, w, h), wBp: w, hBp: h });
    // full: a REAL shipped page — it owns its page style (pdfpages sets
    // \thispagestyle{empty}), so the preview must not stamp a folio on it
    items.push({ k: 'box', h, d: 0, chunk: key, coff: 0, full: 1 });
    items.push({ k: 'eject', v: -10000 });
  }
  // remainder galley = the LAST pdf page (our manual shipout); its items
  // carry chunk-local offsets so page breaks inside it clip correctly
  const lastPage = ships + 1;
  const svgPath = path.join(jobdir, 'iso.svg');
  await execFileP(
    'pdftocairo',
    ['-svg', '-f', String(lastPage), '-l', String(lastPage), pdf, svgPath],
    { timeout: 30_000 }
  );
  const remainderKey = block.id;
  if ((st.h ?? 0) + (st.d ?? 0) > 0.01) {
    chunks.push({
      key: remainderKey,
      svg: cropSvg(readFileSync(svgPath, 'utf8'), st.w, st.h + st.d),
      wBp: st.w,
      hBp: st.h + st.d,
    });
    let coff = 0;
    for (const it of st.items ?? []) {
      if (it.k === 'box') {
        items.push({ ...it, chunk: remainderKey, coff });
        coff += (it.h ?? 0) + (it.d ?? 0);
      } else {
        items.push(it);
        if (it.k === 'glue' || it.k === 'kern') coff += it.a ?? 0;
      }
    }
  }
  if (!process.env.TDOM_ISO_KEEP) rmSync(jobdir, { recursive: true, force: true });
  else console.error('ISO_KEEP', block.id, jobdir);
  // a success supersedes any earlier failure recorded for the same inputs
  // (retry ladders, transient infra) — stale entries would keep
  // frozenBlockIds reporting a healed block forever
  engine.isoFailCache.delete(negKey);
  // trailing skip for the NEXT block's \addvspace merge: last glue item, sp
  const compiledOff = entryOff;
  const state = { ...(st.state ?? {}) };
  let trailLs = 0;
  for (const it of items) {
    if (it.k === 'glue' || it.k === 'kern') trailLs = it.a ?? 0;
    else if (it.k === 'box') trailLs = 0;
  }
  state['tdom@ls'] = Math.round(trailLs * 65781.76);
  return {
    w: Math.max(st.w ?? 0, ships ? (geo.textwidth ?? 0) : 0),
    h: st.h,
    d: st.d,
    items,
    labels: (st.labels ?? []).map(([k, v, h]) => (h != null ? { k, v, h } : { k, v })),
    toclines: (st.toclines ?? []).map(([e, l, t]) => ({ e, l, t })),
    refs: st.refs ?? [],
    refVals: Object.fromEntries((st.refs ?? []).map((k) => [k, labelSnap.get(k)])),
    compiledOff,
    state,
    chunks,
  };
}
