import test from 'node:test';
import assert from 'node:assert/strict';

await import('../web/canonical-anchor-raster.js');

const { validateVisualCutPage, ringPixelsUniform } = globalThis.TdomCanonicalAnchorRaster;

const box = (left, top, right, bottom) => ({ left, top, right, bottom });
const whiteRaster = (width, height) => {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let offset = 0; offset < data.length; offset += 4) {
    data.set([255, 255, 255, 255], offset);
  }
  return data;
};

test('VisualCut page masks require parallel contained, non-overlapping base masks', () => {
  assert.equal(validateVisualCutPage({
    masks: [box(0, 0, 6, 6), box(8, 0, 12, 6)],
    baseMasks: [box(1, 1, 5, 5), box(9, 1, 11, 5)],
  }), true);
  assert.equal(validateVisualCutPage({
    masks: [box(0, 0, 6, 6)],
    baseMasks: [],
  }), false, 'every expanded mask needs its ordinary base mask');
  assert.equal(validateVisualCutPage({
    masks: [box(0, 0, 6, 6)],
    baseMasks: [box(-1, 1, 5, 5)],
  }), false, 'the old-layout mask must be contained');
  assert.equal(validateVisualCutPage({
    masks: [box(0, 0, 6, 6), box(5, 0, 10, 6)],
    baseMasks: [box(1, 1, 4, 5), box(6, 1, 9, 5)],
  }), false, 'two erase regions may not overlap');
});

test('VisualCut exhaustively accepts a uniform added ring and rejects canonical ink', () => {
  const width = 6;
  const height = 6;
  const mask = box(0, 0, 6, 6);
  const baseMask = box(1, 1, 5, 5);
  const clean = whiteRaster(width, height);
  const args = { data: clean, width, height, sx: 1, sy: 1, mask, baseMask,
    background: [255, 255, 255] };
  assert.equal(ringPixelsUniform(args), true);

  const borderInk = clean.slice();
  borderInk.set([0, 0, 0, 255], (0 * width + 3) * 4);
  assert.equal(ringPixelsUniform({ ...args, data: borderInk }), false,
    'one unsafe border pixel rejects the whole cut');

  const oldLineInk = clean.slice();
  oldLineInk.set([0, 0, 0, 255], (3 * width + 3) * 4);
  assert.equal(ringPixelsUniform({ ...args, data: oldLineInk }), true,
    'pixels inside the ordinary base mask are replaced by the existing path');
});

test('VisualCut raster work is bounded before scanning pixels', () => {
  const data = whiteRaster(5, 5);
  assert.equal(ringPixelsUniform({
    data, width: 5, height: 5, sx: 1, sy: 1,
    mask: box(0, 0, 5, 5), baseMask: box(1, 1, 4, 4),
    background: [255, 255, 255], maxPixels: 24,
  }), false);
});
