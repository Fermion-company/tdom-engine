// Safety gate — decides what the STRUCTURED layer may touch.
//
// The structured/provisional layer runs the document's real preamble inside
// a real lualatex, so unknown macros per se are not dangerous. What IS
// dangerous is anything that changes how PAGES are assembled, because page
// assembly (breaking, floats, headers) is the one part the live preview
// re-implements in JS (pagebuilder.js). This gate is a conservative static
// scan for exactly those mechanisms; anything it flags sends the WHOLE
// document to the opaque path (display = canonical LuaLaTeX pages only,
// still editable, still converging — just without the glyph-level live
// preview).
//
// Block-level hazards (multicols, longtable, breakable boxes, TikZ …) are
// NOT flagged here: the engine already routes those through the isolated
// exact-render rescue, which shows real LuaLaTeX pixels per block. The gate
// exists for hazards that no per-block fallback can represent.
//
// The gate is deliberately one-directional at runtime: the engine also
// demotes dynamically (boot failure, typeset failure, verification
// mismatch), and a demotion sticks until the offending source changes.

// Packages that hook shipout / paint on the page / re-flow columns —
// mechanisms invisible to the harvested galley stream.
const UNSAFE_PACKAGES = [
  'flowfram',
  'eso-pic',
  'everypage',
  'everypage-1x',
  'background',
  'xwatermark',
  'draftwatermark',
  'atbegshi',
  'everyshi',
  'pdfpages',
  'pagegrid',
  'fancytabs',
  'thumbs',
];
// NOT here: multicol/paracol/longtable/tcolorbox/mdframed — their
// environments are single blocks (the segmenter never splits inside an
// environment) and the isolated exact-render rescue shows real LuaLaTeX
// pixels for them. TikZ/pdf-literal blocks likewise go through the
// exact-render chunk path.

// Preamble constructs that take over page production.
const UNSAFE_PREAMBLE = [
  [/\\output\s*=?\s*\{/, 'custom \\output routine'],
  [/\\shipout\b/, 'raw \\shipout'],
  [/\\AddToHook\s*\{\s*shipout/, 'shipout hook'],
  [/\\At(?:Begin|Next|End)Shipout/, 'shipout hook (atbegshi API)'],
  [/\\(?:documentclass|LoadClass)\s*\[[^\]]*\btwocolumn\b[^\]]*\]/, 'twocolumn class option'],
  [/\\twocolumn\b/, '\\twocolumn'],
  [/\\AtBeginDvi\b/, '\\AtBeginDvi'],
];

// Body constructs the JS page assembly cannot represent even per block:
// they read or change the CURRENT PAGE while it is being built.
const UNSAFE_BODY = [
  [/\\marginpar\b/, '\\marginpar (page-margin placement)'],
  [/\\marginnote\b/, '\\marginnote (page-margin placement)'],
  [/\\newgeometry\b/, '\\newgeometry (mid-document page geometry)'],
  [/\\enlargethispage\b/, '\\enlargethispage'],
  [/\\includepdf\b/, '\\includepdf (foreign pages)'],
  [/\\twocolumn\b/, 'mid-document \\twocolumn'],
  [/\\balance\b/, 'column balancing'],
];

/** Strip TeX comments (unescaped % to end of line) so commented-out
 * dangers don't demote the document. */
function stripComments(text) {
  return String(text ?? '').replace(/(^|[^\\])%[^\n]*/g, '$1');
}

/**
 * Classify a document for the structured layer.
 * @returns {{safe: boolean, reasons: string[]}}
 */
export function classifyDocument(preamble, body) {
  const reasons = [];
  const pre = stripComments(preamble);
  const bod = stripComments(body);

  const pkgRe = /\\(?:usepackage|RequirePackage)\s*(?:\[[^\]]*\])?\s*\{([^}]*)\}/g;
  let m;
  while ((m = pkgRe.exec(pre))) {
    for (const raw of m[1].split(',')) {
      const name = raw.trim();
      if (UNSAFE_PACKAGES.includes(name)) reasons.push(`package ${name}`);
    }
  }
  for (const [re, why] of UNSAFE_PREAMBLE) {
    if (re.test(pre)) reasons.push(why);
  }
  for (const [re, why] of UNSAFE_BODY) {
    if (re.test(bod)) reasons.push(why);
  }
  return { safe: reasons.length === 0, reasons: [...new Set(reasons)] };
}

const LIGATURES = { '\uFB00': 'ff', '\uFB01': 'fi', '\uFB02': 'fl', '\uFB03': 'ffi', '\uFB04': 'ffl', '\uFB05': 'ft', '\uFB06': 'st' };
const ALNUM_PAIR = /^[\p{L}\p{N}]{2}$/u;

/**
 * Tokens for the exactness verification: character bigrams within each
 * whitespace-free segment, lowercased, ligatures expanded, pairs that are
 * not letter/digit dropped. Bigram granularity is the point — TeX kerning
 * splits one word across several glyph runs ("LuaLaTeX" arrives as
 * "Lu|aLa|T|eX"), pdftotext re-joins it, and any word-level comparison
 * mismatches systematically. Bigrams inside each fragment survive both
 * representations, for latin and CJK alike.
 */
export function verifyTokens(text) {
  let s = String(text ?? '').replace(/[\uFB00-\uFB06]/g, (c) => LIGATURES[c] ?? c);
  s = s.toLowerCase();
  const out = [];
  for (const seg of s.split(/\s+/)) {
    for (let i = 0; i + 1 < seg.length; i++) {
      const bg = seg.slice(i, i + 2);
      if (ALNUM_PAIR.test(bg)) out.push(bg);
    }
  }
  return out;
}

/**
 * Multiset containment: what fraction of `wanted` tokens also appear in
 * `pool` (with multiplicity)? 1.0 = every provisional token exists in the
 * canonical page.
 */
export function tokenContainment(wanted, pool) {
  if (!wanted.length) return 1;
  const counts = new Map();
  for (const t of pool) counts.set(t, (counts.get(t) ?? 0) + 1);
  let hit = 0;
  for (const t of wanted) {
    const c = counts.get(t) ?? 0;
    if (c > 0) {
      hit++;
      counts.set(t, c - 1);
    }
  }
  return hit / wanted.length;
}
