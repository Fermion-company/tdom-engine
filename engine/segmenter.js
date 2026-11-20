// Source segmenter — builds the top level of the Source DOM.
//
// The body of the document is split into blocks: the incremental unit of the
// whole pipeline. Boundaries are:
//   - blank lines at group/environment depth 0 (a real \par)
//   - lines starting a sectioning command (which performs its own \par)
//   - lines holding only a standalone generated-content command
//     (\maketitle, \tableofcontents, ...) — isolated on BOTH sides
//
// Blank lines *inside* an environment or display math do not split.
//
// A block boundary MUST be a \par boundary. Splitting at a bare \begin{...}
// or \[ used to detach environments from the paragraph they are attached to
// (no blank line), and the fresh job then entered them in VERTICAL mode
// while the continuous run was still in horizontal mode — \@trivlist adds
// \partopsep only in vmode, displays pick \abovedisplay(short)skip from the
// open paragraph, so every attached list/display drifted by a few points
// (found by the Phase-0 farm). Paragraph-attached environments now stay in
// the block of their paragraph; the h/v-mode at every boundary is vertical
// by construction, in the job AND in the continuous run.
//
// segmentBody() is a linear scan over the body text — trivial arithmetic per
// keystroke. Everything expensive downstream (expansion, semantics, layout)
// is cached per block, so this scan is what keeps block identity honest.

import { fnv1a } from './hash.js';

const FORCED_START = /^\s*\\(par|chapter|section|subsection|subsubsection|paragraph|subparagraph)\b/;

// Standalone generated-content commands. Each performs its own \par and
// emits display material nobody types into (the title block, the toc/lof/lot
// lists), so a line holding only such a command is a complete \par unit.
// Isolating it keeps that block's fate — title blocks are whole-block exact
// chunks, and a wedged render can freeze them — from swallowing the paragraph
// the user is typing directly below (observed: text typed on the line after
// \maketitle shared its block, and once that block froze every keystroke
// there degraded to canonical-latency updates).
const STANDALONE_LINE =
  /^\s*\\(?:(?:maketitle|tableofcontents|listoffigures|listoftables)\s*|(?:input|include|subfile|bibliography)\s*\{[^}]+\}\s*|print(?:bibliography|index)\s*(?:\[[^\]]*\])?\s*)$|^\s*\\ifSubfilesClassLoaded\s*\{\s*\}\s*\{\s*\\printindex\s*(?:\[[^\]]*\])?\s*\}\s*$/;

// Environments whose content is LITERAL: no comments, no macro calls, no
// brace/environment structure. Without this awareness an unbalanced `{`
// (or a `%` hiding the rest of a line) inside a listing poisoned the depth
// counters and merged the entire remaining document into one block — every
// keystroke anywhere in the tail then re-typeset the whole remainder.
const VERBATIM_BEGIN_RE =
  /\\begin\{(verbatim\*?|lstlisting|minted|filecontents\*?|[BLV]erbatim\*?)\}/;

// Preamble declarations that make a literal environment under the user's
// own name (listings, fancyvrb, minted, tcolorbox listings, comment). A
// `TeXBlock` listing is as literal as `lstlisting`, so both the segmenter
// and the document bounds must know its name.
const LITERAL_ENV_DECL_RE =
  /\\(?:lstnewenvironment|DefineVerbatimEnvironment|(?:re)?newtcblisting|(?:Declare|New|Renew|Provide)TCBListing|excludecomment)\s*(?:\[[^\]]*\]\s*)?\{\s*([^{}\s]+)\s*\}/g;
const NEWMINTED_RE = /\\newminted\s*(?:\[\s*([^\]\s]+)\s*\])?\s*\{\s*([^{}\s]+)\s*\}/g;

export function literalEnvironmentNames(text) {
  const names = new Set();
  for (const m of text.matchAll(LITERAL_ENV_DECL_RE)) names.add(m[1]);
  for (const m of text.matchAll(NEWMINTED_RE)) names.add(m[1] ?? `${m[2]}code`);
  return names;
}

function literalBegin(stripped, literalEnvs) {
  const builtin = VERBATIM_BEGIN_RE.exec(stripped);
  if (!literalEnvs?.size) return builtin;
  for (const m of stripped.matchAll(/\\begin\{([^{}]*)\}/g)) {
    if (builtin && m.index >= builtin.index) break;
    if (literalEnvs.has(m[1])) return m;
  }
  return builtin;
}

// The scan itself, from the line that starts at `from` to the end of the
// text. `sync[i]` says that segs[i] began on a line the scan reached with
// nothing open (no environment, group, display, literal run or pending
// block): from such a line on, the result depends on the rest of the text
// alone. `resync(lineStart)` is asked on every such line and may name the
// place in an earlier result from which that result holds again; the scan
// stops there (`spliceFrom`).
function scanSegments(text, baseOffset, from, aliasEvents, literalEnvs, resync) {
  const segs = [];
  const sync = [];
  let aliasEventIndex = 0;
  while (aliasEventIndex < aliasEvents.length && aliasEvents[aliasEventIndex].at < from) aliasEventIndex++;
  let envDepth = 0;
  let braceDepth = 0;
  let inDisplay = false;
  let inVerbatim = null; // env name while inside a literal environment
  let inAlltt = false; // commands/braces execute; unlike normal TeX, % is data
  let inKKcode = false; // inside \KKcodeS...\KKcodeE (KKluaverb)
  let cur = null; // { start, sync }
  let curStructuralSinks = new Set();

  const flush = (endOffset) => {
    if (cur !== null) {
      const raw = text.slice(cur.start, endOffset);
      if (raw.trim().length > 0) {
        segs.push({
          start: baseOffset + cur.start,
          end: baseOffset + endOffset,
          text: raw,
          structuralSinks: [...curStructuralSinks],
          hash: fnv1a(raw),
        });
        sync.push(cur.sync);
      }
      cur = null;
      curStructuralSinks = new Set();
    }
  };

  const ln = { start: 0, end: 0, text: '' };
  for (let lineStart = from; lineStart <= text.length; lineStart = ln.end + 1) {
    const newline = text.indexOf('\n', lineStart);
    ln.start = lineStart;
    ln.end = newline < 0 ? text.length : newline;
    ln.text = text.slice(ln.start, ln.end);
    const settled = cur === null && envDepth === 0 && braceDepth === 0 && !inDisplay && inVerbatim === null &&
      !inAlltt && !inKKcode && curStructuralSinks.size === 0;
    if (settled && resync) {
      const spliceFrom = resync(ln.start);
      if (spliceFrom >= 0) return { segs, sync, spliceFrom };
    }
    // KKluaverb's \KKcodeS...\KKcodeE: literal lines, like a verbatim env
    if (inKKcode) {
      if (cur === null) cur = { start: ln.start, sync: settled };
      if (ln.text.includes('\\KKcodeE')) inKKcode = false;
      continue;
    }
    if (inVerbatim) {
      // literal content: no comment stripping, no depth tracking, no
      // blank-line flush (blank lines inside a listing stay in the block)
      if (cur === null) cur = { start: ln.start, sync: settled };
      if (ln.text.includes(`\\end{${inVerbatim}}`)) inVerbatim = null;
      continue;
    }
    // Neutralize inline \verb before comments: its delimiter may contain a
    // literal `%`, which must not hide executable text later on the line.
    let stripped = ln.text.replace(
      /\\verb\*?([^A-Za-z\s])(.*?)\1|\\KKverb\|[^|]*\|/g,
      (match) => ' '.repeat(match.length)
    );
    if (!inAlltt) stripped = stripComment(stripped);
    if (!inAlltt && /\\begin\{alltt\}/.test(stripped)) inAlltt = true;
    const blank = stripped.trim().length === 0 && ln.text.trim().length === 0;
    const atTop = envDepth === 0 && braceDepth <= 0 && !inDisplay;

    if (blank && atTop) {
      flush(ln.start);
      continue;
    }
    if (atTop && cur !== null && (FORCED_START.test(stripped) || STANDALONE_LINE.test(stripped))) {
      flush(ln.start);
    }
    if (cur === null && !blank) cur = { start: ln.start, sync: settled };
    if (atTop && STANDALONE_LINE.test(stripped)) {
      // close the standalone command's block right after its line; the next
      // non-blank line starts a fresh block even without a blank line
      flush(ln.end);
      continue;
    }

    const kkcode = stripped.indexOf('\\KKcodeS');
    if (kkcode >= 0 && !ln.text.slice(ln.text.indexOf('\\KKcodeS')).includes('\\KKcodeE')) {
      const before = stripped.slice(0, kkcode);
      envDepth = Math.max(0, envDepth + countMatches(before, /\\begin\{[^}]*\}/g) - countMatches(before, /\\end\{[^}]*\}/g));
      braceDepth = Math.max(0, braceDepth + braceDelta(before));
      inKKcode = true;
      continue;
    }
    const verb = literalBegin(stripped, literalEnvs);
    if (verb) {
      // enter literal mode unless the same line also closes it; the
      // verbatim env itself contributes nothing to envDepth (its \begin
      // and \end are both skipped, so it stays balanced), but any OTHER
      // structure on the line before \begin{verbatim} still counts
      const before = stripped.slice(0, verb.index);
      envDepth += countMatches(before, /\\begin\{[^}]*\}/g);
      envDepth -= countMatches(before, /\\end\{[^}]*\}/g);
      if (envDepth < 0) envDepth = 0;
      braceDepth += braceDelta(before);
      if (braceDepth < 0) braceDepth = 0;
      if (!ln.text.includes(`\\end{${verb[1]}}`)) inVerbatim = verb[1];
      continue;
    }

    // Track depth transitions on this line.
    envDepth += countMatches(stripped, /\\begin\{[^}]*\}/g);
    envDepth -= countMatches(stripped, /\\end\{[^}]*\}/g);
    while (aliasEventIndex < aliasEvents.length && aliasEvents[aliasEventIndex].at <= ln.end) {
      const event = aliasEvents[aliasEventIndex++];
      if (event.at < ln.start) continue;
      for (const sink of event.sinks ?? []) curStructuralSinks.add(sink);
      for (const effect of event.effects ?? []) {
        if (effect.kind === 'begin') envDepth++;
        else if (effect.kind === 'end') envDepth--;
      }
    }
    if (envDepth < 0) envDepth = 0;
    if (inAlltt && /\\end\{alltt\}/.test(stripped)) inAlltt = false;
    // `\\[2mm]` in align/tabular is a row break with optional spacing, not
    // the display opener `\[`.  A substring regex sees the second slash of
    // `\\[` and poisons inDisplay for the whole remaining document, merging
    // every later paragraph into the exact-render block.  TeX reads a bracket
    // as the control symbol only after an odd run of backslashes.
    if (hasControlSymbol(stripped, '[')) inDisplay = true;
    if (hasControlSymbol(stripped, ']')) inDisplay = false;
    braceDepth += braceDelta(stripped);
    if (braceDepth < 0) braceDepth = 0;
    // NOTE: an environment/display CLOSING no longer ends the block — text
    // attached right after \end{...} (no blank line) continues in @endpe
    // state in the continuous run, so it belongs to the same \par unit.
  }
  flush(text.length);
  return { segs, sync, spliceFrom: -1 };
}

const SCAN_BLOCK = 8192;
function commonPrefixLength(a, b) {
  const limit = Math.min(a.length, b.length);
  let at = 0;
  while (at + SCAN_BLOCK <= limit && a.substring(at, at + SCAN_BLOCK) === b.substring(at, at + SCAN_BLOCK)) at += SCAN_BLOCK;
  while (at < limit && a.charCodeAt(at) === b.charCodeAt(at)) at++;
  return at;
}
function commonSuffixLength(a, b, limit) {
  let n = 0;
  while (n + SCAN_BLOCK <= limit &&
      a.substring(a.length - n - SCAN_BLOCK, a.length - n) === b.substring(b.length - n - SCAN_BLOCK, b.length - n)) n += SCAN_BLOCK;
  while (n < limit && a.charCodeAt(a.length - n - 1) === b.charCodeAt(b.length - n - 1)) n++;
  return n;
}

// The text differs from the one `prior` was made from in one stretch. The
// blocks before the last settled block start above that stretch are kept;
// the scan restarts there and stops at the first settled line below the
// stretch where the earlier result has a block starting too. Everything
// from that block on is the earlier result, moved by the change in length.
function resegment(text, baseOffset, literalEnvs, prior) {
  const old = prior.text;
  if (old === text) return { segs: prior.segs, sync: prior.sync };
  const prefix = commonPrefixLength(old, text);
  const suffix = commonSuffixLength(old, text, Math.min(old.length, text.length) - prefix);
  const delta = text.length - old.length;
  const changedLine = prefix === 0 ? 0 : old.lastIndexOf('\n', prefix - 1) + 1;
  const { segs, sync } = prior;
  // the last block that starts on an earlier line than the change
  let lo = 0;
  let hi = segs.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (segs[mid].start - baseOffset < changedLine) lo = mid + 1;
    else hi = mid;
  }
  let keep = lo - 1;
  while (keep >= 0 && !sync[keep]) keep--;
  const from = keep >= 0 ? segs[keep].start - baseOffset : 0;
  const unchangedFrom = text.length - suffix;
  let starts = prior.starts;
  if (!starts) {
    starts = prior.starts = new Map();
    for (let i = 0; i < segs.length; i++) if (sync[i]) starts.set(segs[i].start - baseOffset, i);
  }
  const scanned = scanSegments(text, baseOffset, from, [], literalEnvs, (lineStart) => {
    if (lineStart < unchangedFrom) return -1;
    const index = starts.get(lineStart - delta);
    return index !== undefined && index > keep ? index : -1;
  });
  const head = keep > 0 ? segs.slice(0, keep) : [];
  const headSync = keep > 0 ? sync.slice(0, keep) : [];
  if (scanned.spliceFrom < 0) return { segs: head.concat(scanned.segs), sync: headSync.concat(scanned.sync) };
  const tail = segs.slice(scanned.spliceFrom);
  if (delta !== 0) {
    for (let i = 0; i < tail.length; i++) tail[i] = { ...tail[i], start: tail[i].start + delta, end: tail[i].end + delta };
  }
  return { segs: head.concat(scanned.segs, tail), sync: headSync.concat(scanned.sync, sync.slice(scanned.spliceFrom)) };
}

const literalEnvKey = (literalEnvs) => (literalEnvs?.size ? [...literalEnvs].sort().join('\u0000') : '');

/**
 * Split a body into blocks. `memo` (an object the caller keeps for one text
 * that changes a little between calls: a document's body, a book's joined
 * chapters) lets the next call scan only around what changed: a keystroke
 * in a 389-page book scanned all 1.6 MB of it. The result is the same as a
 * scan of the whole text.
 */
export function segmentBody(text, baseOffset, { structuralEvents = [], literalEnvs = null, memo = null } = {}) {
  const aliasEvents = [...structuralEvents].sort((a, b) => a.at - b.at);
  if (!memo) return scanSegments(text, baseOffset, 0, aliasEvents, literalEnvs, null).segs;
  const envKey = literalEnvKey(literalEnvs);
  // structural events sit at offsets of their own: such a text is scanned whole
  const prior = !aliasEvents.length && memo.plain === true && memo.baseOffset === baseOffset && memo.envKey === envKey
    ? memo : null;
  const result = (prior && resegment(text, baseOffset, literalEnvs, prior)) ||
    scanSegments(text, baseOffset, 0, aliasEvents, literalEnvs, null);
  memo.text = text;
  memo.baseOffset = baseOffset;
  memo.envKey = envKey;
  memo.plain = aliasEvents.length === 0;
  memo.segs = result.segs;
  memo.sync = result.sync;
  memo.starts = null;
  // the caller's own objects: what it does to them must not reach the memo
  return result.segs.map((seg) => ({ ...seg, structuralSinks: [...seg.structuralSinks] }));
}


// Environments TeX reads as literal characters, for the document bounds.
// Unlike VERBATIM_BEGIN_RE this leaves out alltt: \, { and } keep their
// meaning there, so an \end{document} inside alltt really ends the run.
const LITERAL_BOUNDARY_ENVS = new Set([
  'verbatim', 'verbatim*', 'Verbatim', 'Verbatim*', 'BVerbatim', 'BVerbatim*',
  'LVerbatim', 'LVerbatim*', 'SaveVerbatim', 'VerbatimOut', 'lstlisting', 'minted',
  'filecontents', 'filecontents*', 'comment', 'tcblisting', 'luacode', 'luacode*',
]);
const MARKER_RE = /\\(begin|end)\{([^{}]*)\}/g;
const INLINE_VERB_RE =
  /(\\(?:verb\*?|lstinline(?:\[[^\]]*\])?|mintinline(?:\[[^\]]*\])?\{[^{}]*\})([^A-Za-z\s{*]))(.*?)\2/g;
const INLINE_BRACED_RE =
  /(\\(?:lstinline(?:\[[^\]]*\])?|mintinline(?:\[[^\]]*\])?\{[^{}]*\})\{)((?:[^{}]|\{[^{}]*\})*)\}/g;

const LITERAL_OR_INLINE_RE = new RegExp(
  `\\\\(?:verb|lstinline|mintinline)|\\\\begin\\{(?:${[...LITERAL_BOUNDARY_ENVS].map((name) => name.replace('*', '\\*')).join('|')})\\}`
);

let boundsMemo = { text: null, value: null };

/**
 * Locate the preamble/body split. Returns
 * { preamble:{start,end}, body:{start,end}, hasBegin, literalEnvs }. If
 * \begin{document} is missing the whole file is treated as body (keeps the
 * engine alive mid-edit).
 *
 * The markers are the first ACTIVE \begin{document} and the first active
 * \end{document} after it: not in a comment, not in a verbatim/listing
 * environment, not in \verb. Manuals and LaTeX tutorials quote
 * \end{document} in listings; taking the first string match cut the body
 * there, and the resident dropped every page after the listing.
 */
// The literal environments and the conditionals are handed out as the sets
// they were for the text before whenever they hold the same names: callers
// keep what they worked out per block for as long as these are the same
// objects (update-prepare.js closureMemo). In a single-file document the
// text changes with every keystroke, so they were new sets each time, and
// the closure of all 2,600 blocks of a 191-page file was read again with
// every key (0.7 ms).
const sameNames = (a, b) => {
  if (a === b) return true;
  if (!a || !b || a.size !== b.size) return false;
  for (const name of a) if (!b.has(name)) return false;
  return true;
};
export function documentBounds(text) {
  if (boundsMemo.text !== text) {
    const value = scanDocumentBounds(text);
    const before = boundsMemo.value;
    if (before && sameNames(before.literalEnvs, value.literalEnvs)) value.literalEnvs = before.literalEnvs;
    if (before && sameNames(before.conditionals, value.conditionals)) value.conditionals = before.conditionals;
    boundsMemo = { text, value };
  }
  const { preamble, body, hasBegin, literalEnvs } = boundsMemo.value;
  return { preamble: { ...preamble }, body: { ...body }, hasBegin, literalEnvs, conditionals: boundsMemo.value.conditionals };
}

function scanDocumentBounds(text) {
  const bounds = scanDocumentMarkers(text);
  // the document's own switches (\newif\ifdraft), for closure.js
  const conditionals = new Set();
  for (const match of text.slice(bounds.preamble.start, bounds.preamble.end).matchAll(/\\newif\s*\\(if[A-Za-z@]+)/g)) conditionals.add(match[1]);
  return { ...bounds, conditionals };
}

function scanDocumentMarkers(text) {
  const literalEnvs = literalEnvironmentNames(text);
  const { begin, end } = plainDocumentMarkers(text, literalEnvs) ?? findDocumentMarkers(text, literalEnvs);
  if (begin < 0) {
    return { preamble: { start: 0, end: 0 }, body: { start: 0, end: text.length }, hasBegin: false, literalEnvs };
  }
  const bodyStart = begin + '\\begin{document}'.length;
  const bodyEnd = end < 0 ? text.length : end;
  return { preamble: { start: 0, end: begin }, body: { start: bodyStart, end: bodyEnd }, hasBegin: true, literalEnvs };
}

// The common case without a line scan: each marker occurs once, on an
// uncommented line, and nothing literal could be quoting it.
function plainDocumentMarkers(text, literalEnvs) {
  const begin = text.indexOf('\\begin{document}');
  const end = text.indexOf('\\end{document}');
  if (begin < 0 || end < begin) return null;
  if (text.indexOf('\\begin{document}', begin + 1) >= 0 || text.indexOf('\\end{document}', end + 1) >= 0) return null;
  if (literalEnvs.size || LITERAL_OR_INLINE_RE.test(text)) return null;
  if (commentedAt(text, begin) || commentedAt(text, end)) return null;
  return { begin, end };
}

function commentedAt(text, offset) {
  const lineStart = text.lastIndexOf('\n', offset - 1) + 1;
  const before = text.slice(lineStart, offset);
  return commentStart(before) < before.length;
}

function findDocumentMarkers(text, literalEnvs) {
  let begin = -1;
  let inLiteral = null;
  for (let pos = 0; pos <= text.length;) {
    let eol = text.indexOf('\n', pos);
    if (eol < 0) eol = text.length;
    const line = text.slice(pos, eol);
    let col = 0;
    scan: while (col <= line.length) {
      if (inLiteral) {
        const close = line.indexOf(`\\end{${inLiteral}}`, col);
        if (close < 0) break;
        col = close + `\\end{${inLiteral}}`.length;
        inLiteral = null;
      }
      const active = maskInlineVerbatim(line.slice(col));
      const code = active.slice(0, commentStart(active));
      MARKER_RE.lastIndex = 0;
      for (let m; (m = MARKER_RE.exec(code));) {
        const [, kind, name] = m;
        if (kind === 'begin' && (LITERAL_BOUNDARY_ENVS.has(name) || literalEnvs.has(name))) {
          inLiteral = name;
          col += m.index + m[0].length;
          continue scan;
        }
        if (name !== 'document') continue;
        if (kind === 'begin' && begin < 0) begin = pos + col + m.index;
        else if (kind === 'end' && begin >= 0) return { begin, end: pos + col + m.index };
      }
      break;
    }
    pos = eol + 1;
  }
  return { begin, end: -1 };
}

// Blank out inline verbatim payloads, keeping every offset in place.
function maskInlineVerbatim(s) {
  if (!/\\(?:verb|lstinline|mintinline)/.test(s)) return s;
  return s
    .replace(INLINE_VERB_RE, (_, head, delim, payload) => `${head}${' '.repeat(payload.length)}${delim}`)
    .replace(INLINE_BRACED_RE, (_, head, payload) => `${head}${' '.repeat(payload.length)}}`);
}

// Offset of the first `%` that starts a comment: one preceded by an even
// run of backslashes (`\\%` is a line break and then a comment).
function commentStart(s) {
  for (let i = s.indexOf('%'); i >= 0; i = s.indexOf('%', i + 1)) {
    let slashes = 0;
    for (let j = i - 1; j >= 0 && s[j] === '\\'; j--) slashes++;
    if (slashes % 2 === 0) return i;
  }
  return s.length;
}

/**
 * Diff old blocks vs new segments by content hash. Reuses block objects for
 * unchanged content (preserving expansion/layout caches by identity), reuses
 * ids for positionally-paired modified blocks, and mints new ids otherwise.
 *
 * Returns { blocks, dirty: Set<blockId>, added: [id], removed: [id] }.
 */
export function diffBlocks(oldBlocks, segs, nextId) {
  const nOld = oldBlocks.length;
  const nNew = segs.length;
  let p = 0;
  while (p < nOld && p < nNew && oldBlocks[p].hash === segs[p].hash) p++;
  let so = nOld;
  let sn = nNew;
  while (so > p && sn > p && oldBlocks[so - 1].hash === segs[sn - 1].hash) {
    so--;
    sn--;
  }

  const blocks = [];
  const dirty = new Set();
  const added = [];
  const removed = [];

  // Common prefix: reuse objects, refresh offsets.
  for (let i = 0; i < p; i++) {
    blocks.push(refresh(oldBlocks[i], segs[i]));
  }
  // Middle: blocks whose text did not change are found by hash (a longest
  // common subsequence), so a second changed region further down does not
  // turn every block between the two into a changed one, and an inserted or
  // deleted block does not shift the pairing of all that follow
  // (tex64-internal #96). Between two such anchors the blocks pair up by
  // position as before: a block edited in place keeps its id.
  const anchors = middleAnchors(oldBlocks, segs, p, so, p, sn);
  const matchedOld = new Map(); // old index -> new index, for every kept block
  const regionInputs = new Map();
  for (let i = 0; i < p; i++) matchedOld.set(i, i);
  let regions = 0;
  let oi = p;
  let ni = p;
  const gap = (oEnd, nEnd) => {
    const midOld = oEnd - oi;
    const midNew = nEnd - ni;
    if (midOld || midNew) regions++;
    const shared = Math.min(midOld, midNew);
    const base = { o: oi, n: ni };
    // Pure deletion has no new input: its boundary would collide with the
    // following kept block's mapping and orphan one of the resident peers.
    if (midOld && midNew) regionInputs.set(base.o, base.n);
    for (let i = 0; i < shared; i++) {
      const ob = oldBlocks[base.o + i];
      const sg = segs[base.n + i];
      if (ob.hash === sg.hash) {
        blocks.push(refresh(ob, sg));
        matchedOld.set(base.o + i, base.n + i);
      } else {
        // Modified in place: keep the id. Expansion/semantics must rebuild
        // (they depend on the text), but the layout cache is carried over —
        // the layout key decides whether the rebuilt semantics differ.
        // The PREVIOUS galley rides along as the stale-first display: an
        // edited rescue-environment block without it had to pay a SYNCHRONOUS
        // isolated compile (~2s) on every keystroke — old-but-clean pixels
        // plus an async exact render is the doctrine, and it needs the old
        // galley to exist. The block stays in `dirty`, so everything that
        // must re-typeset still does; the carried fields are only the
        // "last good" state the rescue tiers show meanwhile.
        const nb = {
          id: ob.id,
          start: sg.start,
          end: sg.end,
          text: sg.text,
          hash: sg.hash,
          sem: null,
          exp: null,
          layout: ob.layout,
          layoutKey: ob.layoutKey,
          galley: ob.galley,
          // One-generation proof input for canonical-addressed wrapped prose:
          // the planner may overlay only the final visual line when every
          // earlier LuaLaTeX line is byte-identical across the edit.
          // (a cold preview is not a proof input: keep the galley it stands
          // in for, docs/10 §10.4b)
          previousGalley: ob.galley?.tdomColdPreview ? (ob.previousGalley ?? null) : ob.galley,
          galleyHash: ob.galleyHash,
          // (only for a block edited in place, never across a merge or split:
          // its held galley would show another block's text, tex64-internal #103)
          exactHistory: midOld === midNew ? ob.exactHistory ?? null : null,
          // (the galley the page last showed composed, stream.js: a keystroke
          // that follows quickly sends no RENDER, render-pump.js typedInBurst)
          composedFor: midOld === midNew ? ob.composedFor ?? null : null,
          stateVec: ob.stateVec,
          units: ob.units,
          rescued: ob.rescued,
          pageOffset: ob.pageOffset,
          fidelity: ob.fidelity,
          needsRender: ob.needsRender,
          gfx: ob.gfx,
          kind: ob.kind,
          consumesToc: ob.consumesToc,
          file: sg.file ?? null,
          sourceStart: sg.sourceStart ?? null,
          sourceEnd: sg.sourceEnd ?? null,
          sourceParts: sg.sourceParts ?? null,
          includeStart: !!sg.includeStart,
          includeEnd: !!sg.includeEnd,
          subfileStart: !!sg.subfileStart,
          subfileEnd: !!sg.subfileEnd,
          importDir: sg.importDir ?? null,
          externalGraphics: !!sg.externalGraphics,
          structuralSinks: sg.structuralSinks ?? [],
          sourceChanged: true,
          typesetCostMs: ob.typesetCostMs,
        };
        blocks.push(nb);
        dirty.add(nb.id);
      }
    }
    for (let i = shared; i < midNew; i++) {
      const sg = segs[base.n + i];
      const id = 'b' + nextId();
      blocks.push({
        id,
        start: sg.start,
        end: sg.end,
        text: sg.text,
        hash: sg.hash,
        sem: null,
        exp: null,
        layout: null,
        layoutKey: null,
        file: sg.file ?? null,
        sourceStart: sg.sourceStart ?? null,
        sourceEnd: sg.sourceEnd ?? null,
        sourceParts: sg.sourceParts ?? null,
        includeStart: !!sg.includeStart,
        includeEnd: !!sg.includeEnd,
        subfileStart: !!sg.subfileStart,
        subfileEnd: !!sg.subfileEnd,
        importDir: sg.importDir ?? null,
        externalGraphics: !!sg.externalGraphics,
        structuralSinks: sg.structuralSinks ?? [],
        sourceChanged: true,
      });
      dirty.add(id);
      added.push(id);
    }
    for (let i = shared; i < midOld; i++) removed.push(oldBlocks[base.o + i].id);
    oi = oEnd;
    ni = nEnd;
  };
  for (const [ao, an] of anchors) {
    gap(ao, an);
    blocks.push(refresh(oldBlocks[ao], segs[an]));
    matchedOld.set(ao, an);
    oi = ao + 1;
    ni = an + 1;
  }
  gap(so, sn);
  // Common suffix.
  for (let i = 0; i < nNew - sn; i++) {
    blocks.push(refresh(oldBlocks[so + i], segs[sn + i]));
    matchedOld.set(so + i, sn + i);
  }
  // Checkpoint re-keying (checkpoint-preservation.js): the boundary before
  // old block k survives at the boundary before its new position when that
  // block is kept. The exit of a kept predecessor also survives: it is the
  // input of the next changed region, even though that block is not kept.
  // Prefix boundaries (k <= prefixLen) hold exactly the old
  // state; the others follow an edit and survive as volatile-stale, the
  // rule the suffix always had. The end of the document follows the end.
  const boundaryMap = new Map();
  for (let k = 0; k <= nOld; k++) {
    if (k <= p) boundaryMap.set(k, { to: k, exact: true });
    else if (k === nOld) boundaryMap.set(k, { to: nNew, exact: false });
    else if (matchedOld.has(k)) boundaryMap.set(k, { to: matchedOld.get(k), exact: false });
    else if (regionInputs.has(k)) boundaryMap.set(k, { to: regionInputs.get(k), exact: false });
  }
  // the blocks of the window that did change, on each side
  const keptNew = new Set(matchedOld.values());
  const changedOld = [];
  for (let k = p; k < so; k++) if (!matchedOld.has(k)) changedOld.push(k);
  const changedNew = [];
  for (let k = p; k < sn; k++) if (!keptNew.has(k)) changedNew.push(k);

  // Window bounds for checkpoint re-keying: a checkpoint at boundary k holds
  // the state after blocks[0..k-1], so prefix boundaries (k <= prefixLen)
  // survive as-is and suffix boundaries (old k >= oldSuffixStart) survive at
  // k + (newSuffixStart - oldSuffixStart). Only boundaries inside the edited
  // window are gone for real.
  return {
    blocks,
    dirty,
    added,
    removed,
    bounds: { prefixLen: p, oldSuffixStart: so, newSuffixStart: sn, boundaryMap, regions, changedOld, changedNew },
  };
}

// Pairs [oldIndex, newIndex] of unchanged blocks in the middle windows, in
// order: a longest common subsequence of their hashes. A window too large
// for the table keeps the positional pairing (no anchors).
const MAX_LCS_CELLS = 4_000_000;
function middleAnchors(oldBlocks, segs, oStart, oEnd, nStart, nEnd) {
  const n = oEnd - oStart;
  const m = nEnd - nStart;
  if (!n || !m || n * m > MAX_LCS_CELLS) return [];
  const width = m + 1;
  const table = new Int32Array((n + 1) * width);
  for (let i = n - 1; i >= 0; i--) {
    const h = oldBlocks[oStart + i].hash;
    for (let j = m - 1; j >= 0; j--) {
      table[i * width + j] = h === segs[nStart + j].hash
        ? table[(i + 1) * width + j + 1] + 1
        : Math.max(table[(i + 1) * width + j], table[i * width + j + 1]);
    }
  }
  const anchors = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (oldBlocks[oStart + i].hash === segs[nStart + j].hash) {
      anchors.push([oStart + i, nStart + j]);
      i++;
      j++;
    } else if (table[(i + 1) * width + j] >= table[i * width + j + 1]) i++;
    else j++;
  }
  return anchors;
}

function refresh(block, seg) {
  block.start = seg.start;
  block.end = seg.end;
  block.file = seg.file ?? null;
  block.sourceStart = seg.sourceStart ?? null;
  block.sourceEnd = seg.sourceEnd ?? null;
  block.sourceParts = seg.sourceParts ?? null;
  block.includeStart = !!seg.includeStart;
  block.includeEnd = !!seg.includeEnd;
  block.subfileStart = !!seg.subfileStart;
  block.subfileEnd = !!seg.subfileEnd;
  block.importDir = seg.importDir ?? null;
  block.externalGraphics = !!seg.externalGraphics;
  block.structuralSinks = seg.structuralSinks ?? [];
  return block;
}

function stripComment(line) {
  for (let i = 0; i < line.length; i++) {
    if (line[i] === '%' && (i === 0 || line[i - 1] !== '\\')) {
      return line.slice(0, i);
    }
  }
  return line;
}

function countMatches(s, re) {
  const m = s.match(re);
  return m ? m.length : 0;
}

function hasControlSymbol(s, symbol) {
  for (let i = 0; i < s.length; i++) {
    if (s[i] !== symbol) continue;
    let slashes = 0;
    for (let j = i - 1; j >= 0 && s[j] === '\\'; j--) slashes++;
    if (slashes % 2 === 1) return true;
  }
  return false;
}

function braceDelta(s) {
  let d = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c !== '{' && c !== '}') continue;
    // \{ is a printed brace, \\} is a line break followed by a real one:
    // only an odd run of backslashes escapes it. A table-like argument that
    // ends in `\\}` left the depth open, and everything up to the end of
    // the document (44 pages of a book) became one block.
    let slashes = 0;
    for (let j = i - 1; j >= 0 && s[j] === '\\'; j--) slashes++;
    if (slashes % 2 === 0) d += c === '{' ? 1 : -1;
  }
  return d;
}
