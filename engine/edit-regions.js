// Direct-edit regions for the live PDF surface.
//
// The source stays authoritative. We conservatively identify source spans
// that can be replaced without rewriting surrounding LaTeX syntax. The
// resident and canonical compilers both receive unchanged TeX; the client
// combines these spans with TeX-harvested line geometry and SyncTeX.

import mathMacros from '../web/math-macro-projection.cjs';
import { detokenizedArgument, stringToken } from './checkpoint/closure.js';

const MATH_ENVS = new Set([
  'math', 'displaymath', 'equation', 'equation*', 'align', 'align*',
  'alignat', 'alignat*', 'gather', 'gather*', 'multline', 'multline*',
  'flalign', 'flalign*', 'eqnarray', 'eqnarray*',
]);

const VERBATIM_ENVS = new Set([
  'verbatim', 'verbatim*', 'lstlisting', 'minted', 'alltt',
  'BVerbatim', 'LVerbatim', 'Verbatim', 'BVerbatim*', 'LVerbatim*', 'Verbatim*',
]);

const VISIBLE_ENVIRONMENT_OPTIONS = new Set([
  'theorem', 'lemma', 'proposition', 'corollary', 'definition',
  'remark', 'example', 'exercise', 'problem', 'proof',
]);

// Arguments immediately following these \begin{...} declarations describe
// layout, not printed prose.  They must be consumed before the environment
// body is scanned or values such as a tabular column specification (`lrr`)
// become bogus editable text.
const ENVIRONMENT_PREFIX_ARGUMENTS = new Map([
  ['array', ['required']],
  ['tabular', ['required']],
  ['tabular*', ['required', 'optional', 'required']],
  ['tabularx', ['required', 'required']],
  ['longtable', ['required']],
  ['thebibliography', ['required']],
  ['minipage', ['optional', 'optional', 'optional', 'required']],
]);

const VISIBLE_ESCAPES = new Map([
  ['%', '%'],
  ['#', '#'],
  ['_', '_'],
  ['&', '&'],
  ['$', '$'],
  ['{', '{'],
  ['}', '}'],
]);

// Only arguments that are genuinely printed prose are traversed.  Unknown
// command arguments are deliberately opaque: editing \label{key}, a cite key,
// a file path, a length, or macro code as if it were visible text is worse than
// leaving that uncommon fragment source-only.
const VISIBLE_ARGUMENTS = new Set([
  'title', 'author', 'date', 'thanks',
  'part', 'chapter', 'section', 'subsection', 'subsubsection',
  'paragraph', 'subparagraph', 'caption',
  'text', 'textrm', 'textsf', 'texttt', 'textnormal',
  'textbf', 'textmd', 'textit', 'textsl', 'textsc', 'emph',
  'textsuperscript', 'textsubscript', 'oldstylenums',
  'underline', 'uline', 'uuline', 'uwave', 'dashuline', 'dotuline', 'sout', 'xout',
  'mbox', 'fbox', 'framebox', 'makebox', 'makecell', 'shortstack',
  'enquote', 'footnote', 'marginpar',
]);

// Commands whose final printed argument follows one or more structural
// arguments. Only the visible argument is exposed, so changing a link label,
// colored phrase, or spanning table cell cannot alter its URL, color, width,
// or alignment contract.
const VISIBLE_AFTER_REQUIRED_ARGUMENTS = new Map([
  ['href', 1],
  ['textcolor', 1],
  ['colorbox', 1],
  ['fcolorbox', 2],
  ['foreignlanguage', 1],
  ['captionof', 1],
  ['multicolumn', 2],
  ['multirow', 2],
  ['parbox', 1],
  ['raisebox', 1],
  ['rotatebox', 1],
  ['resizebox', 2],
]);

const TEXT_BREAK = new Set(['\\', '$', '{', '}', '%', '~', '^', '_', '&', '#']);

function escaped(text, index) {
  let slashes = 0;
  for (let i = index - 1; i >= 0 && text[i] === '\\'; i--) slashes++;
  return (slashes & 1) === 1;
}

function controlAt(text, index) {
  if (text[index] !== '\\') return null;
  const next = text[index + 1] ?? '';
  if (/[A-Za-z@]/.test(next)) {
    let end = index + 2;
    while (end < text.length && /[A-Za-z@]/.test(text[end])) end++;
    return { name: text.slice(index + 1, end), end };
  }
  return { name: next, end: Math.min(text.length, index + 2) };
}

function skipSpace(text, index, end) {
  while (index < end && /\s/.test(text[index])) index++;
  return index;
}

function balanced(text, open, close, index, end) {
  if (text[index] !== open) return null;
  let depth = 1;
  for (let i = index + 1; i < end; i++) {
    if (text[i] === '%' && !escaped(text, i)) {
      const nl = text.indexOf('\n', i + 1);
      if (nl < 0 || nl >= end) return null;
      i = nl;
      continue;
    }
    if (escaped(text, i)) continue;
    if (text[i] === open) depth++;
    else if (text[i] === close && --depth === 0) return { start: index + 1, end: i, after: i + 1 };
  }
  return null;
}

function mathDelimited(text, index, end) {
  const opener = text[index] === '$' ? (text[index + 1] === '$' ? '$$' : '$') :
    text[index] === '\\' && (text[index + 1] === '(' || text[index + 1] === '[') ? text.slice(index, index + 2) : null;
  if (!opener || escaped(text, index)) return null;
  const closer = opener === '\\(' ? '\\)' : opener === '\\[' ? '\\]' : opener;
  const tokens = /\\(?:[A-Za-z@]+|[\s\S])|%|\$/g;
  tokens.lastIndex = index + opener.length;
  for (let token; (token = tokens.exec(text)) && token.index < end;) {
    if (token[0] === '%') {
      const newline = text.indexOf('\n', tokens.lastIndex);
      if (newline < 0 || newline >= end) return null;
      tokens.lastIndex = newline + 1;
    } else if (text.startsWith(closer, token.index) && token.index + closer.length <= end) {
      return { start: index, end: token.index + closer.length, contentStart: index + opener.length,
        contentEnd: token.index, display: opener === '$$' || opener === '\\[' };
    } else if (token[0][0] === '\\') {
      const literal = inlineLiteral(text, { name: token[0].slice(1), end: tokens.lastIndex }, end);
      if (literal) tokens.lastIndex = literal.after;
    }
  }
  return null;
}

// Inline code is literal up to its closing delimiter or the end of its line.
// A pasted unfinished example must not hide the rest of the manuscript.
export function inlineLiteral(text, control, end, readValue = false) {
  if (control.name === 'detokenize') return detokenizedArgument(text, control.end, end, readValue);
  if (control.name === 'string') return stringToken(text, control.end, end);
  if (!['verb', 'lstinline', 'mintinline'].includes(control.name)) return null;
  let at = control.end;
  const newline = text.indexOf('\n', at);
  const stop = newline < 0 ? end : Math.min(end, newline);
  if (control.name === 'verb') {
    if (text[at] === '*') at++;
  } else {
    at = skipSpace(text, at, stop);
    if (text[at] === '[') at = balanced(text, '[', ']', at, stop)?.after ?? stop;
    if (control.name === 'mintinline') at = balanced(text, '{', '}', skipSpace(text, at, stop), stop)?.after ?? stop;
    at = skipSpace(text, at, stop);
    if (text[at] === '{') {
      const group = balanced(text, '{', '}', at, stop);
      return group ?? { after: stop };
    }
  }
  if (at >= stop) return { after: stop };
  const close = text.slice(at + 1, stop).indexOf(text[at]);
  return close < 0 ? { after: stop } : { start: at + 1, end: at + 1 + close, after: at + 2 + close };
}

// Match closing commands once per block. In particular the inner tabular's
// closing command must not terminate the surrounding cell or table.
function environmentClosings(text) {
  const pairs = new Map(), stack = [];
  const tokens = /%|\\(?:[A-Za-z@]+|[\s\S])/g;
  const argument = /\s*\{\s*([^{}\\%\s]+)\s*\}/y;
  for (let token; (token = tokens.exec(text));) {
    if (token[0] === '%') {
      const newline = text.indexOf('\n', tokens.lastIndex);
      if (newline < 0) break;
      tokens.lastIndex = newline + 1;
      continue;
    }
    const name = token[0].slice(1);
    if (name !== 'begin' && name !== 'end') {
      const literal = inlineLiteral(text, { name, end: tokens.lastIndex }, text.length);
      if (literal) tokens.lastIndex = literal.after;
      continue;
    }
    argument.lastIndex = tokens.lastIndex;
    const arg = argument.exec(text);
    if (!arg) continue;
    tokens.lastIndex = argument.lastIndex;
    if (name === 'end') {
      if (stack.at(-1)?.name === arg[1]) pairs.set(stack.pop().start, { at: token.index, end: tokens.lastIndex });
    } else if (VERBATIM_ENVS.has(arg[1])) {
      const close = '\\end{' + arg[1] + '}', at = text.indexOf(close, tokens.lastIndex);
      if (at < 0) break;
      tokens.lastIndex = at + close.length;
      pairs.set(token.index, { at, end: tokens.lastIndex });
    } else stack.push({ start: token.index, name: arg[1] });
  }
  return pairs;
}

function environmentAt(text, index, end, close) {
  if (!close || close.end > end) return null;
  let p = skipSpace(text, index + 6, end);
  const nameArg = balanced(text, '{', '}', p, end);
  if (!nameArg) return null;
  const name = text.slice(nameArg.start, nameArg.end).trim();
  let contentStart = nameArg.after;
  const optionalAt = skipSpace(text, contentStart, end);
  let optional = null;
  if (text[optionalAt] === '[') {
    optional = balanced(text, '[', ']', optionalAt, end);
    if (optional) contentStart = optional.after;
  }
  for (const argument of ENVIRONMENT_PREFIX_ARGUMENTS.get(name) ?? []) {
    contentStart = skipSpace(text, contentStart, end);
    const open = argument === 'optional' ? '[' : '{';
    const closeArg = argument === 'optional' ? ']' : '}';
    if (text[contentStart] !== open) {
      if (argument === 'optional') continue;
      break;
    }
    const parsed = balanced(text, open, closeArg, contentStart, end);
    if (!parsed) break;
    contentStart = parsed.after;
  }
  return {
    name,
    start: index,
    contentStart,
    contentEnd: close.at,
    end: close.end,
    optional,
  };
}

/** Return non-overlapping editable source spans, ordered by source offset. */
export function discoverEditRegions(source) {
  const text = String(source ?? '');
  const regions = [];
  let tableCell = null, closings, leadingLiteral = '';

  const add = (
    kind,
    start,
    end,
    contentStart = start,
    contentEnd = end,
    visibleValue = null,
    metadata = null
  ) => {
    if (end <= start || contentEnd < contentStart) return;
    const sourceValue = text.slice(contentStart, contentEnd);
    const value = visibleValue ?? (kind === 'math' ? mathMacros.withoutComments(sourceValue) : sourceValue);
    if (kind === 'text' && !/\S/u.test(value)) return;
    regions.push({
      id: regions.length + 1,
      kind,
      start,
      end,
      contentStart,
      contentEnd,
      value,
      sourceValue,
      ...(tableCell && { tableRow: tableCell.row, tableColumn: tableCell.column,
        ...(leadingLiteral && { tableLiteralBefore: leadingLiteral }),
        ...(tableCell.span > 1 && { tableSpan: tableCell.span }) }),
      ...(metadata ?? {}),
    });
    leadingLiteral = '';
  };

  const finishRow = (table) => {
    for (let i = table.firstRegion; i < regions.length; i++) {
      const region = regions[i];
      if (region.tableRow !== table.row) continue;
      if (table.unknownSpan) {
        delete region.tableRow;
        delete region.tableColumn;
        delete region.tableSpan;
      } else region.tableColumns = table.column + table.span;
    }
  };
  const scan = (from, to, visible, table = null) => {
    let i = from;
    while (i < to) {
      if (text[i] === '%' && !escaped(text, i)) {
        const nl = text.indexOf('\n', i + 1);
        i = nl < 0 || nl >= to ? to : nl + 1;
        continue;
      }

      if (table && text[i] === '&') {
        table.column += table.span;
        table.span = 1;
        i++;
        continue;
      }

      const math = mathDelimited(text, i, to);
      if (math) {
        add('math', math.start, math.end, math.contentStart, math.contentEnd, null, {
          display: math.display,
        });
        i = math.end;
        continue;
      }

      if (text[i] === '\\') {
        const env = text.startsWith('\\begin', i) &&
          environmentAt(text, i, to, (closings ??= environmentClosings(text)).get(i));
        if (env) {
          if (MATH_ENVS.has(env.name)) {
            add('math', env.start, env.end, env.contentStart, env.contentEnd, null, {
              display: env.name !== 'math',
            });
          } else if (!VERBATIM_ENVS.has(env.name)) {
            if (env.optional && VISIBLE_ENVIRONMENT_OPTIONS.has(env.name)) {
              scan(env.optional.start, env.optional.end, true);
            }
            if (['tabular', 'tabular*', 'tabularx', 'longtable'].includes(env.name)) {
              const previous = tableCell;
              tableCell = { row: env.contentStart, column: 0, span: 1, firstRegion: regions.length };
              scan(env.contentStart, env.contentEnd, visible, tableCell);
              finishRow(tableCell);
              tableCell = previous;
            } else scan(env.contentStart, env.contentEnd, visible);
          }
          i = env.end;
          continue;
        }

        const control = controlAt(text, i);
        if (!control) { i++; continue; }
        const literal = inlineLiteral(text, control, to, Boolean(tableCell));
        if (literal) {
          // Literal ink participates in identifying the surrounding cells,
          // but must never receive a prose or math edit of its own.
          if (tableCell && literal.start != null) {
            const value = literal.value ?? text.slice(literal.start, literal.end);
            const previous = regions.at(-1);
            if (previous?.tableRow != null) previous.tableLiteralAfter = (previous.tableLiteralAfter ?? '') + value;
            else leadingLiteral += value;
          }
          i = literal.after;
          continue;
        }
        if (table && (control.name === '\\' || control.name === 'tabularnewline' || control.name === 'cr')) {
          finishRow(table);
          i = control.end;
          if (text[i] === '*') i++;
          const option = balanced(text, '[', ']', skipSpace(text, i, to), to);
          if (option) i = option.after;
          table.row = i;
          table.column = 0;
          table.span = 1;
          table.unknownSpan = false;
          table.firstRegion = regions.length;
          continue;
        }
        if (VISIBLE_ESCAPES.has(control.name)) {
          add('text', i, control.end, i, control.end, VISIBLE_ESCAPES.get(control.name));
          i = control.end;
          continue;
        }
        i = control.end;
        if (control.name === 'item') {
          i = skipSpace(text, i, to);
          if (text[i] === '[') {
            const label = balanced(text, '[', ']', i, to);
            if (label) {
              scan(label.start, label.end, true);
              i = label.after;
            }
          }
          continue;
        }
        const structuralPrefix = VISIBLE_AFTER_REQUIRED_ARGUMENTS.get(control.name);
        if (structuralPrefix != null) {
          if (text[i] === '*') i++;
          i = skipSpace(text, i, to);
          // Package commands commonly put one or more layout/color options
          // before their required arguments. None are printed prose.
          while (text[i] === '[') {
            const optional = balanced(text, '[', ']', i, to);
            if (!optional) break;
            i = skipSpace(text, optional.after, to);
          }
          let complete = true;
          for (let argument = 0; argument < structuralPrefix; argument++) {
            const structural = balanced(text, '{', '}', i, to);
            if (!structural) {
              complete = false;
              break;
            }
            if (table && control.name === 'multicolumn' && argument === 0) {
              const count = text.slice(structural.start, structural.end).trim();
              if (/^[1-9]\d*$/.test(count) && Number.isSafeInteger(Number(count))) table.span = Number(count);
              else table.unknownSpan = true;
            }
            i = skipSpace(text, structural.after, to);
            // `raisebox` and a few related commands place optional dimensions
            // between the required layout value and the visible content.
            while (text[i] === '[') {
              const optional = balanced(text, '[', ']', i, to);
              if (!optional) break;
              i = skipSpace(text, optional.after, to);
            }
          }
          const visibleArg = complete ? balanced(text, '{', '}', i, to) : null;
          if (visibleArg) {
            scan(visibleArg.start, visibleArg.end, true);
            i = visibleArg.after;
          }
          continue;
        }
        if (!VISIBLE_ARGUMENTS.has(control.name)) {
          // Structural/unknown command arguments are opaque.  Consume them
          // here so the generic `{...}` branch below cannot accidentally
          // expose a label key, citation key, path, macro body, or dimension
          // as editable prose.
          let p = skipSpace(text, i, to);
          if (text[p] === '*') p = skipSpace(text, p + 1, to);
          if (text[p] === '[') {
            const optional = balanced(text, '[', ']', p, to);
            if (optional) p = skipSpace(text, optional.after, to);
          }
          while (text[p] === '{') {
            const arg = balanced(text, '{', '}', p, to);
            if (!arg) break;
            p = skipSpace(text, arg.after, to);
          }
          i = p;
          continue;
        }
        // Starred sectioning commands and optional short titles/captions.
        if (text[i] === '*') i++;
        i = skipSpace(text, i, to);
        while (text[i] === '[') {
          const optional = balanced(text, '[', ']', i, to);
          if (!optional) break;
          i = skipSpace(text, optional.after, to);
        }
        const arg = balanced(text, '{', '}', i, to);
        if (arg) {
          scan(arg.start, arg.end, true);
          i = arg.after;
        }
        continue;
      }

      if (text[i] === '{') {
        const group = balanced(text, '{', '}', i, to);
        if (group) {
          if (visible) scan(group.start, group.end, true);
          i = group.after;
          continue;
        }
      }

      if (!visible || TEXT_BREAK.has(text[i])) { i++; continue; }
      const start = i;
      while (i < to && !TEXT_BREAK.has(text[i])) i++;
      // Trim boundary whitespace: it belongs to TeX line-breaking, while the
      // editable value should be the characters the user actually sees.
      let a = start;
      let b = i;
      while (a < b && /\s/.test(text[a])) a++;
      while (b > a && /\s/.test(text[b - 1])) b--;
      add('text', a, b);
    }
  };

  scan(0, text.length, true);
  return regions;
}

/** Return source-identical resident input plus conservative edit metadata. */
export function instrumentEditRegions(source, { baseId = 0 } = {}) {
  const text = String(source ?? '');
  const regions = discoverEditRegions(text).map((region) => ({
    ...region,
    id: region.id + baseId,
  }));
  // Keep the resident input byte-for-byte equivalent at TeX's token layer.
  // Even attribute assignments can alter paragraph/checkpoint state in
  // complex documents. Hit geometry comes from unchanged line boxes plus
  // these conservative source regions instead.
  return { text, regions };
}
