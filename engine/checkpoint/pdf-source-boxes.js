import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { createGunzip } from 'node:zlib';

// Inputs can be declared between sheets, and the postscript can change
// units for every sheet. Validate the entire stream, keeping just the
// requested page. TeX node nesting is checked separately on that page.
function collectSourcePage(page, dvi, visitSheet, cwd, large) {
  const header = new Map(), inputs = new Map(), lines = [];
  let observed = [], observedBytes = 0, lastVisited = 0;
  let currentPage = null, found = false, post = false, valid = true, bytes = 0;
  function accept(line) {
    if (!valid) return;
    if (post) { if (line.trim()) valid = false; return; }
    const initial = line[0];
    if (!visitSheet && currentPage !== null && currentPage !== page &&
        initial !== '{' && initial !== '}' && initial !== 'I' && initial !== 'P' &&
        !'OSMUXY'.includes(initial)) return;
    if (initial === '{' && /^\{\d+$/.test(line)) {
      if (currentPage !== null) { valid = false; return; }
      currentPage = Number(line.slice(1));
      if (currentPage === page) {
        if (found) valid = false;
        found = true;
      }
      return;
    }
    if (initial === '}' && /^\}\d*$/.test(line)) {
      if (currentPage === null || line.length > 1 && Number(line.slice(1)) !== currentPage) valid = false;
      if (visitSheet) {
        if (currentPage <= lastVisited) valid = false;
        if (valid) visitSheet(currentPage, observed);
        lastVisited = currentPage;
        observed = [];
        observedBytes = 0;
      }
      currentPage = null;
      return;
    }
    if (initial === 'I') {
      const input = /^Input:(\d+):(.+)$/.exec(line);
      if (input) {
        // Detach the path from its gzip output chunk.
        inputs.set(Number(input[1]), path.resolve(cwd, Buffer.from(input[2]).toString()));
        bytes += Buffer.byteLength(line);
      }
    } else if (initial === 'P' && line === 'Post scriptum:') post = true;
    else if (line.startsWith('Output:')) header.set('output', line.slice(7));
    else if ('SMUXY'.includes(initial)) {
      const setting = /^(SyncTeX Version|Magnification|Unit|X Offset|Y Offset):(.+)$/.exec(line);
      if (setting) header.set(setting[1], Number(setting[2]));
    }
    if (visitSheet && currentPage !== null) {
      if (large) {
        observedBytes += Buffer.byteLength(line) + 1;
        if (observedBytes > 16 * 1024 * 1024 || observed.length >= 250000) { valid = false; return; }
      }
      observed.push(line);
    }
    if (currentPage === page) { lines.push(line); bytes += Buffer.byteLength(line); }
    if (large && (bytes > 16 * 1024 * 1024 || lines.length > 250000 || inputs.size > 65536)) valid = false;
  }
  function finish() {
    if (!valid || currentPage !== null || header.get('SyncTeX Version') !== 1 ||
        header.get('Magnification') !== 1000 || header.get('Unit') !== 1) return null;
    const originX = header.get('X Offset'), originY = header.get('Y Offset');
    if (!Number.isSafeInteger(originX) || !Number.isSafeInteger(originY)) return null;
    if ((originX || originY) && !(dvi && header.get('output') === 'dvi')) return null;
    return { inputs, lines, bytes, originX, originY };
  }
  return { accept, finish };
}

async function readSyncTeX(filename, page, visitSheet, { dvi = false, cwd = process.cwd(), signal } = {}) {
  // Long books have large sidecars even when each individual page is small.
  // Bound what is retained per page and reject excessive gzip expansion.
  const compressedBytes = (await stat(filename)).size;
  const large = compressedBytes > 8 * 1024 * 1024;
  const reader = collectSourcePage(page, dvi, visitSheet, cwd, large);
  const maxBytes = Math.max(256 * 1024 * 1024, compressedBytes * 64);
  await pipeline(createReadStream(filename), createGunzip({ chunkSize: 64 * 1024 }), async function consume(chunks) {
    chunks.setEncoding('utf8');
    let partial = '', bytes = 0;
    for await (const chunk of chunks) {
      bytes += Buffer.byteLength(chunk);
      if (bytes > maxBytes) throw new Error('SyncTeX exceeds decompressed size limit');
      const lines = chunk.split('\n');
      if (large && partial.length + lines[0].length > 1024 * 1024) throw new Error('SyncTeX record exceeds size limit');
      if (lines.length === 1) { partial += chunk; continue; }
      lines[0] = partial + lines[0];
      partial = lines.pop();
      for (const line of lines) reader.accept(line.endsWith('\r') ? line.slice(0, -1) : line);
    }
    if (partial) reader.accept(partial);
  }, { signal });
  return reader.finish();
}

export function readSyncTeXSourcePage(filename, page, options) {
  return readSyncTeX(filename, page, null, options);
}

// Validate the same stream and visit one complete sheet at a time. Counts
// collected by the caller are usable only if the whole file validates.
export async function visitSyncTeXSheets(filename, visitSheet, options) {
  return Boolean(await readSyncTeX(filename, 0, visitSheet, options));
}

// SyncTeX's view command omits void hboxes, including an empty fraction
// branch. Keep native node order and ancestry for each requested source range.
export function sourceBoxesOnPage({ inputs, lines, originX = 0, originY = 0 }, { file, page, startLine, endLine, sourceInputs = null }) {
  const source = sourceInputs ? null : path.resolve(file), boxes = [], stack = [];
  const scale = 72 / 72.27 / 65536;
  let sequence = 0;
  for (const line of lines) {
    if (line === ')' || line === ']') {
      const parent = stack.pop();
      if (!parent || parent.kind !== (line === ')' ? 'hbox' : 'vbox')) return null;
      continue;
    }
    if (/^[<>f]/.test(line)) return null; // transformed/reused forms need their own proof
    if (!/^[\[(hv]/.test(line)) continue;
    const node = /^([\[(hv])(\d+),(\d+)(?:,(-?\d+))?:(-?\d+),(-?\d+):(-?\d+),(-?\d+),(-?\d+)$/.exec(line);
    if (!node) return null;
    const [, type, tag, sourceLine, , rawX, rawY, rawWidth, rawHeight, rawDepth] = node;
    const kind = type === '(' || type === 'h' ? 'hbox' : 'vbox';
    const parent = stack.at(-1), id = ++sequence;
    if (kind === 'hbox' && parent) parent.hboxChildren++;
    const x = (Number(rawX) + originX) * scale, y = (Number(rawY) + originY) * scale;
    const width = Number(rawWidth) * scale, height = Number(rawHeight) * scale, depth = Number(rawDepth) * scale;
    const mapped = sourceInputs?.get(Number(tag));
    if (kind === 'hbox' && (sourceInputs ? mapped : inputs.get(Number(tag)) === source) &&
        Number(sourceLine) >= startLine && Number(sourceLine) <= endLine && width >= 0) {
      boxes.push({ id, parentId: parent?.id ?? null, parentKind: parent?.kind ?? null, parent,
        ancestors: stack.map(frame => frame.id),
        empty: type === 'h', page, ...(mapped && { file: mapped.file }), line: Number(sourceLine) + (mapped?.offset ?? 0), x, y,
        box: { left: x, right: x + width, top: y - height, bottom: y + depth } });
      if (boxes.length > 4096) return null;
    }
    if (type === '(' || type === '[') {
      if (stack.length >= 128) return null;
      stack.push({ id, kind, hboxChildren: 0 });
    }
  }
  if (stack.length) return null;
  return boxes.map(({ parent, ...box }) => ({ ...box, parentChildCount: parent?.hboxChildren ?? 0 }));
}

export function parseSyncTeXSourceBoxes(text, query) {
  const reader = collectSourcePage(query.page);
  for (const line of String(text).split(/\r?\n/)) reader.accept(line);
  const page = reader.finish();
  return page && sourceBoxesOnPage(page, query);
}
