import { walkItemRuns, stableFontKey } from './util/galley.js';
import { fnv1a } from '../hash.js';

const pageSigs = new WeakMap(); // header/footer map -> page number -> signature of that page's entry

/**
 * What a page's display list takes from the header/footer map: that page's
 * own head and foot ('' while it has none: the provisional folio). A
 * display list is rebuilt when this changes (page-patches.js).
 *
 * It used to be the signature of the whole map, so each header job that
 * landed (a heading moved to another page, the page count changed: every
 * keystroke that adds a line to a paragraph, in a book with running heads)
 * rebuilt the display list of every page of the document in one piece, on
 * the thread that takes the keystrokes: 20 to 45 ms for 72 pages, for the
 * few pages whose head had changed.
 */
export function pageHfSig(hf, pageNumber) {
  const entry = hf?.get(pageNumber);
  if (!entry) return '';
  let sigs = pageSigs.get(hf);
  if (!sigs) pageSigs.set(hf, sigs = new Map());
  let sig = sigs.get(pageNumber);
  if (sig === undefined) sigs.set(pageNumber, sig = fnv1a(JSON.stringify(entry)));
  return sig;
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
  for (const [pageStr, entry] of Object.entries(payload.hf ?? {})) {
    walkItemRuns(entry.h, rewrite);
    walkItemRuns(entry.f, rewrite);
    map.set(Number(pageStr.replace(/^p/, '')), entry);
  }
  return map;
}
