import { readFileSync } from 'node:fs';
import path from 'node:path';
import { documentBounds } from '../segmenter.js';
import { isPathInside, resolveProjectInput } from '../project-inputs.js';
import { stripComments } from './safety.js';

// Environments that drive TeX's page builder themselves (own \output,
// column balancing against \vsize) or that MUST break across real pages
// (longtable's page-splitting, landscape's rotated geometry). On the
// dormant \vsize=\maxdimen page they yield garbage or a single giant
// galley — route them through the isolated exact-render rescue, where a
// real lualatex with the real \textheight typesets them exactly as print
// (taller-than-page material ships real pages → per-page chunks with
// forced breaks).
// environments the dormant galley cannot represent: output-routine swappers
// (multicols, longtable …) and page-context readers that split against
// \pagegoal-\pagetotal (mdframed, framed, breakable tcolorbox).
// wrapfig/rotating/algorithm floats are here because only figure/table are
// shimmed for capture — unshimmed float envs used to be absorbed by the
// dormant output routine and silently VANISH from the preview; the rescue
// tier at least shows their real pixels inline (canonical owns placement).
// algorithm[H] is exempt: an H placement never enters the float queue (it
// typesets inline like any box), so the fast path already shows it — only
// FLOATING algorithm blocks need the rescue.
const OUTPUT_HIJACK_RE =
  /\\begin\{(multicols\*?|paracol|longtable|landscape|mdframed|framed|shaded|wrapfigure|wraptable|sidewaysfigure|sidewaystable)\}|\\begin\{algorithm\*?\}(?!\[[^\]]*H)|\\begin\{tcolorbox\}\[[^\]]*breakable|\\includepdf\b/;

// Ordinary forced breaks are retained by the native output absorb, including
// material before/after the break. Isolating them loses page context and can
// turn clearpage's empty output into another printed page. Title machinery
// still uses the isolated path for class-specific output and page styles.
const TITLE_RE = /\\maketitle\b/;
const RESCUE_STRUCTURAL_SINKS = new Set([
  'includepdf',
  'maketitle',
  'multicols',
  'multicols*',
  'paracol',
  'longtable',
  'landscape',
  'mdframed',
  'framed',
  'shaded',
  'wrapfigure',
  'wraptable',
  'sidewaysfigure',
  'sidewaystable',
  'algorithm',
  'algorithm*',
  'tcolorbox',
]);

function skipSpace(source, at) {
  while (at < source.length && /\s/.test(source[at])) at++;
  return at;
}

function readBalanced(source, at, open, close) {
  if (source[at] !== open) return null;
  let depth = 0;
  for (let i = at; i < source.length; i++) {
    if (source[i] === '\\') {
      i++; // escaped delimiters do not close the TeX argument
      continue;
    }
    if (source[i] === open) depth++;
    else if (source[i] === close && --depth === 0) {
      return { value: source.slice(at + 1, i), end: i + 1 };
    }
  }
  return null;
}

/** Find custom tcolorbox environments whose option argument enables
 * `breakable`. Definitions are commonly formatted across many lines, so
 * a line-bounded regex misses the normal form used by TeX documents.
 * The xparse forms (\DeclareTColorBox & co.) take an argument
 * specification in braces where \newtcolorbox takes [n][default]. */
export function collectBreakableTcolorboxNames(preamble) {
  const source = stripComments(preamble);
  const names = [];
  const declarations =
    /\\(newtcolorbox|renewtcolorbox|newtcbtheorem|renewtcbtheorem|DeclareTColorBox|NewTColorBox|RenewTColorBox|ProvideTColorBox)\b/g;
  for (const match of source.matchAll(declarations)) {
    const theorem = /tcbtheorem$/.test(match[1]);
    const xparse = /TColorBox$/.test(match[1]);
    let at = skipSpace(source, match.index + match[0].length);
    if (source[at] === '[') {
      const initial = readBalanced(source, at, '[', ']');
      if (!initial) continue;
      at = skipSpace(source, initial.end);
    }
    const name = readBalanced(source, at, '{', '}');
    if (!name || !/^[A-Za-z@0-9]+$/.test(name.value)) continue;
    at = skipSpace(source, name.end);
    if (xparse) {
      const spec = readBalanced(source, at, '{', '}');
      if (!spec) continue;
      at = skipSpace(source, spec.end);
    }
    while (source[at] === '[') {
      const optional = readBalanced(source, at, '[', ']');
      if (!optional) break;
      at = skipSpace(source, optional.end);
    }
    if (theorem) {
      const displayName = readBalanced(source, at, '{', '}');
      if (!displayName) continue;
      at = skipSpace(source, displayName.end);
    }
    const options = readBalanced(source, at, '{', '}');
    if (options && /\bbreakable\b(?!\s*=\s*false\b)/.test(options.value)) names.push(name.value);
  }
  return [...new Set(names)];
}

/**
 * The text of the packages and classes the preamble loads from the project
 * itself (a local .sty next to main.tex, and what those load in turn).
 * Documents keep their box definitions there: the 316-page sandbox declares
 * all 36 of its tcolorboxes in stypattern2-boxes.sty (tex64-internal #88).
 * TeX-system packages stay out: reading TEXMF would cost a kpathsea walk
 * per preamble, and their breakable boxes are used through \tcolorbox.
 */
export function projectPackageText(preamble, { docDir, overlayDir = null } = {}) {
  if (!docDir) return '';
  const parts = [];
  const seen = new Set();
  const visit = (text, depth) => {
    if (depth > 6) return;
    const clean = stripComments(text);
    const loads =
      /\\(?:usepackage|RequirePackage|RequirePackageWithOptions|documentclass|LoadClass|LoadClassWithOptions)\s*(?:\[[^\]]*\]\s*)?\{([^}]+)\}/g;
    for (const match of clean.matchAll(loads)) {
      const ext = /documentclass|LoadClass/.test(match[0]) ? '.cls' : '.sty';
      for (const raw of match[1].split(',')) {
        const name = raw.trim();
        if (!name || /[\\#{}]/.test(name)) continue;
        const resolved = resolveProjectInput(name.endsWith(ext) ? name : name + ext, { docDir, overlayDir });
        if (!resolved || !isPathInside(docDir, resolved.actualPath) || seen.has(resolved.actualPath)) continue;
        seen.add(resolved.actualPath);
        let body;
        try { body = readFileSync(resolved.readPath, 'utf8'); } catch { continue; }
        parts.push(body);
        visit(body, depth + 1);
      }
    }
    for (const match of clean.matchAll(/\\input\s*\{([^}]+)\}/g)) {
      const name = match[1].trim();
      const resolved = resolveProjectInput(name, { docDir, overlayDir, extensions: ['.tex', '.sty'] });
      if (!resolved || !isPathInside(docDir, resolved.actualPath) || seen.has(resolved.actualPath) ||
          !/\.(?:sty|cls|tex|def|cfg)$/i.test(resolved.actualPath)) continue;
      seen.add(resolved.actualPath);
      let body;
      try { body = readFileSync(resolved.readPath, 'utf8'); } catch { continue; }
      parts.push(body);
      visit(body, depth + 1);
    }
  };
  visit(preamble, 0);
  return parts.join('\n');
}

const namesRe = (names) => names.length
  ? new RegExp(`\\\\begin\\{(?:${names.map((name) => name.replace(/[@]/g, '\\$&')).join('|')})\\}`)
  : null;

/**
 * Rescue triggers: the static hijack list plus breakable tcolorbox
 * environments the PREAMBLE defines (\newtcolorbox/\newtcbtheorem with
 * a `breakable` option create page-splitting envs under custom names).
 */
export function needsRescue(text, {
  preHash,
  breakableFor,
  breakableRe,
  packageBreakableRe = null,
  source,
  packageText = () => '',
  structuralSinks = [],
}) {
  const live = stripComments(text); // `% \begin{longtable}` must not cost a rescue
  const aliasNeedsRescue = structuralSinks.some((sink) => RESCUE_STRUCTURAL_SINKS.has(sink));
  if (breakableFor !== preHash) {
    const src = source() ?? '';
    const b = documentBounds(src);
    const pre = src.slice(b.preamble.start, b.preamble.end);
    const names = collectBreakableTcolorboxNames(pre);
    breakableRe = namesRe(names);
    // Boxes a project package declares: most instances fit where they
    // stand, and the fast path is exact for those. Rescuing all of them
    // would cost one isolated compile each (570 on the 316-page sandbox);
    // queueMovedOffsets rescues only the instances that do not fit from
    // their entry offset, where the real run splits them.
    const packageNames = collectBreakableTcolorboxNames(packageText(pre))
      .filter((name) => !names.includes(name));
    packageBreakableRe = namesRe(packageNames);
    breakableFor = preHash;
  }
  const state = { breakableFor, breakableRe, packageBreakableRe };
  if (aliasNeedsRescue || OUTPUT_HIJACK_RE.test(live) || TITLE_RE.test(live)) {
    return { needs: true, ...state };
  }
  return { needs: breakableRe ? breakableRe.test(live) : false, ...state };
}

/** True when `text` opens a breakable box a project package declares. */
export function opensPackageBreakable(text, packageBreakableRe) {
  return !!packageBreakableRe && packageBreakableRe.test(stripComments(text));
}
