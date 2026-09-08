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
  function mathMatches(field, glyphs, bounds, { complete = false, maxCandidates = Infinity, maxPairings = Infinity } = {}) {
    const atoms = [];
    for (let offset = 1; offset <= Number(field.lastOffset); offset++) {
      const info = field.getElementInfo(offset);
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
    });
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

  function mathMap(field, glyphs, bounds, near = null) {
    const matches = mathMatches(field, glyphs, bounds);
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

  root.TdomDirectEditGeometry = { textMap, textMapFromGlyphs, textMaps, mathMap, mathMaps, hit, caret, nearest };
})(typeof window === 'undefined' ? globalThis : window);
