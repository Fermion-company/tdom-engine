import test from 'node:test';
import assert from 'node:assert/strict';

await import('../web/viewport-math.js');

const { capturePageAnchor, calculateAnchoredScroll } = globalThis.TdomViewportMath;

test('TDOM zoom keeps the paper point beneath the trackpad gesture', () => {
  const anchor = capturePageAnchor({
    clientX: 300,
    clientY: 350,
    pageRect: { left: 100, top: 200, width: 400, height: 600 },
  });
  assert.deepEqual(anchor, {
    clientX: 300,
    clientY: 350,
    xRatio: 0.5,
    yRatio: 0.25,
  });
  assert.deepEqual(calculateAnchoredScroll({
    scrollLeft: 25,
    scrollTop: 300,
    pageRect: { left: 50, top: 100, width: 800, height: 1200 },
    anchor,
  }), {
    left: 175,
    top: 350,
  });
});

test('TDOM zoom clamps a gesture in the page margin to the paper edge', () => {
  assert.deepEqual(capturePageAnchor({
    clientX: 20,
    clientY: 900,
    pageRect: { left: 100, top: 200, width: 400, height: 600 },
  }), {
    clientX: 20,
    clientY: 900,
    xRatio: 0,
    yRatio: 1,
  });
});
