/**
 * Normalize a pdftocairo page SVG to the exact box extent (bp): content is
 * anchored at the origin by the driver's \hoffset/\voffset, so setting the
 * viewBox crops precisely regardless of the page size the ship went out at.
 */
export function cropSvg(svg, wBp, hBp) {
  return svg.replace(
    /<svg([^>]*?)width="[^"]*" height="[^"]*" viewBox="[^"]*"/,
    `<svg$1width="${wBp}pt" height="${hBp}pt" viewBox="0 0 ${wBp} ${hBp}"`
  );
}

/** cropSvg with an origin offset — for real \@outputpage ships, whose content
 * sits at (oddsidemargin, topmargin+headheight+headsep) under \hoffset=-1in. */
export function cropSvgAt(svg, xBp, yBp, wBp, hBp) {
  return svg.replace(
    /<svg([^>]*?)width="[^"]*" height="[^"]*" viewBox="[^"]*"/,
    `<svg$1width="${wBp}pt" height="${hBp}pt" viewBox="${xBp} ${yBp} ${wBp} ${hBp}"`
  );
}

export function r2(v) {
  return Math.round(v * 100) / 100;
}
