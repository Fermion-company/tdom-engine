import { documentBounds } from '../segmenter.js';
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
 * a line-bounded regex misses the normal form used by TeX documents. */
export function collectBreakableTcolorboxNames(preamble) {
  const source = stripComments(preamble);
  const names = [];
  for (const match of source.matchAll(/\\(newtcolorbox|newtcbtheorem)\b/g)) {
    const theorem = match[1] === 'newtcbtheorem';
    let at = skipSpace(source, match.index + match[0].length);
    if (source[at] === '[') {
      const initial = readBalanced(source, at, '[', ']');
      if (!initial) continue;
      at = skipSpace(source, initial.end);
    }
    const name = readBalanced(source, at, '{', '}');
    if (!name || !/^[A-Za-z@]+$/.test(name.value)) continue;
    at = skipSpace(source, name.end);
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
 * Rescue triggers: the static hijack list plus breakable tcolorbox
 * environments the PREAMBLE defines (\newtcolorbox/\newtcbtheorem with
 * a `breakable` option create page-splitting envs under custom names).
 */
export function needsRescue(text, { preHash, breakableFor, breakableRe, source, structuralSinks = [] }) {
  const live = stripComments(text); // `% \begin{longtable}` must not cost a rescue
  if (structuralSinks.length || OUTPUT_HIJACK_RE.test(live) || TITLE_RE.test(live)) {
    return { needs: true, breakableFor, breakableRe };
  }
  if (breakableFor !== preHash) {
    const src = source() ?? '';
    const b = documentBounds(src);
    const pre = src.slice(b.preamble.start, b.preamble.end);
    const names = collectBreakableTcolorboxNames(pre);
    breakableRe = names.length
      ? new RegExp(`\\\\begin\\{(?:${names.join('|')})\\}`)
      : null;
    breakableFor = preHash;
  }
  return {
    needs: breakableRe ? breakableRe.test(live) : false,
    breakableFor,
    breakableRe,
  };
}
