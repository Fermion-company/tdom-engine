import assert from 'node:assert/strict';
import test from 'node:test';

import { buildPages } from '../engine/checkpoint/pagebuilder.js';

const unit = (blockId, h, d = 0) => ({
  blockId,
  li: 0,
  h,
  d,
  ln: { descent: d, boxH: h, runs: [], gfxChunk: null },
});

test('final vfil accounts for the last box depth before forcing a page', () => {
  const stream = [
    { t: 'box', u: unit('first', 80) },
    { t: 'glue', a: 0, st: 20, sh: 0, sto: 0, sho: 0 },
    { t: 'box', u: unit('middle', 10) },
    { t: 'pen', v: -300 },
    { t: 'box', u: unit('deep-last', 6, 5) },
  ];
  const geo = {
    textheight: 100,
    maxdepth: 10,
    topskip: { w: 0, st: 0, sh: 0, sto: 0, sho: 0 },
    raggedbottom: 1,
  };

  const pages = buildPages(stream, geo);

  assert.equal(pages.length, 2);
  assert.deepEqual(pages[0].identity.map((u) => u.blockId), ['first', 'middle']);
  assert.deepEqual(pages[1].identity.map((u) => u.blockId), ['deep-last']);
});

test('glue reapplies a negative maxdepth before the final eject', () => {
  const stream = [
    { t: 'box', u: unit('first', 80) },
    { t: 'glue', a: 0, st: 20, sh: 0, sto: 0, sho: 0 },
    { t: 'box', u: unit('middle', 10) },
    { t: 'pen', v: -300 },
    { t: 'box', u: unit('last', 10) },
    { t: 'pen', v: 10000 },
  ];
  const geo = {
    textheight: 100,
    maxdepth: -2,
    topskip: { w: 0, st: 0, sh: 0, sto: 0, sho: 0 },
    raggedbottom: 1,
  };

  const pages = buildPages(stream, geo);

  assert.equal(pages.length, 2);
  assert.deepEqual(pages[0].identity.map((u) => u.blockId), ['first', 'middle']);
  assert.deepEqual(pages[1].identity.map((u) => u.blockId), ['last']);
});

test('a consumed newpage eject does not split a deferred top float from following text', () => {
  const topFloat = {
    id: 'figure-1',
    blockId: 'figure',
    type: 'figure',
    place: { bits: 2, bang: false },
    h: 30,
    d: 0,
    units: [],
  };
  const stream = [
    { t: 'box', u: unit('first', 80) },
    { t: 'fm', f: topFloat, vmode: true },
    { t: 'eject', v: -10000 },
    { t: 'box', u: unit('following', 10) },
  ];
  const geo = {
    textheight: 100,
    maxdepth: 10,
    topskip: { w: 0, st: 0, sh: 0, sto: 0, sho: 0 },
    textfloatsep: { w: 10, st: 0, sh: 0, sto: 0, sho: 0 },
    topfraction: 0.7,
    textfraction: 0.2,
    raggedbottom: 1,
  };

  const pages = buildPages(stream, geo);

  assert.equal(pages.length, 2);
  assert.deepEqual(pages[0].identity.map((u) => u.blockId), ['first']);
  assert.deepEqual(pages[1].topFloats.map((f) => f.id), ['figure-1']);
  assert.deepEqual(pages[1].identity.map((u) => u.blockId), ['figure', 'following']);
});
