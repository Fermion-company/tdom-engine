export function buildPagePatches(pages, prevPages, hfSig, displayList) {
  const prevHashes = new Map(prevPages.map((p) => [p.number, p.dl?.hash]));
  const patches = [];
  const dirtyPages = [];
  for (const page of pages) {
    if (!page.dl || page.dl.hfSig !== hfSig) page.dl = displayList(page);
    if (page.dl.hash !== prevHashes.get(page.number)) {
      dirtyPages.push(page.number);
      patches.push({ type: 'replace-page', page: page.number, displayList: page.dl });
    }
  }
  if (pages.length < prevPages.length) {
    patches.push({ type: 'remove-pages', from: pages.length + 1 });
  }
  return { patches, dirtyPages };
}
