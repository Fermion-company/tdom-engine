import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { segmentBody } from '../segmenter.js';
import { fnv1a } from '../hash.js';
import { resolveProjectInput } from '../project-inputs.js';

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
    const local = segmentBody(source.slice(start, end), start, { structuralEvents });
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
    for (let segmentIndex = 0; segmentIndex < local.length; segmentIndex++) {
      const seg = local[segmentIndex];
      const match = seg.text.match(/^\s*\\input\s*\{([^}]+)\}\s*$/);
      if (!match || depth >= 4) continue;
      const resolved = resolveProjectInput(match[1], {
        docDir: context.docDir ?? context.workDir,
        overlayDir: context.overlayDir,
        baseDir: path.dirname(file),
        extensions: ['.tex'],
      });
      if (!resolved) continue;
      let text;
      try {
        const stat = statSync(resolved.readPath);
        text = readFileSync(resolved.readPath, 'utf8');
        context.includes.set(resolved.actualPath, { mtime: stat.mtimeMs, readPath: resolved.readPath, text });
        context.watchInclude(resolved.readPath);
      } catch { continue; }
      const rootUnit = depth === 0 ? segmentIndex + 1 : inheritedRootUnit;
      context.includeTrace?.push({
        actualPath: resolved.actualPath,
        readPath: resolved.readPath,
        command: 'input',
        raw: match[1],
        depth,
        parentFile: file,
        rootUnit,
      });
      literal(seg.start);
      expand(text, resolved.actualPath, 0, text.length, depth + 1, [], rootUnit);
      // EOF supplies an endline even when the file has no final newline.
      // Consume the input command's own endline with a comment: inserting
      // an empty physical line here would manufacture a \par at every EOF.
      if (!text.endsWith('\n')) append('\n', null);
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
  return segmentBody(text, 0, { structuralEvents: events }).flatMap(seg => {
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
    if (!first) return [];
    const single = parts.length === 1 && first.at === 0 && first.to === seg.text.length;
    const rootOnly = single && first.file === root;
    return { ...seg, start: first.start, end: first.end,
      file: rootOnly ? undefined : first.file,
      sourceStart: rootOnly ? undefined : first.sourceStart,
      sourceEnd: rootOnly ? undefined : first.sourceEnd,
      sourceParts: single ? undefined : parts,
      resourceBaseDir: path.dirname(first.file),
      hash: fnv1a(`${seg.hash}|${parts.map(part => part.file).join('|')}`) };
  });
}

function offsetPosition(text, offset, indexes) {
  let starts = indexes.get(text);
  if (!starts) {
    starts = [0];
    for (let at = text.indexOf('\n'); at >= 0; at = text.indexOf('\n', at + 1)) starts.push(at + 1);
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
