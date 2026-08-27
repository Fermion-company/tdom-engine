// Direct-edit regions for the live PDF surface.
//
// The source stays authoritative. We conservatively identify source spans
// that can be replaced without rewriting surrounding LaTeX syntax. The
// resident and canonical compilers both receive unchanged TeX; the client
// combines these spans with TeX-harvested line geometry and SyncTeX.

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
  if (text[index] === '$' && !escaped(text, index)) {
    const double = text[index + 1] === '$';
    const token = double ? '$$' : '$';
    for (let i = index + token.length; i < end; i++) {
      if (!escaped(text, i) && text.startsWith(token, i)) {
        return {
          start: index,
          end: i + token.length,
          contentStart: index + token.length,
          contentEnd: i,
          display: double,
        };
      }
    }
    return null;
  }
  if (text.startsWith('\\(', index) || text.startsWith('\\[', index)) {
    const close = text[index + 1] === '(' ? '\\)' : '\\]';
    for (let i = index + 2; i < end - 1; i++) {
      if (text.startsWith(close, i) && !escaped(text, i)) {
        return {
          start: index,
          end: i + 2,
          contentStart: index + 2,
          contentEnd: i,
          display: text[index + 1] === '[',
        };
      }
    }
  }
  return null;
}

function environmentAt(text, index, end) {
  if (!text.startsWith('\\begin', index)) return null;
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
  const close = `\\end{${name}}`;
  const closeAt = text.indexOf(close, contentStart);
  if (closeAt < 0 || closeAt >= end) return null;
  return {
    name,
    start: index,
    contentStart,
    contentEnd: closeAt,
    end: closeAt + close.length,
    optional,
  };
}

/** Return non-overlapping editable source spans, ordered by source offset. */
export function discoverEditRegions(source) {
  const text = String(source ?? '');
  const regions = [];

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
    const value = visibleValue ?? sourceValue;
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
      ...(metadata ?? {}),
    });
  };

  const scan = (from, to, visible) => {
    let i = from;
    while (i < to) {
      if (text[i] === '%' && !escaped(text, i)) {
        const nl = text.indexOf('\n', i + 1);
        i = nl < 0 || nl >= to ? to : nl + 1;
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
        const env = environmentAt(text, i, to);
        if (env) {
          if (MATH_ENVS.has(env.name)) {
            add('math', env.start, env.end, env.contentStart, env.contentEnd, null, {
              display: env.name !== 'math',
            });
          } else if (!VERBATIM_ENVS.has(env.name)) {
            if (env.optional && VISIBLE_ENVIRONMENT_OPTIONS.has(env.name)) {
              scan(env.optional.start, env.optional.end, true);
            }
            scan(env.contentStart, env.contentEnd, visible);
          }
          i = env.end;
          continue;
        }

        const control = controlAt(text, i);
        if (!control) { i++; continue; }
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
