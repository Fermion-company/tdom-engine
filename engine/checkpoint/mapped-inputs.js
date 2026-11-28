import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { segmentBody } from '../segmenter.js';
import { fnv1a } from '../hash.js';
import { resolveProjectInput } from '../project-inputs.js';
import { cacheIncludeRead, includeTextCurrent } from './include-cache.js';
import { documentBodyRange, subfileGroupOpen, subfileGroupClose } from './subfile.js';

const joinedSegmentMemos = new WeakMap(); // include cache -> file -> segmentBody memo of its joined text
// This runs for every file of the project on every keystroke, and most of
// what it computes is the same as the keystroke before: the line starts of
// files that did not change, whether a file reads others, a segment's
// identity from its own hash and its files (2.7 ms of each keystroke on a
// 72-page book of ten chapter files, a third of it those three). Kept by
// value, bounded.
const lineStartsMemo = new Map(); // file text -> its line starts
const readsOthersMemo = new Map(); // file text -> first \input and \subfile in it
const segmentHashMemo = new Map(); // `${seg.hash}|${files}` -> hash
const bounded = (memo, limit) => { if (memo.size > limit) memo.clear(); return memo; };

// An input is token substitution, not a paragraph boundary. Segment the
// substituted body and keep a source map for regions crossing file edges.
export function expandInputParagraphs(segs, context) {
  if (!segs.length || typeof context.source !== 'string') return segs;
  const root = path.resolve(context.docDir ?? context.workDir, context.file);
  const pieces = [];
  const events = [];
  let length = 0;
  let expanded = false;
  const append = (text, file, start, source) => {
    if (!text) return;
    pieces.push({ text, file, start, source, at: length });
    length += text.length;
  };
  const expand = (source, file, start, end, depth, structuralEvents = [], inheritedRootUnit = null) => {
    let cursor = start;
    const literal = stop => {
      const base = length;
      append(source.slice(cursor, stop), file, cursor, source);
      for (const event of structuralEvents) {
        const at = start + event.at;
        if (at >= cursor && at < stop) events.push({ ...event, at: base + at - cursor });
      }
      cursor = stop;
    };
    // Segmenting a file only finds its \input lines: a file without one (every
    // chapter of the 316-page book) is taken literally. This runs for every
    // file on every keystroke (tex64-internal #85).
    const firstOf = (needle) => { const at = source.indexOf(needle, start); return at < 0 || at >= end ? -1 : at; };
    let nested;
    if (start === 0 && end === source.length) {
      let held = readsOthersMemo.get(source);
      if (held === undefined) bounded(readsOthersMemo, 128).set(source, held = Math.max(firstOf('\\input'), firstOf('\\subfile')));
      nested = held;
    } else nested = Math.max(firstOf('\\input'), firstOf('\\subfile'));
    if (depth >= 4 || nested < 0) {
      literal(end);
      return;
    }
    const local = segmentBody(source.slice(start, end), start, { structuralEvents, literalEnvs: context.literalEnvs });
    for (let segmentIndex = 0; segmentIndex < local.length; segmentIndex++) {
      const seg = local[segmentIndex];
      const match = seg.text.match(/^\s*\\(input|subfile)\s*\{([^}]+)\}\s*$/);
      if (!match || depth >= 4) continue;
      const subfile = match[1] === 'subfile';
      const resolved = resolveProjectInput(match[2], {
        docDir: context.docDir ?? context.workDir,
        overlayDir: context.overlayDir,
        sourceDir: context.sourceDir,
        baseDir: path.dirname(file),
        extensions: ['.tex'],
        onMissing: context.watchInclude,
      });
      if (!resolved) continue;
      let text;
      try {
        const stat = statSync(resolved.readPath);
        // unchanged since the last expansion: the bytes read then (same rule
        // as include-expander's expandTextFile)
        const cached = context.includes.get(resolved.actualPath);
        text = includeTextCurrent(cached, stat, resolved.readPath, resolved.overlay)
          ? cached.text
          : readFileSync(resolved.readPath, 'utf8');
        cacheIncludeRead(context.includes, resolved.actualPath,
          { mtime: stat.mtimeMs, size: stat.size, readPath: resolved.readPath, text });
        context.watchInclude(resolved.readPath);
      } catch { continue; }
      const rootUnit = depth === 0 ? segmentIndex + 1 : inheritedRootUnit;
      context.includeTrace?.push({
        actualPath: resolved.actualPath,
        readPath: resolved.readPath,
        command: match[1],
        raw: match[2],
        depth,
        parentFile: file,
        rootUnit,
      });
      literal(seg.start);
      if (subfile) {
        // subfiles.sty: only the chapter's document body, in a group, with
        // the chapter's folder on the input paths. The group and the paths
        // are engine text (no source file); the body keeps its own offsets.
        const range = documentBodyRange(text) ?? { start: 0, end: text.length };
        let from = range.start, to = range.end;
        while (from < to && /\s/.test(text[from])) from++;
        while (to > from && /\s/.test(text[to - 1])) to--;
        append(subfileGroupOpen(path.dirname(resolved.actualPath) + path.sep) + '%\n', null);
        expand(text, resolved.actualPath, from, to, depth + 1, [], rootUnit);
        append('\n' + subfileGroupClose() + '%\n', null);
      } else {
        expand(text, resolved.actualPath, 0, text.length, depth + 1, [], rootUnit);
      }
      // EOF supplies an endline even when the file has no final newline.
      // Consume the input command's own endline with a comment: inserting
      // an empty physical line here would manufacture a \par at every EOF.
      if (!subfile && !text.endsWith('\n')) append('\n', null);
      append('% tdom input boundary\n', null);
      cursor = seg.end + (source[seg.end] === '\n' ? 1 : 0);
      expanded = true;
    }
    literal(end);
  };
  expand(context.source, root, segs[0].start, segs.at(-1).end, 0, context.structuralEvents ?? []);
  if (!expanded) return segs;
  const text = pieces.map(piece => piece.text).join('');
  const lineIndexes = new Map();
  let firstPiece = 0;
  // Engine text with no source file (a \subfile's group lines) must never be
  // dropped with a segment of its own: an opened group would stay open. It
  // joins the segment before it, or waits for the next one.
  let carry = '';
  const mapped = [];
  // The joined text of a book is megabytes and changes by a keystroke: one
  // memo per file that joins others (the root, a chapter that reads its
  // sections), kept with the project's include cache, scans only around it.
  let memo = null;
  if (context.includes) {
    const memos = joinedSegmentMemos.get(context.includes) ?? joinedSegmentMemos.set(context.includes, new Map()).get(context.includes);
    memo = memos.get(root) ?? memos.set(root, {}).get(root);
  }
  for (const seg of segmentBody(text, 0, { structuralEvents: events, literalEnvs: context.literalEnvs, memo })) {
    const out = mapSegment(seg);
    if (out) {
      if (carry) {
        const shift = carry.length;
        out.text = carry + out.text;
        out.sourceParts = (out.sourceParts ?? [{ file: out.file ?? root, at: 0, to: out.text.length - shift,
          start: out.start, end: out.end, sourceStart: out.sourceStart, sourceEnd: out.sourceEnd }])
          .map(part => ({ ...part, at: part.at + shift, to: part.to + shift }));
        out.hash = fnv1a(`${out.hash}|${carry}`);
        carry = '';
      }
      mapped.push(out);
    } else if (/[^\s%]/.test(seg.text.replace(/^\s*%.*$/gm, ''))) {
      const previous = mapped.at(-1);
      if (previous) {
        previous.text += (previous.text.endsWith('\n') ? '' : '\n') + seg.text;
        previous.sourceParts ??= [{ file: previous.file ?? root, at: 0, to: previous.text.length,
          start: previous.start, end: previous.end, sourceStart: previous.sourceStart, sourceEnd: previous.sourceEnd }];
        previous.hash = fnv1a(`${previous.hash}|${seg.text}`);
      } else carry += seg.text + (seg.text.endsWith('\n') ? '' : '\n');
    }
  }
  return mapped;
  function mapSegment(seg) {
    while (firstPiece < pieces.length && pieces[firstPiece].at + pieces[firstPiece].text.length <= seg.start) firstPiece++;
    const parts = [];
    for (let index = firstPiece; index < pieces.length && pieces[index].at < seg.end; index++) {
      const piece = pieces[index];
      if (!piece.file) continue;
      const from = Math.max(seg.start, piece.at);
      const to = Math.min(seg.end, piece.at + piece.text.length);
      const start = piece.start + from - piece.at;
      const end = piece.start + to - piece.at;
      parts.push({ file: piece.file, at: from - seg.start, to: to - seg.start, start, end,
        sourceStart: offsetPosition(piece.source, start, lineIndexes),
        sourceEnd: offsetPosition(piece.source, end, lineIndexes) });
    }
    const first = parts[0];
    if (!first) return null;
    const single = parts.length === 1 && first.at === 0 && first.to === seg.text.length;
    const rootOnly = single && first.file === root;
    return { ...seg, start: first.start, end: first.end,
      file: rootOnly ? undefined : first.file,
      sourceStart: rootOnly ? undefined : first.sourceStart,
      sourceEnd: rootOnly ? undefined : first.sourceEnd,
      sourceParts: single ? undefined : parts,
      resourceBaseDir: path.dirname(first.file),
      hash: segmentHash(`${seg.hash}|${parts.map(part => part.file).join('|')}`) };
  }
}

function segmentHash(key) {
  let hash = segmentHashMemo.get(key);
  if (hash === undefined) bounded(segmentHashMemo, 16384).set(key, hash = fnv1a(key));
  return hash;
}

function offsetPosition(text, offset, indexes) {
  let starts = indexes.get(text);
  if (!starts) {
    starts = lineStartsMemo.get(text);
    if (!starts) {
      starts = [0];
      for (let at = text.indexOf('\n'); at >= 0; at = text.indexOf('\n', at + 1)) starts.push(at + 1);
      bounded(lineStartsMemo, 128).set(text, starts);
    }
    indexes.set(text, starts);
  }
  let lo = 0, hi = starts.length;
  while (lo + 1 < hi) {
    const mid = (lo + hi) >>> 1;
    if (starts[mid] <= offset) lo = mid;
    else hi = mid;
  }
  return { line: lo + 1, column: offset - starts[lo] + 1 };
}
