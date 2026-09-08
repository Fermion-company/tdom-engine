(function (root) {
  const key = (s) => String(s ?? '').normalize('NFKC').replace(/\s/gu, '');
  const center = (b) => ({ x: (b.left + b.right) / 2, y: (b.top + b.bottom) / 2 });
  const union = (boxes) => boxes.length ? ({
    left: Math.min(...boxes.map(b => b.left)), right: Math.max(...boxes.map(b => b.right)),
    top: Math.min(...boxes.map(b => b.top)), bottom: Math.max(...boxes.map(b => b.bottom)),
  }) : null;
  function textMap(value, words, glyphs) {
    const chars = [];
    let at = 0;
    for (const char of String(value)) {
      for (const folded of key(char)) chars.push({ char: folded, start: at, end: at + char.length });
      at += char.length;
    }
    const source = chars.map(c => c.char).join('');
    const result = [];
    let cursor = 0;
    for (const word of words ?? []) {
      const token = key(word.text);
      const start = source.indexOf(token, cursor);
      if (start < 0) return [];
      const candidates = glyphs.filter(g => {
        const c = center(g);
        return c.x >= word.left - 0.5 && c.x <= word.right + 0.5 &&
          g.baseline >= word.top - 0.5 && g.baseline <= word.bottom + 1;
      }).sort((a, b) => a.left - b.left);
      if (candidates.map(g => key(g.text)).join('') !== token) return [];
      // String search offsets count UTF-16 code units, while chars contains
      // Unicode code points. Preserve the original UTF-16 caret boundaries.
      let index = [...source.slice(0, start)].length;
      for (const glyph of candidates) {
        const length = [...key(glyph.text)].length;
        // A ligature is one painted glyph. Its interior caret stops share
        // its advance; ordinary proportional letters each use their own.
        for (let part = 0; part < length; part++) {
          result.push({ ...glyph, top: word.top, bottom: word.bottom,
            left: glyph.left + (glyph.right - glyph.left) * part / length,
            right: glyph.left + (glyph.right - glyph.left) * (part + 1) / length,
            start: chars[index]?.start, end: chars[index]?.end });
          index++;
        }
      }
      cursor = start + token.length;
    }
    return cursor === source.length ? result : [];
  }
  function nearest(map, point) {
    return map.map(g => {
      const dx = Math.max(g.left - point.x, 0, point.x - g.right);
      const dy = Math.max(g.top - point.y, 0, point.y - g.bottom);
      const c = center(g);
      return { glyph: g, score: dx * dx + dy * dy * 4 + Math.abs(c.y - point.y) * 0.01 };
    }).sort((a, b) => a.score - b.score)[0]?.glyph ?? null;
  }
  function textMatches(value, glyphs, maxCandidates = Infinity) {
    const source = [], painted = [];
    let offset = 0;
    for (const char of String(value)) {
      for (const token of key(char)) source.push({ token, start: offset, end: offset + char.length });
      offset += char.length;
    }
    for (const glyph of glyphs) {
      const tokens = [...key(glyph.text)];
      for (let i = 0; i < tokens.length; i++) painted.push({ token: tokens[i], glyph: {
        ...glyph, left: glyph.left + (glyph.right - glyph.left) * i / tokens.length,
        right: glyph.left + (glyph.right - glyph.left) * (i + 1) / tokens.length,
      } });
    }
    const needle = source.map(c => c.token).join(''), text = painted.map(c => c.token).join('');
    if (!needle) return [];
    const matches = [];
    for (let at = text.indexOf(needle); at >= 0; at = text.indexOf(needle, at + 1)) {
      // Tokens can be non-BMP; offsets into the normalized string must be
      // converted back to token indices before indexing the painted list.
      const start = [...text.slice(0, at)].length;
      const map = source.map((c, i) => ({ ...painted[start + i].glyph, start: c.start, end: c.end }));
      matches.push({ map, cost: 0, start, end: start + source.length });
      if (matches.length > maxCandidates) return null;
    }
    return matches;
  }
  function textMapFromGlyphs(value, glyphs, near = null) {
    const matches = textMatches(value, glyphs).map(match => match.map);
    if (!near || matches.length < 2) return matches[0] ?? [];
    const p = center(near);
    return matches.sort((a, b) => {
      const x = center(union(a)), y = center(union(b));
      return (x.x-p.x)**2+(x.y-p.y)**2-((y.x-p.x)**2+(y.y-p.y)**2);
    })[0] ?? [];
  }
  function textMaps(value, glyphs) {
    if (String(value).length > 4096 || glyphs.length > 4096) return [];
    return distinctOccurrences(textMatches(value, glyphs, 256));
  }
  function hit(map, point) {
    const glyph = nearest(map, point);
    if (!glyph) return null;
    return point.x < (glyph.left + glyph.right) / 2 ? glyph.start : glyph.end;
  }
  function caret(map, offset) {
    // Prefer the following glyph for text at a wrap, then the preceding
    // glyph for an end-of-branch boundary in a structured formula.
    const after = map.find(g => g.start === offset);
    if (after) return { ...after, x: after.left };
    const before = map.findLast(g => g.end === offset);
    if (before) return { ...before, x: before.right };
    const next = map.find(g => g.start > offset);
    const previous = map.findLast(g => g.end < offset);
    return previous ? { ...previous, x: previous.right } : next ? { ...next, x: next.left } : null;
  }
  const modelSnapshot = Symbol('modelSnapshot');
  function mathModelSnapshot(field) {
    if (field[modelSnapshot]) return field;
    // One synchronous operation owns this snapshot. Do not retain model or
    // DOM metadata across input, Undo, layout, or a PDF generation change.
    const metadata = field.getModelMetadata?.();
    const infos = new Map();
    return {
      [modelSnapshot]: true, lastOffset: Number(field.lastOffset),
      structures: new WeakMap(), branches: new Map(), sourceGroups: new WeakMap(),
      getElementInfo(offset) {
        if (metadata) return metadata[offset];
        // Older embedded MathLive bundles still read each offset at most once.
        if (!infos.has(offset)) infos.set(offset, field.getElementInfo(offset));
        return infos.get(offset);
      },
    };
  }
  function mathLayoutSnapshot(field) {
    const infos = new Map();
    return {
      lastOffset: Number(field.lastOffset),
      getElementInfo(offset) {
        if (!infos.has(offset)) infos.set(offset, field.getElementInfo(offset));
        return infos.get(offset);
      },
    };
  }
  function mathStructure(field, map) {
    if (!field.structures.has(map)) field.structures.set(map, {
      mappedOffsets: new Set(map.flatMap(g => [g.start, g.end])),
      glyphBranches: new Map(), arrayLayouts: new Map(), carets: new Map(),
    });
    return field.structures.get(map);
  }
  function glyphBranches(field, map, offset) {
    const cache = mathStructure(field, map).glyphBranches;
    if (!cache.has(offset)) cache.set(offset, map.map(glyph => ({
      glyph, branch: branchAtAncestor(field, glyph, offset),
    })));
    return cache.get(offset);
  }
  function sourceBoxGroups(field, sourceBoxes, count, requireId = false) {
    if (!field.sourceGroups.has(sourceBoxes)) field.sourceGroups.set(sourceBoxes, new Map());
    const cache = field.sourceGroups.get(sourceBoxes), key = `${count}:${requireId}`;
    if (!cache.has(key)) {
      const groups = new Map();
      for (const box of sourceBoxes) {
        if (box.parentKind !== 'vbox' || box.parentChildCount !== count ||
            requireId && !Number.isInteger(box.parentId)) continue;
        if (!groups.has(box.parentId)) groups.set(box.parentId, []);
        groups.get(box.parentId).push(box);
      }
      cache.set(key, [...groups.values()].map(group => group.sort((a, b) => a.y - b.y)));
    }
    return cache.get(key);
  }
  function mathCaret(field, map, offset, bounds, sourceBoxes = []) {
    const mapped = field[modelSnapshot] ? mathStructure(field, map).mappedOffsets.has(offset)
      : map.some(glyph => glyph.start === offset || glyph.end === offset);
    if (mapped) return caret(map, offset);
    field = mathModelSnapshot(field);
    const cache = mathStructure(field, map).carets, previous = cache.get(offset);
    if (previous && previous.bounds === bounds && previous.sourceBoxes === sourceBoxes) return previous.box;
    const box = mathCaretInSnapshot(field, map, offset, bounds, sourceBoxes);
    cache.set(offset, { bounds, sourceBoxes, box });
    return box;
  }
  function mathCaretInSnapshot(field, map, offset, bounds, sourceBoxes) {
    const info = field.getElementInfo(offset);
    if (info?.type === 'array') return arrayBoundaryCaret(field, map, offset, info, sourceBoxes);
    if (info?.type === 'genfrac') return fractionBoundaryCaret(field, map, offset, sourceBoxes);
    // An unpainted structural offset is not the preceding leaf's insertion
    // point: after a matrix/fraction must never look like its final cell.
    if (info?.type !== 'first' && !virtualPlaceholder(info)) return null;
    const branch = info?.parentBranch;
    const parent = Number.isInteger(info?.parentOffset) ? field.getElementInfo(info.parentOffset) : null;
    if (parent?.type === 'genfrac' && ['above', 'below'].includes(branch)) {
      return emptyFractionCaret(field, map, offset, info, sourceBoxes);
    }
    if (!Array.isArray(branch) || !parent?.array || !bounds?.sourceRows?.length) return null;
    const [row, column] = branch;
    const { rows, columns, alignments } = parent.array;
    if (!Number.isInteger(row) || !Number.isInteger(column) || row < 0 || row >= rows ||
        column < 0 || column >= columns || rows > 512) return null;

    // Empty cells paint no PDF glyph. Pair the model's real row/column with
    // SyncTeX row baselines, certified against every occupied simple cell.
    // Browser row spacing and placeholder width are never copied to paper.
    const layouts = mathStructure(field, map).arrayLayouts;
    let layout = layouts.get(info.parentOffset);
    if (!layout || layout.bounds !== bounds) {
      const cells = new Map();
      for (const { glyph, branch } of glyphBranches(field, map, info.parentOffset)) {
        if (!Array.isArray(branch)) continue;
        const [r, c] = branch;
        const key = `${r}:${c}`;
        if (!cells.has(key)) cells.set(key, { row: r, column: c, glyphs: [] });
        cells.get(key).glyphs.push(glyph);
      }
      const groups = new Map();
      for (const box of bounds.sourceRows) {
        if (!['left', 'right', 'top', 'bottom', 'baseline'].every(key => Number.isFinite(box[key]))) continue;
        const key = `${box.left.toFixed(3)}:${box.right.toFixed(3)}`;
        if (!groups.has(key)) groups.set(key, new Map());
        groups.get(key).set(box.baseline.toFixed(3), box);
      }
      const matches = [...groups.values()].map(group => [...group.values()].sort((a, b) => a.baseline - b.baseline))
        .filter(group => group.length === rows && [...cells.values()].every(cell =>
          group[cell.row] && cell.glyphs.every(glyph => Number.isFinite(glyph.baseline) &&
            Math.abs(glyph.baseline - group[cell.row].baseline) <= 0.1)));
      const reference = [...cells.values()].flatMap(cell => cell.glyphs);
      const ascent = reference.map(glyph => glyph.baseline - glyph.top).sort((a, b) => a - b);
      const descent = reference.map(glyph => glyph.bottom - glyph.baseline).sort((a, b) => a - b);
      layout = { bounds, cells, matches, ascent, descent };
      layouts.set(info.parentOffset, layout);
    }
    const { cells, matches, ascent, descent } = layout;
    if (!cells.size || matches.length !== 1) return null;
    const alignment = alignments?.[column % alignments.length];
    if (!['l', 'c', 'r'].includes(alignment)) return null;
    const columnBoxes = [...cells.values()].filter(cell => cell.column === column).map(cell => union(cell.glyphs));
    if (!columnBoxes.length) return null;
    const positions = columnBoxes.map(box => alignment === 'l' ? box.left : alignment === 'r' ? box.right : center(box).x);
    // All occupied cells must agree on the same physical column alignment.
    // A script/fraction with an unmeasured extent cannot establish this stop.
    if (Math.max(...positions) - Math.min(...positions) > 0.25) return null;
    const x = positions.reduce((sum, value) => sum + value, 0) / positions.length;
    const baseline = matches[0][row].baseline;
    const top = Math.max(matches[0][row].top, baseline - ascent[Math.floor(ascent.length / 2)]);
    const bottom = Math.min(matches[0][row].bottom, baseline + descent[Math.floor(descent.length / 2)]);
    if (!(bottom > top)) return null;
    return { x, left: x, right: x, top, bottom, baseline, start: offset, end: offset };
  }
  function mathHit(field, map, point, bounds, sourceBoxes = []) {
    const last = Number(field.lastOffset);
    if (!Number.isInteger(last) || last < 1 || last > 512) return hit(map, point);
    field = mathModelSnapshot(field);
    const mappedOffsets = mathStructure(field, map).mappedOffsets;
    // Empty branches have no glyph to hit. Include only boundaries whose
    // real TeX boxes also prove their painted caret, never browser offsets.
    const empty = [];
    for (let offset = 0; offset <= last; offset++) {
      if (mappedOffsets.has(offset)) continue;
      const info = field.getElementInfo(offset);
      if (info?.type !== 'first') continue;
      const box = mathCaret(field, map, offset, bounds, sourceBoxes);
      if (box) empty.push(box);
    }
    return hit([...map, ...empty], point);
  }
  function branchAtAncestor(field, glyph, offset) {
    const key = `${glyph.end}:${offset}`;
    if (field.branches.has(key)) return field.branches.get(key);
    let atom = field.getElementInfo(glyph.end);
    const seen = new Set();
    while (atom && atom.parentOffset !== offset && Number.isInteger(atom.parentOffset) &&
        !seen.has(atom.parentOffset) && seen.size < 32) {
      seen.add(atom.parentOffset);
      atom = field.getElementInfo(atom.parentOffset);
    }
    const branch = atom?.parentOffset === offset ? atom.parentBranch : null;
    field.branches.set(key, branch);
    return branch;
  }
  function measuredBoxCaret(box, reference, offset) {
    const ascent = reference.map(g => g.baseline - g.top).sort((a, b) => a - b);
    const descent = reference.map(g => g.bottom - g.baseline).sort((a, b) => a - b);
    const x = box.box.right, baseline = box.y;
    const top = baseline - ascent[Math.floor(ascent.length / 2)];
    const bottom = baseline + descent[Math.floor(descent.length / 2)];
    if (![x, top, bottom].every(Number.isFinite) || !(bottom > top)) return null;
    return { x, left: x, right: x, top, bottom, baseline, start: offset, end: offset };
  }
  function arrayBoundaryCaret(field, map, offset, info, sourceBoxes) {
    const rows = info.array?.rows;
    if (!Number.isInteger(rows) || rows < 1 || rows > 512) return null;
    const reference = [], outside = [];
    for (const { glyph, branch } of glyphBranches(field, map, offset)) {
      if (Array.isArray(branch)) reference.push({ ...glyph, row: branch[0] });
      else outside.push(glyph);
    }
    if (!reference.length) return null;
    const rowGroups = sourceBoxGroups(field, sourceBoxes, rows).filter(group =>
      group.length === rows && group.every(box => Math.abs(box.box.left - group[0].box.left) < 0.01 &&
        Math.abs(box.box.right - group[0].box.right) < 0.01) && reference.every(g => {
        const row = group[g.row];
        return row && Math.abs(g.baseline - row.y) < 0.1 &&
          g.left >= row.box.left - 0.1 && g.right <= row.box.right + 0.1;
      }));
    const deepest = rowGroups.filter(group => !rowGroups.some(other => other !== group &&
      other.every(row => group.some(parent => row.ancestors?.includes(parent.id)))));
    if (deepest.length !== 1) return null;
    return enclosingBoundaryCaret(deepest[0], reference, outside, offset, sourceBoxes);
  }
  function enclosingBoundaryCaret(parts, reference, outside, offset, sourceBoxes) {
    const rowsBox = union(parts.map(part => part.box));
    const candidates = sourceBoxes.filter(box => !box.empty &&
      parts.every(part => part.ancestors?.includes(box.id)) &&
      box.box.left <= rowsBox.left + 0.01 && box.box.right >= rowsBox.right - 0.01 &&
      box.box.top <= rowsBox.top + 0.01 && box.box.bottom >= rowsBox.bottom - 0.01 &&
      !outside.some(g => {
        const point = center(g);
        return point.x > box.box.left && point.x < box.box.right &&
          g.baseline >= box.box.top && g.baseline <= box.box.bottom;
      }));
    // The enclosing natural hbox includes delimiter/kern advances. Branch
    // boxes omit them; a surrounding expression includes outside ink.
    const smallest = candidates.filter(box => !candidates.some(other => other !== box &&
      other.box.left >= box.box.left && other.box.right <= box.box.right &&
      other.box.top >= box.box.top && other.box.bottom <= box.box.bottom &&
      (other.box.left > box.box.left + 0.01 || other.box.right < box.box.right - 0.01 ||
        other.box.top > box.box.top + 0.01 || other.box.bottom < box.box.bottom - 0.01)));
    if (!smallest.length || smallest.some(box => Math.abs(box.box.right - smallest[0].box.right) > 0.01 ||
        Math.abs(box.y - smallest[0].y) > 0.01)) return null;
    return measuredBoxCaret(smallest[0], reference, offset);
  }
  function fractionBoundaryCaret(field, map, offset, sourceBoxes) {
    const above = [], below = [], outside = [];
    for (const { glyph, branch } of glyphBranches(field, map, offset)) {
      if (branch === 'above') above.push(glyph);
      else if (branch === 'below') below.push(glyph);
      else outside.push(glyph);
    }
    const reference = [...above, ...below];
    if (!reference.length) return null;
    const pairs = sourceBoxGroups(field, sourceBoxes, 2).filter(group =>
      group.length === 2 && group[1].y > group[0].y && [above, below].every((branch, index) => {
        const box = group[index];
        return branch.length ? !box.empty && branch.every(g =>
          g.left >= box.box.left - 0.1 && g.right <= box.box.right + 0.1 &&
          g.baseline >= box.box.top - 0.1 && g.baseline <= box.box.bottom + 0.1)
          : box.empty && Math.abs(box.box.bottom - box.box.top) < 0.01;
      }));
    if (pairs.length !== 1) return null;
    return enclosingBoundaryCaret(pairs[0], reference, outside, offset, sourceBoxes);
  }
  function emptyFractionCaret(field, map, offset, info, sourceBoxes) {
    const reference = [];
    for (const { glyph, branch } of glyphBranches(field, map, info.parentOffset)) {
      if (branch === info.parentBranch) return null;
      if (branch === (info.parentBranch === 'above' ? 'below' : 'above')) reference.push(glyph);
    }
    if (!reference.length) return null;
    const matches = [];
    for (const children of sourceBoxGroups(field, sourceBoxes, 2, true)) {
      if (children.length !== 2) continue;
      const ordered = children;
      const empty = ordered[info.parentBranch === 'above' ? 0 : 1];
      const occupied = ordered[info.parentBranch === 'above' ? 1 : 0];
      if (!empty.empty || occupied.empty || !(ordered[1].y > ordered[0].y) ||
          !(empty.box.right > empty.box.left) || Math.abs(empty.box.bottom - empty.box.top) > 0.01 ||
          Math.abs(empty.y - empty.box.top) > 0.01 ||
          Math.abs(empty.box.left - occupied.box.left) > 0.1 ||
          Math.abs(empty.box.right - occupied.box.right) > 0.1) continue;
      // A fraction is a pair of sibling TeX hboxes, including its void
      // branch. Printed atoms prove the occupied sibling; model ancestry
      // selects the opposite one, even for a fraction nested in another.
      if (!reference.every(glyph => Number.isFinite(glyph.baseline) &&
          glyph.left >= occupied.box.left - 0.1 && glyph.right <= occupied.box.right + 0.1 &&
          glyph.baseline >= occupied.box.top - 0.1 && glyph.baseline <= occupied.box.bottom + 0.1)) continue;
      matches.push(empty);
    }
    if (matches.length !== 1) return null;
    const empty = matches[0], x = (empty.box.left + empty.box.right) / 2;
    const ascent = reference.map(g => g.baseline - g.top).sort((a, b) => a - b);
    const descent = reference.map(g => g.bottom - g.baseline).sort((a, b) => a - b);
    const top = empty.y - ascent[Math.floor(ascent.length / 2)];
    const bottom = empty.y + descent[Math.floor(descent.length / 2)];
    if (![x, top, bottom].every(Number.isFinite) || !(bottom > top)) return null;
    return { x, left: x, right: x, top, bottom, baseline: empty.y, start: offset, end: offset };
  }
  function virtualPlaceholder(info) {
    return info?.type === 'placeholder' || info?.command === '\\placeholder' ||
      /^\\placeholder(?:\[|\{|$)/.test(String(info?.latex ?? ''));
  }
  function mathMatches(field, glyphs, bounds, { complete = false, contiguous = false, maxCandidates = Infinity, maxPairings = Infinity } = {}) {
    const atoms = [];
    for (let offset = 1; offset <= Number(field.lastOffset); offset++) {
      const info = field.getElementInfo(offset);
      if (virtualPlaceholder(info)) continue;
      const text = key(info?.symbol);
      const box = info?.glyphBounds ?? info?.bounds;
      if (!text || !box || !Number.isInteger(info.beforeOffset) || box.width <= 0) continue;
      // A named operator (sin, log, lim inf, ...) is one MathLive atom,
      // although a PDF paints its letters separately. Match those letters
      // individually, then reunite their ink under the atom's real pair of
      // cursor boundaries below.
      const tokens = [...text];
      for (let part = 0; part < tokens.length; part++) {
        atoms.push({ text: tokens[part], symbol: text, box: {
          left: box.left + (box.right - box.left) * part / tokens.length,
          right: box.left + (box.right - box.left) * (part + 1) / tokens.length,
          top: box.top, bottom: box.bottom,
        }, start: info.beforeOffset, end: offset });
      }
    }
    const printed = glyphs.flatMap(g => {
      const tokens = [...key(g.text)];
      return tokens.map((text, i) => ({ ...g, text,
        left: g.left + (g.right - g.left) * i / tokens.length,
        right: g.left + (g.right - g.left) * (i + 1) / tokens.length }));
    }).filter(g => {
      const c = center(g);
      return c.x >= bounds.left - 1 && c.x <= bounds.right + 1 &&
        c.y >= bounds.top - 2 && c.y <= bounds.bottom + 2;
    }).map((g, index) => ({ ...g, paintIndex: index }));
    // SyncTeX can return the enclosing paragraph as well as the formula.
    // Find the complete printed symbol multiset inside that region before
    // assigning repeated symbols by their two-dimensional math layout.
    const paintedTokens = new Set(printed.map(g => key(g.text)));
    if (atoms.some(a => (complete || /^[\p{L}\p{N}]+$/u.test(a.text)) && !paintedTokens.has(a.text))) return [];
    const matchedAtoms = atoms.filter(a => paintedTokens.has(a.text));
    const supported = new Set(matchedAtoms.map(a => a.text));
    const available = printed.filter(g => supported.has(key(g.text)));
    const wanted = new Map();
    for (const a of matchedAtoms) wanted.set(a.text, (wanted.get(a.text) ?? 0) + 1);
    const sourceBounds = union(matchedAtoms.map(a => a.box));
    if (!sourceBounds || !matchedAtoms.length) return [];
    const relative = (b, outer) => ({
      x: (center(b).x - outer.left) / Math.max(1, outer.right - outer.left),
      y: (center(b).y - outer.top) / Math.max(1, outer.bottom - outer.top),
    });
    const matches = [];
    const count = matchedAtoms.length;
    let pairings = 0;
    for (let start = 0; start + count <= available.length; start++) {
      const window = available.slice(start, start + count);
      const counts = new Map();
      for (const g of window) counts.set(key(g.text), (counts.get(key(g.text)) ?? 0) + 1);
      if ([...wanted].some(([token, n]) => counts.get(token) !== n)) continue;
      // A wider source envelope must not borrow matching letters across
      // unrelated prose. Structural PDF delimiters can be separate paint,
      // but every intervening letter/digit must belong to the expression.
      if (contiguous && printed.slice(window[0].paintIndex, window.at(-1).paintIndex + 1)
        .some(g => /^[\p{L}\p{N}]+$/u.test(key(g.text)) && !supported.has(key(g.text)))) continue;
      const targetBounds = union(window);
      const result = [];
      let cost = 0;
      for (const token of supported) {
        const aa = matchedAtoms.filter(a => a.text === token);
        const gg = window.filter(g => key(g.text) === token);
        pairings += aa.length * gg.length;
        if (pairings > maxPairings) return null;
        const pairs = aa.flatMap(a => gg.map(g => {
          const p = relative(a.box, sourceBounds), q = relative(g, targetBounds);
          return { a, g, cost: (p.x - q.x) ** 2 + (p.y - q.y) ** 2 };
        })).sort((a, b) => a.cost - b.cost);
        const usedAtoms = new Set(), usedGlyphs = new Set();
        for (const pair of pairs) {
          const { a, g } = pair;
          if (usedAtoms.has(a) || usedGlyphs.has(g)) continue;
          usedAtoms.add(a); usedGlyphs.add(g);
          result.push({ ...g, symbol: a.symbol, start: a.start, end: a.end });
          cost += pair.cost;
        }
      }
      matches.push({ map: mergeMathAtoms(result), cost, start, end: start + count });
      if (matches.length > maxCandidates) return null;
    }
    return matches;
  }
  function mergeMathAtoms(mapped) {
    const byAtom = new Map();
    for (const glyph of mapped) {
      const previous = byAtom.get(glyph.end);
      byAtom.set(glyph.end, previous
        ? { ...previous, ...union([previous, glyph]) }
        : { ...glyph, text: glyph.symbol });
    }
    return [...byAtom.values()].sort((a, b) => a.end - b.end);
  }

  function mathMap(field, glyphs, bounds, near = null, { allowUnpaintedAnchor = false, sourceBoxes = [] } = {}) {
    const layout = mathLayoutSnapshot(field);
    let matches = mathMatches(layout, glyphs, bounds);
    if (!matches.length && Number(field.lastOffset) <= 512 && glyphs.length <= 4096 &&
        [bounds.left, bounds.right, bounds.top, bounds.bottom, near?.x, near?.y].every(Number.isFinite)) {
      // SyncTeX can expose only an array's inner rows for A=(matrix)6.
      // Keep its measured vertical envelope, then prove a complete symbol
      // occurrence containing the clicked ink before extending horizontally.
      const scope = union(glyphs);
      const expanded = scope ? mathMatches(layout, glyphs, { ...bounds, left: scope.left, right: scope.right }, {
        complete: true, contiguous: true, maxCandidates: 256, maxPairings: 200000,
      }) : [];
      let model;
      matches = (expanded ?? []).filter(match => {
        const glyph = nearest(match.map, near);
        if (allowUnpaintedAnchor && near.x >= bounds.left && near.x <= bounds.right &&
            near.y >= bounds.top && near.y <= bounds.bottom) return true;
        if (glyph && near.x >= glyph.left - 2 && near.x <= glyph.right + 2 &&
            near.y >= glyph.top - 2 && near.y <= glyph.bottom + 2) return true;
        model ??= mathModelSnapshot(field);
        const offset = mathHit(model, match.map, near, bounds, sourceBoxes);
        if (match.map.some(g => g.start === offset || g.end === offset)) return false;
        const empty = mathCaret(model, match.map, offset, bounds, sourceBoxes);
        return empty && Math.abs(near.x - empty.x) <= 2 && near.y >= empty.top && near.y <= empty.bottom;
      });
      // More than one complete occurrence at the anchor is not a proof.
      if (matches.length !== 1) return [];
    }
    if (near) {
      for (const match of matches) {
        const closest = nearest(match.map, near);
        const dx = Math.max(closest.left - near.x, 0, near.x - closest.right);
        const dy = Math.max(closest.top - near.y, 0, near.y - closest.bottom);
        // Repeated copies of the same formula must stay at the clicked ink.
        match.cost += (dx * dx + dy * dy) / 100;
      }
    }
    return matches.sort((a, b) => a.cost - b.cost)[0]?.map ?? [];
  }

  // Enumerate distinct copies before assigning source regions to them. A
  // separate near-point lookup for each identical source region would map
  // every region onto the clicked copy. This bounded helper refuses partial
  // matches and ambiguous occurrence sets instead of inventing a bijection.
  function mathMaps(field, glyphs, bounds) {
    if (Number(field.lastOffset) > 512 || glyphs.length > 4096) return [];
    const matches = mathMatches(field, glyphs, bounds, {
      complete: true, maxCandidates: 256, maxPairings: 200000,
    });
    return distinctOccurrences(matches);
  }

  function distinctOccurrences(matches) {
    if (!matches?.length) return [];
    const best = Array(matches.length + 1);
    best[matches.length] = { occurrences: [], cost: 0, ambiguous: false };
    for (let index = matches.length - 1; index >= 0; index--) {
      const candidate = matches[index];
      let next = index + 1;
      while (next < matches.length && matches[next].start < candidate.end) next++;
      const rest = best[next];
      const take = { occurrences: [candidate, ...rest.occurrences], cost: candidate.cost + rest.cost, ambiguous: rest.ambiguous };
      const skip = best[index + 1];
      const countDelta = take.occurrences.length - skip.occurrences.length;
      if (countDelta || Math.abs(take.cost - skip.cost) > 1e-8) {
        best[index] = countDelta > 0 || !countDelta && take.cost < skip.cost ? take : skip;
      } else {
        best[index] = { ...take, ambiguous: true };
      }
    }
    if (best[0].ambiguous) return [];
    return best[0].occurrences.map(({ map, cost }) => ({ map, cost }));
  }

  root.TdomDirectEditGeometry = { textMap, textMapFromGlyphs, textMaps, mathMap, mathMaps, hit, mathHit, caret, mathCaret, nearest };
})(typeof window === 'undefined' ? globalThis : window);
