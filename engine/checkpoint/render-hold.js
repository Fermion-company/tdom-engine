// cheap "will want an exact preview chunk" scan for blocks with no fidelity
// verdict yet (checkpoint render-hold heuristic — a miss only costs the
// slower isolated render path)
const MATHY_RE =
  /\$|\\\[|\\\(|\\begin\{(equation|align|gather|multline|eqnarray|math|displaymath|tikzpicture)/;

// how many off-grid checkpoints may stay alive awaiting their block's chunk
const RENDER_HOLD_MAX = Number(process.env.TDOM_RENDER_HOLD_MAX || 8);

/** Will this block plausibly want an exact preview chunk? Known from its
 * last fidelity verdict; brand-new blocks get a cheap math/gfx scan. */
export function mayNeedRender(block) {
  if (block.fidelity) return !!block.needsRender;
  return MATHY_RE.test(block.text);
}

export function maybeHoldRenderCheckpoint(idx, block, renderHold) {
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
