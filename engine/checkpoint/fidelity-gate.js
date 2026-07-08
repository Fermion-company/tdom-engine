import { fnv1a } from '../hash.js';
import { classifyGalley, demoteFidelity } from './fidelity.js';

// Margin placement: material lands OUTSIDE the galley box (page margin), so
// no per-block chunk can represent it — the block is typeset in-chain for
// its body text and demoted to CANONICAL_ONLY. \todo is todonotes
// (paper-draft review marks — marginpar underneath).
const MARGIN_RE = /\\(?:marginpar|marginnote|todo)\b/;

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
  if (MARGIN_RE.test(block.text)) {
    fid = demoteFidelity(fid, 'canonical');
  }
  block.fidelity = fid;
  block.needsRender = !block.rescued && !fid.canonicalOnly && fid.exact;
  block.units = null;
}
