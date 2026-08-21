// cheap "will want an exact preview chunk" scan for blocks with no fidelity
// verdict yet (checkpoint render-hold heuristic — a miss only costs the
// slower isolated render path)
const MATHY_RE =
  /\$|\\\[|\\\(|\\includegraphics\b|\\begin\{(equation|align|alignat|gather|multline|eqnarray|math|displaymath|cases|array|split|aligned|gathered|alignedat|tikzpicture)/;

// how many off-grid checkpoints may stay alive awaiting their block's chunk
const RENDER_HOLD_MAX = Number(process.env.TDOM_RENDER_HOLD_MAX || 8);

/** Will this block plausibly want an exact preview chunk? Known from its
 * last fidelity verdict; brand-new blocks get a cheap math/gfx scan. */
export function mayNeedRender(block) {
  if (block.fidelity) return !!block.needsRender;
  return MATHY_RE.test(block.text);
}

export function maybeHoldRenderCheckpoint(idx, block, renderHold) {
  const externalGraphic = !!block && /\\includegraphics\b/.test(block.text);
  // Math-heavy papers can fill every render hold before reaching a figure
  // near the end of the document. Unlike math, an image has no usable glyph
  // bridge at all, so reserve a warm checkpoint for it by evicting the
  // oldest latency-only hold. The normal checkpoint cap retires that peer.
  if (
    externalGraphic &&
    !renderHold.has(idx) &&
    renderHold.size >= RENDER_HOLD_MAX
  ) {
    renderHold.delete(renderHold.keys().next().value);
  }
  if (
    block &&
    !renderHold.has(idx) &&
    renderHold.size < RENDER_HOLD_MAX &&
    mayNeedRender(block)
  ) {
    renderHold.set(idx, block.id);
    return true;
  }
  return false;
}

export function releaseRenderHold(renderHold, idx) {
  return renderHold.delete(idx);
}
