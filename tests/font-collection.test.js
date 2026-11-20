// One face of a .ttc served as a font of its own (font-collection.js).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { collectionFaces, extractFace, pickFace, requestedFace } from '../engine/checkpoint/font-collection.js';
import { registerFont } from '../engine/checkpoint/font-registry.js';
import { fontFile } from '../engine/checkpoint/public-accessors.js';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const utf16be = (text) => { const out = Buffer.alloc(text.length * 2); [...text].forEach((ch, i) => out.writeUInt16BE(ch.charCodeAt(0), i * 2)); return out; };

function nameTable(records) { // [[nameId, text]] as Windows Unicode names
  const strings = records.map(([, text]) => utf16be(text));
  const head = Buffer.alloc(6 + records.length * 12);
  head.writeUInt16BE(records.length, 2);
  head.writeUInt16BE(head.length, 4);
  let at = 0;
  records.forEach(([id], i) => {
    const record = 6 + i * 12;
    head.writeUInt16BE(3, record); head.writeUInt16BE(1, record + 2); head.writeUInt16BE(0x409, record + 4);
    head.writeUInt16BE(id, record + 6); head.writeUInt16BE(strings[i].length, record + 8); head.writeUInt16BE(at, record + 10);
    at += strings[i].length;
  });
  return Buffer.concat([head, ...strings]);
}

// two faces that share one glyph table, as real collections do
function collection() {
  const shared = Buffer.from('shared-outline-data!');
  const names = [nameTable([[6, 'Demo-W3'], [4, 'Demo W3']]), nameTable([[6, 'Demo-W6'], [4, '.Demo Interface W6']])];
  const headerSize = 12 + 2 * 4;
  const dirSize = 12 + 2 * 16;
  const pad = (n) => (n + 3) & ~3;
  let at = headerSize + 2 * dirSize;
  const sharedAt = at; at += pad(shared.length);
  const nameAt = names.map((table) => { const here = at; at += pad(table.length); return here; });
  const out = Buffer.alloc(at);
  out.write('ttcf', 0, 'latin1'); out.writeUInt32BE(0x00010000, 4); out.writeUInt32BE(2, 8);
  names.forEach((table, face) => {
    const dir = headerSize + face * dirSize;
    out.writeUInt32BE(dir, 12 + face * 4);
    out.write('OTTO', dir, 'latin1'); out.writeUInt16BE(2, dir + 4);
    const record = (i, tag, offset, length) => { const r = dir + 12 + i * 16; out.write(tag, r, 4, 'latin1'); out.writeUInt32BE(offset, r + 8); out.writeUInt32BE(length, r + 12); };
    record(0, 'CFF ', sharedAt, shared.length);
    record(1, 'name', nameAt[face], table.length);
    table.copy(out, nameAt[face]);
  });
  shared.copy(out, sharedAt);
  return out;
}

test('a luaotfload font name says which face of the collection it wants', () => {
  assert.deepEqual(requestedFace('name:HiraMinProN-W3:mode=node;script=hani;jfm=jlreq'), { name: 'hiraminpronw3', index: null });
  assert.deepEqual(requestedFace('"name:.Hiragino Kaku Gothic Interface W5:mode=node;"'), { name: '.hiraginokakugothicinterfacew5', index: null });
  assert.deepEqual(requestedFace('[HiraginoSans.ttc](2):mode=node'), { name: 'hiraginosans', index: 2 });
});

test('faces are found by PostScript or full name, and unknown names by none', () => {
  const faces = collectionFaces(collection());
  assert.equal(faces.length, 2);
  assert.equal(pickFace(faces, 'name:Demo-W3:mode=node'), 0);
  assert.equal(pickFace(faces, '"name:.Demo Interface W6:mode=node;"'), 1);
  assert.equal(pickFace(faces, '[demo.ttc](1):'), 1);
  assert.equal(pickFace(faces, '[demo.ttc](7):'), -1);
  assert.equal(pickFace(faces, 'name:Other-W3:'), -1);
  assert.deepEqual(collectionFaces(Buffer.from('OTTO not a collection')), []);
});

test('an extracted face is a font file with its own table directory', () => {
  const font = extractFace(collection(), 1);
  assert.equal(font.toString('latin1', 0, 4), 'OTTO');
  assert.equal(font.readUInt16BE(4), 2);
  const tables = [0, 1].map((i) => ({ tag: font.toString('latin1', 12 + i * 16, 16 + i * 16),
    offset: font.readUInt32BE(20 + i * 16), length: font.readUInt32BE(24 + i * 16) }));
  assert.deepEqual(tables.map((table) => table.tag), ['CFF ', 'name']);
  assert.ok(tables.every((table) => table.offset % 4 === 0 && table.offset + table.length <= font.length));
  assert.equal(font.toString('latin1', tables[0].offset, tables[0].offset + tables[0].length), 'shared-outline-data!');
  assert.ok(font.subarray(tables[1].offset, tables[1].offset + tables[1].length).includes(utf16be('Demo-W6')));
  assert.equal(extractFace(collection(), 5), null);
});

test('a font read from a collection is native: its lines need no exact picture', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'tdom-ttc-'));
  const file = path.join(dir, 'demo.ttc');
  writeFileSync(file, collection());
  try {
    const state = { fonts: new Map(), fontFiles: new Map(), demotedFamilies: new Set() };
    registerFont('A', { file, name: 'name:Demo-W3:mode=node', size: 10 }, state);
    registerFont('B', { file, name: 'name:Demo-W6:mode=node', size: 10 }, state);
    registerFont('C', { file, name: 'name:Missing-W9:mode=node', size: 10 }, state);
    assert.equal(state.fonts.get('A').tier, 'native');
    assert.equal(state.fonts.get('B').tier, 'native');
    assert.notEqual(state.fonts.get('A').family, state.fonts.get('B').family, 'two weights are two browser fonts');
    assert.equal(state.fonts.get('C').tier, 'none');
    const served = fontFile(state.fontFiles, state.fonts.get('B').family);
    assert.equal(served.toString('latin1', 0, 4), 'OTTO');
    assert.ok(served.includes(utf16be('Demo-W6')) && !served.includes(utf16be('Demo-W3')));
    assert.equal(fontFile(state.fontFiles, state.fonts.get('C').family), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
