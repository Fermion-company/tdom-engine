import path from 'node:path';

const normal = value => String(value).normalize('NFKC').replace(/[^\p{L}\p{N}]/gu, '');
const tokens = value => String(value).normalize('NFKC').match(/[\p{Script=Latin}\p{N}]+|[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]+/gu) ?? [];
const uncomment = value => String(value).replace(/\\verb\*?([^\w\s])[^\n]*?\1|\\[%\\]|%[^\n]*/g,
  token => token[0] === '%' ? '' : token);
const decode = value => value.replace(/&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (_, code) =>
  code[0] === '#' ? String.fromCodePoint(parseInt(code.slice(code[1] === 'x' ? 2 : 1), code[1] === 'x' ? 16 : 10)) :
    ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" })[code]);
const bounds = boxes => ({ left: Math.min(...boxes.map(b => b.left)), top: Math.min(...boxes.map(b => b.top)),
  right: Math.max(...boxes.map(b => b.right)), bottom: Math.max(...boxes.map(b => b.bottom)) });

// Preserve Poppler's typeset-line boundaries: merging words by y alone joins
// columns, raster cells and side-by-side boxes into a page-wide marker.
export function parseJumpText(output) {
  const pages = [];
  for (const page of String(output).matchAll(/<page\b[^>]*>([\s\S]*?)<\/page>/g)) {
    const rows = [];
    for (const line of page[1].matchAll(/<line\b[^>]*>([\s\S]*?)<\/line>/g)) {
      const words = [];
      for (const word of line[1].matchAll(/<word\b([^>]*)>([\s\S]*?)<\/word>/g)) {
        const attr = Object.fromEntries([...word[1].matchAll(/(xMin|yMin|xMax|yMax)="([\d.-]+)"/g)].map(m => [m[1], Number(m[2])]));
        const box = { left: attr.xMin, top: attr.yMin, right: attr.xMax, bottom: attr.yMax };
        if (Object.values(box).every(Number.isFinite)) words.push({ ...box, text: normal(decode(word[2])), tokens: tokens(decode(word[2])) });
      }
      if (words.length) rows.push({ page: pages.length + 1, box: bounds(words), text: words.map(w => w.text).join(''), tokens: words.flatMap(w => w.tokens) });
    }
    pages.push(rows);
  }
  return pages.flat();
}

// Some Poppler versions throw while writing empty beamer PDF metadata to
// XHTML. TSV uses the same layout analysis without that metadata writer.
export function parseJumpTsv(output) {
  const rows = [];
  let row = null;
  for (const line of String(output).split(/\r?\n/)) {
    const [level, page, , , , , left, top, width, height, , ...text] = line.split('\t');
    if (level === '4') {
      const box = { left: +left, top: +top, right: +left + +width, bottom: +top + +height };
      row = Object.values(box).every(Number.isFinite) ? { page: +page, box, text: '', tokens: [] } : null;
      if (row) rows.push(row);
    } else if (level === '5' && row && row.page === +page) {
      row.text += normal(text.join('\t'));
      row.tokens.push(...tokens(text.join('\t')));
    }
  }
  return rows;
}

// A closing/blank line belongs to the preceding output; an opening marker
// introduces the following output. Work from the current editor snapshot.
export function jumpAnchor(lines, requested) {
  const text = n => uncomment(lines[n - 1] ?? '').trim();
  const closing = t => /^\\(?:end\b|(?:clearpage|cleardoublepage|newpage|pagebreak)\b)|^\\\\(?:\[[^\]]*\])?$/.test(t) || t === '\\]';
  const opening = t => /^(?:\\noindent\s*)?\\(?:begin|label|centering|toprule|midrule|bottomrule|hline|cline|tcblower|onecolumn|twocolumn|columnbreak)\b/.test(t) || /^\\item\s*(?:\[[^\]]*\])?$/.test(t) || t === '\\[';
  const own = text(requested), end = !own || closing(own);
  if (!end && !opening(own)) return { line: requested, toEnd: false };
  for (let delta = 1; delta <= 80; delta++) {
    const line = requested + (end ? -delta : delta);
    if (line < 1 || line > lines.length) break;
    const value = text(line);
    if (value && !closing(value) && !opening(value)) return { line, toEnd: end };
  }
  return { line: requested, toEnd: end };
}

// Record leaf ownership rather than the enclosing page/column box returned
// by `synctex view`. Coordinates remain in SyncTeX space until the renderer
// applies the generation's rotation/content transform.
export function parseJumpRecords(text, baseDir) {
  const inputs = new Map(), records = new Map(), settings = new Map();
  const stack = [];
  let page = 0;
  for (const row of String(text).split(/\r?\n/)) {
    const input = /^Input:(\d+):(.+)$/.exec(row);
    if (input) { inputs.set(Number(input[1]), path.resolve(baseDir, input[2])); continue; }
    const setting = /^(SyncTeX Version|Magnification|Unit|X Offset|Y Offset):(.+)$/.exec(row);
    if (setting) { settings.set(setting[1], Number(setting[2])); continue; }
    if (/^\{\d+$/.test(row)) { page = Number(row.slice(1)); stack.length = 0; continue; }
    if (/^\}/.test(row)) { page = 0; continue; }
    if (row === ')' || row === ']') { stack.pop(); continue; }
    if (!page) continue;
    const node = /^([\[(xgk$hrv])([\d]+),(\d+)(?:,-?\d+)?:(-?\d+),(-?\d+)(?::(-?\d+),(-?\d+),(-?\d+))?/.exec(row);
    if (!node) continue;
    const [, kind, tag, line, h, v, w, ht, dp] = node;
    if (kind === '(' || kind === '[') {
      stack.push({ kind, box: w == null ? null : { left: +h, right: +h + +w, top: +v - +ht, bottom: +v + +dp } });
      continue;
    }
    if (kind !== 'x' && kind !== 'g' && kind !== 'k' && kind !== '$' && kind !== 'r') continue;
    const owner = stack.findLast(b => b.kind === '(' && b.box && b.box.bottom > b.box.top);
    const key = `${tag}:${line}`;
    if (!records.has(key)) records.set(key, []);
    records.get(key).push({ page, x: +h, y: +v, box: owner?.box, ink: kind === 'x' || kind === '$' || kind === 'r' });
  }
  if (settings.get('SyncTeX Version') !== 1 || settings.get('Magnification') !== 1000 ||
      settings.get('Unit') !== 1 || settings.get('X Offset') !== 0 || settings.get('Y Offset') !== 0 ||
      /Post scriptum:\s*\S/.test(text) || /^[<>f]/m.test(text)) return null;
  const scale = 72 / 72.27 / 65536;
  return { inputs, records, scale };
}

export function jumpRecords(index, file, line) {
  if (!index) return [];
  const tags = [...index.inputs].filter(([, input]) => input === path.resolve(file)).map(([tag]) => tag);
  return tags.flatMap(tag => (index.records.get(`${tag}:${line}`) ?? []).map(r => ({ ...r,
    x: r.x * index.scale, y: r.y * index.scale,
    box: r.box && Object.fromEntries(Object.entries(r.box).map(([key, value]) => [key, value * index.scale])),
  })));
}

function tableRowBoxes(rows, literal, seeds) {
  // Short/numeric cells need row-local evidence; sweeping the page at
  // this y would also highlight an unrelated table in the other column.
  const selected = [...seeds], counts = new Map();
  const band = rows.filter(row => row.page === seeds[0].page && seeds.some(seed =>
    Math.min(row.box.bottom, seed.box.bottom) - Math.max(row.box.top, seed.box.top) >
      Math.min(row.box.bottom - row.box.top, seed.box.bottom - seed.box.top) / 2));
  for (const fragment of tokens(literal)) counts.set(fragment, (counts.get(fragment) ?? 0) + 1);
  for (const [fragment, count] of counts) {
    const matches = band.filter(row => row.tokens ? row.tokens.includes(fragment) : row.text === fragment);
    if (matches.length <= count) for (const row of matches) if (!selected.includes(row)) selected.push(row);
  }
  const boxes = [];
  for (const row of selected.sort((a, b) => a.box.top - b.box.top)) {
    const same = boxes.find(b => Math.min(b.bottom, row.box.bottom) - Math.max(b.top, row.box.top) >
      Math.min(b.bottom - b.top, row.box.bottom - row.box.top) / 2);
    if (same) Object.assign(same, bounds([same, row.box]));
    else boxes.push({ ...row.box });
  }
  return boxes;
}

export function locateJump(rows, sourceLine, records, toEnd = false, textOnly = false) {
  // Collected macro arguments (twocolumn, align, user wrappers) may all
  // carry their closing source line. Literal text in this very PDF supplies
  // the missing distinction; repeated text still needs SyncTeX ownership.
  const literal = uncomment(sourceLine).replace(/\\verb\*?([^\w\s])([^\n]*?)\1/g, '$2')
    .replace(/\\(?:begin|end|label|ref|eqref)\s*\{[^}]*\}/g, ' ')
    .replace(/\\[a-zA-Z@]+\*?/g, ' ').replace(/[\w/.]+\s*=/g, ' ');
  const table = /(?<!\\)&/.test(literal);
  const fragments = [...new Set(tokens(literal).map(normal).filter(s => s.length >= 4 || table))];
  const owned = new Map(rows.map(row => [row, records.filter(record => record.page === row.page &&
    record.x >= row.box.left - 2 && record.x <= row.box.right + 2 &&
    record.y >= row.box.top - 3 && record.y <= row.box.bottom + 3)]));
  const candidates = new Map();
  for (const fragment of fragments) {
    const matches = rows.filter(row => row.tokens && /^[\p{Script=Latin}\p{N}]+$/u.test(fragment)
      ? row.tokens.includes(fragment) : row.text.includes(fragment));
    const qualified = fragment.length >= 4 && matches.length === 1 ? matches : matches.filter(row => owned.get(row).some(r => r.ink));
    if (qualified.length !== 1) continue;
    const row = qualified[0];
    if (!candidates.has(row)) candidates.set(row, { first: fragments.indexOf(fragment), score: 0 });
    candidates.get(row).score += fragment.length;
  }
  if (candidates.size) {
    const ranked = [...candidates].sort((a, b) => a[1].first - b[1].first);
    const pages = new Map();
    for (const [row, evidence] of ranked) pages.set(row.page, (pages.get(row.page) ?? 0) + evidence.score);
    const bestPage = [...pages].sort((a, b) => b[1] - a[1])[0][0];
    const best = toEnd ? [...candidates].sort((a, b) => b[1].score - a[1].score)[0][0] :
      ranked.find(([row]) => row.page === bestPage)[0];
    const selected = ranked.map(([row]) => row).filter(row => row.page === best.page)
      .sort((a, b) => a.box.top - b.box.top || a.box.left - b.box.left);
    if (table) {
      const boxes = tableRowBoxes(rows, literal, selected);
      return { page: best.page, boxes: toEnd ? boxes.slice(-1) : boxes };
    }
    if (toEnd) {
      // A blank/closing line follows the main text run, not a detached
      // footnote printed much later on the same page.
      const connected = new Set([best]);
      for (let changed = true; changed;) {
        changed = false;
        for (const row of selected) {
          if (connected.has(row)) continue;
          if ([...connected].some(other => row.box.left < other.box.right && row.box.right > other.box.left &&
              Math.max(row.box.top - other.box.bottom, other.box.top - row.box.bottom) <
                Math.max(row.box.bottom - row.box.top, other.box.bottom - other.box.top))) {
            connected.add(row); changed = true;
          }
        }
      }
      return { page: best.page, boxes: [selected.filter(row => connected.has(row)).at(-1).box] };
    }
    return { page: best.page, boxes: selected.map(row => row.box) };
  }
  if (textOnly) return null;
  const ink = rows.filter(row => owned.get(row).some(r => r.ink));
  const options = ink.length ? ink : rows.filter(row => owned.get(row).length);
  if (!options.length) return null;
  options.sort((a, b) => a.page - b.page || a.box.top - b.box.top || a.box.left - b.box.left);
  const chosen = toEnd ? options.at(-1) : options[0];
  return { page: chosen.page, boxes: table ? tableRowBoxes(rows, literal, [chosen]) : [chosen.box] };
}
