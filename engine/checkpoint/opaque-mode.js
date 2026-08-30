import { buildOpaqueUpdateResponse } from './update-response.js';
import { instrumentEditRegions } from '../edit-regions.js';
import { documentBounds } from '../segmenter.js';

export function opaqueUpdate(engine, editLabel, t, reasons, { teardownTree, shipUpdate }) {
  const text = engine.store.get(engine.file);
  // Opaque mode changes how pages are painted, not whether the source is
  // editable.  Populate the same conservative source regions without
  // booting the resident TeX tree so canonical-only documents can
  // still be edited through SyncTeX hit geometry.
  for (const block of engine.blocks) {
    block.editRegions = instrumentEditRegions(block.text).regions;
  }
  const bounds = documentBounds(text);
  engine.preambleEditRegions = instrumentEditRegions(
    text.slice(bounds.preamble.start, bounds.preamble.end),
    { baseId: 1_000_000 }
  ).regions;
  if (engine.mode !== 'opaque') {
    engine.mode = 'opaque';
    // the compile IS the display now: recompile promptly on every pause
    engine.canonical.pressure = 'display';
    engine.diagnostics.push(`structured layer demoted to opaque: ${reasons.join('; ')}`);
    teardownTree();
  }
  engine.modeReasons = reasons;
  t.lap('gate');
  engine.rev++;
  engine.srcRev++;
  engine.canonical.schedule(text, engine.srcRev);
  shipUpdate(text);
  return buildOpaqueUpdateResponse({
    rev: engine.rev,
    srcRev: engine.srcRev,
    editLabel,
    backendName: engine.backendName,
    mode: engine.mode,
    modeReasons: engine.modeReasons,
    previewPolicy: engine.previewPolicy,
    previewReasons: engine.previewReasons,
    canonical: engine.canonical.info(),
    fonts: engine.getFontManifest(),
    timerStats: t.done(),
    diagnostics: engine.diagnostics,
  });
}
