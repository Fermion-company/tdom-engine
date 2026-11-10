import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { IsoPageCache, isoPageKeys, readIsoPageKeys } from '../engine/checkpoint/iso-page-cache.js';
import { renderIsoPages } from '../engine/checkpoint/iso-pages.js';

function fixture() {
  return { pages: [{ object: '3 0 R' }, { object: '4 0 R' }], qpdf: [{ jsonversion: 2 }, {
    trailer: { value: { '/Root': '1 0 R' } },
    'obj:1 0 R': { value: { '/Type': '/Catalog', '/Pages': '2 0 R' } },
    'obj:2 0 R': { value: { '/Type': '/Pages', '/Kids': ['3 0 R', '4 0 R'],
      '/MediaBox': [0, 0, 400, 600], '/Resources': { '/Font': { '/F1': '7 0 R' } } } },
    'obj:3 0 R': { value: { '/Type': '/Page', '/Parent': '2 0 R', '/Contents': '5 0 R' } },
    'obj:4 0 R': { value: { '/Type': '/Page', '/Parent': '2 0 R', '/Contents': '6 0 R' } },
    'obj:5 0 R': { stream: { dict: {}, data: Buffer.from('BT /F1 10 Tf (1) Tj ET').toString('base64') } },
    'obj:6 0 R': { stream: { dict: {}, data: Buffer.from('BT /F1 10 Tf (2) Tj ET').toString('base64') } },
    'obj:7 0 R': { value: { '/Type': '/Font', '/FontDescriptor': '8 0 R' } },
    'obj:8 0 R': { value: { '/FontFile': '9 0 R' } },
    'obj:9 0 R': { stream: { dict: {}, data: 'fontbytes' } },
  }] };
}

test('only a changed page misses; object dictionary order does not matter', () => {
  const json = fixture(), before = isoPageKeys(json, 2);
  assert.equal(before.length, 2);
  json.qpdf[1]['obj:5 0 R'].stream.data = 'edited paragraph';
  const after = isoPageKeys(json, 2);
  assert.notEqual(after[0], before[0]);
  assert.equal(after[1], before[1]);
  json.qpdf[1] = Object.fromEntries(Object.entries(json.qpdf[1]).reverse());
  assert.deepEqual(isoPageKeys(json, 2), after);
});

for (const kind of ['counter', 'label', 'width', 'font']) {
  test(`changed ${kind} paint input misses even with unchanged paragraph source`, () => {
    const json = fixture(), before = isoPageKeys(json, 2);
    if (kind === 'width') json.qpdf[1]['obj:2 0 R'].value['/MediaBox'][2]++;
    else if (kind === 'font') json.qpdf[1]['obj:9 0 R'].stream.data = 'different outlines';
    else json.qpdf[1]['obj:5 0 R'].stream.data = Buffer.from(`BT (${kind} now 3) Tj ET`).toString('base64');
    assert.notEqual(isoPageKeys(json, 2)[0], before[0]);
  });
}

test('transitive image/form resources, rotation and crop participate in the key', () => {
  for (const key of ['/XObject', '/Rotate', '/CropBox']) {
    const json = fixture(), dict = json.qpdf[1]['obj:3 0 R'].value;
    if (key === '/XObject') {
      dict['/Resources'] = { '/XObject': { '/Im1': '10 0 R' } };
      json.qpdf[1]['obj:10 0 R'] = { stream: { dict: { '/Resources': { '/XObject': { '/Im2': '11 0 R' } } }, data: 'form' } };
      json.qpdf[1]['obj:11 0 R'] = { stream: { dict: {}, data: 'image1' } };
      const before = isoPageKeys(json, 2);
      json.qpdf[1]['obj:11 0 R'].stream.data = 'image2';
      assert.notEqual(isoPageKeys(json, 2)[0], before[0]);
    } else {
      const before = isoPageKeys(json, 2);
      dict[key] = key === '/Rotate' ? 90 : [1, 2, 390, 580];
      assert.notEqual(isoPageKeys(json, 2)[0], before[0]);
    }
  }
});

test('malformed, cyclic, incomplete and unsupported PDF graphs fail closed', () => {
  assert.equal(isoPageKeys({}, 2), null);
  assert.equal(isoPageKeys(fixture(), 3), null);
  for (const mutate of [
    o => { delete o['obj:5 0 R']; },
    o => { o['obj:8 0 R'].value['/FontFile'] = '7 0 R'; },
    o => { o['obj:2 0 R'].value['/Parent'] = '2 0 R'; },
    o => { o['obj:1 0 R'].value['/OCProperties'] = {}; },
    o => { o['obj:1 0 R'].value['/OutputIntents'] = []; },
  ]) {
    const json = fixture(); mutate(json.qpdf[1]);
    assert.equal(isoPageKeys(json, 2), null);
  }
});

test('missing qpdf or invalid JSON retains the complete conversion fallback', async () => {
  assert.equal(await readIsoPageKeys('missing.pdf', 2, async () => { throw new Error('ENOENT'); }), null);
  assert.equal(await readIsoPageKeys('bad.pdf', 2, async () => ({ stdout: '{' })), null);
});

test('page cache has a byte bound and evicts the least recently used SVG', () => {
  const cache = new IsoPageCache(6);
  cache.set('a', Buffer.from('aaa')); cache.set('b', Buffer.from('bbb'));
  cache.get('a'); cache.set('c', Buffer.from('ccc'));
  assert.equal(cache.get('b'), undefined);
  assert.equal(cache.get('a').toString(), 'aaa');
  cache.set('large', Buffer.alloc(7));
  assert.equal(cache.get('large'), undefined);
  assert.equal(cache.bytes, 6);
});

test('reuse skips converters but returns every page in order and caches only complete runs', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'tdom-page-cache-test-'));
  try {
    const cache = new IsoPageCache(), calls = [];
    cache.set('same', Buffer.from('unchanged SVG'));
    const convert = async (_cmd, args) => { calls.push(Number(args[2])); writeFileSync(args.at(-1), 'new SVG'); };
    const paths = await renderIsoPages(dir, 'doc.pdf', 2, convert, cache, async () => ['same', 'new']);
    assert.deepEqual(calls, [2]);
    assert.deepEqual(paths.map(p => readFileSync(p, 'utf8')), ['unchanged SVG', 'new SVG']);
    await assert.rejects(renderIsoPages(dir, 'doc.pdf', 2, async (_cmd, args) => {
      if (args[2] === '2') throw new Error('conversion failed');
      writeFileSync(args.at(-1), 'uncommitted');
    }, cache, async () => ['uncommitted', 'failed']), /conversion failed/);
    assert.equal(cache.get('uncommitted'), undefined);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
