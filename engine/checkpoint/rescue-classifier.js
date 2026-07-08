import { documentBounds } from '../segmenter.js';

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
// \pagegoal-\pagetotal (mdframed, framed, breakable tcolorbox)
const OUTPUT_HIJACK_RE =
  /\\begin\{(multicols\*?|paracol|longtable|landscape|mdframed|framed|shaded)\}|\\begin\{tcolorbox\}\[[^\]]*breakable|\\includepdf\b/;

/**
 * Rescue triggers: the static hijack list plus breakable tcolorbox
 * environments the PREAMBLE defines (\newtcolorbox/\newtcbtheorem with
 * a `breakable` option create page-splitting envs under custom names).
 */
export function needsRescue(text, { preHash, breakableFor, breakableRe, source }) {
  if (OUTPUT_HIJACK_RE.test(text)) {
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
    needs: breakableRe ? breakableRe.test(text) : false,
    breakableFor,
    breakableRe,
  };
}
