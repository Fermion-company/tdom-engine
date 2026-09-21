(function installCanonicalAnchorRaster(root) {
  const DEFAULT_MAX_PIXELS = 250000;

  const validBox = (box) => box &&
    [box.left, box.top, box.right, box.bottom].every(Number.isFinite) &&
    box.right > box.left && box.bottom > box.top;

  const boxInside = (inner, outer) => validBox(inner) && validBox(outer) &&
    inner.left >= outer.left && inner.right <= outer.right &&
    inner.top >= outer.top && inner.bottom <= outer.bottom;

  const overlaps = (left, right) => left.left < right.right && left.right > right.left &&
    left.top < right.bottom && left.bottom > right.top;

  const validateVisualCutPage = (page) => {
    const masks = page?.masks;
    const baseMasks = page?.baseMasks;
    if (!Array.isArray(masks) || !masks.length || !Array.isArray(baseMasks) ||
        baseMasks.length !== masks.length) return false;
    for (let index = 0; index < masks.length; index++) {
      if (!boxInside(baseMasks[index], masks[index])) return false;
      for (let other = 0; other < index; other++) {
        if (overlaps(masks[index], masks[other])) return false;
      }
    }
    return true;
  };

  /** Exhaustively inspect the additional old-raster area erased by a
   * VisualCut. Pixels inside the ordinary base mask are deliberately ignored;
   * every pixel in the added ring must composite to the sampled background. */
  const ringPixelsUniform = ({
    data,
    width,
    height,
    originX = 0,
    originY = 0,
    sx,
    sy,
    mask,
    baseMask,
    background,
    tolerance = 8,
    maxPixels = DEFAULT_MAX_PIXELS,
  } = {}) => {
    if (!(data instanceof Uint8ClampedArray) || !Number.isInteger(width) || width <= 0 ||
        !Number.isInteger(height) || height <= 0 || data.length !== width * height * 4 ||
        !Number.isFinite(originX) || !Number.isFinite(originY) || !(sx > 0) || !(sy > 0) ||
        !boxInside(baseMask, mask) || !Array.isArray(background) || background.length !== 3 ||
        !background.every(Number.isFinite) || !(tolerance >= 0) ||
        !Number.isInteger(maxPixels) || maxPixels <= 0 || width * height > maxPixels) return false;
    for (let row = 0; row < height; row++) {
      const pageTop = (originY + row) / sy;
      const pageBottom = (originY + row + 1) / sy;
      for (let column = 0; column < width; column++) {
        const pageLeft = (originX + column) / sx;
        const pageRight = (originX + column + 1) / sx;
        const intersectsMask = pageRight > mask.left && pageLeft < mask.right &&
          pageBottom > mask.top && pageTop < mask.bottom;
        const entirelyInsideBase = pageLeft >= baseMask.left && pageRight <= baseMask.right &&
          pageTop >= baseMask.top && pageBottom <= baseMask.bottom;
        if (!intersectsMask || entirelyInsideBase) continue;
        const offset = (row * width + column) * 4;
        const alpha = data[offset + 3] / 255;
        for (let channel = 0; channel < 3; channel++) {
          const composited = data[offset + channel] * alpha + background[channel] * (1 - alpha);
          if (Math.abs(composited - background[channel]) > tolerance) return false;
        }
      }
    }
    return true;
  };

  root.TdomCanonicalAnchorRaster = Object.freeze({
    DEFAULT_MAX_PIXELS,
    validateVisualCutPage,
    ringPixelsUniform,
  });
})(globalThis);
