/**
 * True when a block opens with a vertical-mode environment (its content
 * begins in vertical mode, not by continuing a paragraph). Such blocks must
 * not be forced into horizontal mode with \noindent in the isolated rescue.
 */
function startsVertical(text) {
  return /^\s*(\\begin\s*\{|\\(chapter|section|subsection|subsubsection|vspace|vskip|clearpage|newpage|noindent)\b)/.test(text);
}

/**
 * True when a block opens with a construct that emits leading vertical space
 * via LaTeX's \addvspace (sectioning commands, list/box environments, the
 * \…skip family) — i.e. it MERGES (maxes) against \lastskip rather than
 * summing. Only such blocks want the \lastskip primer; a plain paragraph
 * keeps \lastskip and would just accrue the primer as extra height.
 */
function startsAddvspace(text) {
  return /^\s*(\\begin\s*\{|\\(chapter|section|subsection|subsubsection|paragraph|subparagraph)\b|\\(addvspace|vspace|smallskip|medskip|bigskip)\b)/.test(text);
}

/**
 * The \r@<key> macro body for a live label definition. Plain labels carry a
 * bare page number; cleveref's @cref labels carry the bracketed page field
 * its parser expects ([1][1][]1 — pages are substituted by the orchestrator,
 * never read from here). Under hyperref the plain body must be the FIVE
 * group form {label}{page}{name}{anchor}{ext} — hyperref's \@setref and
 * \hyperref parse exactly five and typeset garbage otherwise.
 */
function labelDefBody(key, val, hy, href) {
  if (key.endsWith('@cref')) return `{{${val}}{[1][1][]1}}`;
  if (hy) return `{{${val}}{1}{}{${href ?? ''}}{}}`;
  return `{{${val}}{1}}`;
}

/** Kernel \@arabic/\@roman/\@Roman/\@alph/\@Alph transcriptions. */
function formatFolio(n, fmt) {
  if (fmt === 'roman' || fmt === 'Roman') {
    const table = [
      [1000, 'm'], [900, 'cm'], [500, 'd'], [400, 'cd'], [100, 'c'], [90, 'xc'],
      [50, 'l'], [40, 'xl'], [10, 'x'], [9, 'ix'], [5, 'v'], [4, 'iv'], [1, 'i'],
    ];
    let v = n;
    let out = '';
    for (const [val, sym] of table) {
      while (v >= val) {
        out += sym;
        v -= val;
      }
    }
    return fmt === 'Roman' ? out.toUpperCase() : out;
  }
  if (fmt === 'alph') return String.fromCharCode(96 + n);
  if (fmt === 'Alph') return String.fromCharCode(64 + n);
  return String(n);
}

/** Extract a balanced {...} group's contents starting at an opening brace. */
function extractBraced(text, open) {
  if (open < 0 || text[open] !== '{') return '';
  let depth = 1;
  let i = open + 1;
  while (i < text.length && depth > 0) {
    const c = text[i];
    if (c === '{' && text[i - 1] !== '\\') depth++;
    else if (c === '}' && text[i - 1] !== '\\') depth--;
    if (depth === 0) break;
    i++;
  }
  return text.slice(open + 1, i);
}

/** Pull the first TeX error lines out of a lualatex log/stdout capture. */
function texErrorFrom(log) {
  const lines = String(log || '').split('\n');
  const idx = lines.findIndex((l) => l.startsWith('! '));
  if (idx < 0) return '';
  return lines.slice(idx, idx + 2).join(' ').trim();
}

function scanCounterDefs(preamble) {
  const out = [];
  const re = /\\newtheorem\*?\{([^}]+)\}|\\newcounter\{([^}]+)\}/g;
  let m;
  while ((m = re.exec(preamble))) out.push(m[1] ?? m[2]);
  return out;
}

function luaStr(s) {
  return s.replace(/\\/g, '/').replace(/'/g, "\\'");
}

/** Net {…} depth of a block (comments stripped, \{ \} ignored). */
function braceImbalance(text) {
  let d = 0;
  for (const line of text.split('\n')) {
    let s = line;
    const ci = s.search(/(?<!\\)%/);
    if (ci >= 0) s = s.slice(0, ci);
    for (let i = 0; i < s.length; i++) {
      if (s[i] === '\\') { i++; continue; }
      if (s[i] === '{') d++;
      else if (s[i] === '}') d--;
    }
  }
  return d;
}

export {
  luaStr,
  braceImbalance,
  labelDefBody,
  extractBraced,
  startsVertical,
  startsAddvspace,
  scanCounterDefs,
  formatFolio,
  texErrorFrom,
};
