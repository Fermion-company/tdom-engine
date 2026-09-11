import { SAFE_GLYPH, fontTier } from './fidelity.js';
import { sourceBoxLineCommands } from './display-list.js';
import {
  changedGalleyLines,
  changedMixedGalleyLines,
  galleyLineWitnesses,
  galleyMixedLineWitnesses,
  mixedGalleyFrame,
} from './canonical-paint-index.js';
import path from 'node:path';

const PLAIN_FLOW_UNSAFE = /[\\$%{}&#^_~]/;
const ANCHOR_BLEED_BP = 2;
// Budgets from edit acceptance; a proof or publication past them falls back
// to the canonical build.
export const ANCHOR_PROOF_BUDGET_MS = 700;
export const ANCHOR_PUBLISH_BUDGET_MS = 850;
const SP_PER_BP = 65781.76;

/** Return the one contiguous edit between two plain-text snapshots. */
export function singlePlainTextDelta(before, after) {
  const left = String(before ?? '');
  const right = String(after ?? '');
  if (left === right) return null;
  let start = 0;
  while (start < left.length && start < right.length && left[start] === right[start]) start++;
  let oldEnd = left.length;
  let newEnd = right.length;
  while (oldEnd > start && newEnd > start && left[oldEnd - 1] === right[newEnd - 1]) {
    oldEnd--;
    newEnd--;
  }
  const removed = left.slice(start, oldEnd);
  const text = right.slice(start, newEnd);
  if (/[\r\n]/.test(removed) || /[\r\n]/.test(text) ||
      PLAIN_FLOW_UNSAFE.test(removed) || PLAIN_FLOW_UNSAFE.test(text)) return null;
  return { start, end: oldEnd, text };
}

/** Freeze the pre-edit resident witness while that exact source is still the
 * canonical generation. The server calls this inside its serialized edit
 * critical section, before engine.edit() can replace the galley. */
export function captureCanonicalAnchorBase({ blocks, domBlocks, edit, certificate, diagnostics = null }) {
  const reject = (reason) => {
    if (diagnostics) diagnostics.reason = reason;
    return null;
  };
  const start = Number(edit?.start);
  const end = Number(edit?.end);
  if (![start, end].every(Number.isFinite) || end < start || !certificate?.id) return reject('base-edit-span');
  const editFile = typeof edit?.file === 'string' ? path.resolve(edit.file) : null;
  if (editFile && typeof edit?.canonicalInputPath !== 'string') return reject('base-child-input');
  if (editFile && blocks.some((item) => item.sourceParts?.some((part) =>
    typeof part.file === 'string' && path.resolve(part.file) === editFile &&
    start >= Number(part.start) && end <= Number(part.end)))) return reject('base-shared-child');
  const candidates = blocks.filter((item) => {
    if (item.sourceParts || start < Number(item.start) || end > Number(item.end)) return false;
    if (!editFile) return !item.file;
    return typeof item.file === 'string' && path.resolve(item.file) === editFile;
  });
  if (editFile ? candidates.length !== 1 : candidates.length === 0) return reject('base-block');
  const block = candidates[0];
  const dom = domBlocks.find((item) => item.id === block?.id);
  if (!block || !dom) return reject('base-block');
  const plain = !hasGalleySideEffects(block.galley) && block.fidelity?.level === SAFE_GLYPH;
  if (editFile && (typeof dom.source?.file !== 'string' || path.resolve(dom.source.file) !== editFile)) return reject('base-dom-file');
  const plainWitnesses = plain ? galleyLineWitnesses(block.galley) : null;
  const mixed = plainWitnesses ? null : mixedAnchorFrame(block, diagnostics);
  const lineWitnesses = plainWitnesses ?? mixed?.lineWitnesses;
  if (!lineWitnesses) return plain ? reject('base-plain-witness') : null;
  const structuralStateVec = canonicalAnchorStructuralState(block.stateVec);
  if (structuralStateVec === null) return reject('base-structural-state');
  return {
    blockId: block.id,
    blockHash: block.hash,
    galleyHash: block.galleyHash,
    stateVec: JSON.stringify(block.stateVec ?? null),
    structuralStateVec,
    file: editFile,
    span: editFile
      ? { start: Number(block.start), end: Number(block.end) }
      : { ...dom.span },
    canonicalInputPath: typeof edit?.canonicalInputPath === 'string'
      ? path.resolve(edit.canonicalInputPath)
      : null,
    source: structuredClone(dom.source),
    lineWitnesses: structuredClone(lineWitnesses),
    frame: mixed?.frame ?? null,
    certificate: { ...certificate },
  };
}

/** A block whose plain lines sit among opaque boxes (a heading box, framed
 * material, graphics) or declare side effects (a toc line, labels) may still
 * anchor an edit to one of its plain lines: the frame freezes everything
 * else, and the plan requires it byte-identical after the edit. */
function mixedAnchorFrame(block, diagnostics = null) {
  const reject = (reason) => {
    if (diagnostics) diagnostics.reason = reason;
    return null;
  };
  const galley = block.galley;
  if (!galley || galley.tdomFrozen || galley.tdomDeferred || block.fidelity?.canonicalOnly) return reject('mixed-unavailable');
  // Only a resident harvest fingerprints paint whatsits per box (fx), keeps
  // the state trail and contribution epochs, and reports active characters;
  // with one active, "plain" text runs macros.
  if (block.rescued || galley.closure !== 'native') return reject('mixed-not-native');
  if (galley.tdomActive) return reject('mixed-active-chars');
  if (typeof galley.trail !== 'string' || !Array.isArray(galley.epochs) ||
      galley.epochs.length !== (galley.items ?? []).length) return reject('mixed-no-trail');
  const lineWitnesses = galleyMixedLineWitnesses(galley);
  const frame = lineWitnesses ? mixedGalleyFrame(galley, lineWitnesses) : null;
  return frame ? { lineWitnesses, frame } : reject('mixed-no-witness');
}

/** A changed plain line of a mixed block must itself be a safe glyph line:
 * fidelity flags are per galley item, the witnesses per box ordinal. */
function mixedLinesPaintSafely(block, lineIndexes) {
  const flags = block.fidelity?.itemFlags;
  if (!Array.isArray(flags)) return false;
  const boxItems = [];
  (block.galley?.items ?? []).forEach((item, index) => {
    if (item?.k === 'box') boxItems.push(index);
  });
  return lineIndexes.every((line) => Number.isInteger(boxItems[line]) && (flags[boxItems[line]] ?? 0) === 0);
}

/** The frame freezes every opaque box, so the canonical page holds exactly
 * their resident glyphs. SyncTeX cannot say which source line a line's text
 * came from (line boxes and the glue inside them carry the paragraph's
 * closing line), so provenance is by content instead: when no opaque box
 * paints a plain witness's glyph sequence, no line inside framed material
 * can pass for that prose line in the proof. */
function opaqueTextHoldsWitness(galley, witnesses) {
  const texts = [];
  let box = -1;
  for (const item of galley?.items ?? []) {
    if (item?.k !== 'box') continue;
    box++;
    if (witnesses[box]) continue;
    texts.push((item.runs ?? []).filter((run) => !run.rule && run.t)
      .map((run) => String(run.t).normalize('NFC')).join('').replace(/\s/gu, ''));
  }
  return witnesses.some((witness) => witness && texts.some((text) => text.includes(witness.paintText)));
}

const INCOMPARABLE_TEXT = /[\uE000-\uF8FF\uFFFD\u{F0000}-\u{10FFFF}]/u;

/** The content provenance compares resident run text; the proof compares
 * canonical ToUnicode text. Opaque text counts only where the two are the
 * same representation: native font files, no remapped or math glyphs. */
function opaqueTextComparable(galley, witnesses, fonts) {
  if (!(fonts instanceof Map)) return false;
  let box = -1;
  for (const item of galley?.items ?? []) {
    if (item?.k !== 'box') continue;
    box++;
    if (witnesses[box]) continue;
    for (const run of item.runs ?? []) {
      if (run.rule || !run.t) continue;
      const meta = fonts.get(run.f);
      if (run.m || fontTier(meta) !== 'native' || meta.remap || meta.mth || meta.omx ||
          INCOMPARABLE_TEXT.test(String(run.t))) return false;
    }
  }
  return true;
}

// Shipout filters add paint after the resident's harvest; node-list filters
// see typed text. Each registration below is understood, by exact callback
// and description: LuaTeX-ja and luaotfload shape and space glyphs and lines
// (the resident runs them too, so the harvest has their output), lua-ul adds
// its rules at hpack/vpack (harvested), ltj.direction resolves LuaTeX-ja's
// direction nodes (a rotated tate line fails the proof's horizontal-matrix
// check), and luacolor colors attribute-carrying nodes at shipout (a
// repainted line must carry none, see `ca`). Anything else, under any name,
// keeps the canonical build.
const KNOWN_PAINT_CALLBACKS = {
  pre_shipout_filter: new Set(['ltj.direction', 'luacolor.process']),
  pre_linebreak_filter: new Set(['ltj.adjust_icflag', 'ltj.set_stack_level',
    'luaotfload.node_processor', 'ltj.main']),
  post_linebreak_filter: new Set(['luaotfload.harf.finalize_vlist', 'ltj.create_dir_whatsit',
    'ltj.lineskip']),
  hpack_filter: new Set(['ltj.adjust_icflag', 'ltj.set_stack_level', 'luaotfload.node_processor',
    'ltj.main', 'luaotfload.harf.finalize_hlist', 'ltj.create_dir_whatsit', 'add underlines to list']),
  vpack_filter: new Set(['ltj.direction', 'add underlines to list']),
  pre_output_filter: new Set(['ltj.direction']),
  append_to_vlist_filter: new Set(['ltj.lineskip']),
  hyphenate: new Set(['ltj.hyphenate']),
};

/** Every paint callback the document has registered in this generation: the
 * preamble's (GEO) and each galley's later ones. A block without a galley
 * has run nothing the resident saw, so the set is unknown. */
function documentPaintCallbacks(geometry, blocks) {
  const boot = geometry?.paintCallbacks;
  if (boot !== 'none' && (!boot || typeof boot !== 'object')) return null;
  const callbacks = new Map();
  const merge = (registered) => Object.entries(registered).every(([name, descriptions]) => {
    if (!Array.isArray(descriptions)) return false;
    const known = callbacks.get(name) ?? new Set();
    for (const description of descriptions) known.add(String(description));
    callbacks.set(name, known);
    return true;
  });
  if (boot !== 'none' && !merge(boot)) return null;
  for (const block of blocks ?? []) {
    const late = block.galley?.paintLate;
    if (!block.galley || late != null && (typeof late !== 'object' || !merge(late))) return null;
  }
  return callbacks;
}

function paintCallbacksKnown(callbacks) {
  if (!callbacks) return false;
  for (const [name, descriptions] of callbacks) {
    const known = Object.hasOwn(KNOWN_PAINT_CALLBACKS, name) ? KNOWN_PAINT_CALLBACKS[name] : null;
    if (!known || [...descriptions].some((description) => !known.has(description))) return false;
  }
  return true;
}

/** The frame's trail proves the state after the edited paragraph; inside it,
 * code after the edit reads horizontal-mode state no sample sees. Every
 * contribution that carries a changed line (its paragraph, with any display,
 * \vadjust or insert material it moved) must therefore paint only what the
 * harvest reads: no paint whatsit, shipout color, float or insert. */
function editedContributionsReadable(galley, lineIndexes) {
  const items = galley?.items ?? [];
  const epochs = galley?.epochs;
  const boxes = [];
  items.forEach((item, index) => {
    if (item?.k === 'box') boxes.push(index);
  });
  const edited = new Set();
  for (const line of lineIndexes) {
    const epoch = epochs?.[boxes[line]];
    if (!Number.isInteger(epoch) || epoch <= 0) return false;
    edited.add(epoch);
  }
  return items.every((item, index) => !edited.has(epochs[index]) ||
    item?.k !== 'ins' && item?.k !== 'fm' && !(item?.k === 'box' && (item.fx || item.ca || item.fm)));
}

/** luacolor writes a node's color only at shipout: a line whose glyphs or
 * rules carry its attribute (ca) paints a color the resident runs lack. */
function linesCarryShipoutColor(galley, lineIndexes) {
  const boxes = (galley?.items ?? []).filter((item) => item?.k === 'box');
  return lineIndexes.some((line) => boxes[line]?.ca);
}

/**
 * Plan the deliberately narrow mixed-generation preview we permit.  A
 * resident-TeX prose suffix may be painted over the immediately preceding
 * canonical generation only when the source edit is inside a discovered
 * visible-text region and unchanged TeX line boxes prove the boundary.  The
 * canonical generation supplies the physical page address; provisional page
 * numbers never do.
 */
export function planTerminalCanonicalAnchor({
  blocks,
  domBlocks,
  report,
  geometry,
  lineage = null,
  edit = null,
  baseSnapshot = null,
  inputEpoch = null,
  acceptedAt = performance.now(),
  clientEditAtEpochMs = null,
  paintContext = null,
  diagnostics = null,
}) {
  // Every refusal names its check: the preview then silently waits for the
  // canonical build, and a reason in the report is the only trace of why.
  const reject = (reason) => {
    if (diagnostics) diagnostics.reason = reason;
    return null;
  };
  const canonical = report?.canonical;
  const canonicalAnchorPolicy = report?.previewPolicy === 'canonical-anchor';
  const residentEditCandidate = report?.residentEditCandidate === true;
  if (report?.mode !== 'structured' || !canonical?.id) return reject('no-structured-canonical');
  if (!canonicalAnchorPolicy && !residentEditCandidate &&
      canonical.pageCount === report.stats?.pageCount) return reject('not-needed');
  if (report.dirtySourceNodes?.length !== 1) return reject('dirty-blocks');

  const blockId = String(report.dirtySourceNodes[0]).replace(/^src-/, '');
  const immediateBase = canonical.rev === report.srcRev - 1;
  const continuedBase = lineage &&
    lineage.blockId === blockId &&
    lineage.baseGeneration === canonical.id &&
    lineage.baseRev === canonical.rev &&
    lineage.lastSrcRev === report.srcRev - 1 &&
    lineage.baseSnapshot;
  if (!immediateBase && !continuedBase) return reject('base-generation');
  const block = blocks.find((item) => item.id === blockId);
  const dom = domBlocks.find((item) => item.id === blockId);
  const base = immediateBase ? baseSnapshot : lineage.baseSnapshot;
  if (!block || !dom) return reject('block-missing');
  if (!base) return reject('no-base');
  if (base.blockId !== blockId ||
      base.certificate?.id !== canonical.id || base.certificate?.rev !== canonical.rev) return reject('base-mismatch');
  const editFile = typeof edit?.file === 'string' ? path.resolve(edit.file) : null;
  const blockFile = typeof block.file === 'string' ? path.resolve(block.file) : null;
  const baseFile = typeof base.file === 'string' ? path.resolve(base.file) : null;
  if (block.sourceParts || editFile !== blockFile || baseFile !== blockFile) return reject('file-mismatch');
  const mixed = typeof base.frame === 'string';
  if (mixed) {
    // The resident's exact chunk is irrelevant here: only plain lines are
    // repainted, and everything else must be the same TeX output as the base.
    const frame = mixedAnchorFrame(block);
    if (!frame || frame.frame !== base.frame) return reject('mixed-frame-changed');
  } else {
    if (block.fidelity?.level !== SAFE_GLYPH || block.needsRender) return reject('not-safe-glyph');
    if (hasGalleySideEffects(block.galley)) return reject('side-effects');
  }
  // Plain text legitimately changes the three volatile paragraph-tail
  // locals (prevdepth, nobreak and lastskip).  Requiring the complete exit
  // vector to stay byte-identical therefore rejects ordinary prose based on
  // the depth of its final glyph.  Counters plus the active column mode and
  // width remain a hard proof boundary; only those three documented locals
  // are excluded from the canonical-anchor structural witness.
  if (canonicalAnchorStructuralState(block.stateVec) !== base.structuralStateVec) return reject('structural-state');

  const plainEdit = edit ? plainEditContext(block, dom, edit, base) : null;
  if (!plainEdit) return reject('plain-edit');
  const currentLines = mixed ? galleyMixedLineWitnesses(block.galley) : galleyLineWitnesses(block.galley);
  const changedLines = mixed
    ? changedMixedGalleyLines(base.lineWitnesses, currentLines)
    : changedGalleyLines(base.lineWitnesses, currentLines);
  if (!currentLines || !changedLines) return reject('line-change');
  if (linesCarryShipoutColor(block.galley, changedLines)) return reject('shipout-color');
  if (mixed) {
    if (!mixedLinesPaintSafely(block, changedLines)) return reject('mixed-line-flags');
    if (!editedContributionsReadable(block.galley, changedLines)) return reject('edited-contribution-paint');
    if (!paintCallbacksKnown(documentPaintCallbacks(geometry, blocks))) return reject('paint-callbacks');
    if (!opaqueTextComparable(block.galley, base.lineWitnesses, paintContext?.fonts)) return reject('opaque-text-incomparable');
    if (opaqueTextHoldsWitness(block.galley, base.lineWitnesses)) return reject('opaque-text-holds-witness');
  }

  const containing = (report.patches ?? []).filter((patch) =>
    patch.type === 'replace-page' &&
    patch.displayList?.commands?.some((command) => command.src === blockId)
  );
  if (!containing.length) return reject('no-page-patch');
  const linePlans = [];
  for (const lineIndex of changedLines) {
    const owners = containing.flatMap((patch) => {
      const commands = patch.displayList.commands.filter((command) =>
        command.src === blockId && Number(command.line) === lineIndex
      );
      return commands.length ? [{ page: patch.page, commands }] : [];
    });
    if (owners.length !== 1) return reject('line-owner');
    const owner = owners[0];
    const painted = (commands) => (commands ?? []).filter((command) => command.op === 'glyphs' || command.op === 'rule');
    let paint = painted(owner.commands);
    if (!paint.length && mixed) {
      // A block with graphics routes every line to its exact chunk, so the
      // page carries only the line's source hit box. Paint the safe line's
      // own runs from that position, as the display list would have.
      const hits = owner.commands.filter((command) => command.op === 'sourcebox');
      const item = (block.galley?.items ?? []).filter((entry) => entry?.k === 'box')[lineIndex];
      paint = hits.length === 1 && paintContext
        ? painted(sourceBoxLineCommands(hits[0], item, {
            src: blockId,
            line: lineIndex,
            fonts: paintContext.fonts ?? new Map(),
            twinMetrics: paintContext.twinMetrics,
            backend: block.galley?.backend ?? null,
          }))
        : [];
    }
    if (!paint.length || paint.some((command) => command.math)) return reject('line-paint');
    const bounds = commandBounds(paint);
    const current = currentLines[lineIndex];
    const baselines = uniqueBaselines(paint.filter((command) => command.op === 'glyphs'));
    if (baselines.length !== 1) return reject('line-baseline');
    const lineBoxLeft = Number(bounds?.left) - current.contentLeft;
    const baseline = baselines[0];
    if (!bounds || ![lineBoxLeft, baseline].every(Number.isFinite)) return reject('line-bounds');
    linePlans.push({
      lineIndex,
      provisionalPage: owner.page,
      commands: paint,
      bounds,
      lineBoxLeft,
      baseline,
    });
  }
  const activeGeometry = geometryForGalley(geometry, block.galley);
  const proofDeadline = Number(acceptedAt) + ANCHOR_PROOF_BUDGET_MS;
  const publishDeadline = Number(acceptedAt) + ANCHOR_PUBLISH_BUDGET_MS;

  return {
    blockId,
    srcRev: report.srcRev,
    baseGeneration: canonical.id,
    baseRev: canonical.rev,
    inputEpoch: Number.isInteger(Number(inputEpoch)) ? Number(inputEpoch) : null,
    physicalPageCount: canonical.pageCount,
    policy: canonicalAnchorPolicy ? 'canonical-anchor' : 'terminal',
    provisionalPages: [...new Set(linePlans.map((line) => line.provisionalPage))],
    source: base.source,
    sourceSpan: base.span,
    baseSnapshot: base,
    // The proof matches every plain line; opaque boxes carry no witness.
    baseLineWitnesses: mixed ? base.lineWitnesses.filter(Boolean) : base.lineWitnesses,
    currentLineWitnesses: currentLines,
    changedLines,
    linePlans,
    geometry: activeGeometry,
    acceptedAt,
    clientEditAtEpochMs: Number.isFinite(Number(clientEditAtEpochMs))
      ? Number(clientEditAtEpochMs)
      : null,
    proofDeadline,
    publishDeadline,
    public: {
      status: 'pending',
      blockId,
      srcRev: report.srcRev,
      baseGeneration: canonical.id,
      baseRev: canonical.rev,
      provisionalPages: [...new Set(linePlans.map((line) => line.provisionalPage))],
      policy: canonicalAnchorPolicy ? 'canonical-anchor' : 'terminal',
      clientEditAtEpochMs: Number.isFinite(Number(clientEditAtEpochMs))
        ? Number(clientEditAtEpochMs)
        : null,
    },
  };
}

export function canonicalAnchorStructuralState(stateVec) {
  try {
    const values = JSON.parse(stateVec ?? '[]');
    if (!Array.isArray(values) || values.length < 5) return null;
    return JSON.stringify(values.slice(0, -3));
  } catch {
    return null;
  }
}

function geometryForGalley(geometry, galley) {
  const state = galley?.state ?? {};
  const hasMode = Object.prototype.hasOwnProperty.call(state, 'tdom@twocolumn');
  const columnWidthSp = Number(state['tdom@columnwidth']);
  return {
    ...geometry,
    twocolumn: hasMode ? Number(state['tdom@twocolumn']) : Number(geometry?.twocolumn ?? 0),
    columnwidth: columnWidthSp > 0
      ? columnWidthSp / SP_PER_BP
      : Number(geometry?.columnwidth ?? 0),
  };
}

/** Convert a certified full block matching into an atomic multi-line patch.
 * No candidate ranking exists here: the verifier already proved exactly one
 * physical hbox for every base line or returned null. */
export function buildTerminalCanonicalPatch(plan, matching) {
  if (!plan || !Array.isArray(matching) || matching.length !== plan.baseLineWitnesses?.length) return null;
  // matching is positional over the certified witnesses; a mixed block's
  // plain lines keep their own box ordinal, which the line plans use.
  const byLine = new Map(matching.map((entry) => {
    const witness = plan.baseLineWitnesses[Number(entry.lineIndex)];
    return [Number.isInteger(witness?.index) ? witness.index : Number(entry.lineIndex), entry.candidate];
  }));
  const pages = new Map();
  for (const line of plan.linePlans ?? []) {
    const anchor = byLine.get(line.lineIndex);
    if (!anchor || !validBox(anchor.box)) return null;
    const body = bodyBounds(plan.geometry, anchor.page);
    const region = columnRegionForBox(plan.geometry, anchor.page, anchor.box);
    if (!region || anchor.box.left < body.left - ANCHOR_BLEED_BP ||
        anchor.box.right > body.right + ANCHOR_BLEED_BP ||
        anchor.box.top < body.top - ANCHOR_BLEED_BP ||
        anchor.box.bottom > body.bottom + ANCHOR_BLEED_BP) return null;
    const dx = anchor.box.left - line.lineBoxLeft;
    const dy = Number(anchor.y) - line.baseline;
    const commands = line.commands.map((command) => translateCommand(command, dx, dy));
    const translated = translateBox(line.bounds, dx, dy);
    if (!boxInside(translated, region, ANCHOR_BLEED_BP)) return null;
    const mask = unionBoxes(anchor.box, translated, ANCHOR_BLEED_BP);
    if (!validBox(mask)) return null;
    if (!pages.has(anchor.page)) pages.set(anchor.page, { page: anchor.page, masks: [], commands: [] });
    pages.get(anchor.page).masks.push(mask);
    pages.get(anchor.page).commands.push(...commands);
  }
  if (!pages.size) return null;
  const pagePatches = [...pages.values()].sort((left, right) => left.page - right.page);
  const patch = {
    status: 'ready',
    blockId: plan.blockId,
    srcRev: plan.srcRev,
    baseGeneration: plan.baseGeneration,
    baseRev: plan.baseRev,
    changedLines: [...plan.changedLines],
    publishWithinMs: 850,
    clientEditAtEpochMs: plan.clientEditAtEpochMs,
    pages: pagePatches,
  };
  // Transitional single-line fields keep older clients fail-safe while the
  // installed app and engine are updated together.
  if (pagePatches.length === 1 && pagePatches[0].masks.length === 1) {
    patch.page = pagePatches[0].page;
    patch.mask = pagePatches[0].masks[0];
    patch.commands = pagePatches[0].commands;
  }
  return patch;
}

function hasGalleySideEffects(galley) {
  if (!galley || galley.tdomFrozen || galley.tdomDeferred) return true;
  return Boolean(
    galley.gfx ||
    galley.floats?.length ||
    galley.events?.length ||
    galley.labels?.length ||
    galley.refs?.length ||
    galley.toclines?.length
  );
}

function stableWrappedTailLines(block, baselineCount, allowGrowth = false) {
  const before = (block.previousGalley?.items ?? []).filter((item) => item.k === 'box');
  const after = (block.galley?.items ?? []).filter((item) => item.k === 'box');
  if (baselineCount < 2 || after.length !== baselineCount) return 0;
  const grewOneLine = after.length === before.length + 1;
  if (grewOneLine && !allowGrowth) return 0;
  if (!grewOneLine && after.length !== before.length) return 0;
  const stableCount = grewOneLine ? Math.max(0, before.length - 1) : baselineCount - 1;
  for (let index = 0; index < stableCount; index++) {
    if (lineProofSignature(before[index]) !== lineProofSignature(after[index])) return 0;
  }
  return grewOneLine ? 2 : 1;
}

function stableEditedSuffix(block, baselineCount, terminal) {
  const before = (block.previousGalley?.items ?? []).filter((item) => item.k === 'box');
  const after = (block.galley?.items ?? []).filter((item) => item.k === 'box');
  if (!before.length || !after.length || after.length !== baselineCount) return null;
  const grewOneLine = after.length === before.length + 1;
  if (after.length !== before.length && !(terminal && grewOneLine)) return null;

  let firstLine = 0;
  while (
    firstLine < before.length &&
    firstLine < after.length &&
    lineProofSignature(before[firstLine]) === lineProofSignature(after[firstLine])
  ) {
    firstLine++;
  }
  if (firstLine >= after.length) return null;
  const paintLines = after.length - firstLine;
  if (paintLines < 1 || paintLines > 6) return null;
  return { firstLine, paintLines };
}

function lineProofSignature(item) {
  return JSON.stringify([
    item.w,
    item.h,
    item.d,
    item.runs,
  ]);
}

function sourceTailLocation(source, text) {
  const start = source?.start;
  if (!start) return source;
  const tail = String(text ?? '').trimEnd();
  const lines = tail.split('\n');
  return {
    ...source,
    start: {
      line: Number(start.line) + lines.length - 1,
      column: lines.length === 1
        ? Number(start.column) + lines[0].length
        : lines.at(-1).length + 1,
    },
  };
}

function plainEditContext(block, dom, edit, base) {
  const spanStart = Number(base?.span?.start);
  const editStart = Number(edit?.start);
  const editEnd = Number(edit?.end);
  const replacement = String(edit?.text ?? '');
  if (![spanStart, editStart, editEnd].every(Number.isFinite) || editEnd < editStart) return null;
  if (replacement.includes('\n') || PLAIN_FLOW_UNSAFE.test(replacement)) return null;

  const localStart = editStart - spanStart;
  const localAfter = localStart + replacement.length;
  if (localStart < 0 || localAfter < localStart || localAfter > String(block.text ?? '').length) return null;
  const region = (block.editRegions ?? []).find((item) =>
    item.kind === 'text' &&
    localStart >= Number(item.contentStart) &&
    localStart <= Number(item.contentEnd) &&
    localAfter >= Number(item.contentStart) &&
    localAfter <= Number(item.contentEnd)
  );
  if (!region) return null;
  return {
    source: sourceLocationAtOffset(dom.source, block.text, localStart),
  };
}

function sourceLocationAtOffset(source, text, offset) {
  const start = source?.start;
  if (!start) return source;
  const prefix = String(text ?? '').slice(0, Math.max(0, offset));
  const lines = prefix.split('\n');
  return {
    ...source,
    start: {
      line: Number(start.line) + lines.length - 1,
      column: lines.length === 1
        ? Number(start.column) + lines[0].length
        : lines.at(-1).length + 1,
    },
  };
}

export function dirtyWithoutPatchFallback(report) {
  if (!report?.dirtySourceNodes?.length || report.patches?.length) return null;
  return {
    kind: 'canonical-fallback',
    reason: 'dirty-source-without-structured-patch',
  };
}

function uniqueBaselines(commands) {
  const values = [];
  for (const command of commands) {
    const y = Number(command.y);
    if (!Number.isFinite(y)) continue;
    if (!values.some((value) => Math.abs(value - y) < 0.5)) values.push(y);
  }
  return values;
}

function commandBounds(commands) {
  let left = Infinity;
  let top = Infinity;
  let right = -Infinity;
  let bottom = -Infinity;
  for (const command of commands) {
    const x = Number(command.x);
    const y = Number(command.y);
    const w = Number(command.w);
    if (![x, y, w].every(Number.isFinite)) continue;
    const commandTop = command.op === 'glyphs' ? y - Number(command.gh ?? command.size ?? 0) : y;
    const commandBottom = command.op === 'glyphs'
      ? y + Number(command.gd ?? 0)
      : y + Number(command.h ?? 0);
    left = Math.min(left, x);
    top = Math.min(top, commandTop);
    right = Math.max(right, x + Math.max(0, w));
    bottom = Math.max(bottom, commandBottom);
  }
  return [left, top, right, bottom].every(Number.isFinite)
    ? { left, top, right, bottom }
    : null;
}

function bodyBounds(geometry = {}, pageNumber = 1) {
  const top = 72 + Number(geometry.topmargin ?? 0) +
    Number(geometry.headheight ?? 0) + Number(geometry.headsep ?? 0);
  const evenPage = Number(geometry.twoside) && pageNumber % 2 === 0;
  const sideMargin = evenPage
    ? Number(geometry.evensidemargin ?? geometry.oddsidemargin ?? 0)
    : Number(geometry.oddsidemargin ?? 0);
  const left = 72 + sideMargin;
  return {
    left,
    top,
    right: left + Number(geometry.textwidth ?? 0),
    bottom: top + Number(geometry.textheight ?? 0),
  };
}

function validBox(box) {
  return box && [box.left, box.top, box.right, box.bottom].every(Number.isFinite) &&
    box.right > box.left && box.bottom > box.top;
}

function boxArea(box) {
  return (box.right - box.left) * (box.bottom - box.top);
}

function boxHeight(box) {
  return box.bottom - box.top;
}

function boxInside(box, region, bleed = 0) {
  return box.left >= region.left - bleed && box.right <= region.right + bleed &&
    box.top >= region.top - bleed && box.bottom <= region.bottom + bleed;
}

function columnRegionForBox(geometry, page, box) {
  const body = bodyBounds(geometry, page);
  if (!Number(geometry?.twocolumn)) return boxInside(box, body, ANCHOR_BLEED_BP) ? body : null;
  const width = Number(geometry?.columnwidth);
  const sep = Number(geometry?.columnsep);
  if (!(width > 0) || !(sep >= 0)) return null;
  const columns = [
    { ...body, right: body.left + width },
    { ...body, left: body.left + width + sep, right: body.left + width * 2 + sep },
  ];
  return columns.find((region) => boxInside(box, region, ANCHOR_BLEED_BP)) ?? null;
}

function translateCommand(command, dx, dy) {
  return {
    ...command,
    x: Number(command.x) + dx,
    y: Number(command.y) + dy,
  };
}

function translateBox(box, dx, dy) {
  return {
    left: box.left + dx,
    top: box.top + dy,
    right: box.right + dx,
    bottom: box.bottom + dy,
  };
}

function unionBoxes(left, right, bleed) {
  return {
    left: Math.min(left.left, right.left) - bleed,
    top: Math.min(left.top, right.top) - bleed,
    right: Math.max(left.right, right.right) + bleed,
    bottom: Math.max(left.bottom, right.bottom) + bleed,
  };
}
