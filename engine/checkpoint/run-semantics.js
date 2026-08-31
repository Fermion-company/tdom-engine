// Resident run semantics shared by the canonical paint proof and the
// provisional renderer.  Geometry alone is deliberately not a paint oracle:
// a normal zero-width PDF rule may become a visible hairline.  Only a rule
// whose raw LuaTeX subtype is certified as backend-no-paint is LayoutOnly.

export const RESIDENT_RUN_SCHEMA_VERSION = 2;
export const RUN_SEMANTICS_VERSION = 1;

const EMPTY_RULE_SUBTYPE = 3;
const MIN_EMPTY_RULE_LUATEX_VERSION = 85;
const CERTIFIED_PDF_ENGINES = new Set(['luatex', 'luahbtex']);

export function residentBackendProfileKey(profile) {
  if (!profile || typeof profile !== 'object') return null;
  const schema = Number(profile.schema);
  const version = Number(profile.version);
  const revision = Number(profile.revision ?? 0);
  const outputMode = Number(profile.outputMode);
  const emptyRuleSubtype = Number(profile.emptyRuleSubtype);
  const engine = String(profile.engine ?? '');
  const capture = String(profile.capture ?? '');
  if (![schema, version, revision, outputMode, emptyRuleSubtype].every(Number.isFinite) ||
      !engine || !capture) return null;
  return [
    `runs-v${schema}`,
    engine,
    `${version}.${revision}`,
    `output-${outputMode}`,
    capture,
    `empty-${emptyRuleSubtype}`,
    String(profile.format ?? ''),
  ].join(':');
}

export function isCertifiedLuaTeXPdfProfile(profile) {
  return Number(profile?.schema) === RESIDENT_RUN_SCHEMA_VERSION &&
    CERTIFIED_PDF_ENGINES.has(profile?.engine) &&
    Number.isInteger(Number(profile?.version)) &&
    Number(profile.version) >= MIN_EMPTY_RULE_LUATEX_VERSION &&
    Number(profile?.outputMode) === 1 &&
    profile?.capture === 'resident-post-linebreak' &&
    Number(profile?.emptyRuleSubtype) === EMPTY_RULE_SUBTYPE &&
    residentBackendProfileKey(profile) !== null;
}

/**
 * Pure fail-closed projection from one normalized resident run to its paint
 * semantics.  LayoutOnly still participates in stableRunLayoutRecord(); it
 * is omitted only from the PDF paint witness.
 */
export function classifyResidentRun(run, profile) {
  if (!run || typeof run !== 'object') return reject('UNKNOWN_RUN');
  if (!run.rule) {
    return typeof run.t === 'string'
      ? { tag: 'GlyphPaint' }
      : reject('UNKNOWN_RUN');
  }
  if (Number(run.rv) !== RESIDENT_RUN_SCHEMA_VERSION) return reject('RULE_SCHEMA_UNKNOWN');

  const numeric = ['x', 'dy', 'w', 'h', 'rw', 'rh', 'rd', 'rl', 'rr', 'ri'];
  if (numeric.some((key) => !Number.isFinite(Number(run[key])))) return reject('NONFINITE_GEOMETRY');
  if (!['rw', 'rh', 'rd', 'rl', 'rr', 'ri'].every((key) => Number.isInteger(Number(run[key])))) {
    return reject('NONINTEGER_RULE_GEOMETRY');
  }
  if (Number(run.rw) < 0 || Number(run.rh) < 0 || Number(run.rd) < 0 ||
      Number(run.w) < 0 || Number(run.h) < 0) return reject('RUNNING_OR_NEGATIVE_DIMENSION');
  if (typeof run.rdir !== 'string' || typeof run.ra !== 'string') return reject('RULE_SCHEMA_INCOMPLETE');
  if (!isCertifiedLuaTeXPdfProfile(profile)) return reject('PROFILE_MISMATCH');

  const subtype = Number(run.rs);
  if (!Number.isInteger(subtype)) return reject('RULE_SUBTYPE_MISSING');
  if (subtype === Number(profile.emptyRuleSubtype)) {
    return {
      tag: 'LayoutOnly',
      proof: 'CertifiedEmptyRule',
      profileKey: residentBackendProfileKey(profile),
    };
  }
  return {
    tag: 'OtherPaint',
    reason: Number(run.w) === 0 || Number(run.h) === 0
      ? 'NORMAL_ZERO_AREA_RULE'
      : 'RULE_PAINT_UNSUPPORTED',
  };
}

/** Every field that can affect layout or provisional paint stays ordered in
 * the layout witness, including backend-no-paint empty rules. */
export function stableRunLayoutRecord(run) {
  if (run?.rule) {
    return [
      'rule', run.rv ?? null, run.rs ?? null,
      run.rw ?? null, run.rh ?? null, run.rd ?? null,
      run.ri ?? null, run.rl ?? null, run.rr ?? null,
      run.rdir ?? null, run.ra ?? null,
      run.x ?? null, run.dy ?? 0, run.w ?? null, run.h ?? null, run.c ?? null,
    ];
  }
  return [
    'glyph', run?.t ?? null, run?.x ?? null, run?.w ?? null,
    run?.f ?? null, run?.s ?? null, run?.dy ?? 0, run?.c ?? null,
    run?.m ?? null, run?.gh ?? null, run?.gd ?? null,
  ];
}

function reject(reason) {
  return { tag: 'Reject', reason };
}
