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

/**
 * pdftocairo's arguments for one page of a PDF as an SVG of exactly that
 * page. Without the last two options pdftocairo fits the page to a "paper"
 * of the page's own size rounded down to whole points: it shrinks the page
 * until it fits and centres it. A block shipped as a page 17.455 pt high
 * came out 2.6 % smaller (17 / 17.455) and shifted, a one-line formula with
 * every glyph 4 to 19 bp from its place; an A4 page (595.276 x 841.89)
 * 0.05 % smaller, its last character on a line 0.6 bp left of where the PDF
 * has it; a B5 book page up to 1.6 bp off. Ghostscript and pdftocairo's own
 * bitmap output agree with the PDF. With them the first glyph of a test
 * line is at x = 62.362, y = 76.284, the numbers in the PDF's own Tm.
 * (The page comes first so that callers and tests can find it by position.)
 */
export function pdfPageSvgArgs(page, pdf, out) {
  return ['-svg', '-f', String(page), '-l', String(page), '-noshrink', '-nocenter', pdf, out];
}

export function r2(v) {
  return Math.round(v * 100) / 100;
}
