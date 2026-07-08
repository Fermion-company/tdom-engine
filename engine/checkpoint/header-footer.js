import { walkItemRuns, stableFontKey } from './util/galley.js';

export function normalizeHeaderFooterPayload(payload, registerFont) {
  // same stable-key rewrite as galleys (lineage-independent identity)
  const fkeys = new Map();
  for (const [fid, meta] of Object.entries(payload.fonts ?? {})) {
    const key = stableFontKey(meta);
    fkeys.set(Number(fid), key);
    registerFont(key, meta);
  }
  const rewrite = (r) => {
    if (r.rule || r.f == null) return;
    const key = fkeys.get(r.f);
    if (key) r.f = key;
  };
  const map = new Map();
  for (const [pageStr, entry] of Object.entries(payload.hf ?? {})) {
    walkItemRuns(entry.h, rewrite);
    walkItemRuns(entry.f, rewrite);
    map.set(Number(pageStr.replace(/^p/, '')), entry);
  }
  return map;
}
