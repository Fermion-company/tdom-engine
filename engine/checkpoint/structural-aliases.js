// Conservative structural-effect analysis for locally-defined aliases.
//
// The structured page builder may only see an output-routine environment
// when the whole environment is one source block.  TeX macros can hide the
// \begin/\end tokens from the raw segmenter, so a wrapper must never inherit
// the ordinary-glyph privilege merely because its call site looks harmless.
// This is deliberately not a TeX expander: it follows only balanced local
// definitions and propagates known page-building sinks to a fixed point.

const STRUCTURAL_ENVIRONMENTS = new Set([
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
  // A non-breakable tcolorbox is less dangerous, but an alias can hide its
  // options from the block classifier.  False-positive opaque display is
  // preferable to silently accepting a breakable page-building box.
  'tcolorbox',
]);

const STRUCTURAL_COMMANDS = new Map([
  ['includepdf', 'includepdf'],
  ['maketitle', 'forced-page-break'],
  ['twocolumn', 'column-layout-change'],
  ['onecolumn', 'column-layout-change'],
  ['columnbreak', 'forced-column-break'],
  ['pagebreak', 'forced-page-break'],
  ['newpage', 'forced-page-break'],
  ['clearpage', 'forced-page-break'],
  ['cleardoublepage', 'forced-page-break'],
  ['eject', 'forced-page-break'],
  ['shipout', 'output-routine-change'],
  ['output', 'output-routine-change'],
]);

const LATEX_COMMAND_DEFS = new Set([
  'newcommand',
  'renewcommand',
  'providecommand',
  'DeclareRobustCommand',
]);

const XPARSE_COMMAND_DEFS = new Set([
  'NewDocumentCommand',
  'RenewDocumentCommand',
  'ProvideDocumentCommand',
  'DeclareDocumentCommand',
]);

const PRIMITIVE_DEFS = new Set(['def', 'gdef', 'edef', 'xdef']);
const LATEX_ENV_DEFS = new Set(['newenvironment', 'renewenvironment']);
const XPARSE_ENV_DEFS = new Set([
  'NewDocumentEnvironment',
  'RenewDocumentEnvironment',
  'ProvideDocumentEnvironment',
  'DeclareDocumentEnvironment',
]);

const LITERAL_ENVS = [
  'verbatim\\*?',
  'lstlisting',
  'minted',
  'alltt',
  'filecontents\\*?',
  '[BLV]Verbatim\\*?',
].join('|');
const LITERAL_RE = new RegExp(`\\\\begin\\{(${LITERAL_ENVS})\\}[\\s\\S]*?\\\\end\\{\\1\\}`, 'g');

function blankRange(chars, start, end) {
  for (let i = start; i < end; i++) {
    if (chars[i] !== '\n' && chars[i] !== '\r') chars[i] = ' ';
  }
}

/** Mask comments and literal payloads without changing source offsets. */
function maskIgnored(source) {
  source = String(source ?? '');
  const chars = source.split('');
  const text = chars.join('');
  for (const match of text.matchAll(LITERAL_RE)) blankRange(chars, match.index, match.index + match[0].length);

  for (let i = 0; i < chars.length; ) {
    if (chars[i] === ' ') {
      i++;
      continue;
    }
    if (chars[i] === '%') {
      let slashes = 0;
      for (let p = i - 1; p >= 0 && chars[p] === '\\'; p--) slashes++;
      if (slashes % 2 === 0) {
        let end = i;
        while (end < chars.length && chars[end] !== '\n') end++;
        blankRange(chars, i, end);
        i = end;
        continue;
      }
    }
    if (chars[i] === '\\') {
      const control = readControl(source, i);
      if (control?.name === 'verb') {
        let at = control.end;
        if (chars[at] === '*') at++;
        const delim = chars[at];
        if (delim && !/[A-Za-z\s]/.test(delim)) {
          let end = at + 1;
          while (end < chars.length && chars[end] !== delim && chars[end] !== '\n') end++;
          if (chars[end] === delim) end++;
          blankRange(chars, i, end);
          i = end;
          continue;
        }
      }
    }
    i++;
  }
  return chars.join('');
}

function skipSpace(source, at) {
  while (at < source.length && /\s/.test(source[at])) at++;
  return at;
}

function readControl(source, at) {
  if (source[at] !== '\\' || at + 1 >= source.length) return null;
  if (!/[A-Za-z@]/.test(source[at + 1])) {
    return { name: source[at + 1], start: at, end: at + 2 };
  }
  let end = at + 2;
  while (end < source.length && /[A-Za-z@]/.test(source[end])) end++;
  return { name: source.slice(at + 1, end), start: at, end };
}

function readBalanced(source, at, open = '{', close = '}') {
  at = skipSpace(source, at);
  if (source[at] !== open) return null;
  let depth = 1;
  for (let i = at + 1; i < source.length; i++) {
    if (source[i] === '\\') {
      const control = readControl(source, i);
      if (control) {
        i = control.end - 1;
        continue;
      }
    }
    if (source[i] === open) depth++;
    else if (source[i] === close && --depth === 0) {
      return { value: source.slice(at + 1, i), start: at, end: i + 1 };
    }
  }
  return null;
}

function readMacroTarget(source, at) {
  at = skipSpace(source, at);
  if (source[at] === '{') {
    const group = readBalanced(source, at);
    if (!group) return null;
    const innerAt = skipSpace(group.value, 0);
    const control = readControl(group.value, innerAt);
    if (!control) return null;
    return { key: `\\${control.name}`, end: group.end };
  }
  const control = readControl(source, at);
  return control ? { key: `\\${control.name}`, end: control.end } : null;
}

function skipOptionalGroups(source, at, limit = 2) {
  for (let i = 0; i < limit; i++) {
    at = skipSpace(source, at);
    if (source[at] !== '[') break;
    const group = readBalanced(source, at, '[', ']');
    if (!group) break;
    at = group.end;
  }
  return at;
}

function addDefinition(defs, key, bodies, start, end) {
  if (!key || !bodies.length || !Number.isFinite(end)) return;
  const record = defs.get(key) ?? { key, bodies: [], direct: new Set(), deps: new Set(), may: new Set() };
  record.bodies.push(...bodies);
  record.start = Math.min(record.start ?? start, start);
  record.end = Math.max(record.end ?? end, end);
  defs.set(key, record);
}

function collectDefinitions(source) {
  const masked = maskIgnored(source);
  const defs = new Map();
  const spans = [];
  for (let i = 0; i < masked.length; ) {
    if (masked[i] !== '\\') {
      i++;
      continue;
    }
    const command = readControl(masked, i);
    if (!command) {
      i++;
      continue;
    }
    const name = command.name;
    let at = command.end;
    if (masked[at] === '*') at++;

    if (LATEX_COMMAND_DEFS.has(name)) {
      const target = readMacroTarget(masked, at);
      if (!target) {
        i = command.end;
        continue;
      }
      at = skipOptionalGroups(masked, target.end);
      const body = readBalanced(masked, at);
      if (!body) {
        i = command.end;
        continue;
      }
      addDefinition(defs, target.key, [body.value], i, body.end);
      spans.push([i, body.end]);
      i = body.end;
      continue;
    }

    if (XPARSE_COMMAND_DEFS.has(name)) {
      const target = readMacroTarget(masked, at);
      const spec = target ? readBalanced(masked, target.end) : null;
      const body = spec ? readBalanced(masked, spec.end) : null;
      if (!target || !spec || !body) {
        i = command.end;
        continue;
      }
      addDefinition(defs, target.key, [body.value], i, body.end);
      spans.push([i, body.end]);
      i = body.end;
      continue;
    }

    if (PRIMITIVE_DEFS.has(name)) {
      const target = readMacroTarget(masked, at);
      if (!target) {
        i = command.end;
        continue;
      }
      at = target.end;
      while (at < masked.length && masked[at] !== '{' && masked[at] !== '\n') at++;
      const body = readBalanced(masked, at);
      if (!body) {
        i = command.end;
        continue;
      }
      addDefinition(defs, target.key, [body.value], i, body.end);
      spans.push([i, body.end]);
      i = body.end;
      continue;
    }

    if (name === 'let') {
      const target = readMacroTarget(masked, at);
      at = target ? skipSpace(masked, target.end) : at;
      if (masked[at] === '=') at = skipSpace(masked, at + 1);
      const sourceControl = target ? readControl(masked, at) : null;
      if (!target || !sourceControl) {
        i = command.end;
        continue;
      }
      addDefinition(defs, target.key, [`\\${sourceControl.name}`], i, sourceControl.end);
      spans.push([i, sourceControl.end]);
      i = sourceControl.end;
      continue;
    }

    if (LATEX_ENV_DEFS.has(name) || XPARSE_ENV_DEFS.has(name)) {
      const envName = readBalanced(masked, at);
      if (!envName) {
        i = command.end;
        continue;
      }
      at = envName.end;
      if (XPARSE_ENV_DEFS.has(name)) {
        const spec = readBalanced(masked, at);
        if (!spec) {
          i = command.end;
          continue;
        }
        at = spec.end;
      } else {
        at = skipOptionalGroups(masked, at);
      }
      const beginBody = readBalanced(masked, at);
      const endBody = beginBody ? readBalanced(masked, beginBody.end) : null;
      if (!beginBody || !endBody) {
        i = command.end;
        continue;
      }
      const key = `env:${envName.value.trim()}`;
      addDefinition(defs, key, [beginBody.value, endBody.value], i, endBody.end);
      spans.push([i, endBody.end]);
      i = endBody.end;
      continue;
    }
    i = command.end;
  }
  return { masked, defs, spans };
}

function inspectDefinition(record) {
  for (const body of record.bodies) {
    for (let i = 0; i < body.length; ) {
      if (body[i] !== '\\') {
        i++;
        continue;
      }
      const control = readControl(body, i);
      if (!control) {
        i++;
        continue;
      }
      const direct = STRUCTURAL_COMMANDS.get(control.name);
      if (direct) record.direct.add(direct);
      if (control.name === 'begin' || control.name === 'end') {
        const env = readBalanced(body, control.end);
        if (env) {
          const envName = env.value.trim();
          if (STRUCTURAL_ENVIRONMENTS.has(envName)) record.direct.add(envName);
          else record.deps.add(`env:${envName}`);
          i = env.end;
          continue;
        }
      }
      record.deps.add(`\\${control.name}`);
      i = control.end;
    }
  }
  for (const sink of record.direct) record.may.add(sink);
}

function mergeDefinitions(target, incoming) {
  for (const [key, record] of incoming) {
    const have = target.get(key);
    if (!have) {
      target.set(key, record);
      continue;
    }
    have.bodies.push(...record.bodies);
    have.start = Math.min(have.start ?? record.start, record.start);
    have.end = Math.max(have.end ?? record.end, record.end);
  }
}

function propagate(defs) {
  for (const record of defs.values()) inspectDefinition(record);
  const reverse = new Map();
  for (const record of defs.values()) {
    for (const dep of record.deps) {
      if (!defs.has(dep)) continue;
      const users = reverse.get(dep) ?? new Set();
      users.add(record.key);
      reverse.set(dep, users);
    }
  }
  const queue = [...defs.values()].filter((record) => record.may.size).map((record) => record.key);
  const queued = new Set(queue);
  for (let head = 0; head < queue.length; head++) {
    const key = queue[head];
    queued.delete(key);
    const target = defs.get(key);
    for (const userKey of reverse.get(key) ?? []) {
      const user = defs.get(userKey);
      let changed = false;
      for (const sink of target.may) {
        if (!user.may.has(sink)) {
          user.may.add(sink);
          changed = true;
        }
      }
      if (changed && !queued.has(userKey)) {
        queue.push(userKey);
        queued.add(userKey);
      }
    }
  }
}

function maskSpans(source, spans) {
  const chars = source.split('');
  for (const [start, end] of spans) blankRange(chars, start, end);
  return chars.join('');
}

function usedStructuralAliases(bodyInfo, defs) {
  const source = maskSpans(bodyInfo.masked, bodyInfo.spans);
  const found = [];
  for (let i = 0; i < source.length; ) {
    if (source[i] !== '\\') {
      i++;
      continue;
    }
    const control = readControl(source, i);
    if (!control) {
      i++;
      continue;
    }
    if (control.name === 'begin' || control.name === 'end') {
      const env = readBalanced(source, control.end);
      if (env) {
        const key = `env:${env.value.trim()}`;
        const record = defs.get(key);
        if (record?.may.size) found.push({ key, sinks: [...record.may] });
        i = env.end;
        continue;
      }
    }
    const key = `\\${control.name}`;
    const record = defs.get(key);
    if (record?.may.size) found.push({ key, sinks: [...record.may] });
    i = control.end;
  }
  return found;
}

/**
 * Detect local aliases that can reach a page-building environment/command.
 * Definitions alone are harmless; only an invocation outside a definition
 * removes the document's structured-preview privilege.
 */
export function classifyStructuralAliases(preamble, body) {
  const preInfo = collectDefinitions(preamble);
  const bodyInfo = collectDefinitions(body);
  const defs = new Map();
  mergeDefinitions(defs, preInfo.defs);
  mergeDefinitions(defs, bodyInfo.defs);
  propagate(defs);
  const uses = usedStructuralAliases(bodyInfo, defs);
  const reasons = uses.map(({ key, sinks }) => {
    const display = key.startsWith('env:') ? `environment ${key.slice(4)}` : `macro ${key}`;
    return `${display} reaches page-building ${sinks.join(', ')}`;
  });
  return {
    safe: reasons.length === 0,
    reasons: [...new Set(reasons)],
    aliases: new Map([...defs].map(([key, value]) => [key, [...value.may]])),
  };
}

export { STRUCTURAL_ENVIRONMENTS };
