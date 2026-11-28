// A formula the keystroke changed, shown before its own exact pixels exist.
//
// A line with a formula is shown composed while its picture is behind
// (exact-parts.js): its text as glyphs, each run that needs exact pixels as
// a cut-out of the picture in hand. That works while every such run is in
// that picture, which is to say while the keystroke stays out of the
// formula. A keystroke inside it makes a run the picture does not hold, and
// the paragraph stood as it was until the new picture landed: 100 to 160 ms.
//
// But a formula is glyphs and rules, and the engine knows where TeX put each
// of them (the galley) and has, from the pictures already made and checked
// against their galleys (render-chunks.js anchorGlyphs), the outline of
// every glyph it has drawn so far: the converter writes one outline per
// glyph of a font at a size and one <use> per glyph on the page, in the
// galley's order. So the picture of the changed formula can be put together
// from those outlines at the galley's positions, at once, and the line
// composed out of it exactly as it is out of a picture in hand. The real
// picture lands a moment later and takes its place, as it does today.
//
// Nothing is guessed: one glyph whose outline has not been seen in this
// font at this size, one run that is not mathematics, one rule without a
// size, and there is no such picture; the block is shown as before.

const SYMBOL = /<g id="(glyph-\d+-\d+)">\s*([\s\S]*?)\s*<\/g>/g;
const GLYPH_USE = /<use xlink:href="#(glyph-[^"]+)" x="(-?[\d.]+)" y="(-?[\d.]+)"\/>/g;
const COLOR = /^#[0-9a-fA-F]{6}$/;
// A document's formulas use a few hundred glyphs; this only bounds a
// document that sets whole pages in mathematics fonts.
const MAX_OUTLINES = 20000;
// A real render retires the synthetic SVG. If the block needs a different
// synthetic SVG later, its immutable image URL must still be new.
const lastSyntheticVersion = new WeakMap();
// Room around the galley's width for ink that hangs over its edge.
const SYNTH_PAD_BP = 12;

const fixed = (value) => String(Math.round(value * 1e6) / 1e6);

// The slot of a run's glyph in its font: what `t` says, or `gc` where `t`
// could not carry it (daemon.lua encode_runs).
const slotOf = (run, chars, index) => (Array.isArray(run.gc) ? run.gc[index] : chars[index].codePointAt(0));
const outlineKey = (run, slot) => `${run.f}|${slot}`;

/**
 * Remember the outline of every formula glyph in a picture whose glyphs
 * stand where `galley` says (an anchored picture: one <use> per galley
 * glyph, in order). Returns how many were new.
 */
export function learnOutlines(svg, galley, store) {
  if (!store || !galley || typeof svg !== 'string') return 0;
  const cut = svg.indexOf('</defs>');
  if (cut < 0) return 0;
  let symbols = null;
  const uses = svg.slice(cut).matchAll(GLYPH_USE);
  let learned = 0;
  for (const item of galley.items ?? []) {
    if (item.k !== 'box') continue;
    for (const run of item.runs ?? []) {
      if (run.rule || !run.t) continue;
      const chars = [...run.t];
      for (let i = 0; i < chars.length; i++) {
        const use = uses.next().value;
        if (!use) return learned; // (fewer glyphs than the galley: not the picture it was said to be)
        if (!run.m) continue;
        const slot = slotOf(run, chars, i);
        if (!Number.isSafeInteger(slot)) continue;
        const key = outlineKey(run, slot);
        if (store.has(key) || store.size >= MAX_OUTLINES) continue;
        symbols ??= new Map([...svg.slice(0, cut).matchAll(SYMBOL)].map((match) => [match[1], match[2]]));
        const outline = symbols.get(use[1]);
        if (outline === undefined) continue;
        store.set(key, outline);
        learned++;
      }
    }
  }
  return learned;
}

/**
 * The picture of every run of `galley` that needs exact pixels, put together
 * from outlines in `store`: { svg, wBp, logicalWBp, xBp, hBp }, laid out as a
 * rendered chunk is (the galley's left edge `-xBp` in, its top at 0). Null
 * when any such run cannot be drawn this way.
 */
export function synthesizeExactPicture(galley, fidelity, store, pad = SYNTH_PAD_BP) {
  if (!store?.size || !galley || !fidelity || !Number.isFinite(galley.w)) return null;
  const symbols = new Map(); // outline -> id in this picture
  const body = [];
  let y = 0;
  const items = galley.items ?? [];
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    if (item.k === 'glue' || item.k === 'kern') y += item.a ?? 0;
    if (item.k !== 'box') continue;
    const baseline = y + (item.h ?? 0);
    y += (item.h ?? 0) + (item.d ?? 0);
    if (!((fidelity.itemFlags?.[i] ?? 0) & 1)) continue;
    const exact = fidelity.exactRuns?.[i];
    if (!Array.isArray(exact) || item.chunk) return null;
    for (const k of exact) {
      const run = item.runs?.[k];
      if (!run || !Number.isFinite(run.x) || !Number.isFinite(baseline)) return null;
      const color = run.c ?? '#000000';
      if (!COLOR.test(color)) return null;
      if (run.rule) {
        // (dy is the rule's top from the baseline, h its whole height)
        const left = run.x + pad;
        const top = baseline + (run.dy ?? 0);
        if (!(run.w > 0) || !(run.h > 0) || !Number.isFinite(top)) return null;
        body.push(`<path fill="${color}" d="M ${fixed(left)} ${fixed(top)} L ${fixed(left + run.w)} ${fixed(top)} ` +
          `L ${fixed(left + run.w)} ${fixed(top + run.h)} L ${fixed(left)} ${fixed(top + run.h)} Z"/>`);
        continue;
      }
      if (!run.m || !run.t) return null;
      const chars = [...run.t];
      if (chars.length > 1 && (!Array.isArray(run.gp) || run.gp.length !== chars.length)) return null;
      if (Array.isArray(run.gc) && run.gc.length !== chars.length) return null;
      const at = baseline + (run.dy ?? 0);
      for (let g = 0; g < chars.length; g++) {
        const slot = slotOf(run, chars, g);
        const outline = Number.isSafeInteger(slot) ? store.get(outlineKey(run, slot)) : undefined;
        const offset = chars.length > 1 ? run.gp[g] : 0;
        if (outline === undefined || !Number.isFinite(offset) || !Number.isFinite(at)) return null;
        let id = symbols.get(outline);
        if (id === undefined) symbols.set(outline, id = symbols.size);
        body.push(`<g fill="${color}" fill-opacity="1"><use xlink:href="#glyph-s-${id}" x="${fixed(run.x + pad + offset)}" y="${fixed(at)}"/></g>`);
      }
    }
  }
  if (!body.length || !Number.isFinite(y) || !(y > 0)) return null;
  const width = galley.w + 2 * pad;
  const defs = [...symbols].map(([outline, id]) => `<g id="glyph-s-${id}">${outline}</g>`).join('\n');
  const svg = '<?xml version="1.0" encoding="UTF-8"?>\n' +
    `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${fixed(width)}pt" ` +
    `height="${fixed(y)}pt" viewBox="0 0 ${fixed(width)} ${fixed(y)}">\n<defs>\n<g>\n${defs}\n</g>\n</defs>\n${body.join('\n')}\n</svg>\n`;
  return { svg, wBp: width, logicalWBp: galley.w, xBp: -pad, hBp: y };
}

/** The key under which a block's put-together picture is kept among its chunks. */
export const synthChunkKey = (blockId) => `${blockId}~s`;

/**
 * The put-together picture of `block`'s current galley among `chunks`
 * (made now if need be), or null when it cannot be made. `chunks.outlines`
 * is the store learnOutlines fills.
 */
export function synthChunkFor(block, chunks) {
  const key = synthChunkKey(block.id);
  const held = chunks.get(key);
  if (held?.forGalley === block.galleyHash) return held;
  const picture = synthesizeExactPicture(block.galley, block.fidelity, chunks.outlines);
  if (!picture) {
    if (held) chunks.delete(key);
    return null;
  }
  const version = (lastSyntheticVersion.get(chunks) ?? 0) + 1;
  lastSyntheticVersion.set(chunks, version);
  const chunk = { ...picture, v: version, forGalley: block.galleyHash, synthetic: true };
  chunks.set(key, chunk);
  return chunk;
}
