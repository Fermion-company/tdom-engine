import { buildOpaqueUpdateResponse } from './update-response.js';

export function opaqueUpdate(engine, editLabel, t, reasons, { teardownTree, shipUpdate }) {
  const text = engine.store.get(engine.file);
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
    canonical: engine.canonical.info(),
    timerStats: t.done(),
    diagnostics: engine.diagnostics,
  });
}
