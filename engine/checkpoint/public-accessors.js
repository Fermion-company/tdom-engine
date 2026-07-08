import { existsSync, readFileSync } from 'node:fs';

export function source(store, file) {
  return store.get(file);
}

export function displayLists(pages) {
  return pages.map((p) => p.dl);
}

export function geometry(geo) {
  return geo;
}

export function fontFile(fontFiles, key) {
  const p = fontFiles.get(key);
  if (!p || !existsSync(p)) return null;
  return readFileSync(p);
}

export function fontManifest(fontFiles) {
  return [...fontFiles.keys()];
}

export function chunkSvg(chunks, id) {
  return chunks.get(id)?.svg ?? null;
}
