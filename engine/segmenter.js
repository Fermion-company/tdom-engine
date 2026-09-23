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
  /^\s*\\(?:(?:maketitle|tableofcontents|listoffigures|listoftables)\s*|(?:input|include|bibliography)\s*\{[^}]+\}\s*|printbibliography\s*(?:\[[^\]]*\])?\s*)$/;

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

export function segmentBody(text, baseOffset, { structuralEvents = [], literalEnvs = null } = {}) {
  const segs = [];
  const lines = splitLines(text);
  const aliasEvents = [...structuralEvents].sort((a, b) => a.at - b.at);
  let aliasEventIndex = 0;
  let envDepth = 0;
  let braceDepth = 0;
  let inDisplay = false;
  let inVerbatim = null; // env name while inside a literal environment
  let inAlltt = false; // commands/braces execute; unlike normal TeX, % is data
  let cur = null; // { start, end }
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
        });
      }
      cur = null;
      curStructuralSinks = new Set();
    }
  };

  for (const ln of lines) {
    if (inVerbatim) {
      // literal content: no comment stripping, no depth tracking, no
      // blank-line flush (blank lines inside a listing stay in the block)
      if (cur === null) cur = { start: ln.start };
      if (ln.text.includes(`\\end{${inVerbatim}}`)) inVerbatim = null;
      continue;
    }
    // Neutralize inline \verb before comments: its delimiter may contain a
    // literal `%`, which must not hide executable text later on the line.
    let stripped = ln.text.replace(
      /\\verb\*?([^A-Za-z\s])(.*?)\1/g,
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
    if (cur === null && !blank) cur = { start: ln.start };
    if (atTop && STANDALONE_LINE.test(stripped)) {
      // close the standalone command's block right after its line; the next
      // non-blank line starts a fresh block even without a blank line
      flush(ln.end);
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

  for (const s of segs) s.hash = fnv1a(s.text);
  return segs;
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
export function documentBounds(text) {
  if (boundsMemo.text !== text) boundsMemo = { text, value: scanDocumentBounds(text) };
  const { preamble, body, hasBegin, literalEnvs } = boundsMemo.value;
  return { preamble: { ...preamble }, body: { ...body }, hasBegin, literalEnvs };
}

function scanDocumentBounds(text) {
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
  // Middle: pair positionally.
  const midOld = so - p;
  const midNew = sn - p;
  const shared = Math.min(midOld, midNew);
  for (let i = 0; i < shared; i++) {
    const ob = oldBlocks[p + i];
    const sg = segs[p + i];
    if (ob.hash === sg.hash) {
      blocks.push(refresh(ob, sg));
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
        previousGalley: ob.galley,
        galleyHash: ob.galleyHash,
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
    const sg = segs[p + i];
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
      externalGraphics: !!sg.externalGraphics,
      structuralSinks: sg.structuralSinks ?? [],
      sourceChanged: true,
    });
    dirty.add(id);
    added.push(id);
  }
  for (let i = shared; i < midOld; i++) removed.push(oldBlocks[p + i].id);
  // Common suffix.
  for (let i = 0; i < nNew - sn; i++) {
    blocks.push(refresh(oldBlocks[so + i], segs[sn + i]));
  }

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
    bounds: { prefixLen: p, oldSuffixStart: so, newSuffixStart: sn },
  };
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
  block.externalGraphics = !!seg.externalGraphics;
  block.structuralSinks = seg.structuralSinks ?? [];
  return block;
}

function splitLines(text) {
  const out = [];
  let start = 0;
  for (let i = 0; i <= text.length; i++) {
    if (i === text.length || text[i] === '\n') {
      out.push({ start, end: i, text: text.slice(start, i) });
      start = i + 1;
    }
  }
  return out;
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
    if ((c === '{' || c === '}') && (i === 0 || s[i - 1] !== '\\')) {
      d += c === '{' ? 1 : -1;
    }
  }
  return d;
}
