// The reader's place, kept across a change of the paper (docs/04 §4.5,
// 「読み手の位置」).
// Pure: the caller reads the page boxes and the display lists, this decides
// what the anchor is and how far to scroll so that it stays where it was.
//
// An anchor is a typeset source line (a block id and the line within the
// block, as the display list's commands carry them) and how far through that
// line's typeset extent the point stood, with the point's viewport y. When no
// line is in view (exact pixels only) it is a page and a fraction of it.
// - edit anchor: the line of the last edit, when it is in view. The paper
//   does not scroll while it stays in view; when it leaves, it is put back
//   where it was.
// - reading anchor: the line at the viewport centre. Put back exactly.
(function installTdomViewAnchor(root) {
  const clamp01 = (value) => Math.max(0, Math.min(1, Number(value) || 0));
  const keyOf = (src, line) => `${src}\u0000${line}`;

  // A line's extent on its page, in paper units from the page top, of every
  // command that draws a source line (the glyph runs and rules a display
  // list carries with `src` and `line`; page furniture `_…` and drawing
  // over-text left out). Rows of one source line (a wrapped paragraph line)
  // make one extent.
  const extentsCache = new WeakMap();
  function lineExtents(dl) {
    if (!dl || !Array.isArray(dl.commands)) return new Map();
    const cached = extentsCache.get(dl);
    if (cached && cached.commands === dl.commands) return cached.extents;
    const extents = new Map();
    for (const cmd of dl.commands) {
      if ((cmd.op !== 'glyphs' && cmd.op !== 'rule') || cmd.ov || cmd.src == null || cmd.line == null) continue;
      const src = String(cmd.src);
      if (src.startsWith('_')) continue;
      const y = Number(cmd.y);
      if (!Number.isFinite(y)) continue;
      let top, bottom;
      if (cmd.op === 'rule') {
        const h = Number(cmd.h);
        top = y; bottom = y + (h > 0 ? h : 0);
      } else {
        const size = Number(cmd.size) > 0 ? Number(cmd.size) : 10;
        top = y - (Number(cmd.gh) > 0 ? Number(cmd.gh) : size * 0.75);
        bottom = y + (Number(cmd.gd) > 0 ? Number(cmd.gd) : size * 0.25);
      }
      const key = keyOf(src, cmd.line);
      const extent = extents.get(key);
      if (extent) {
        extent.top = Math.min(extent.top, top);
        extent.bottom = Math.max(extent.bottom, bottom);
      } else extents.set(key, { src, line: cmd.line, top, bottom, order: extents.size,
        ...(dl.exact && { baseline: y }) });
    }
    extentsCache.set(dl, { commands: dl.commands, extents });
    return extents;
  }

  // One line's extent on a page: a scan for it alone (a page just committed
  // has no map yet, and building one for a dense page of 2,000 commands to
  // find a line was the cost of keeping the place on a keystroke).
  function lineExtent(dl, src, line) {
    const cached = dl && extentsCache.get(dl);
    if (cached && cached.commands === dl.commands) return cached.extents.get(keyOf(src, line)) ?? null;
    if (!dl || !Array.isArray(dl.commands)) return null;
    let extent = null;
    const wanted = String(src);
    for (const cmd of dl.commands) {
      if ((cmd.op !== 'glyphs' && cmd.op !== 'rule') || cmd.ov || cmd.line !== line || String(cmd.src) !== wanted) continue;
      const y = Number(cmd.y);
      if (!Number.isFinite(y)) continue;
      let top, bottom;
      if (cmd.op === 'rule') {
        const h = Number(cmd.h);
        top = y; bottom = y + (h > 0 ? h : 0);
      } else {
        const size = Number(cmd.size) > 0 ? Number(cmd.size) : 10;
        top = y - (Number(cmd.gh) > 0 ? Number(cmd.gh) : size * 0.75);
        bottom = y + (Number(cmd.gd) > 0 ? Number(cmd.gd) : size * 0.25);
      }
      if (extent) {
        extent.top = Math.min(extent.top, top);
        extent.bottom = Math.max(extent.bottom, bottom);
      } else extent = { src: wanted, line, top, bottom };
    }
    return extent;
  }

  const contentCache = new WeakMap();
  const normalize = text => String(text ?? '').normalize('NFKC').replace(/\s+/gu, '');
  function rowContents(dl) {
    if (!dl?.commands) return [];
    const cached = contentCache.get(dl);
    if (cached?.commands === dl.commands) return cached.rows;
    const groups = new Map();
    for (const cmd of dl.commands) {
      if (cmd.op !== 'glyphs' || !cmd.text || cmd.ov || cmd.math || cmd.src == null ||
          String(cmd.src).startsWith('_') || cmd.line == null || !Number.isFinite(cmd.y)) continue;
      const key = keyOf(cmd.src, cmd.line);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(cmd);
    }
    const rows = [...groups.values()].map(commands => {
      commands.sort((a, b) => a.x - b.x);
      const first = commands[0];
      return { src: String(first.src), line: first.line, y: first.y,
        text: normalize(commands.map(cmd => cmd.text).join('')) };
    }).sort((a, b) => a.y - b.y);
    contentCache.set(dl, { commands: dl.commands, rows });
    return rows;
  }

  function contentOf(dl, src, line) {
    const rows = rowContents(dl);
    const index = rows.findIndex(row => row.src === src && row.line === line);
    const row = rows[index];
    if (!row || row.text.length < 8) return null;
    return { ...row, before: rows[index - 1]?.text, after: rows[index + 1]?.text };
  }

  // Compare text across paginations. The row itself can wrap and the
  // neighboring text helps disambiguate repeated rows.
  function contentPlace(content, dl, near = null) {
    if (!content?.text) return null;
    const rows = rowContents(dl);
    const text = normalize(content.text);
    let best = null;
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      const tail = rows[i + 1];
      const joined = row.text + (tail?.text ?? '');
      const offset = joined.indexOf(text);
      if (offset < 0 || offset >= row.text.length) continue;
      let score = text.length * 2 + (row.text === text ? 50 : 0);
      const context = Number(Boolean(content.before && rows[i - 1]?.text === content.before)) +
        Number(Boolean(content.after && tail?.text === content.after));
      score += context * 35;
      if (row.src === content.src && row.line === content.line) score += 10;
      const distance = near == null ? 0 : Math.abs(row.y - near);
      if (!best || score > best.score || score === best.score && distance < best.distance) {
        best = { ...row, score, context, distance };
      }
    }
    return best;
  }

  function exactDisplayList(src, glyphs) {
    const rows = [];
    for (const glyph of [...glyphs].sort((a, b) => a.baseline - b.baseline)) {
      const y = Number(glyph.baseline);
      if (!Number.isFinite(y) || !glyph.text) continue;
      let row = rows.at(-1);
      if (!row || y - row.y > 0.75) {
        row = { y, glyphs: [] };
        rows.push(row);
      }
      row.glyphs.push(glyph);
    }
    return { exact: true, commands: rows.map((row, line) => {
      row.glyphs.sort((a, b) => a.left - b.left);
      const first = row.glyphs[0];
      return { op: 'glyphs', src, line, x: first.left, y: first.baseline,
        gh: first.baseline - first.top, gd: first.bottom - first.baseline,
        text: row.glyphs.map(g => g.text).join('') };
    }) };
  }

  // pages: [{ page, top, height, width, paperHeight, dl? }] in client px (dl:
  // the display list on that page's paper, when it is resident ink). Returns
  // the anchor, or null when nothing is in view.
  function captureAnchor({ pages, viewTop, viewBottom, editSrcs = null }) {
    if (!(viewBottom > viewTop) || !Array.isArray(pages) || !pages.length) return null;
    const visible = pages.filter(p => p.height > 0 && p.top < viewBottom && p.top + p.height > viewTop);
    const centre = (viewTop + viewBottom) / 2;
    let edit = null, reading = null;
    for (const p of visible) {
      if (!(p.paperHeight > 0) || !p.dl) continue;
      const scale = p.height / p.paperHeight;
      for (const extent of lineExtents(p.dl).values()) {
        const top = p.top + extent.top * scale, bottom = p.top + extent.bottom * scale;
        if (bottom < viewTop || top > viewBottom) continue;
        const distance = centre < top ? top - centre : centre > bottom ? centre - bottom : 0;
        const candidate = { src: extent.src, line: extent.line, page: p.page, top, bottom, distance, order: extent.order };
        if (editSrcs?.has(extent.src) && (!edit || distance < edit.distance)) edit = candidate;
        if (Number.isFinite(extent.baseline)) candidate.distance = Math.abs(p.top + extent.baseline * scale - centre);
        if (!reading || candidate.distance < reading.distance) reading = candidate;
      }
    }
    if (edit) {
      return { kind: 'edit', src: edit.src, line: edit.line, page: edit.page, top: edit.top, bottom: edit.bottom,
        fraction: 0, y: edit.top, viewTop, viewBottom };
    }
    if (reading) {
      const height = reading.bottom - reading.top;
      const fraction = height > 0 ? clamp01((centre - reading.top) / height) : 0;
      const p = pages.find(page => page.page === reading.page);
      const content = contentOf(p.dl, reading.src, reading.line);
      const baseline = content && p.top + content.y * p.height / p.paperHeight;
      return { kind: 'reading', src: reading.src, line: reading.line, page: reading.page, top: reading.top,
        bottom: reading.bottom, fraction, y: reading.top + fraction * height, viewTop, viewBottom,
        ...(content && { content, baseline }) };
    }
    // exact pixels only: the page at the centre and how far down it
    const held = visible.find(p => p.top <= centre && p.top + p.height >= centre) ??
      visible.sort((a, b) =>
        Math.abs(a.top + a.height / 2 - centre) - Math.abs(b.top + b.height / 2 - centre))[0];
    if (!held) return null;
    const fraction = clamp01((centre - held.top) / held.height);
    return { kind: 'page', page: held.page, fraction, y: held.top + fraction * held.height, viewTop, viewBottom };
  }

  // Where the anchor's line stands on `pages` now (client px), the same page
  // first, then the nearest. A line no longer typeset: the next line of its
  // block, then the next block the anchor's page showed (`following`), as
  // far as `pages` hold them.
  function locateAnchor(anchor, pages, following = []) {
    if (!anchor || anchor.kind === 'page') return null;
    // (the anchor's page first, then the nearer pages: the first found is the nearest)
    const order = pages.filter((p) => p.dl && p.paperHeight > 0 && p.height > 0)
      .sort((a, b) => Math.abs(a.page - anchor.page) - Math.abs(b.page - anchor.page) || a.page - b.page);
    const find = (src, line) => {
      for (const p of order) {
        const extent = lineExtent(p.dl, src, line);
        if (!extent) continue;
        const scale = p.height / p.paperHeight;
        const content = anchor.content && contentOf(p.dl, String(src), line);
        return { page: p.page, src, line, top: p.top + extent.top * scale, bottom: p.top + extent.bottom * scale,
          ...(content && { baseline: p.top + content.y * scale }) };
      }
      return null;
    };
    const exact = find(anchor.src, anchor.line);
    if (exact) return { ...exact, exact: true };
    if (anchor.content) {
      let best = null;
      for (const p of order) {
        const row = contentPlace(anchor.content, p.dl, anchor.content.y);
        if (row && (!best || row.score > best.row.score)) best = { p, row };
      }
      if (best) {
        const { p, row } = best;
        const baseline = p.top + row.y * p.height / p.paperHeight;
        return { page: p.page, top: baseline, bottom: baseline, baseline, exact: true };
      }
    }
    if (Number.isInteger(Number(anchor.line))) {
      for (let line = Number(anchor.line) + 1; line <= Number(anchor.line) + 40; line++) {
        const next = find(anchor.src, line);
        if (next) return { ...next, exact: false };
      }
    }
    for (const { src, line } of following) {
      const next = find(src, line);
      if (next) return { ...next, exact: false };
    }
    return null;
  }

  // How far to scroll (client px, + down) so the anchor stands where it was.
  // `now`: its line's extent now (locateAnchor), or for a page anchor the
  // page's box now ({ top, height }). An edit anchor still in view (inside
  // `margin` of either edge) does not move the paper.
  function restoreDelta(anchor, now, { margin = 0 } = {}) {
    if (!anchor || !now) return 0;
    let delta;
    if (anchor.kind === 'page') {
      if (!(now.height > 0)) return 0;
      delta = now.top + anchor.fraction * now.height - anchor.y;
    } else if (anchor.kind === 'edit') {
      // (whole in view: a line half off an edge is put back where it was)
      const inView = now.top >= anchor.viewTop + margin && now.bottom <= anchor.viewBottom - margin;
      if (inView) return 0;
      delta = now.top - anchor.top;
    } else {
      delta = Number.isFinite(anchor.baseline) && Number.isFinite(now.baseline)
        ? now.baseline - anchor.baseline
        : now.top + anchor.fraction * (now.bottom - now.top) - anchor.y;
    }
    return Math.abs(delta) < 0.5 ? 0 : delta;
  }

  // The lines after the anchor's on its page, in the order the page draws
  // them: where to look when the anchor's own line is gone.
  function followingLines(anchor, dl, count = 24) {
    if (!anchor || anchor.kind === 'page' || !dl) return [];
    const list = [...lineExtents(dl).values()].sort((a, b) => a.order - b.order);
    const at = list.findIndex((extent) => extent.src === anchor.src && extent.line === anchor.line);
    return (at >= 0 ? list.slice(at + 1, at + 1 + count) : []).map(({ src, line }) => ({ src, line }));
  }

  root.TdomViewAnchor = Object.freeze({ lineExtents, lineExtent, captureAnchor, locateAnchor, restoreDelta, followingLines, contentOf, contentPlace, exactDisplayList });
})(typeof window === 'undefined' ? globalThis : window);
