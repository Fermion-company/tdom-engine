// Package-independent lexical closure gate for the keystroke path.
//
// A positive result is deliberately modest: it only says that the source is
// not *obviously* waiting for more input.  The resident LuaLaTeX JOB is the
// semantic authority and supplies the second half of the certificate.  A
// negative result holds the resident tree instead of feeding invented
// closing tokens to TeX. Only canonical compilation can distinguish an
// unfinished document from syntax hidden behind macro expansion.

const LITERAL_ENVS = new Set([
  'verbatim',
  'verbatim*',
  'lstlisting',
  'minted',
  'alltt',
  'filecontents',
  'filecontents*',
  'Verbatim',
  'BVerbatim',
  'LVerbatim',
  'VVerbatim',
  'Verbatim*',
  'BVerbatim*',
  'LVerbatim*',
  'VVerbatim*',
  'SaveVerbatim',
  'VerbatimOut',
  'tcblisting',
  'luacode',
  'luacode*',
]);

const CONDITIONALS = new Set([
  'if',
  'ifcat',
  'ifnum',
  'ifdim',
  'ifodd',
  'ifvmode',
  'ifhmode',
  'ifmmode',
  'ifinner',
  'ifvoid',
  'ifhbox',
  'ifvbox',
  'ifx',
  'ifeof',
  'iftrue',
  'iffalse',
  'ifcase',
  'ifdefined',
  'ifcsname',
  'iffontchar',
]);

const fail = (reason, at) => ({ closed: false, reason, at });

function skipSpace(text, at) {
  while (at < text.length && /\s/.test(text[at])) at++;
  return at;
}

// TeX's \string reads one unexpanded token. Comments and intervening
// whitespace produce no printed characters; the returned offsets refer to
// the original source so the same token can be excluded from edit targets.
export function stringToken(text, at, limit = text.length) {
  let lineStart = false;
  while (at < limit) {
    if (text[at] === '\n') {
      if (lineStart) return { start: at, end: at + 1, after: at + 1, value: '\\par' };
      lineStart = true;
    } else if (text[at] === '%') {
      const newline = text.indexOf('\n', at);
      if (newline < 0 || newline >= limit) return { after: limit };
      at = newline;
      lineStart = true;
    } else if (!/\s/.test(text[at])) break;
    at++;
  }
  if (at === limit) return { after: limit };
  const start = at;
  if (text[at] === '\\' && ++at < limit && /[A-Za-z@]/.test(text[at])) {
    while (at < limit && /[A-Za-z@]/.test(text[at])) at++;
  } else if (at < limit) {
    at = Math.min(limit, at + (text.codePointAt(at) > 0xffff ? 2 : 1));
  }
  return { start, end: at, after: at };
}

// A braced \detokenize reads ordinary TeX tokens without expanding them.
// Only group braces govern its extent. When the editor needs the printed
// text, control words get their terminator and a parameter token prints ##.
export function detokenizedArgument(text, at, limit, readValue = false) {
  // The opening group must be the next token; expansion-driven forms
  // such as \detokenize\expandafter are left to TeX.
  const opening = stringToken(text, at, limit);
  if (opening.start == null || text[opening.start] !== '{') return null;
  at = opening.start;
  const start = ++at;
  let depth = 1, value = '', lineState = 'middle';
  while (at < limit) {
    const token = text[at++];
    if (token === '%') {
      const newline = text.indexOf('\n', at);
      at = newline < 0 ? limit : Math.min(limit, newline + 1);
      lineState = 'new';
      continue;
    }
    if (token === '\\') {
      const from = at - 1;
      const word = /[A-Za-z@]/.test(text[at] ?? '');
      if (word) while (at < limit && /[A-Za-z@]/.test(text[at])) at++;
      else if (at < limit) at += text.codePointAt(at) > 0xffff ? 2 : 1;
      if (readValue) value += text.slice(from, at) + (word ? ' ' : '');
      lineState = word ? 'skip' : 'middle';
      continue;
    }
    if (token === '{') depth++;
    if (token === '}' && --depth === 0) {
      return { start, end: at - 1, after: at, ...(readValue && { value }) };
    }
    if (token === '\n') {
      if (readValue) value += lineState === 'new' ? '\\par ' : lineState === 'middle' ? ' ' : '';
      lineState = 'new';
    } else if (/[ \t\r]/.test(token)) {
      if (lineState === 'middle') {
        if (readValue) value += ' ';
        lineState = 'skip';
      }
    } else {
      if (readValue) value += token === '#' ? '##' : token;
      lineState = 'middle';
    }
  }
  return { after: limit }; // no closing brace yet
}

function bracedArgument(text, at) {
  let i = at;
  while (i < text.length && /\s/.test(text[i])) i++;
  if (text[i] !== '{') return null;
  const start = i;
  let depth = 1;
  i++;
  while (i < text.length) {
    if (text[i] === '\\') {
      i += Math.min(2, text.length - i);
      continue;
    }
    if (text[i] === '{') depth++;
    else if (text[i] === '}' && --depth === 0) {
      return { value: text.slice(start + 1, i), end: i + 1 };
    }
    i++;
  }
  return null;
}

// `literalEnvs` names the literal environments the preamble declares
// (\lstnewenvironment and friends, see literalEnvironmentNames): a
// listing that quotes \end{document} or an unbalanced brace is closed.
/** Conditionals the document declares itself (\newif\ifdraft). */
export function declaredConditionals(text) {
  const names = new Set();
  for (const match of String(text ?? '').matchAll(/\\newif\s*\\(if[A-Za-z@]+)/g)) names.add(match[1]);
  return names;
}

// `documentConditionals` are the document's own switches (declaredConditionals)
// and `carried` the number of them an earlier block left open. A book wraps
// its chapter list in one: `\ifshortbuild\else` … forty \subfile lines …
// `\fi`. Read alone, the last of those blocks holds an unexpected \fi, and
// every edit of the book was deferred as unfinished source. A conditional of
// TeX's own that a block leaves open is still unfinished typing.
// The result's `carry` is what this block leaves open for the next.
export function sourceClosure(text, { literalEnvs = null, documentConditionals = null, carried = 0 } = {}) {
  const envs = [];
  let carriedLeft = Math.max(0, Number(carried) || 0);
  const conditionals = [];
  const loops = [];
  const customConditionals = new Set();
  const math = [];
  let groups = 0;
  let literal = null;

  for (let i = 0; i < text.length; ) {
    if (literal) {
      const endToken = `\\end{${literal}}`;
      const end = text.indexOf(endToken, i);
      if (end < 0) return fail(`environment:${literal}`, i);
      i = end + endToken.length;
      envs.pop();
      literal = null;
      continue;
    }

    const c = text[i];
    if (c === '%') {
      const nl = text.indexOf('\n', i + 1);
      i = nl < 0 ? text.length : nl + 1;
      continue;
    }
    if (c === '$') {
      const display = text[i + 1] === '$';
      const kind = display ? '$$' : '$';
      if (math.at(-1) === kind) math.pop();
      else if (math.length) return fail(`math:${math.at(-1)}`, i);
      else math.push(kind);
      i += display ? 2 : 1;
      continue;
    }
    if (c === '{') {
      groups++;
      i++;
      continue;
    }
    if (c === '}') {
      if (groups === 0) return fail('unexpected:}', i);
      groups--;
      i++;
      continue;
    }
    if (c !== '\\') {
      i++;
      continue;
    }
    if (i + 1 >= text.length) return fail('control-sequence', i);

    const symbol = text[i + 1];
    if (!/[A-Za-z@]/.test(symbol)) {
      if (symbol === '(' || symbol === '[') {
        math.push(symbol);
      } else if (symbol === ')' || symbol === ']') {
        const opener = symbol === ')' ? '(' : '[';
        if (math.at(-1) !== opener) return fail(`unexpected:\\${symbol}`, i);
        math.pop();
      }
      // All other control symbols (including \\, \{, \}, \$, and \%)
      // quote their next character and therefore carry no lexical nesting.
      i += 2;
      continue;
    }

    let end = i + 2;
    while (end < text.length && /[A-Za-z@]/.test(text[end])) end++;
    const name = text.slice(i + 1, end);

    // \string quotes the next token: `\string\verb` prints a name, it does
    // not open a verbatim payload.
    if (name === 'string') {
      const token = stringToken(text, end);
      if (token.start == null) return fail('string-token', i);
      i = token.after;
      continue;
    }

    if (name === 'detokenize') {
      const literal = detokenizedArgument(text, end, text.length);
      if (literal) {
        if (literal.end == null) return fail('detokenize', i);
        i = literal.after;
        continue;
      }
    }
    if (name === 'lstinline' || name === 'mintinline') {
      let p = end;
      if (text[p] === '[') {
        const close = text.indexOf(']', p);
        if (close < 0) return fail(`${name}-options`, i);
        p = close + 1;
      }
      if (name === 'mintinline') {
        const language = bracedArgument(text, p);
        if (!language) return fail('mintinline-language', i);
        p = language.end;
      }
      if (text[p] === '{') {
        const payload = bracedArgument(text, p);
        if (!payload) return fail('verb-payload', i);
        i = payload.end;
        continue;
      }
      const delim = text[p];
      if (!delim || /[A-Za-z\s]/.test(delim)) return fail('verb-delimiter', i);
      const close = text.indexOf(delim, p + 1);
      const nl = text.indexOf('\n', p + 1);
      if (close < 0 || (nl >= 0 && nl < close)) return fail('verb-payload', i);
      i = close + 1;
      continue;
    }

    // KKluaverb reads \KKverb|...| and \KKcodeS...\KKcodeE as literal text
    // (a process_input_buffer rewrite; its default delimiters are | and |).
    // The payload may span lines. A brace or a % inside it is data.
    if (name === 'KKverb' || name === 'KKcodeS') {
      const closer = name === 'KKverb' ? '|' : '\\KKcodeE';
      if (name === 'KKverb' && text[end] !== '|') {
        i = end;
        continue;
      }
      const from = name === 'KKverb' ? end + 1 : end;
      const close = text.indexOf(closer, from);
      if (close < 0) return fail('verb-payload', i);
      i = close + closer.length;
      continue;
    }

    if (name === 'verb') {
      let p = end;
      if (text[p] === '*') p++;
      const delim = text[p];
      if (!delim || /[A-Za-z\s]/.test(delim)) return fail('verb-delimiter', i);
      const close = text.indexOf(delim, p + 1);
      const nl = text.indexOf('\n', p + 1);
      if (close < 0 || (nl >= 0 && nl < close)) return fail('verb-payload', i);
      i = close + 1;
      continue;
    }

    if (name === 'begin' || name === 'end') {
      const arg = bracedArgument(text, end);
      if (!arg) return fail(`${name}-argument`, i);
      const env = arg.value.trim();
      if (!env) return fail(`${name}-environment`, i);
      if (name === 'begin') {
        envs.push(env);
        if (LITERAL_ENVS.has(env) || literalEnvs?.has(env)) literal = env;
      } else {
        if (envs.at(-1) !== env) return fail(`unexpected:end:${env}`, i);
        envs.pop();
      }
      i = arg.end;
      continue;
    }

    if (name === 'newif') {
      const nextAt = skipSpace(text, end);
      if (text[nextAt] === '\\') {
        let nextEnd = nextAt + 2;
        while (nextEnd < text.length && /[A-Za-z@]/.test(text[nextEnd])) nextEnd++;
        const custom = text.slice(nextAt + 1, nextEnd);
        if (custom.startsWith('if') && custom.length > 2) customConditionals.add(custom);
        i = nextEnd;
        continue;
      }
    }
    // Plain TeX's \repeat supplies the closing \fi for the loop test.
    // Track the entry depth so nested loops cannot consume an outer test.
    if (name === 'loop') loops.push(conditionals.length);
    else if (name === 'repeat') {
      if (!loops.length || conditionals.length !== loops.at(-1) + 1) return fail('loop-test', i);
      loops.pop();
      conditionals.pop();
    } else if (CONDITIONALS.has(name) || customConditionals.has(name)) conditionals.push(name);
    else if (documentConditionals?.has(name)) conditionals.push(`#${name}`);
    else if (name === 'fi') {
      if (conditionals.length) conditionals.pop();
      else if (carriedLeft > 0) carriedLeft--;
      else return fail('unexpected:fi', i);
    }
    i = end;
  }

  if (literal) return fail(`environment:${literal}`, text.length);
  if (envs.length) return fail(`environment:${envs.at(-1)}`, text.length);
  if (groups) return fail('group', text.length);
  if (math.length) return fail(`math:${math.at(-1)}`, text.length);
  if (loops.length) return fail('loop', text.length);
  const unfinished = conditionals.filter((name) => !name.startsWith('#'));
  if (unfinished.length) return fail(`conditional:${unfinished.at(-1)}`, text.length);
  const carry = carriedLeft + conditionals.length;
  return carry ? { closed: true, reason: null, at: text.length, carry } : { closed: true, reason: null, at: text.length };
}

/** How many document conditionals the blocks before each block leave open
 * (index-aligned with `blocks`). */
export function carriedConditionals(blocks, options = {}) {
  const out = new Array(blocks.length).fill(0);
  if (!options.documentConditionals?.size) return out;
  let carried = 0;
  for (let i = 0; i < blocks.length; i++) {
    out[i] = carried;
    const text = blocks[i]?.text ?? '';
    if (!text.includes('\\if') && !text.includes('\\fi')) continue;
    const closure = sourceClosure(text, { ...options, carried });
    if (closure.closed) carried = closure.carry ?? 0;
  }
  return out;
}
