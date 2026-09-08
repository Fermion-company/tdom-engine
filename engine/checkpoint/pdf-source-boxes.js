import path from 'node:path';

// SyncTeX's `view` command omits void hboxes, including an empty fraction
// branch. Read those boxes from the same immutable generation as the PDF.
// Support only the unscaled v1 format emitted by our LuaLaTeX invocation;
// unfamiliar units, nesting or post-processing must not invent coordinates.
export function parseSyncTeXSourceBoxes(text, { file, page, startLine, endLine }) {
  const lines = String(text).split(/\r?\n/);
  const header = new Map(), inputs = new Map();
  for (const line of lines) {
    const input = /^Input:(\d+):(.+)$/.exec(line);
    if (input) inputs.set(Number(input[1]), path.resolve(input[2]));
    const setting = /^(SyncTeX Version|Magnification|Unit|X Offset|Y Offset):(.+)$/.exec(line);
    if (setting) header.set(setting[1], Number(setting[2]));
  }
  if (header.get('SyncTeX Version') !== 1 || header.get('Magnification') !== 1000 ||
      header.get('Unit') !== 1 || header.get('X Offset') !== 0 || header.get('Y Offset') !== 0) return null;
  const post = lines.indexOf('Post scriptum:');
  if (post >= 0 && lines.slice(post + 1).some(line => line.trim())) return null;
  const source = path.resolve(file), boxes = [], stack = [];
  const scale = 72 / 72.27 / 65536;
  let currentPage = null, sequence = 0, foundPage = false;
  for (const line of lines) {
    const opening = /^\{(\d+)$/.exec(line);
    if (opening) {
      if (currentPage != null) return null;
      currentPage = Number(opening[1]);
      if (currentPage === page) {
        if (foundPage) return null;
        foundPage = true;
      }
      stack.length = 0; continue;
    }
    const closing = /^\}(\d+)?$/.exec(line);
    if (closing) {
      if (currentPage == null || closing[1] != null && Number(closing[1]) !== currentPage) return null;
      if (currentPage === page && stack.length) return null;
      currentPage = null; continue;
    }
    if (currentPage !== page) continue;
    if (line === ')' || line === ']') {
      const parent = stack.pop();
      if (!parent || parent.kind !== (line === ')' ? 'hbox' : 'vbox')) return null;
      continue;
    }
    if (/^[<>f]/.test(line)) return null; // transformed/reused forms need their own proof
    if (!/^[\[(hv]/.test(line)) continue;
    const node = /^([\[(hv])(\d+),(\d+)(?:,(-?\d+))?:(-?\d+),(-?\d+):(-?\d+),(-?\d+),(-?\d+)$/.exec(line);
    if (!node) return null;
    const [, type, tag, sourceLine, , rawX, rawY, rawWidth, rawHeight, rawDepth] = node;
    const kind = type === '(' || type === 'h' ? 'hbox' : 'vbox';
    const parent = stack.at(-1), id = ++sequence;
    if (kind === 'hbox' && parent) parent.hboxChildren++;
    const x = Number(rawX) * scale, y = Number(rawY) * scale;
    const width = Number(rawWidth) * scale, height = Number(rawHeight) * scale, depth = Number(rawDepth) * scale;
    if (kind === 'hbox' && inputs.get(Number(tag)) === source &&
        Number(sourceLine) >= startLine && Number(sourceLine) <= endLine && width >= 0) {
      boxes.push({ id, parentId: parent?.id ?? null, parentKind: parent?.kind ?? null, parent,
        ancestors: stack.map(frame => frame.id),
        empty: type === 'h', page, line: Number(sourceLine), x, y,
        box: { left: x, right: x + width, top: y - height, bottom: y + depth } });
      if (boxes.length > 4096) return null;
    }
    if (type === '(' || type === '[') {
      if (stack.length >= 128) return null;
      stack.push({ id, kind, hboxChildren: 0 });
    }
  }
  if (currentPage != null || stack.length) return null;
  return boxes.map(({ parent, ...box }) => ({ ...box, parentChildCount: parent?.hboxChildren ?? 0 }));
}
