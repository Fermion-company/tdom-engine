// One update builds at most this many display lists; the pages after that
// are owed (engine-v3.js #pumpOwedPages builds and sends them a few at a
// time). A keystroke that makes a paragraph a line longer moves a line
// across every page break after it: in the middle of a 191-page single flow
// the keystroke built 96 display lists (150 ms on the thread that answers
// keystrokes) and sent them as one 18 MB event, which is over what an event
// stream may hold back for one client: the server dropped the viewer's
// stream, and until it had connected again, three seconds later, no
// keystroke was shown (20 of a run of 70).
// TDOM_EAGER_PAGES=<n>: another number (0: every page at once, as before).
const EAGER = process.env.TDOM_EAGER_PAGES;
export const EAGER_PAGES = EAGER !== undefined && EAGER !== '' && Number(EAGER) >= 0
  ? (Number(EAGER) === 0 ? Infinity : Math.floor(Number(EAGER))) : 4;

// What the viewers show of a page: the hash of the list they were last sent
// for its number. Kept on a page whose own list is not built yet (`owed`).
const shownOf = (page) => (page.owed && page.owed.number === page.number ? page.owed.hash : page.dl?.hash);

/** Whether any page's display list is still to be built and sent. */
export function pagesOwed(pages) {
  for (const page of pages) if (page.owed && page.owed.number === page.number) return true;
  return false;
}

// `hfSig`: the header/footer signature a page's display list must have been
// built with to be kept, as a function of the page (header-footer.js
// pageHfSig) or one value for every page.
/**
 * The display lists of the pages that need one, and the patches for those
 * that differ from what the viewers show. With `limit`, only the `limit`
 * pages nearest to page `focus` are built now; the others stay owed. Pages
 * already owed are left to the pump unless `owedToo` (the pump's own call):
 * a keystroke that follows one which moved every page builds its own page,
 * not three more of the pages still on their way.
 */
export function buildPagePatches(pages, prevPages, hfSig, displayList, { limit = Infinity, focus = null, owedToo = false } = {}) {
  const prevHashes = new Map(prevPages.map((p) => [p.number, shownOf(p)]));
  const patches = [];
  const dirtyPages = [];
  const sigOf = typeof hfSig === 'function' ? hfSig : () => hfSig;
  const stale = (page) => !page.dl || page.dl.hfSig !== sigOf(page);
  const owed = (page) => !!page.owed && page.owed.number === page.number;
  // (a page copied to another number carries no claim about that number)
  for (const page of pages) if (page.owed && page.owed.number !== page.number) delete page.owed;
  let later = null;
  if (Number.isFinite(limit)) {
    const need = pages.filter((page) => stale(page) || owed(page));
    const fresh = owedToo ? need : need.filter((page) => !owed(page));
    if (need.length > limit || fresh.length < need.length) {
      const center = Number.isFinite(focus) ? focus : (fresh[0] ?? need[0])?.number;
      const now = new Set([...fresh]
        .sort((a, b) => Math.abs(a.number - center) - Math.abs(b.number - center) || a.number - b.number)
        .slice(0, Math.max(0, limit)));
      // (a shrink sends the surviving tail whatever happens: below)
      if (pages.length < prevPages.length) now.add(pages.at(-1));
      later = new Set(need.filter((page) => !now.has(page)));
    }
  }
  for (const page of pages) {
    if (later?.has(page)) {
      if (!owed(page)) page.owed = { number: page.number, hash: prevHashes.get(page.number) ?? null };
      continue;
    }
    if (stale(page)) page.dl = displayList(page);
    const shown = owed(page) ? page.owed.hash : prevHashes.get(page.number);
    delete page.owed;
    if (page.dl.hash !== shown) {
      dirtyPages.push(page.number);
      patches.push({ type: 'replace-page', page: page.number, displayList: page.dl });
    }
  }
  if (pages.length < prevPages.length) {
    // A shrink needs a drawable surviving tail, even when its ink did not
    // change. A count alone cannot replace the viewer's last good pages.
    const tail = pages.at(-1);
    if (tail && !dirtyPages.includes(tail.number)) {
      dirtyPages.push(tail.number);
      patches.push({ type: 'replace-page', page: tail.number, displayList: tail.dl });
    }
    patches.push({ type: 'remove-pages', from: pages.length + 1 });
  }
  return { patches, dirtyPages, later: later?.size ?? 0 };
}
