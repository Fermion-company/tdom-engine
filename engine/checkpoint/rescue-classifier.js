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

/**
 * Rescue triggers: the static hijack list plus breakable tcolorbox
 * environments the PREAMBLE defines (\newtcolorbox/\newtcbtheorem with
 * a `breakable` option create page-splitting envs under custom names).
 */
export function needsRescue(text, { preHash, breakableFor, breakableRe, source }) {
  const live = stripComments(text); // `% \begin{longtable}` must not cost a rescue
  if (OUTPUT_HIJACK_RE.test(live)) {
    return { needs: true, breakableFor, breakableRe };
  }
  if (breakableFor !== preHash) {
    const src = source() ?? '';
    const b = documentBounds(src);
    const pre = src.slice(b.preamble.start, b.preamble.end);
    const names = [];
    for (const m of pre.matchAll(/\\newtcolorbox\{([A-Za-z@]+)\}[^\n]*?breakable/g)) names.push(m[1]);
    for (const m of pre.matchAll(/\\newtcbtheorem(?:\[[^\]]*\])?\{([A-Za-z@]+)\}[^\n]*?breakable/g)) names.push(m[1]);
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
