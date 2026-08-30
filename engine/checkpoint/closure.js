// Package-independent lexical closure gate for the keystroke path.
//
// A positive result is deliberately modest: it only says that the source is
// not *obviously* waiting for more input.  The resident LuaLaTeX JOB is the
// semantic authority and supplies the second half of the certificate.  A
// negative result is conclusive enough to avoid feeding invented closing
// tokens to TeX while the user is still typing.

const LITERAL_ENVS = new Set([
  'verbatim',
  'verbatim*',
  'lstlisting',
  'minted',
  'alltt',
  'filecontents',
  'filecontents*',
  'BVerbatim',
  'LVerbatim',
  'VVerbatim',
  'BVerbatim*',
  'LVerbatim*',
  'VVerbatim*',
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

export function sourceClosure(text) {
  const envs = [];
  const conditionals = [];
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
        if (LITERAL_ENVS.has(env)) literal = env;
      } else {
        if (envs.at(-1) !== env) return fail(`unexpected:end:${env}`, i);
        envs.pop();
      }
      i = arg.end;
      continue;
    }

    if (CONDITIONALS.has(name)) conditionals.push(name);
    else if (name === 'fi') {
      if (!conditionals.length) return fail('unexpected:fi', i);
      conditionals.pop();
    }
    i = end;
  }

  if (literal) return fail(`environment:${literal}`, text.length);
  if (envs.length) return fail(`environment:${envs.at(-1)}`, text.length);
  if (groups) return fail('group', text.length);
  if (math.length) return fail(`math:${math.at(-1)}`, text.length);
  if (conditionals.length) return fail(`conditional:${conditionals.at(-1)}`, text.length);
  return { closed: true, reason: null, at: text.length };
}
