import { readFileSync } from 'node:fs';
import path from 'node:path';

// engine.includes maps each project input the resident read to
// {mtime, readPath, text, announcedText}. `announcedText` is what the
// canonical layer was last told this input holds: the first read through
// `readPath` (inside the open or edit that reached it) or the disk bytes when
// an external-change refresh invalidated it. A resident-only re-read (a cold
// resume, a structured re-probe) that finds new bytes keeps the old value, so
// the watcher event those bytes raise still invalidates canonical.
export function cacheIncludeRead(includes, file, { mtime, readPath, text }) {
  const cached = includes.get(file);
  const announcedText = cached?.readPath === readPath ? cached.announcedText : text;
  includes.set(file, { mtime, readPath, text, announcedText });
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
