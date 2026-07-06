// Unit tests for the Visual Fidelity Gate (pure classification — no TeX).
//
// The gate's contract: anything that could make browser glyph output differ
// from LuaLaTeX (math, legacy/twin fonts, unencoded glyphs, unservable font
// files) classifies DOWN to exact-preview-required; only provably-identical
// lines stay safe-glyph. Verification demotions are strictly stronger.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyGalley,
  lineFidelity,
  demoteFidelity,
  fontTier,
  SAFE_GLYPH,
  EXACT_PREVIEW,
  CANONICAL_ONLY,
} from '../engine/checkpoint/fidelity.js';

const fonts = new Map([
  [1, { tier: 'native' }], // the actual TeX .otf served to the browser
  [2, { tier: 'twin' }], // legacy CM substituted by its LM twin
  [3, { tier: 'none' }], // unservable (pfb without twin, missing file)
  [4, { tier: 'native', mth: 1 }], // OpenType MATH font (unicode-math)
]);

const box = (runs, flags = {}) => ({ k: 'box', h: 10, d: 2, w: 300, runs, ...flags });
const textRun = (f, t = 'hello') => ({ f, t, x: 0, dy: 0, s: 10 });
const rule = () => ({ rule: true, x: 0, dy: 0, w: 100, h: 0.4 });

test('plain text on a served font is safe-glyph', () => {
  const g = { items: [box([textRun(1)]), box([textRun(1), rule()])], floats: [] };
  const fid = classifyGalley(g, fonts);
  assert.equal(fid.level, SAFE_GLYPH);
  assert.equal(fid.exact, false);
  assert.equal(fid.exactLines, 0);
  assert.deepEqual(fid.itemFlags, [0, 0]);
});

test('a math line (daemon x flag) is exact-preview-required, bridge allowed', () => {
  const g = { items: [box([textRun(1)]), box([textRun(1)], { x: 1 })], floats: [] };
  const fid = classifyGalley(g, fonts);
  assert.equal(fid.level, EXACT_PREVIEW);
  assert.equal(fid.exactLines, 1);
  assert.deepEqual(fid.itemFlags, [0, 1]); // only the math line maps to the chunk
  assert.equal(fid.noBridge, false);
});

test('unencoded glyphs (daemon xb flag) forbid even the glyph bridge', () => {
  const g = { items: [box([textRun(1)], { x: 1, xb: 1 })], floats: [] };
  const fid = classifyGalley(g, fonts);
  assert.equal(fid.level, EXACT_PREVIEW);
  assert.equal(fid.itemFlags[0] & 2, 2);
  assert.equal(fid.noBridge, true);
});

test('twin-substituted fonts demand exact preview (substitution is not exact)', () => {
  const fid = lineFidelity(box([textRun(2)]), fonts);
  assert.equal(fid.exact, true);
  assert.equal(fid.noBridge, false); // the twin may bridge the render latency
});

test('unservable fonts demand exact preview with no bridge', () => {
  const fid = lineFidelity(box([textRun(3)]), fonts);
  assert.equal(fid.exact, true);
  assert.equal(fid.noBridge, true);
});

test('OpenType MATH font glyphs are math, whatever the file format', () => {
  const fid = lineFidelity(box([textRun(4)]), fonts);
  assert.equal(fid.exact, true);
});

test('unknown font ids default DOWN: exact, no bridge', () => {
  const fid = lineFidelity(box([textRun(99)]), fonts);
  assert.equal(fid.exact, true);
  assert.equal(fid.noBridge, true);
  assert.equal(fontTier(undefined), 'none');
});

test('rules alone never demote a line (they are exact by construction)', () => {
  const fid = lineFidelity(box([rule()]), fonts);
  assert.equal(fid.exact, false);
});

test('pdf-literal galleys (gfx) are block-exact', () => {
  const g = { gfx: true, items: [box([textRun(1)])], floats: [] };
  const fid = classifyGalley(g, fonts);
  assert.equal(fid.level, EXACT_PREVIEW);
  assert.equal(fid.blockExact, true);
});

test('floats and footnote inserts classify independently of the body', () => {
  const g = {
    items: [
      box([textRun(1)]),
      { k: 'ins', items: [box([textRun(1)], { x: 1 })] },
      { k: 'ins', items: [box([textRun(1)])] },
    ],
    floats: [
      { n: 1, items: [box([textRun(1)])] },
      { n: 2, items: [box([textRun(2)])] },
    ],
  };
  const fid = classifyGalley(g, fonts);
  assert.equal(fid.level, EXACT_PREVIEW);
  assert.equal(fid.exactLines, 0, 'body lines stay safe');
  assert.ok(fid.ins.get(0)?.exact, 'math footnote flagged');
  assert.equal(fid.ins.has(1), false, 'plain footnote untouched');
  assert.ok(fid.floats.get(2)?.exact, 'twin-font float flagged');
  assert.equal(fid.floats.has(1), false, 'plain float untouched');
});

test('gfx floats stay exact even when their glyph runs look safe', () => {
  const g = { items: [], floats: [{ n: 1, gfx: true, items: [box([textRun(1)])] }] };
  const fid = classifyGalley(g, fonts);
  assert.ok(fid.floats.get(1)?.exact);
});

test('verification demotion: exact strips glyph privileges, canonical strips everything', () => {
  const base = classifyGalley({ items: [box([textRun(1)])], floats: [] }, fonts);
  const exact = demoteFidelity(base, 'exact');
  assert.equal(exact.level, EXACT_PREVIEW);
  assert.equal(exact.blockExact, true);
  assert.equal(exact.noBridge, true);
  assert.equal(exact.canonicalOnly, false);
  const canon = demoteFidelity(base, 'canonical');
  assert.equal(canon.level, CANONICAL_ONLY);
  assert.equal(canon.canonicalOnly, true);
});
