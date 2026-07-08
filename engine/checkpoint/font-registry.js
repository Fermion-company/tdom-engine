import { existsSync } from 'node:fs';
import path from 'node:path';
import { fnv1a } from '../hash.js';
import { mapLegacyFont } from './mathmap.js';
import { walkItemRuns, stableFontKey } from './util/galley.js';
import { resolveFont } from './util/fs.js';

/**
 * Rewrite the galley's numeric daemon font ids to stable keys BEFORE
 * anything hashes or stores it. Daemon ids are allocation-order artifacts
 * of one fork lineage: replaying the same block in a different lineage
 * (chain preservation, background rebuild, engine restart) yields
 * different ids for identical output — which used to make galleyHash /
 * page identity churn, mark untouched pages dirty and peel their
 * canonical overlays. After this pass, galley identity is a pure function
 * of TeX's output.
 */
export function normalizeGalleyFonts(galley, { registerFont, diagnostics }) {
  const map = new Map();
  for (const [fid, meta] of Object.entries(galley.fonts ?? {})) {
    const key = stableFontKey(meta);
    map.set(Number(fid), key);
    registerFont(key, meta);
  }
  if (galley.fontsNormalized) return; // stale-first reuse re-adopts objects
  const rewrite = (r) => {
    if (r.rule || r.f == null) return;
    const key = map.get(r.f);
    if (key) r.f = key;
    else if (typeof r.f === 'number' && map.size) {
      // a PARTIALLY mapped galley is a real bug (the daemon reports every
      // id its runs use); rescued iso galleys legitimately carry no font
      // table at all — their pixels come from chunks, runs only size them
      diagnostics.push(`font id ${r.f} missing from galley font table`);
    }
  };
  walkItemRuns(galley.items, rewrite);
  for (const f of galley.floats ?? []) walkItemRuns(f.items, rewrite);
  galley.fontsNormalized = true;
}

export function registerFont(key, meta, { fonts, fontFiles, demotedFamilies }) {
  if (fonts.has(key)) return;
  const base = path.basename(meta.file || meta.name || '');
  const browserLoadable = /\.(otf|ttf)$/i.test(base);
  const legacy = !browserLoadable ? mapLegacyFont(meta.name) : null;
  // delivery tier (fidelity gate input): only the ACTUAL TeX font file,
  // present on disk and browser-loadable, is 'native'. Legacy fonts with
  // a Latin Modern twin are 'twin' (a substitution — never exact); every
  // other case (pfb without a twin, missing file) is 'none': the glyph
  // layer must not fake those at all.
  let familyKey;
  let tier;
  if (legacy) {
    familyKey = 'twin-' + legacy.twin;
    if (!fontFiles.has(familyKey)) {
      fontFiles.set(familyKey, resolveFont(legacy.twin));
    }
    const twinPath = fontFiles.get(familyKey);
    tier = twinPath && existsSync(twinPath) ? 'twin' : 'none';
  } else if (browserLoadable && meta.file && existsSync(meta.file)) {
    familyKey = 'f-' + fnv1a(meta.file);
    if (!fontFiles.has(familyKey)) fontFiles.set(familyKey, meta.file);
    tier = 'native';
  } else {
    familyKey = 'f-' + fnv1a(meta.file || meta.name || String(key));
    tier = 'none';
  }
  if (demotedFamilies.has(familyKey)) tier = 'none';
  fonts.set(key, {
    ...meta,
    family: familyKey,
    remap: legacy?.map ?? null,
    omx: !!legacy?.omx,
    tier,
  });
}

export function demoteFontFamily(familyKey, { demotedFamilies, fonts }) {
  if (!familyKey || demotedFamilies.has(familyKey)) return false;
  demotedFamilies.add(familyKey);
  let touched = false;
  for (const meta of fonts.values()) {
    if (meta.family === familyKey && meta.tier !== 'none') {
      meta.tier = 'none';
      touched = true;
    }
  }
  return touched;
}
