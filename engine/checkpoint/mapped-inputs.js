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
  const expand = (source, file, start, end, depth, structuralEvents = []) => {
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
    for (const seg of local) {
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
      literal(seg.start);
      expand(text, resolved.actualPath, 0, text.length, depth + 1);
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
  return segmentBody(text, 0, { structuralEvents: events }).flatMap(seg => {
    const parts = pieces.filter(piece => piece.file && piece.at < seg.end && piece.at + piece.text.length > seg.start)
      .map(piece => {
        const from = Math.max(seg.start, piece.at);
        const to = Math.min(seg.end, piece.at + piece.text.length);
        const start = piece.start + from - piece.at;
        const end = piece.start + to - piece.at;
        return { file: piece.file, at: from - seg.start, to: to - seg.start, start, end,
          sourceStart: offsetPosition(piece.source, start), sourceEnd: offsetPosition(piece.source, end) };
      });
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

function offsetPosition(text, offset) {
  const prefix = text.slice(0, offset);
  const last = prefix.lastIndexOf('\n');
  return { line: prefix.split('\n').length, column: offset - last };
}
