(function installTdomViewportMath(root) {
  const clampRatio = (value) => Math.max(0, Math.min(1, Number(value) || 0));

  const capturePageAnchor = ({ clientX, clientY, pageRect }) => {
    if (!pageRect || !(pageRect.width > 0) || !(pageRect.height > 0)) return null;
    return {
      clientX,
      clientY,
      xRatio: clampRatio((clientX - pageRect.left) / pageRect.width),
      yRatio: clampRatio((clientY - pageRect.top) / pageRect.height),
    };
  };

  const calculateAnchoredScroll = ({ scrollLeft, scrollTop, pageRect, anchor }) => ({
    left: scrollLeft + pageRect.left + anchor.xRatio * pageRect.width - anchor.clientX,
    top: scrollTop + pageRect.top + anchor.yRatio * pageRect.height - anchor.clientY,
  });

  root.TdomViewportMath = Object.freeze({
    capturePageAnchor,
    calculateAnchoredScroll,
  });
})(globalThis);
