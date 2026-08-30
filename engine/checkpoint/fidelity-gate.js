import { fnv1a } from '../hash.js';
import { classifyGalley, demoteFidelity } from './fidelity.js';
import { stripComments } from './safety.js';

// Margin placement: material lands OUTSIDE the galley box (page margin), so
// no per-block chunk can represent it — the block is typeset in-chain for
// its body text and demoted to CANONICAL_ONLY. \todo is todonotes
// (paper-draft review marks — marginpar underneath).
const MARGIN_RE = /\\(?:marginpar|marginnote|todo)\b/;
// LuaTeX represents included PDF/PNG/JPEG assets as backend image nodes,
// not necessarily pdf_literal whatsits. Older daemon builds therefore saw
// correct box dimensions but no `galley.gfx` bit and let the browser glyph
// layer draw an empty rectangle. Source-level inclusion is definitive: the
// whole block must come from TeX-derived pixels.
const EXTERNAL_GRAPHICS_RE = /\\includegraphics\*?\b/;

export function sourceRequiresCanonicalOnly(text) {
  return MARGIN_RE.test(stripComments(text));
}

/**
 * Visual fidelity gate, applied per adopted galley: classify every line
 * (safe-glyph vs exact-preview-required), merge any sticky verification
 * demotion, and derive whether the block needs a high-fidelity chunk.
 * Rescued blocks already carry print-identical chunks — the resident
 * RENDER path (dormant-page reship) must not overwrite them.
 */
export function applyFidelity(block, galley, { fonts, fidelityDemoted }) {
  let fid = classifyGalley(galley, fonts);
  const dem = fidelityDemoted.get(block.id);
  if (dem && dem.hash === fnv1a(block.text)) {
    fid = demoteFidelity(fid, dem.level);
  }
  // Margin placement (\marginpar / \marginnote / todonotes' \todo) writes
  // OUTSIDE the galley box — no per-block chunk can show it. The block
  // still typesets in-chain for its BODY text (layout stays exact), but
  // its pixels are canonical-only: the provisional layer never patches
  // this band, so the canonical page (margin note included) shows
  // through. This is what keeps \todo-bearing paper drafts structured
  // instead of demoting the whole document.
  if (sourceRequiresCanonicalOnly(block.text)) {
    // comment-stripped: a `% \todo{...}` must not blank the block's band
    fid = demoteFidelity(fid, 'canonical');
  }
  if (block.externalGraphics || EXTERNAL_GRAPHICS_RE.test(stripComments(block.text))) {
    fid = demoteFidelity(fid, 'exact');
    // Some LuaTeX builds expose PDF/PNG/JPEG inclusion without a backend
    // whatsit in the harvested float. Source inclusion is definitive, so
    // every float owned by this source block gets its own TeX-rendered
    // chunk as well. Otherwise a figure can leak through as an unscaled
    // browser rule while the canonical page is converging.
    for (const fl of galley?.floats ?? []) {
      fid.floats.set(fl.n, { exact: true, noBridge: true });
    }
  }
  block.fidelity = fid;
  block.needsRender = !block.rescued && !fid.canonicalOnly && fid.exact;
  block.units = null;
}
