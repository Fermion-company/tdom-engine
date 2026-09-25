import { fnv1a } from '../hash.js';

/**
 * Preamble definition patches (tex64-internal #93).
 *
 * A preamble edit reboots the resident root and re-typesets every block (40 s
 * on the 316-page fixture). When the edit only changes the body of a macro or
 * environment the document itself declares (\newcommand & co.), the booted
 * root is still right about everything else: re-running the changed
 * declarations in front of each job that uses them gives that job the new
 * definition, whatever checkpoint it forks from. Only the blocks that use a
 * changed name (directly, or through another preamble declaration) are
 * dirty; every other galley and checkpoint stays.
 *
 * Anything else (packages, options, \renewcommand of a name the document
 * did not declare, \def, catcode or expl3 regions, a use outside the
 * document body) is not a patch: the caller reboots as before.
 */

// declarations whose name the document owns: the preamble creates it
const DECLARATIONS = {
  newcommand: 'command',
  NewDocumentCommand: 'xcommand',
  DeclareMathOperator: 'operator',
  newenvironment: 'environment',
  NewDocumentEnvironment: 'xenvironment',
};

// a definition command inside a body block could capture a changed name
const BODY_DEFINITION_RE =
  /\\(?:(?:re)?newcommand|providecommand|DeclareRobustCommand|[gex]?def|let|(?:re)?newenvironment|(?:New|Renew|Provide|Declare)Document(?:Command|Environment)|DeclareMathOperator)(?![A-Za-z])/;

const isLetter = (ch) => /[A-Za-z]/.test(ch ?? '');

/** Index past a comment starting at `i` (the '%'), newline included. */
function skipComment(text, i) {
  const nl = text.indexOf('\n', i);
  return nl < 0 ? text.length : nl + 1;
}

/** Skip spaces, newlines and comments between arguments. */
function skipSpace(text, i) {
  for (;;) {
    if (i >= text.length) return i;
    const ch = text[i];
    if (ch === '%') i = skipComment(text, i);
    else if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') i++;
    else return i;
  }
}

/** A balanced {group} at `i` → { start, end (past '}'), inner } or null. */
function readGroup(text, i) {
  i = skipSpace(text, i);
  if (text[i] !== '{') return null;
  let depth = 0;
  for (let k = i; k < text.length; k++) {
    const ch = text[k];
    if (ch === '\\') { k++; continue; }
    if (ch === '%') { k = skipComment(text, k) - 1; continue; }
    if (ch === '{') depth++;
    else if (ch === '}' && --depth === 0) return { start: i, end: k + 1, inner: text.slice(i + 1, k) };
  }
  return null;
}

/** An optional [argument] at `i` (brace-balanced) → { end } or null. */
function readOptional(text, i) {
  const at = skipSpace(text, i);
  if (text[at] !== '[') return null;
  let depth = 0;
  for (let k = at + 1; k < text.length; k++) {
    const ch = text[k];
    if (ch === '\\') { k++; continue; }
    if (ch === '%') { k = skipComment(text, k) - 1; continue; }
    if (ch === '{') depth++;
    else if (ch === '}') depth--;
    else if (ch === ']' && depth === 0) return { end: k + 1 };
  }
  return null;
}

/** `{\name}` or `\name` at `i` → { name, end } (letters, and @ under \makeatletter) or null. */
function readCommandName(text, i, atLetter) {
  const at = skipSpace(text, i);
  const letters = atLetter ? '[A-Za-z@]+' : '[A-Za-z]+';
  if (text[at] === '{') {
    const g = readGroup(text, at);
    const m = g && new RegExp(`^\\s*\\\\(${letters})\\s*$`).exec(g.inner);
    return m ? { name: m[1], end: g.end } : null;
  }
  const m = new RegExp(`^\\\\(${letters})`).exec(text.slice(at, at + 200));
  return m ? { name: m[1], end: at + m[0].length } : null;
}

/**
 * Split a preamble into owned declarations and the rest. Returns null when a
 * declaration cannot be read (the caller reboots).
 */
export function scanPreamble(preamble) {
  const decls = [];
  let other = '';
  let from = 0;
  let atLetter = false;
  let expl = false;
  for (let i = 0; i < preamble.length; i++) {
    const ch = preamble[i];
    if (ch === '%') {
      other += preamble.slice(from, i);
      i = skipComment(preamble, i) - 1;
      from = i + 1;
      continue;
    }
    if (ch !== '\\') continue;
    let j = i + 1;
    while (isLetter(preamble[j])) j++;
    const word = preamble.slice(i + 1, j);
    if (!word) { i = j; continue; } // control symbol: \% \{ …
    if (word === 'makeatletter') atLetter = true;
    else if (word === 'makeatother') atLetter = false;
    else if (word === 'ExplSyntaxOn') expl = true;
    else if (word === 'ExplSyntaxOff') expl = false;
    const kind = DECLARATIONS[word];
    if (!kind) { i = j - 1; continue; }
    let k = j;
    if (preamble[k] === '*') k++;
    let name;
    if (kind === 'environment' || kind === 'xenvironment') {
      const g = readGroup(preamble, k);
      if (!g || !/^[A-Za-z*]+$/.test(g.inner.trim())) return null;
      name = g.inner.trim();
      k = g.end;
    } else {
      const n = readCommandName(preamble, k, atLetter);
      if (!n) return null;
      name = n.name;
      k = n.end;
    }
    const groups = [];
    if (kind === 'command' || kind === 'environment') {
      for (let o = 0; o < 2; o++) {
        const opt = readOptional(preamble, k);
        if (!opt) break;
        k = opt.end;
      }
      const need = kind === 'command' ? 1 : 2;
      for (let g = 0; g < need; g++) {
        const grp = readGroup(preamble, k);
        if (!grp) return null;
        groups.push(grp.inner);
        k = grp.end;
      }
    } else {
      const need = kind === 'operator' ? 1 : kind === 'xcommand' ? 2 : 3;
      for (let g = 0; g < need; g++) {
        const grp = readGroup(preamble, k);
        if (!grp) return null;
        groups.push(grp.inner);
        k = grp.end;
      }
    }
    other += preamble.slice(from, i);
    const raw = preamble.slice(i, k);
    decls.push({ kind, name, raw, body: groups.join('\n'), atLetter, expl, key: `${kind}:${name}` });
    from = k;
    i = k - 1;
  }
  other += preamble.slice(from);
  return { decls, other: other.replace(/\s+/g, ' ').trim() };
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** A RegExp matching a use of any of `decls` in TeX source. */
function usesRe(decls) {
  const alts = [];
  for (const d of decls) {
    if (d.kind === 'environment' || d.kind === 'xenvironment') {
      alts.push(`\\\\(?:begin|end)\\s*\\{${escapeRe(d.name)}\\}`);
      if (/^[A-Za-z]+$/.test(d.name)) alts.push(`\\\\(?:end)?${d.name}(?![A-Za-z])`);
    } else {
      alts.push(`\\\\${escapeRe(d.name)}(?![A-Za-z@])`);
    }
  }
  return alts.length ? new RegExp(alts.join('|')) : null;
}

/** Declarations whose raw text differs between two scans (same shape). */
function changedDecls(from, to) {
  return to.decls.filter((d, i) => from.decls[i].raw !== d.raw);
}

/**
 * The declarations `changed` reach through other declarations' bodies, with
 * the regex of all of them. Null when a use of one sits outside a
 * declaration body (hooks, \title, class options …): it could run anywhere.
 */
function reach(scan, changed) {
  const reached = new Map(changed.map((d) => [d.key, d]));
  for (let grew = true; grew;) {
    grew = false;
    const re = usesRe([...reached.values()]);
    for (const d of scan.decls) {
      if (!reached.has(d.key) && re?.test(d.body)) {
        reached.set(d.key, d);
        grew = true;
      }
    }
  }
  const all = [...reached.values()];
  const re = usesRe(all);
  if (re && re.test(scan.other)) return null;
  return { decls: all, re };
}

/** The TeX that re-runs `decls`, restoring the catcode of @ after. */
function preludeFor(decls) {
  if (!decls.length) return '';
  const lines = ['\\chardef\\TDOMdefsat=\\catcode`\\@\\relax%'];
  for (const d of decls) {
    let reset = '';
    if (d.kind === 'environment' || d.kind === 'xenvironment') {
      reset = `\\expandafter\\let\\csname ${d.name}\\endcsname\\relax` +
        `\\expandafter\\let\\csname end${d.name}\\endcsname\\relax`;
    } else {
      reset = `\\let\\${d.name}\\relax`;
    }
    lines.push(`${d.atLetter ? '\\makeatletter' : '\\makeatother'}${reset}%`);
    lines.push(`${d.raw}%`);
  }
  lines.push('\\catcode`\\@=\\TDOMdefsat\\relax%');
  return lines.join('\n') + '\n';
}

/**
 * Plan a patch from the preamble the root booted with (`bootPreamble`) and
 * the one before this edit (`prevPreamble`) to `preamble`.
 *
 * Returns { ok: false, reason } when the edit needs a reboot, else
 * { ok: true, prelude, sig, touches(text), dirtyRe, names }:
 * - prelude: TeX run in front of a job whose block `touches` (the changed
 *   declarations since boot, in preamble order), '' when the preamble is
 *   back to the booted one;
 * - dirtyRe: uses of the declarations this edit changed (since the previous
 *   preamble), the blocks to re-typeset now.
 * `packageText` is the project's own .sty/.cls text, `blockTexts` every body
 * block's source.
 */
export function planPreamblePatch({ bootPreamble, prevPreamble, preamble, blockTexts = [], packageText = '' }) {
  const boot = scanPreamble(bootPreamble);
  const prev = scanPreamble(prevPreamble);
  const next = scanPreamble(preamble);
  if (!boot || !prev || !next) return { ok: false, reason: 'unreadable-declaration' };
  const sameShape = (a) => a.other === next.other && a.decls.length === next.decls.length &&
    a.decls.every((d, i) => d.key === next.decls[i].key);
  if (!sameShape(boot) || !sameShape(prev)) return { ok: false, reason: 'not-only-declarations' };
  const sinceBoot = changedDecls(boot, next);
  const sinceNow = changedDecls(prev, next);
  if (sinceBoot.some((d) => d.expl) || sinceNow.some((d) => d.expl)) return { ok: false, reason: 'expl3-declaration' };
  const bootReach = reach(next, sinceBoot);
  const nowReach = reach(next, sinceNow);
  if (!bootReach || !nowReach) return { ok: false, reason: 'used-in-preamble' };
  // a changed name the document owns can still be used where no block walk
  // reaches: the project's own packages, or a definition inside the body
  if (bootReach.re && bootReach.re.test(packageText)) return { ok: false, reason: 'used-in-package' };
  if (nowReach.re && blockTexts.some((t) => nowReach.re.test(t) && BODY_DEFINITION_RE.test(t))) {
    return { ok: false, reason: 'used-in-body-definition' };
  }
  const prelude = preludeFor(next.decls.filter((d) => sinceBoot.includes(d)));
  const touchRe = bootReach.re;
  return {
    ok: true,
    prelude,
    sig: prelude ? fnv1a(prelude) : '',
    touches: (text) => !!prelude && !!touchRe && touchRe.test(text),
    dirtyRe: nowReach.re,
    names: sinceNow.map((d) => d.name),
  };
}
