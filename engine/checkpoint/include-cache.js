import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fnv1a } from '../hash.js';

// engine.includes maps each project input the resident read to
// {mtime, readPath, text, announcedText}. `announcedText` is what the
// canonical layer was last told this input holds: the first read through
// `readPath` (inside the open or edit that reached it) or the disk bytes when
// an external-change refresh invalidated it. A resident-only re-read (a cold
// resume, a structured re-probe) that finds new bytes keeps the old value, so
// the watcher event those bytes raise still invalidates canonical.
export function cacheIncludeRead(includes, file, { mtime, readPath, text, size = null }) {
  const cached = includes.get(file);
  const announcedText = cached?.readPath === readPath ? cached.announcedText : text;
  // `settled`: the file had been at rest for longer than any filesystem's
  // timestamp step when these bytes were taken (includeTextCurrent)
  includes.set(file, { mtime, readPath, text, announcedText, size, settled: Date.now() - mtime > OVERLAY_REST_MS,
    // (the hash of these bytes, once asked for: overlayContentSig)
    sig: cached && cached.text === text ? cached.sig : undefined });
}

/**
 * The identity of an overlay's bytes for a block that reads it (an \input
 * or \include line, a listing). It was the hash of a second read of the
 * file at every expansion. The expansion that runs just before has read the
 * file (or holds it, includeTextCurrent) and left its text here: when the
 * file still has that time and size, the hash is taken from that text, once.
 */
export function overlayContentSig(includes, file, readPath, stat) {
  const cached = includes?.get(file);
  if (!READ_OVERLAYS_ALWAYS && cached && cached.readPath === readPath && cached.mtime === stat.mtimeMs &&
      cached.size === stat.size && typeof cached.text === 'string') {
    return cached.sig ??= fnv1a(cached.text);
  }
  return fnv1a(readFileSync(readPath, 'utf8'));
}

// An unsaved editor buffer reaches TeX as an overlay file, written again by
// the server whenever the buffer changes. Its time of writing alone does not
// say it is unchanged (two writes inside one step of a coarse filesystem
// clock carry the same time), so an overlay was read again at every
// expansion: every keystroke read every overlay of the project. A host that
// keeps one chapter of a book live sends the other chapters as (empty)
// overlays, forty files read with each keystroke for nothing (1.5 ms).
// An overlay is taken from the cache when it has the time and the size it
// was read with and had already been at rest for OVERLAY_REST_MS when it
// was read: no later write can hide behind that time. A file of the project
// itself keeps its rule (the time it was written).
// TDOM_READ_OVERLAYS_ALWAYS=1: every overlay read at every expansion.
export const OVERLAY_REST_MS = 3000;
const READ_OVERLAYS_ALWAYS = !!process.env.TDOM_READ_OVERLAYS_ALWAYS;
export function includeTextCurrent(cached, stat, readPath, overlay) {
  if (!cached || cached.readPath !== readPath || cached.mtime !== stat.mtimeMs) return false;
  if (!overlay) return true;
  return !READ_OVERLAYS_ALWAYS && cached.settled === true && cached.size === stat.size;
}

// Runs right before a refresh invalidates `files` on the canonical layer:
// canonical compiles these bytes or newer ones, and newer ones raise their
// own watcher event.
export function announceIncludeReads(includes, files) {
  const targets = new Set(files.map((file) => path.resolve(file)));
  for (const [file, cached] of includes) {
    if (typeof cached?.readPath !== 'string') continue;
    if (!targets.has(path.resolve(file)) && !targets.has(path.resolve(cached.readPath))) continue;
    let announcedText = null;
    try { announcedText = readFileSync(cached.readPath, 'utf8'); } catch { /* gone: nothing announced */ }
    includes.set(file, { ...cached, announcedText });
  }
}

// True when an overlay carrying `text` for project file `file` changes no TeX
// input: the resident already read exactly these bytes for it and canonical
// was told about them. An autosave of the same keystroke reaches the engine
// first, through the watcher, while the overlay request waits behind an
// earlier edit.
export function includeHoldsText(includes, file, text) {
  if (typeof text !== 'string') return false;
  const cached = includes.get(path.resolve(file));
  return typeof cached?.text === 'string' && cached.text === text && cached.announcedText === text;
}

// The overlay of `file` at `readPath` now holds the bytes the resident read
// elsewhere (includeHoldsText): read it from there on, as canonical does
// (its SyncTeX names the overlay), until the next expansion re-reads it.
export function rebindIncludeRead(includes, file, readPath) {
  const key = path.resolve(file);
  const cached = includes.get(key);
  if (!cached) return;
  let mtime;
  try { mtime = statSync(readPath).mtimeMs; } catch { return; }
  includes.set(key, { ...cached, readPath, mtime });
}

// True when a watcher event on `file` changes no TeX input: every include
// read through it holds exactly the bytes on disk, and canonical was told
// about those bytes. Compares bytes, not decoded text: TeX reads the raw
// file, and invalid UTF-8 decodes lossily. A file no include was read
// through (an image, a listing) is never unchanged here.
export function includeReadCurrent(includes, file) {
  const target = path.resolve(file);
  let bytes = null;
  for (const cached of includes.values()) {
    if (typeof cached?.readPath !== 'string' || path.resolve(cached.readPath) !== target) continue;
    if (typeof cached.text !== 'string' || cached.text !== cached.announcedText) return false;
    try { bytes ??= readFileSync(target); } catch { return false; }
    if (!bytes.equals(Buffer.from(cached.text, 'utf8'))) return false;
  }
  return bytes !== null;
}

// engine.resourceReads maps each input TeX reads without it entering the
// source DOM (an image, a listing, a mid-paragraph \input) to
// {mtime, size, hash, announcedHash}, keyed by the path TeX reads. Block
// identity uses the content hash, so a touch or a same-bytes rewrite leaves
// the owning block clean; the file is hashed again only when its mtime or
// size moves. `announcedHash` follows `announcedText` above.
export function resourceContentSig(resources, file, st) {
  const key = path.resolve(file);
  const cached = resources?.get(key);
  if (cached && cached.mtime === st.mtimeMs && cached.size === st.size) return cached.hash;
  const hash = hashFile(key);
  resources?.set(key, { mtime: st.mtimeMs, size: st.size, hash, announcedHash: cached ? cached.announcedHash : hash });
  return hash;
}

export function announceResourceReads(resources, files) {
  for (const file of files) {
    const key = path.resolve(file);
    if (!resources?.has(key)) continue;
    try {
      const st = statSync(key);
      const hash = hashFile(key);
      resources.set(key, { mtime: st.mtimeMs, size: st.size, hash, announcedHash: hash });
    } catch {
      resources.delete(key);
    }
  }
}

// True when a watcher event on `file` changes no TeX input: every read of it
// the resident made (as an include, as a resource) holds the bytes on disk,
// and canonical was told about them. A file the resident never read is
// never unchanged here.
export function inputReadCurrent(includes, resources, file) {
  const target = path.resolve(file);
  const viaResource = resources?.has(target) ?? false;
  let viaInclude = false;
  for (const cached of includes.values()) {
    if (typeof cached?.readPath === 'string' && path.resolve(cached.readPath) === target) viaInclude = true;
  }
  if (!viaInclude && !viaResource) return false;
  if (viaInclude && !includeReadCurrent(includes, target)) return false;
  return !viaResource || resourceReadCurrent(resources, target);
}

function resourceReadCurrent(resources, target) {
  const cached = resources.get(target);
  if (!cached || cached.hash !== cached.announcedHash) return false;
  let st;
  try { st = statSync(target); } catch { return false; }
  if (st.size !== cached.size) return false;
  if (st.mtimeMs === cached.mtime) return true;
  let hash;
  try { hash = hashFile(target); } catch { return false; }
  if (hash !== cached.hash) return false;
  resources.set(target, { ...cached, mtime: st.mtimeMs });
  return true;
}

function hashFile(file) {
  return createHash('sha1').update(readFileSync(file)).digest('hex');
}
