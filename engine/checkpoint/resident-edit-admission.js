import { SAFE_GLYPH } from './fidelity.js';

const TEX_EDIT_STRUCTURE = /[\\$%{}&#^_~\r\n]/;
const TEX_BLOCK_STRUCTURE = /[\\$%{}&#^_~]/;
const ATOMIC_LAYOUT = /\\(?:begin|end)\s*\{|\\(?:columnbreak|setcolumnsep|onecolumn|twocolumn)\b/;

export function bindEditContext(engine, text, context) {
  if (!context || context.baseSrcRev !== engine.srcRev) return null;
  const source = context.file === engine.file ? text : engine.includes?.get(context.file)?.text;
  return typeof source === 'string' && source === context.after ? context : null;
}

/**
 * A shipping-exact document may still run an independent plain paragraph
 * through the resident foreground path. This grants only a candidate for
 * the existing canonical-anchor proof; it never grants physical page-tree
 * authority to the resident paginator.
 */
export function classifyResidentEdit(engine, {
  text,
  editContext,
  oldBlocks,
  dirtySource,
  rebooted,
}) {
  const exactOnly = (reason) => Object.freeze({ kind: 'exact-only', reason });
  const context = bindEditContext(engine, text, editContext);
  if (!context) return exactOnly('stale-or-missing-edit-context');
  if (rebooted) return exactOnly('resident-reboot');
  if (engine.pendingChain) return exactOnly('resident-chain-pending');
  if (dirtySource.size !== 1) return exactOnly('multi-block-edit');

  const file = context.file === engine.file ? null : context.file;
  const ownsEdit = (block, end) => (block.file ?? null) === file && !block.sourceParts &&
    context.start >= Number(block.start) && end <= Number(block.end);
  const oldBlock = oldBlocks.find((block) => ownsEdit(block, context.end));
  const newEnd = context.start + context.replacement.length;
  const block = engine.blocks.find((candidate) =>
    candidate.id === oldBlock?.id && ownsEdit(candidate, newEnd));
  if (!oldBlock || !block || !dirtySource.has(block.id)) return exactOnly('block-boundary-edit');
  if (block.includeStart || block.includeEnd || block.subfileStart || block.subfileEnd) {
    return exactOnly('included-source');
  }
  if (block.structuralSinks?.length || oldBlock.structuralSinks?.length ||
      ATOMIC_LAYOUT.test(oldBlock.text) || ATOMIC_LAYOUT.test(block.text)) {
    return exactOnly('atomic-layout-region');
  }
  if (TEX_EDIT_STRUCTURE.test(context.replacement) ||
      TEX_EDIT_STRUCTURE.test(context.before.slice(context.start, context.end)) ||
      TEX_BLOCK_STRUCTURE.test(oldBlock.text) || TEX_BLOCK_STRUCTURE.test(block.text)) {
    return exactOnly('tex-bearing-paragraph');
  }
  if (!oldBlock.galley || oldBlock.fidelity?.level !== SAFE_GLYPH ||
      oldBlock.needsRender || oldBlock.gfx || oldBlock.rescued || oldBlock.galley.tdomColdPreview) {
    return exactOnly('resident-witness-unavailable');
  }
  return Object.freeze({ kind: 'probe', blockId: block.id });
}
