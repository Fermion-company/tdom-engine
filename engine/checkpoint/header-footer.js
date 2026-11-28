import { walkItemRuns, stableFontKey } from './util/galley.js';
import { fnv1a } from '../hash.js';

const pageSigs = new WeakMap(); // header/footer map -> page number -> fingerprints of that page's entry

/** The fingerprint of one slot of a header entry, `h` (head) or `f`
 * (foot): its typeset items (runs, rules, every literal's payload), its
 * graphics flag and its literals' hash (`hg`/`hx`, `fg`/`fx`: daemon.lua
 * tdom_hf_box), docs/10 §10.7a F1. */
export function slotFingerprint(entry, which) {
  return entry ? fnv1a(JSON.stringify([entry[which] ?? null, entry[`${which}g`] ?? null, entry[`${which}x`] ?? null])) : '';
}

/** The fingerprint of a whole header entry: its two slots'. */
export function entryFingerprint(entry) {
  return entry ? `${slotFingerprint(entry, 'h')}/${slotFingerprint(entry, 'f')}` : '';
}

/**
 * What a page's display list takes from the header/footer map: the
 * fingerprint of that page's own entry, or of one slot of it ('' while it
 * has none: the provisional folio). A display list is rebuilt when what it
 * draws changes (engine-v3.js furnitureSig, page-patches.js).
 *
 * It used to be the signature of the whole map, so each header job that
 * landed (a heading moved to another page, the page count changed: every
 * keystroke that adds a line to a paragraph, in a book with running heads)
 * rebuilt the display list of every page of the document in one piece, on
 * the thread that takes the keystrokes: 20 to 45 ms for 72 pages, for the
 * few pages whose head had changed.
 */
export function pageHfSig(hf, pageNumber, which = null) {
  const entry = hf?.get(pageNumber);
  if (!entry) return '';
  let sigs = pageSigs.get(hf);
  if (!sigs) pageSigs.set(hf, sigs = new Map());
  let fps = sigs.get(pageNumber);
  if (fps === undefined) sigs.set(pageNumber, fps = { h: slotFingerprint(entry, 'h'), f: slotFingerprint(entry, 'f') });
  return which ? fps[which] : `${fps.h}/${fps.f}`;
}

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
  // the probes' entries (page-metadata.js hfJobBody), `q<template>.<component>`
  const probes = new Map();
  for (const [pageStr, entry] of Object.entries(payload.hf ?? {})) {
    walkItemRuns(entry.h, rewrite);
    walkItemRuns(entry.f, rewrite);
    const probe = /^pq(.+)$/.exec(pageStr);
    if (probe) probes.set(probe[1], entry);
    else map.set(Number(pageStr.replace(/^p/, '')), entry);
  }
  return { map, probes };
}
