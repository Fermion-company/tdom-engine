import { SAFE_GLYPH } from './fidelity.js';
import { changedGalleyLines, galleyLineWitnesses } from './canonical-paint-index.js';

const PLAIN_FLOW_UNSAFE = /[\\$%{}&#^_~]/;
const ANCHOR_BLEED_BP = 2;
const SP_PER_BP = 65781.76;

/** Freeze the pre-edit resident witness while that exact source is still the
 * canonical generation. The server calls this inside its serialized edit
 * critical section, before engine.edit() can replace the galley. */
export function captureCanonicalAnchorBase({ blocks, domBlocks, edit, certificate }) {
  const start = Number(edit?.start);
  const end = Number(edit?.end);
  if (![start, end].every(Number.isFinite) || end < start || !certificate?.id) return null;
  const block = blocks.find((item) => start >= Number(item.start) && end <= Number(item.end));
  const dom = domBlocks.find((item) => item.id === block?.id);
  if (!block || !dom || hasGalleySideEffects(block.galley) || block.fidelity?.level !== SAFE_GLYPH) return null;
  const lineWitnesses = galleyLineWitnesses(block.galley);
  const structuralStateVec = canonicalAnchorStructuralState(block.stateVec);
  if (!lineWitnesses || structuralStateVec === null) return null;
  return {
    blockId: block.id,
    blockHash: block.hash,
    galleyHash: block.galleyHash,
    stateVec: JSON.stringify(block.stateVec ?? null),
    structuralStateVec,
    span: { ...dom.span },
    source: structuredClone(dom.source),
    lineWitnesses: structuredClone(lineWitnesses),
    certificate: { ...certificate },
  };
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
  acceptedAt = performance.now(),
  clientEditAtEpochMs = null,
}) {
  const canonical = report?.canonical;
  const canonicalAnchorPolicy = report?.previewPolicy === 'canonical-anchor';
  if (report?.mode !== 'structured' || !canonical?.id) return null;
  if (!canonicalAnchorPolicy && canonical.pageCount === report.stats?.pageCount) return null;
  if (report.dirtySourceNodes?.length !== 1) return null;

  const blockId = String(report.dirtySourceNodes[0]).replace(/^src-/, '');
  const immediateBase = canonical.rev === report.srcRev - 1;
  const continuedBase = lineage &&
    lineage.blockId === blockId &&
    lineage.baseGeneration === canonical.id &&
    lineage.baseRev === canonical.rev &&
    lineage.lastSrcRev === report.srcRev - 1 &&
    lineage.baseSnapshot;
  if (!immediateBase && !continuedBase) return null;
  const block = blocks.find((item) => item.id === blockId);
  const dom = domBlocks.find((item) => item.id === blockId);
  const base = immediateBase ? baseSnapshot : lineage.baseSnapshot;
  if (!block || !dom || !base || base.blockId !== blockId ||
      base.certificate?.id !== canonical.id || base.certificate?.rev !== canonical.rev) return null;
  if (block.fidelity?.level !== SAFE_GLYPH || block.needsRender) return null;
  if (hasGalleySideEffects(block.galley)) return null;
  // Plain text legitimately changes the three volatile paragraph-tail
  // locals (prevdepth, nobreak and lastskip).  Requiring the complete exit
  // vector to stay byte-identical therefore rejects ordinary prose based on
  // the depth of its final glyph.  Counters plus the active column mode and
  // width remain a hard proof boundary; only those three documented locals
  // are excluded from the canonical-anchor structural witness.
  if (canonicalAnchorStructuralState(block.stateVec) !== base.structuralStateVec) return null;

  const plainEdit = edit ? plainEditContext(block, dom, edit) : null;
  if (!plainEdit) return null;
  const currentLines = galleyLineWitnesses(block.galley);
  const changedLines = changedGalleyLines(base.lineWitnesses, currentLines);
  if (!currentLines || !changedLines) return null;

  const containing = (report.patches ?? []).filter((patch) =>
    patch.type === 'replace-page' &&
    patch.displayList?.commands?.some((command) => command.src === blockId)
  );
  if (!containing.length) return null;
  const linePlans = [];
  for (const lineIndex of changedLines) {
    const owners = containing.flatMap((patch) => {
      const commands = patch.displayList.commands.filter((command) =>
        command.src === blockId && Number(command.line) === lineIndex
      );
      return commands.length ? [{ page: patch.page, commands }] : [];
    });
    if (owners.length !== 1) return null;
    const owner = owners[0];
    const paint = owner.commands.filter((command) => command.op === 'glyphs' || command.op === 'rule');
    if (!paint.length || paint.some((command) => command.math)) return null;
    const bounds = commandBounds(paint);
    const current = currentLines[lineIndex];
    const baselines = uniqueBaselines(paint.filter((command) => command.op === 'glyphs'));
    if (baselines.length !== 1) return null;
    const lineBoxLeft = Number(bounds?.left) - current.contentLeft;
    const baseline = baselines[0];
    if (!bounds || ![lineBoxLeft, baseline].every(Number.isFinite)) return null;
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
  const proofDeadline = Number(acceptedAt) + 700;
  const publishDeadline = Number(acceptedAt) + 850;

  return {
    blockId,
    srcRev: report.srcRev,
    baseGeneration: canonical.id,
    baseRev: canonical.rev,
    physicalPageCount: canonical.pageCount,
    policy: canonicalAnchorPolicy ? 'canonical-anchor' : 'terminal',
    provisionalPages: [...new Set(linePlans.map((line) => line.provisionalPage))],
    source: base.source,
    sourceSpan: base.span,
    baseSnapshot: base,
    baseLineWitnesses: base.lineWitnesses,
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
  const byLine = new Map(matching.map((entry) => [Number(entry.lineIndex), entry.candidate]));
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

function plainEditContext(block, dom, edit) {
  const spanStart = Number(dom?.span?.start);
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
