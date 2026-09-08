// Input geometry from the PDF's text operators, never browser font metrics.
// Advances include TJ kerning, character/word spacing, text matrices and CTM.
export function pdfEditGlyphs({ operatorList, viewport, commonObjs, OPS, Util }) {
  const identity = () => [1, 0, 0, 1, 0, 0];
  let s = { ctm: identity(), tm: identity(), x: 0, y: 0, lx: 0, ly: 0,
    size: 0, font: null, char: 0, word: 0, scale: 1, rise: 0, leading: 0, mode: 0 };
  const stack = [];
  const glyphs = [];
  const move = (x, y) => { s.x = s.lx += x; s.y = s.ly += y; };
  const show = (sequence) => {
    const font = s.font;
    if (!font || font.vertical || font.isType3Font || s.size <= 0) return;
    const matrix = Util.transform(viewport.transform, Util.transform(s.ctm, s.tm));
    const point = (x, y) => [matrix[0] * x + matrix[2] * y + matrix[4],
      matrix[1] * x + matrix[3] * y + matrix[5]];
    for (const glyph of sequence ?? []) {
      if (typeof glyph === 'number') { s.x -= glyph * s.size / 1000 * s.scale; continue; }
      if (!glyph || !Number.isFinite(glyph.width)) continue;
      const advance = glyph.width * s.size * (font.fontMatrix?.[0] ?? 0.001);
      const start = point(s.x, s.y + s.rise);
      const end = point(s.x + advance * s.scale, s.y + s.rise);
      const height = Math.hypot(matrix[2], matrix[3]) * s.size;
      // Horizontal writing on the displayed page. A rotated glyph is not
      // assigned a misleading horizontal caret.
      if (Math.abs(start[1] - end[1]) < 0.05 && end[0] > start[0] && (s.mode & 3) !== 3) {
        const text = String(glyph.unicode ?? '').normalize('NFKC');
        if (text && !/^[\s\uFFFD\uE000-\uF8FF]+$/u.test(text)) {
          const ascent = Number.isFinite(font.ascent) ? font.ascent : 0.8;
          const descent = Number.isFinite(font.descent) ? font.descent : -0.2;
          glyphs.push({ text, left: start[0], right: end[0],
            top: start[1] - height * ascent, bottom: start[1] - height * descent,
            baseline: start[1] });
        }
      }
      s.x += (advance + s.char + (glyph.isSpace ? s.word : 0)) * s.scale;
    }
  };
  for (let i = 0; i < operatorList.fnArray.length; i++) {
    const op = operatorList.fnArray[i], a = operatorList.argsArray[i] ?? [];
    if (op === OPS.save) stack.push({ ...s });
    else if (op === OPS.restore) s = stack.pop() ?? s;
    else if (op === OPS.transform) s.ctm = Util.transform(s.ctm, a);
    else if (op === OPS.paintFormXObjectBegin) {
      stack.push({ ...s });
      if (a[0]) s.ctm = Util.transform(s.ctm, a[0]);
    } else if (op === OPS.paintFormXObjectEnd) s = stack.pop() ?? s;
    else if (op === OPS.beginText) { s.tm = identity(); s.x = s.y = s.lx = s.ly = 0; }
    else if (op === OPS.setTextMatrix) { s.tm = a.length === 1 ? a[0] : a; s.x = s.y = s.lx = s.ly = 0; }
    else if (op === OPS.setFont) { s.size = Number(a[1]); s.font = commonObjs.get(a[0]); }
    else if (op === OPS.setCharSpacing) s.char = Number(a[0]);
    else if (op === OPS.setWordSpacing) s.word = Number(a[0]);
    else if (op === OPS.setHScale) s.scale = Number(a[0]) / 100;
    else if (op === OPS.setTextRise) s.rise = Number(a[0]);
    else if (op === OPS.setTextRenderingMode) s.mode = Number(a[0]);
    else if (op === OPS.setLeading) s.leading = -Number(a[0]);
    else if (op === OPS.moveText) move(Number(a[0]), Number(a[1]));
    else if (op === OPS.setLeadingMoveText) { s.leading = Number(a[1]); move(Number(a[0]), s.leading); }
    else if (op === OPS.nextLine) move(0, s.leading);
    else if (op === OPS.showText) show(a[0]);
    else if (op === OPS.nextLineShowText) { move(0, s.leading); show(a[0]); }
    else if (op === OPS.nextLineSetSpacingShowText) {
      s.word = Number(a[0]); s.char = Number(a[1]); move(0, s.leading); show(a[2]);
    }
  }
  return glyphs;
}
