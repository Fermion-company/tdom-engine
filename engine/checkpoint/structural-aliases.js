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
  ['maketitle', 'maketitle'],
  ['twocolumn', 'column-layout-change'],
  ['onecolumn', 'column-layout-change'],
  ['columnbreak', 'forced-column-break'],
  ['pagebreak', 'forced-page-break'],
  ['newpage', 'forced-page-break'],
  ['clearpage', 'forced-page-break'],
  ['cleardoublepage', 'forced-page-break'],
  ['eject', 'forced-page-break'],
  ['shipout', 'output-routine-change'],
  ['RawShipout', 'output-routine-change'],
  ['output', 'output-routine-change'],
  ['AddToHook', 'output-hook-change'],
  ['AddToHookNext', 'output-hook-change'],
  ['AtBeginShipout', 'output-hook-change'],
  ['AtBeginShipoutNext', 'output-hook-change'],
  ['AtEndShipout', 'output-hook-change'],
  ['AtBeginDvi', 'output-hook-change'],
  ['AtEndDvi', 'output-hook-change'],
  ['directlua', 'dynamic-output-code'],
  ['latelua', 'dynamic-output-code'],
  ['luafunction', 'dynamic-output-code'],
  ['lateluafunction', 'dynamic-output-code'],
  ['pdfpagewidth', 'page-geometry-change'],
  ['pdfpageheight', 'page-geometry-change'],
  ['pagewidth', 'page-geometry-change'],
  ['pageheight', 'page-geometry-change'],
  ['pdfpageattr', 'page-geometry-change'],
  ['newgeometry', 'page-geometry-change'],
]);

// These effects change the authority that produces or addresses complete
// physical pages.  A native shipping replay is not enough to keep the
// resident source/edit surface trustworthy, so their used aliases retain the
// document-level opaque fallback.  Other structural sinks can keep source
// identity and defer only physical-page promotion to ShippingChain/canonical.
const DOCUMENT_GLOBAL_SINKS = new Set([
  'output-routine-change',
  'output-hook-change',
  'dynamic-output-code',
  'tokenization-change',
  'page-geometry-change',
]);

// These commands/environments have a stable LaTeX meaning that does not
// grant access to the output routine. Local redefinitions still win: the
// dependency graph is consulted before this list. The list is deliberately
// small; anything else is retained as unresolved and therefore requires a
// native shipping replay before its pages may be shown.
const CERTIFIED_LOCAL_COMMANDS = new Set([
  'par',
  'begingroup',
  'endgroup',
  'noindent',
  'hfill',
  'vfill',
  'hspace',
  'vspace',
  'smallskip',
  'medskip',
  'bigskip',
  'textbf',
  'textit',
  'texttt',
  'textsf',
  'textrm',
  'emph',
  'color',
  'colorbox',
  'fcolorbox',
  'rmfamily',
  'sffamily',
  'ttfamily',
  'bfseries',
  'mdseries',
  'itshape',
  'slshape',
  'scshape',
  'tiny',
  'scriptsize',
  'footnotesize',
  'small',
  'normalsize',
  'large',
  'Large',
  'LARGE',
  'huge',
  'Huge',
  'thispagestyle',
  'refstepcounter',
  'stepcounter',
  'setcounter',
  'addtocounter',
  'label',
  // luatexja's inline tate-chu-yoko formatter. It changes the current box,
  // not page production; a local redefinition is still analysed above.
  'rensuji',
  // Standard/read-only dimension registers used as values in formatting
  // commands. They do not execute code merely by being expanded.
  'textheight',
  'textwidth',
  'linewidth',
  'columnwidth',
  'baselineskip',
  'zw',
]);

const CERTIFIED_LOCAL_ENVIRONMENTS = new Set([
  'center',
  'flushleft',
  'flushright',
  'minipage',
]);

const CERTIFIED_LOCAL_CONTROL_SYMBOLS = new Set([
  '\\', ' ', ',', ':', ';', '!', '/', '%', '#', '&', '_', '{', '}', '@', '-',
]);

function controlNeedsProof(name) {
  return name !== 'relax' &&
    !CERTIFIED_LOCAL_COMMANDS.has(name) &&
    !CERTIFIED_LOCAL_CONTROL_SYMBOLS.has(name);
}

// Sinks whose exact physical page cannot be reconstructed by the resident
// JS page builder even when the source boundary is known. Other sinks use
// the resident chain or an isolated exact block. Unresolved commands do not
// receive an authority upgrade: they remain opaque until statically proved.
const SHIPPING_EXACT_SINKS = new Set([
  'column-layout-change',
  'forced-column-break',
  'landscape',
]);

const SUFFIX_SCOPED_SINKS = new Set([
  'column-layout-change',
  'forced-page-break',
]);

const RESCUE_REQUIRED_SINKS = new Set([
  'includepdf',
  'maketitle',
  ...STRUCTURAL_ENVIRONMENTS,
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

const PRIMITIVE_DEFS = new Set([
  'def', 'gdef', 'edef', 'xdef',
  'cs_new:Npn', 'cs_new_protected:Npn',
  'cs_set:Npn', 'cs_set_protected:Npn',
  'cs_gset:Npn', 'cs_gset_protected:Npn',
]);
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
  'filecontents\\*?',
  '[BLV]Verbatim\\*?',
].join('|');
const LITERAL_RE = new RegExp(`\\\\begin\\{(${LITERAL_ENVS})\\}[\\s\\S]*?\\\\end\\{\\1\\}`, 'g');

/** Mask comments and literal payloads without changing source offsets.
 * Runs over the whole expanded body on every keystroke: blanked positions
 * are marked in a byte mask and the result is built from slices, instead
 * of splitting the body into one string per character (half of the 40 ms
 * segment phase on the 316-page book, tex64-internal #85). */
function maskIgnored(source) {
  source = String(source ?? '');
  const blank = new Uint8Array(source.length);
  const mark = (start, end) => blank.fill(1, start, end);
  const at = (i) => (blank[i] && source[i] !== '\n' && source[i] !== '\r' ? ' ' : source[i]);
  for (const match of source.matchAll(LITERAL_RE)) mark(match.index, match.index + match[0].length);

  for (let i = 0; i < source.length; ) {
    const c = at(i);
    if (c === ' ') {
      i++;
      continue;
    }
    if (c === '%') {
      let slashes = 0;
      for (let p = i - 1; p >= 0 && at(p) === '\\'; p--) slashes++;
      if (slashes % 2 === 0) {
        let end = i;
        while (end < source.length && at(end) !== '\n') end++;
        mark(i, end);
        i = end;
        continue;
      }
    }
    if (c === '\\') {
      const control = readControl(source, i);
      if (control?.name === 'verb') {
        let pos = control.end;
        if (at(pos) === '*') pos++;
        const delim = at(pos);
        if (delim && !/[A-Za-z\s]/.test(delim)) {
          let end = pos + 1;
          while (end < source.length && at(end) !== delim && at(end) !== '\n') end++;
          if (at(end) === delim) end++;
          mark(i, end);
          i = end;
          continue;
        }
      }
    }
    i++;
  }
  return applyBlank(source, blank);
}

// `source` with every marked position except line ends turned into a space.
function applyBlank(source, blank) {
  const parts = [];
  let from = 0;
  for (let i = blank.indexOf(1); i >= 0 && i < source.length; ) {
    let end = i;
    while (end < source.length && blank[end]) end++;
    parts.push(source.slice(from, i), source.slice(i, end).replace(/[^\n\r]/g, ' '));
    from = end;
    i = blank.indexOf(1, end);
  }
  if (!parts.length) return source;
  parts.push(source.slice(from));
  return parts.join('');
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
  const base = source.slice(at + 1, end);
  // expl3 control words deliberately use `_` and `:` as letters while
  // ExplSyntaxOn is active.  Recognise that spelling for source analysis,
  // but never let it swallow a suffix after a known primitive/page command.
  if (!STRUCTURAL_COMMANDS.has(base) && /[_:]/.test(source[end] ?? '')) {
    let expl = end;
    while (expl < source.length && /[A-Za-z@_:]/.test(source[expl])) expl++;
    // `Demo~\theboxdemo: #3` is a counter followed by prose, not an expl3
    // name: a bare trailing colon needs an argument signature or a `_`.
    const name = source.slice(at + 1, expl);
    if (name.includes('_') || /:[A-Za-z]+$/.test(name)) end = expl;
  }
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

function addDefinition(
  defs,
  key,
  bodies,
  start,
  end,
  definitionKind = 'command',
  capturedSinks = []
) {
  if (!key || !bodies.length || !Number.isFinite(end)) return;
  const record = defs.get(key) ?? {
    key,
    bodies: [],
    direct: new Set(),
    deps: new Set(),
    may: new Set(),
    definitionKind,
  };
  if (record.definitionKind !== definitionKind) record.definitionKind = 'ambiguous';
  record.bodies.push(...bodies);
  // TeX's \let copies the current meaning.  Preserve any primitive meaning
  // observed at the assignment site: a later local redefinition of the
  // source name must not retroactively make the alias look harmless.
  for (const sink of capturedSinks) if (sink) record.direct.add(sink);
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

    if (name === 'newcounter') {
      const counter = readBalanced(masked, at);
      if (!counter || !/^[A-Za-z@]+$/.test(counter.value.trim())) {
        i = command.end;
        continue;
      }
      addDefinition(defs, `\\the${counter.value.trim()}`, [''], i, counter.end);
      i = counter.end;
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
      const sourceKey = `\\${sourceControl.name}`;
      // \let snapshots the current meaning.  A name-only graph cannot prove
      // a preceding local redefinition or group lifetime, so never erase a
      // primitive meaning merely because another definition with that name
      // exists somewhere in the source.
      const capturedSink = STRUCTURAL_COMMANDS.get(sourceControl.name);
      addDefinition(
        defs,
        target.key,
        [sourceKey],
        i,
        sourceControl.end,
        'command',
        capturedSink ? [capturedSink] : []
      );
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
      addDefinition(defs, key, [beginBody.value, endBody.value], i, endBody.end, 'environment');
      spans.push([i, endBody.end]);
      i = endBody.end;
      continue;
    }
    i = command.end;
  }
  return { masked, defs, spans };
}

function documentGlobalSinksIn(body) {
  const sinks = new Set();
  if (/\\(?:AddToHook|AddToHookNext)\s*\{\s*shipout(?:\/[^}]*)?\s*\}/.test(body) ||
      /\\At(?:BeginShipout(?:Next)?|EndShipout|BeginDvi|EndDvi)\b/.test(body)) {
    sinks.add('output-hook-change');
  }
  if (/\\pdfvariable\s+(?:pagewidth|pageheight|pageattr)\b/.test(body) ||
      /\\pdfextension\s+pageattr\b/.test(body) ||
      /\\special\s*\{[^}]*@thispage\b/i.test(body) ||
      /\\(?:paperwidth|paperheight|pagewidth|pageheight|pdfpagewidth|pdfpageheight|textwidth|textheight)\s*=/.test(body) ||
      /\\setlength\s*\{\s*\\(?:paperwidth|paperheight|pagewidth|pageheight|pdfpagewidth|pdfpageheight|textwidth|textheight)\s*\}/.test(body)) {
    sinks.add('page-geometry-change');
  }
  if (/\\csname\s*(?:output|shipout|RawShipout|directlua|latelua)\s*\\endcsname/.test(body)) {
    sinks.add('output-routine-change');
  }
  // Other \csname lookups are name registries (\csname badge@#1\endcsname)
  // in almost every real document. `\expandafter\def\csname ...` bodies are
  // collected under the key \csname, so a registry entry that does reach a
  // page sink still propagates to every lookup. Treating the lookup itself
  // as a sink demoted 13 of the 20 stress documents to opaque. Catcode
  // changes are likewise ordinary in verbatim-like helpers; the segmenter's
  // literal-environment and closure gates own that risk.
  if (/\\globaldefs\b/.test(body)) {
    sinks.add('tokenization-change');
  }
  return sinks;
}

function inspectDefinition(record, defs) {
  for (const body of record.bodies) {
    for (const sink of documentGlobalSinksIn(body)) record.direct.add(sink);
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
      // A source-local definition is the binding this scanner can inspect;
      // do not assign the primitive/built-in meaning merely from its name.
      const direct = defs.has(`\\${control.name}`) ? null : STRUCTURAL_COMMANDS.get(control.name);
      if (direct) record.direct.add(direct);
      if (control.name === 'begin' || control.name === 'end') {
        const env = readBalanced(body, control.end);
        if (env) {
          const envName = env.value.trim();
          const envKey = `env:${envName}`;
          // Source-local environment bindings take precedence over the
          // package name.  Their body may itself reach a global sink.
          if (defs.has(envKey)) record.deps.add(envKey);
          else if (STRUCTURAL_ENVIRONMENTS.has(envName)) record.direct.add(envName);
          else record.deps.add(envKey);
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
    for (const sink of record.direct) have.direct.add(sink);
    have.start = Math.min(have.start ?? record.start, record.start);
    have.end = Math.max(have.end ?? record.end, record.end);
  }
}

function propagate(defs) {
  for (const record of defs.values()) inspectDefinition(record, defs);
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

/**
 * Exact structural effect for the deliberately small Phase-2 trust envelope.
 * A command definition is segmentable only when every known structural sink
 * is represented by one unambiguous ordered token sequence. Unknown external
 * commands are left to the ordinary safety gate; ambiguous local definitions
 * remain fail-closed.
 */
function neutralCommandDefinition(key, defs, memo = new Map(), active = new Set()) {
  if (memo.has(key)) return memo.get(key);
  const record = defs.get(key);
  if (!record || record.definitionKind !== 'command' || record.bodies.length !== 1 ||
      record.may.size || active.has(key)) {
    memo.set(key, false);
    return false;
  }
  active.add(key);
  const body = record.bodies[0];
  for (let i = 0; i < body.length; ) {
    if (body[i] !== '\\') { i++; continue; }
    const control = readControl(body, i);
    if (!control) { active.delete(key); memo.set(key, false); return false; }
    const depKey = `\\${control.name}`;
    if (defs.has(depKey)) {
      if (!neutralCommandDefinition(depKey, defs, memo, active)) {
        active.delete(key);
        memo.set(key, false);
        return false;
      }
    } else if (controlNeedsProof(control.name)) {
      active.delete(key);
      memo.set(key, false);
      return false;
    }
    i = control.end;
  }
  active.delete(key);
  memo.set(key, true);
  return true;
}

function exactCommandEffect(
  key,
  defs,
  memo = new Map(),
  active = new Set(),
  neutralMemo = new Map()
) {
  if (memo.has(key)) return memo.get(key);
  const record = defs.get(key);
  if (!record || record.definitionKind !== 'command' || record.bodies.length !== 1 || active.has(key)) {
    memo.set(key, null);
    return null;
  }
  active.add(key);
  const effects = [];
  const covered = new Set();
  const body = record.bodies[0];
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
    const commandSink = defs.has(`\\${control.name}`) ? null : STRUCTURAL_COMMANDS.get(control.name);
    if (commandSink) {
      effects.push({ kind: 'command', sink: commandSink });
      covered.add(commandSink);
      i = control.end;
      continue;
    }
    if (control.name === 'begin' || control.name === 'end') {
      const env = readBalanced(body, control.end);
      if (env) {
        const envName = env.value.trim();
        const dependency = defs.get(`env:${envName}`);
        if (dependency) {
          // Exact command effects do not currently model a custom
          // environment's two executable halves or its binding lifetime.
          // Never let a familiar environment name override that uncertainty.
          active.delete(key);
          memo.set(key, null);
          return null;
        } else if (STRUCTURAL_ENVIRONMENTS.has(envName)) {
          effects.push({ kind: control.name, sink: envName });
          covered.add(envName);
        } else if (!dependency && !CERTIFIED_LOCAL_ENVIRONMENTS.has(envName)) {
          active.delete(key);
          memo.set(key, null);
          return null;
        }
        i = env.end;
        continue;
      }
    }
    if (control.name === 'setlength' && !defs.has('\\setlength')) {
      const target = readBalanced(body, control.end);
      const value = target ? readBalanced(body, target.end) : null;
      if (!target || !value) {
        active.delete(key);
        memo.set(key, null);
        return null;
      }
      if (/\\(?:paperwidth|paperheight|pagewidth|pageheight|pdfpagewidth|pdfpageheight|textwidth|textheight)\b/.test(target.value)) {
        active.delete(key);
        memo.set(key, null);
        return null;
      }
      for (let vi = 0; vi < value.value.length; ) {
        if (value.value[vi] !== '\\') { vi++; continue; }
        const valueControl = readControl(value.value, vi);
        if (!valueControl || defs.has(`\\${valueControl.name}`) || controlNeedsProof(valueControl.name)) {
          active.delete(key);
          memo.set(key, null);
          return null;
        }
        vi = valueControl.end;
      }
      effects.push({ kind: 'state-write', target: target.value.trim() });
      i = value.end;
      continue;
    }
    const depKey = `\\${control.name}`;
    const dependency = defs.get(depKey);
    if (dependency) {
      if (!dependency.may.size) {
        if (!neutralCommandDefinition(depKey, defs, neutralMemo)) {
          active.delete(key);
          memo.set(key, null);
          return null;
        }
        i = control.end;
        continue;
      }
      const nested = exactCommandEffect(depKey, defs, memo, active, neutralMemo);
      if (!nested) {
        active.delete(key);
        memo.set(key, null);
        return null;
      }
      effects.push(...nested);
      for (const effect of nested) covered.add(effect.sink);
    } else if (controlNeedsProof(control.name)) {
      // Certification is intentionally much narrower than hazard
      // discovery. Unknown commands may have an output-routine meaning at
      // runtime, so they cannot occur in an exact structural wrapper.
      active.delete(key);
      memo.set(key, null);
      return null;
    }
    i = control.end;
  }
  active.delete(key);
  const exact = record.may.size > 0 && [...record.may].every((sink) => covered.has(sink)) ? effects : null;
  memo.set(key, exact);
  return exact;
}

// Box-like environments whose whole effect stays inside the block that
// contains them: the rescue classifier typesets that block with the real
// output routine, and ShippingChain proves its pages. Landscape turns
// physical pages and stays a document-level decision.
const SELF_CONTAINED_SINKS = new Set([...STRUCTURAL_ENVIRONMENTS].filter((env) => env !== 'landscape'));

/**
 * A command whose every structural environment opens and closes inside one
 * call, on every branch it can take (tex64-internal #64). Unlike
 * exactCommandEffect it tolerates commands it cannot certify (expl3 state,
 * \IfBooleanTF, pgfkeys): those can only change the contents of the box,
 * not where the box starts or ends, so the call site is a self-contained
 * rescue block whose pages ShippingChain proves. A brace group and each
 * primitive conditional branch must leave the environment stack as it
 * found it, so `\IfBooleanTF{#1}{\begin{X}}{\end{X}}` never passes.
 */
function selfContainedCommand(key, defs, memo = new Map(), active = new Set()) {
  if (memo.has(key)) return memo.get(key);
  const record = defs.get(key);
  if (!record || record.definitionKind !== 'command' || !record.bodies.length || active.has(key) ||
      ![...record.may].every((sink) => SELF_CONTAINED_SINKS.has(sink))) {
    memo.set(key, false);
    return false;
  }
  active.add(key);
  const result = record.bodies.every((body) => balancedBody(body, defs, memo, active));
  active.delete(key);
  memo.set(key, result);
  return result;
}

function balancedBody(body, defs, memo, active) {
  const opened = [];
  const groups = [];
  const conditions = [];
  for (let i = 0; i < body.length; ) {
    const char = body[i];
    if (char === '{') { groups.push(opened.length); i++; continue; }
    if (char === '}') {
      if (groups.length && groups.pop() !== opened.length) return false;
      i++;
      continue;
    }
    if (char !== '\\') { i++; continue; }
    const control = readControl(body, i);
    if (!control) { i++; continue; }
    const name = control.name;
    if (name === 'begin' || name === 'end') {
      const env = readBalanced(body, control.end);
      if (env) {
        const envName = env.value.trim();
        const local = defs.get(`env:${envName}`);
        const structural = local ? local.may.size > 0 : SELF_CONTAINED_SINKS.has(envName);
        if (structural) {
          if (name === 'begin') opened.push(envName);
          else if (opened.pop() !== envName) return false;
        }
        i = env.end;
        continue;
      }
    }
    if (/^if/.test(name)) {
      conditions.push(opened.length);
    } else if (name === 'else' || name === 'or' || name === 'fi') {
      // A macro named \if... that takes braced arguments never reaches a
      // \fi of its own; only a real branch boundary is checked.
      if (conditions.length && conditions.at(-1) !== opened.length) return false;
      if (name === 'fi') conditions.pop();
    } else {
      const dependency = defs.get(`\\${name}`);
      if (dependency?.may.size && !selfContainedCommand(`\\${name}`, defs, memo, active)) return false;
    }
    i = control.end;
  }
  return opened.length === 0 && groups.length === 0;
}

function unresolvedDefinitionCommands(key, defs, memo = new Map(), active = new Set()) {
  if (memo.has(key)) return memo.get(key);
  const record = defs.get(key);
  if (!record) return [];
  if (active.has(key)) return [`recursive ${key}`];
  active.add(key);
  const unresolved = new Set();
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
      const commandKey = `\\${control.name}`;
      if ((!defs.has(commandKey) && STRUCTURAL_COMMANDS.has(control.name)) || control.name === 'relax') {
        i = control.end;
        continue;
      }
      if (control.name === 'begin' || control.name === 'end') {
        const env = readBalanced(body, control.end);
        if (env) {
          const envName = env.value.trim();
          const depKey = `env:${envName}`;
          if (defs.has(depKey)) {
            for (const name of unresolvedDefinitionCommands(depKey, defs, memo, active)) {
              unresolved.add(name);
            }
          } else if (!STRUCTURAL_ENVIRONMENTS.has(envName) &&
                     !CERTIFIED_LOCAL_ENVIRONMENTS.has(envName)) {
            unresolved.add(`environment ${envName}`);
          }
          i = env.end;
          continue;
        }
      }
      if (control.name === 'setlength' && !defs.has('\\setlength')) {
        const target = readBalanced(body, control.end);
        const value = target ? readBalanced(body, target.end) : null;
        if (target && /\\(?:paperwidth|paperheight|pagewidth|pageheight|pdfpagewidth|pdfpageheight|textwidth|textheight)\b/.test(target.value)) {
          unresolved.add(`state write ${target.value.trim()}`);
        }
        if (value) {
          for (let vi = 0; vi < value.value.length; ) {
            if (value.value[vi] !== '\\') { vi++; continue; }
            const valueControl = readControl(value.value, vi);
            if (!valueControl) { vi++; continue; }
            const depKey = `\\${valueControl.name}`;
            if (defs.has(depKey)) {
              for (const name of unresolvedDefinitionCommands(depKey, defs, memo, active)) unresolved.add(name);
            } else if (controlNeedsProof(valueControl.name)) {
              unresolved.add(valueControl.name);
            }
            vi = valueControl.end;
          }
        }
        i = value?.end ?? control.end;
        continue;
      }
      const depKey = commandKey;
      if (defs.has(depKey)) {
        for (const name of unresolvedDefinitionCommands(depKey, defs, memo, active)) {
          unresolved.add(name);
        }
      } else if (controlNeedsProof(control.name)) {
        unresolved.add(control.name);
      }
      i = control.end;
    }
  }
  active.delete(key);
  const result = [...unresolved];
  memo.set(key, result);
  return result;
}

function maskSpans(source, spans) {
  if (!spans.length) return source;
  const blank = new Uint8Array(source.length);
  for (const [start, end] of spans) blank.fill(1, Math.max(0, start), Math.min(source.length, end));
  return applyBlank(source, blank);
}

function usedStructuralAliases(bodyInfo, defs) {
  const source = maskSpans(bodyInfo.masked, bodyInfo.spans);
  const found = [];
  const exactMemo = new Map();
  const unresolvedMemo = new Map();
  const selfContainedMemo = new Map();
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
        if (record?.may.size) {
          const unresolved = unresolvedDefinitionCommands(key, defs, unresolvedMemo);
          // The custom environment's own literal begin/end already gives the
          // raw segmenter an exact nesting boundary. It only needs to carry
          // the hidden sink to the rescue classifier. Unresolved commands in
          // its halves do not make that boundary uncertain; they only leave
          // the physical pages to ShippingChain (see shippingExactUses).
          found.push({
            key,
            at: i,
            sinks: [...record.may],
            effects: control.name === 'begin'
              ? [{ kind: 'rescue', sinks: [...record.may] }]
              : [],
            exact: record.definitionKind === 'environment',
            scoped: record.definitionKind === 'environment' && unresolved.length > 0,
            unresolved,
          });
        }
        i = env.end;
        continue;
      }
    }
    const key = `\\${control.name}`;
    const record = defs.get(key);
    if (record?.may.size) {
      const exact = exactCommandEffect(key, defs, exactMemo);
      const unresolved = exact ? [] : unresolvedDefinitionCommands(key, defs, unresolvedMemo);
      // An uncertified command that still opens and closes its boxes within
      // one call is a rescue block at its call site, like a wrapper
      // environment; its unresolved commands leave the pages to
      // ShippingChain (shippingExactUses).
      const selfContained = !exact && selfContainedCommand(key, defs, selfContainedMemo);
      found.push({
        key,
        at: i,
        sinks: [...record.may],
        effects: exact ?? (selfContained ? [{ kind: 'rescue', sinks: [...record.may] }] : []),
        exact: !!exact || selfContained,
        scoped: selfContained,
        unresolved,
      });
    }
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
  const preambleUses = usedStructuralAliases(preInfo, defs);
  const uses = usedStructuralAliases(bodyInfo, defs);
  const implicitPageBindings = [...defs.values()].filter((record) =>
    ['\\output', '\\shipout', '\\RawShipout'].includes(record.key)
  );
  const unsafeUses = [
    ...preambleUses.filter((use) =>
      !use.exact || use.sinks.some((sink) => DOCUMENT_GLOBAL_SINKS.has(sink))
    ),
    ...uses.filter((use) =>
      !use.exact || use.sinks.some((sink) => DOCUMENT_GLOBAL_SINKS.has(sink))
    ),
    ...implicitPageBindings.map((record) => ({
      key: record.key,
      sinks: ['output-routine-change'],
    })),
  ];
  const reasons = unsafeUses.map(({ key, sinks }) => {
    const display = key.startsWith('env:') ? `environment ${key.slice(4)}` : `macro ${key}`;
    const global = sinks.filter((sink) => DOCUMENT_GLOBAL_SINKS.has(sink));
    return global.length
      ? `${display} reaches a document-global page effect: ${global.join(', ')}`
      : `${display} has an unprovable page-building effect: ${sinks.join(', ')}`;
  });
  const segmentEvents = uses
    .filter((use) => use.exact && use.effects.length &&
      !use.sinks.some((sink) => DOCUMENT_GLOBAL_SINKS.has(sink)))
    .map((use) => ({ at: use.at, key: use.key, sinks: use.sinks, effects: use.effects }));
  const open = [];
  for (const event of segmentEvents) {
    for (const effect of event.effects) {
      if (effect.kind === 'begin') open.push(effect.sink);
      else if (effect.kind === 'end') {
        if (open.at(-1) !== effect.sink) {
          reasons.push(`${event.key} does not close the active structural environment`);
        } else {
          open.pop();
        }
      }
    }
  }
  if (open.length) reasons.push(`structural aliases leave ${open.join(', ')} open`);
  const shippingExactUses = [...preambleUses, ...uses].filter((use) =>
    use.exact && use.sinks.length &&
    ((use.unresolved?.length ?? 0) > 0 || use.sinks.some((sink) => SHIPPING_EXACT_SINKS.has(sink))) &&
    !use.sinks.some((sink) => DOCUMENT_GLOBAL_SINKS.has(sink))
  );
  const scopes = uses.map((use) => ({
    key: use.key,
    sinks: use.sinks,
    scope: use.sinks.some((sink) => DOCUMENT_GLOBAL_SINKS.has(sink))
      ? 'document'
      : (use.unresolved?.length ?? 0) > 0 ||
          use.sinks.some((sink) => SUFFIX_SCOPED_SINKS.has(sink))
        ? 'suffix'
        : use.sinks.some((sink) => SHIPPING_EXACT_SINKS.has(sink))
          ? 'page'
          : 'block',
    authority: !use.exact || use.sinks.some((sink) => DOCUMENT_GLOBAL_SINKS.has(sink))
      ? 'canonical'
      : ((use.unresolved?.length ?? 0) > 0 ||
          use.sinks.some((sink) => SHIPPING_EXACT_SINKS.has(sink)))
        ? 'shipping'
        : use.sinks.some((sink) => RESCUE_REQUIRED_SINKS.has(sink))
          ? 'rescue'
          : 'resident',
    unresolved: use.unresolved ?? [],
  }));
  return {
    safe: reasons.length === 0,
    reasons: [...new Set(reasons)],
    segmentEvents,
    preambleUses,
    uses,
    // Proving where a hidden environment opens/closes is enough to retain
    // incremental source identity, but it does NOT prove that the JS page
    // builder can reproduce TeX's output routine.  Keep those two
    // qualifications separate: exact aliases are segmentable; only scopes
    // that still carry page/suffix uncertainty require ShippingChain.
    requiresShippingExact: shippingExactUses.length > 0,
    shippingExactUses,
    scopes,
    aliases: new Map([...defs].map(([key, value]) => [key, [...value.may]])),
  };
}

/** Mask local definition declarations while preserving offsets. Preamble
 * action gates use this to distinguish defining a dangerous operation from
 * actually executing it; invoked definitions are analysed above. */
export function maskStructuralDefinitions(source) {
  const info = collectDefinitions(source);
  return maskSpans(info.masked, info.spans);
}

export { STRUCTURAL_ENVIRONMENTS };
