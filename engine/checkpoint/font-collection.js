// Font collections (.ttc / .otc). A browser's @font-face takes one font per
// file, so a face TeX reads out of a collection is served as a font of its
// own: the same tables, under a table directory of their own. macOS ships
// its Japanese fonts this way (ヒラギノ明朝 ProN.ttc holds W3 and W6), and
// without this every line set in them waited for an exact picture.

import { readFileSync, statSync } from 'node:fs';

const NAME_IDS = new Set([1, 4, 6, 16]); // family, full, PostScript, typographic family
const normalize = (name) => String(name ?? '').toLowerCase().replace(/[\s_-]+/g, '');

function decodeName(buf, platform, encoding, start, length) {
  const bytes = buf.subarray(start, start + length);
  if (platform === 0 || platform === 3 || (platform === 2 && encoding === 1)) {
    let out = '';
    for (let i = 0; i + 1 < bytes.length; i += 2) out += String.fromCharCode(bytes.readUInt16BE(i));
    return out;
  }
  return bytes.toString('latin1');
}

function faceTables(buf, offset) {
  if (offset + 12 > buf.length) return null;
  const numTables = buf.readUInt16BE(offset + 4);
  if (offset + 12 + numTables * 16 > buf.length) return null;
  const tables = [];
  for (let i = 0; i < numTables; i++) {
    const at = offset + 12 + i * 16;
    const table = {
      tag: buf.toString('latin1', at, at + 4),
      checksum: buf.readUInt32BE(at + 4),
      offset: buf.readUInt32BE(at + 8),
      length: buf.readUInt32BE(at + 12),
    };
    if (table.offset + table.length > buf.length) return null;
    tables.push(table);
  }
  return { version: buf.readUInt32BE(offset), tables };
}

function faceNames(buf, tables) {
  const names = new Set();
  const table = tables.find((entry) => entry.tag === 'name');
  if (!table || table.length < 6) return names;
  const base = table.offset;
  const count = buf.readUInt16BE(base + 2);
  const strings = base + buf.readUInt16BE(base + 4);
  for (let i = 0; i < count; i++) {
    const at = base + 6 + i * 12;
    if (at + 12 > base + table.length) break;
    if (!NAME_IDS.has(buf.readUInt16BE(at + 6))) continue;
    const length = buf.readUInt16BE(at + 8);
    const start = strings + buf.readUInt16BE(at + 10);
    if (start + length > buf.length) continue;
    const name = normalize(decodeName(buf, buf.readUInt16BE(at), buf.readUInt16BE(at + 2), start, length));
    if (name) names.add(name);
  }
  return names;
}

/** The faces of a collection: [{ offset, names }], or [] when `buf` is not one. */
export function collectionFaces(buf) {
  if (buf.length < 12 || buf.toString('latin1', 0, 4) !== 'ttcf') return [];
  const count = buf.readUInt32BE(8);
  if (count > 1024 || 12 + count * 4 > buf.length) return [];
  const faces = [];
  for (let i = 0; i < count; i++) {
    const offset = buf.readUInt32BE(12 + i * 4);
    const face = faceTables(buf, offset);
    faces.push(face ? { offset, names: faceNames(buf, face.tables) } : { offset, names: new Set() });
  }
  return faces;
}

/** What a luaotfload font name asks for: { name, index } (index 0-based or null).
 * "name:HiraMinProN-W3:mode=node;…", "[HiraginoSans.ttc](2):…", "file:x.ttc(1):…" */
export function requestedFace(fontName) {
  const text = String(fontName ?? '').replace(/^"|"$/g, '');
  const match = /^(?:name:|file:|id:)?\s*\[?([^\]:(]+)\]?\s*(?:\((\d+)\))?\s*(?::|$)/.exec(text);
  if (!match) return { name: '', index: null };
  return { name: normalize(match[1].replace(/\.(ttc|otc)$/i, '')), index: match[2] == null ? null : Number(match[2]) };
}

/** Index of the face `fontName` names, or -1 when the collection has no such face. */
export function pickFace(faces, fontName) {
  const want = requestedFace(fontName);
  if (want.index != null) return want.index < faces.length ? want.index : -1;
  if (!want.name) return -1;
  return faces.findIndex((face) => face.names.has(want.name));
}

/** One face as a font file of its own. */
export function extractFace(buf, index) {
  const faces = collectionFaces(buf);
  const face = faces[index] && faceTables(buf, faces[index].offset);
  if (!face) return null;
  const count = face.tables.length;
  let at = 12 + count * 16;
  const placed = face.tables.map((table) => {
    const entry = { ...table, at };
    at += (table.length + 3) & ~3;
    return entry;
  });
  const out = Buffer.alloc(at);
  out.writeUInt32BE(face.version, 0);
  out.writeUInt16BE(count, 4);
  const power = 2 ** Math.floor(Math.log2(Math.max(1, count)));
  out.writeUInt16BE(power * 16, 6);
  out.writeUInt16BE(Math.log2(power), 8);
  out.writeUInt16BE(count * 16 - power * 16, 10);
  placed.forEach((table, i) => {
    const record = 12 + i * 16;
    out.write(table.tag, record, 4, 'latin1');
    out.writeUInt32BE(table.checksum, record + 4);
    out.writeUInt32BE(table.at, record + 8);
    out.writeUInt32BE(table.length, record + 12);
    buf.copy(out, table.at, table.offset, table.offset + table.length);
  });
  return out;
}

// One read per collection and per face for the life of the process: the
// files run to tens of megabytes and every open document asks again.
const facesByFile = new Map(); // path -> { stamp, faces }
const fontByFace = new Map(); // path#index -> { stamp, font }
const stampOf = (file) => { const st = statSync(file); return `${st.size}:${st.mtimeMs}`; };

/** Index of the face `fontName` names in the collection at `file`, or -1. */
export function findCollectionFace(file, fontName) {
  try {
    const stamp = stampOf(file);
    let entry = facesByFile.get(file);
    if (entry?.stamp !== stamp) {
      entry = { stamp, faces: collectionFaces(readFileSync(file)) };
      facesByFile.set(file, entry);
    }
    return pickFace(entry.faces, fontName);
  } catch {
    return -1;
  }
}

/** The bytes of face `index` of the collection at `file`, or null. */
export function collectionFaceFile(file, index) {
  try {
    const stamp = stampOf(file);
    const key = `${file}#${index}`;
    let entry = fontByFace.get(key);
    if (entry?.stamp !== stamp) {
      entry = { stamp, font: extractFace(readFileSync(file), index) };
      fontByFace.set(key, entry);
    }
    return entry.font;
  } catch {
    return null;
  }
}
