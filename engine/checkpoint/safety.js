// Safety gate — decides what the STRUCTURED layer may touch.
import { classifyStructuralAliases, maskStructuralDefinitions } from './structural-aliases.js';
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
  // NOT pdfpages: loading it is harmless (macro definitions only). The
  // ACTION — \includepdf — is a single block, and the isolated exact-render
  // rescue ships its foreign pages as real per-page chunks with forced
  // breaks (same machinery as longtable). Gate granularity is
  // block, not document.
  'pagegrid',
  'fancytabs',
  'thumbs',
  // These packages rotate complete shipped pages. Until page-local geometry
  // and source hit maps are verified together, keep canonical authority.
  'pdflscape',
  'lscape',
];
// NOT here: multicol/paracol/longtable/tcolorbox/mdframed — their
// environments are single blocks (the segmenter never splits inside an
// environment) and the isolated exact-render rescue shows real LuaLaTeX
// pixels for them. TikZ/pdf-literal blocks likewise go through the
// exact-render chunk path.

// Preamble constructs that take over page production.
const UNSAFE_PREAMBLE = [
  [/\\output\b\s*=?\s*\{/, 'custom \\output routine'],
  [/\\(?:shipout|RawShipout)\b/, 'raw \\shipout'],
  [/\\(?:AddToHook|AddToHookNext)\s*\{\s*shipout/, 'shipout hook'],
  [/\\At(?:BeginShipout(?:Next)?|EndShipout|BeginDvi|EndDvi)\b/, 'shipout hook (compatibility API)'],
  [/\\csname\s*(?:output|shipout|RawShipout)\s*\\endcsname/, 'custom \\output routine'],
  [/\\twocolumn\b/, '\\twocolumn'],
  [/\\(?:documentclass|LoadClass)\s*\[[^\]]*\blandscape\b[^\]]*\]/, 'landscape class option'],
];

// Per-page MediaBox/page-dictionary changes cannot share the resident
// renderer's single provisional geometry. In particular, leaving these in
// structured mode makes the exact PDF pixels use one viewport while the
// invisible direct-edit SVG still uses another, so a click can miss by an
// entire line or column. Demote before creating that split coordinate system.
const UNSAFE_PAGE_GEOMETRY = [
  [/\\(?:pagewidth|pageheight|pdfpagewidth|pdfpageheight)\b/, 'per-page paper size primitive'],
  [/\\(?:paperwidth|paperheight|textwidth|textheight)\s*=/, 'page geometry assignment'],
  [/\\setlength\s*\{\s*\\(?:paperwidth|paperheight|textwidth|textheight)\s*\}/, 'page geometry assignment'],
  [/\\pdfvariable\s+(?:pagewidth|pageheight)\b/, 'per-page PDF size assignment'],
  [/\\(?:pdfvariable\s+pageattr|pdfpageattr\b|pdfextension\s+pageattr\b)/, 'raw PDF page attributes'],
  [/\\special\s*\{[^}]*@thispage\b/i, 'raw PDF page special'],
  [/\\begin\s*\{\s*landscape\s*\}/, 'landscape page environment'],
];

// Body constructs the JS page assembly cannot represent even per block:
// they read or change the CURRENT PAGE while it is being built.
const UNSAFE_BODY = [
  // NOT \marginpar/\marginnote (todonotes & co): margin placement writes
  // OUTSIDE the galley box, which no per-block chunk can represent — but
  // the block is typeset in-chain for its BODY text and demoted to the
  // CANONICAL_ONLY fidelity tier (engine-v3 #applyFidelity), so the margin
  // pixels come from the canonical layer instead of demoting the whole
  // document. Paper drafts carry \todo marks routinely.
  [/\\newgeometry\b/, '\\newgeometry (mid-document page geometry)'],
  [/\\output\b\s*=?/, 'custom \\output routine'],
  [/\\(?:shipout|RawShipout)\b/, 'raw \\shipout'],
  [/\\(?:AddToHook|AddToHookNext)\s*\{\s*shipout/, 'shipout hook'],
  [/\\At(?:BeginShipout(?:Next)?|EndShipout|BeginDvi|EndDvi)\b/, 'shipout hook (compatibility API)'],
  [/\\csname\s*(?:output|shipout|RawShipout)\s*\\endcsname/, 'custom \\output routine'],
  // NOT \includepdf: block-level rescue ships its foreign pages exactly
  // (see OUTPUT_HIJACK_RE in engine-v3.js).
  [/\\balance\b/, 'column balancing'],
];

const BODY_COLUMN_SWITCH_RE = /\\(?:one|two)column\b/;

/** Strip TeX comments (unescaped % to end of line) so commented-out
 * dangers don't demote the document. Shared with the other gates
 * (rescue classifier, margin demotion, definition-edit scan) — they used
 * to test raw text, so a commented-out `% \marginpar` or `% \newcommand`
 * silently routed blocks to the slow tiers. */
export function stripComments(text) {
  return String(text ?? '').replace(/(^|[^\\])%[^\n]*/g, '$1');
}

function maskInlineVerbs(line) {
  return line.replace(/\\verb\*?([^A-Za-z\s]).*?\1/g, (match) => ' '.repeat(match.length));
}

// Literal payloads must be removed before TeX comments: `%` inside \verb or
// verbatim is data, while alltt is deliberately excluded because commands in
// it still execute.  Process line-by-line so a commented-out begin marker
// cannot hide executable code on following lines.
function safetySource(text) {
  const literalBegin = /\\begin\{(verbatim\*?|lstlisting|minted|filecontents\*?|[BLV]Verbatim\*?)\}/;
  let literal = null;
  const out = [];
  for (const rawLine of String(text ?? '').split('\n')) {
    let line = rawLine;
    let kept = '';
    while (line.length) {
      if (literal) {
        const endToken = `\\end{${literal}}`;
        const end = line.indexOf(endToken);
        if (end < 0) {
          line = '';
          break;
        }
        line = line.slice(end + endToken.length);
        literal = null;
        continue;
      }
      const executable = stripComments(maskInlineVerbs(line));
      const begin = literalBegin.exec(executable);
      if (!begin) {
        kept += executable;
        break;
      }
      kept += executable.slice(0, begin.index);
      literal = begin[1];
      const endToken = `\\end{${literal}}`;
      const end = executable.indexOf(endToken, begin.index + begin[0].length);
      if (end < 0) break;
      line = executable.slice(end + endToken.length);
      literal = null;
    }
    out.push(kept);
  }
  return out.join('\n');
}

/**
 * Preamble half of the gate: unsafe packages + page-production takeovers.
 * Memoizable by preamble hash — the preamble does not change while the
 * user types in the body, so this never runs per keystroke.
 * @returns {{safe: boolean, reasons: string[]}}
 */
export function classifyPreamble(preamble) {
  const reasons = [];
  const pre = safetySource(preamble);
  const actions = maskStructuralDefinitions(pre);
  const pkgRe = /\\(?:usepackage|RequirePackage)\s*(?:\[[^\]]*\])?\s*\{([^}]*)\}/g;
  let m;
  while ((m = pkgRe.exec(actions))) {
    for (const raw of m[1].split(',')) {
      const name = raw.trim();
      if (UNSAFE_PACKAGES.includes(name)) reasons.push(`package ${name}`);
    }
  }
  for (const [re, why] of UNSAFE_PREAMBLE) {
    if (re.test(actions)) reasons.push(why);
  }
  for (const [re, why] of UNSAFE_PAGE_GEOMETRY) {
    if (re.test(actions)) reasons.push(why);
  }
  if (/\\(?:def|gdef|edef|xdef)\s*\\(?:output|shipout|RawShipout)\b|\\let\s*\\(?:output|shipout|RawShipout)\b|\\(?:newcommand|renewcommand|providecommand|DeclareRobustCommand)\*?\s*\{?\\(?:output|shipout|RawShipout)\b/.test(pre)) {
    reasons.push('page-production API redefinition');
  }
  // A standard class-level twocolumn layout still has a trustworthy hot
  // path: the resident process uses the class's real \columnwidth and line
  // breaker. What it does NOT have is a trustworthy JS page/column builder.
  // Keep the exact canonical PDF as the page surface and permit only
  // canonical-addressed, fail-closed text overlays on top of it.
  const canonicalAnchor = /\\(?:documentclass|LoadClass)\s*\[[^\]]*\btwocolumn\b[^\]]*\]/.test(pre);
  return {
    safe: reasons.length === 0,
    reasons: [...new Set(reasons)],
    previewPolicy: canonicalAnchor ? 'canonical-anchor' : 'structured',
    previewReasons: canonicalAnchor ? ['twocolumn class option'] : [],
  };
}

/**
 * Body half of the gate, per block: returns the reason string when this
 * block carries a construct the JS page assembly cannot represent, else
 * null. Called only for blocks whose text actually changed — the old
 * whole-body regex sweep ran on every keystroke and never saw \input'ed
 * content (which arrives here as expanded blocks).
 */
export function classifyBodyBlock(text) {
  const bod = safetySource(text);
  for (const [re, why] of UNSAFE_BODY) {
    if (re.test(bod)) return why;
  }
  for (const [re, why] of UNSAFE_PAGE_GEOMETRY) {
    if (re.test(bod)) return why;
  }
  return null;
}

/**
 * Page-column switches keep the physical page surface canonical, but they
 * no longer make the resident line breaker unsafe. The dormant output
 * routine executes LaTeX's real \onecolumn/\twocolumn definitions and
 * captures the resulting column state; SyncTeX then provides the physical
 * page/column address for the narrow text overlay.
 */
export function bodyUsesColumnSwitch(text) {
  return BODY_COLUMN_SWITCH_RE.test(safetySource(text));
}

/**
 * Classify a whole document for the structured layer (composition of the
 * two halves; kept for tests and one-shot callers).
 * @returns {{safe: boolean, reasons: string[]}}
 */
export function classifyDocument(preamble, body) {
  const pre = classifyPreamble(preamble);
  const reasons = [...pre.reasons];
  const aliases = classifyStructuralAliases(preamble, body);
  reasons.push(...aliases.reasons);
  const bod = safetySource(body);
  for (const [re, why] of UNSAFE_BODY) {
    if (re.test(bod)) reasons.push(why);
  }
  for (const [re, why] of UNSAFE_PAGE_GEOMETRY) {
    if (re.test(bod)) reasons.push(why);
  }
  const bodyColumnSwitch = BODY_COLUMN_SWITCH_RE.test(bod);
  const shippingExact = aliases.requiresShippingExact;
  return {
    safe: reasons.length === 0,
    reasons: [...new Set(reasons)],
    previewPolicy: shippingExact
      ? 'shipping-exact'
      : bodyColumnSwitch
        ? 'canonical-anchor'
        : pre.previewPolicy,
    previewReasons: shippingExact
      ? [...new Set(aliases.shippingExactUses.flatMap((use) =>
          use.sinks.map((sink) => `certified structural alias: ${use.key} -> ${sink}`)
        ))]
      : bodyColumnSwitch
      ? [...new Set([...pre.previewReasons, 'body column switch'])]
      : pre.previewReasons,
  };
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
