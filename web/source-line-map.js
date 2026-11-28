// Two ordered diffs: whole lines establish the unchanged spans, then words
// align printable words across each replacement.
const LINE_BREAK = /\r\n?|\n/;
const WORDS = new Intl.Segmenter(undefined, { granularity: 'word' });
const normalizeWord = text => String(text ?? '').normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}\p{M}_]/gu, '');

function align(before, after, match, maxCells) {
  let start = 0, oldEnd = before.length, newEnd = after.length;
  while (start < oldEnd && start < newEnd && before[start] === after[start]) {
    match(start, start);
    start++;
  }
  while (oldEnd > start && newEnd > start && before[oldEnd - 1] === after[newEnd - 1]) {
    match(--oldEnd, --newEnd);
  }
  const rows = oldEnd - start, width = newEnd - start + 1;
  if (!rows || width === 1 || (rows + 1) * width > maxCells) return;
  const lengths = new Uint32Array((rows + 1) * width);
  for (let i = rows - 1; i >= 0; i--) {
    for (let j = width - 2; j >= 0; j--) {
      const k = i * width + j;
      lengths[k] = before[start + i] === after[start + j] ? 1 + lengths[k + width + 1]
        : Math.max(lengths[k + 1], lengths[k + width]);
    }
  }
  let i = 0, j = 0;
  while (i < rows && j < width - 1) {
    const k = i * width + j;
    if (before[start + i] === after[start + j]) match(start + i++, start + j++);
    else if (lengths[k + 1] > lengths[k + width]) j++;
    else i++;
  }
}

const LITERAL_ENVS = new Set([
  'verbatim', 'verbatim*', 'Verbatim', 'Verbatim*', 'BVerbatim', 'BVerbatim*',
  'LVerbatim', 'LVerbatim*', 'SaveVerbatim', 'VerbatimOut', 'lstlisting', 'minted',
  'filecontents', 'filecontents*', 'tcblisting', 'luacode', 'luacode*',
]);
const IF_COMMAND = /^\\if(?:abs(?:num|dim)|case|cat|csname|defined|dim|eof|false|fontchar|hbox|hmode|incsname|inner|num|odd|primitive|true|vbox|vmode|void|x)?$/;
const NON_PRINTING_ARGUMENT = /^\\(?:label|(?:auto|page|eq|name)?ref|(?:footnote|page)mark)\*?$/;

// Preserve offsets so the masked text can still give editor columns. Track
// only TeX's known delimiters; arbitrary macros can have arbitrary catcodes.
function printingLines(source) {
  const tokens = /%|\\(?:[A-Za-z@]+|[^\r\n])/g;
  const argument = /^\s*\{\s*([^{}]*?)\s*\}/;
  const conditionals = new Set([...source.matchAll(/\\newif\s*(\\if[A-Za-z@]+)/g)].map(match => match[1]));
  const parts = [];
  let copied = 0;
  const hide = (start, end) => {
    parts.push(source.slice(copied, start), source.slice(start, end).replace(/[^\r\n]/g, ' '));
    copied = end;
    tokens.lastIndex = end;
  };
  const branches = [];
  let hidden = false;
  for (let match; (match = tokens.exec(source));) {
    const [token] = match;
    const start = match.index, end = tokens.lastIndex;
    const lineEnd = () => {
      const length = source.slice(end).search(LINE_BREAK);
      return length < 0 ? source.length : end + length;
    };
    if (token === '%') {
      hide(start, lineEnd());
    } else if (IF_COMMAND.test(token) || conditionals.has(token)) {
      branches.push({ hidden, knownTrue: token === '\\iftrue' });
      hidden ||= token === '\\iffalse';
      hide(start, end);
    } else if (token === '\\fi' || token === '\\else' || token === '\\or') {
      const branch = branches.at(-1);
      if (branch) {
        if (token === '\\fi') {
          branches.pop();
          hidden = branch.hidden;
        } else hidden = branch.hidden || branch.knownTrue;
      }
      hide(start, end);
    } else if (hidden) {
      hide(start, end);
    } else if (token === '\\begin' || token === '\\end') {
      const arg = argument.exec(source.slice(end));
      if (!arg) { hide(start, end); continue; }
      const env = arg[1];
      const after = end + arg[0].length;
      if (token === '\\end' && env === 'document') {
        hide(start, source.length);
        break;
      }
      if (token === '\\begin' && (env === 'comment' || LITERAL_ENVS.has(env))) {
        const close = source.indexOf(`\\end{${env}}`, after);
        const closeEnd = close < 0 ? source.length : close + env.length + 6;
        if (env === 'comment' || /^(?:filecontents|luacode|SaveVerbatim|VerbatimOut)/.test(env)) {
          hide(start, closeEnd);
        } else {
          hide(start, after);
          hide(close < 0 ? closeEnd : close, closeEnd);
        }
      } else hide(start, after);
    } else if (token === '\\verb') {
      const offset = end + Number(source[end] === '*');
      const delimiter = source[offset];
      const close = delimiter && !/\s/.test(delimiter) ? source.indexOf(delimiter, offset + 1) : -1;
      hide(start, close >= 0 && close < lineEnd() ? offset + 1 : end);
      if (close >= 0 && close < lineEnd()) hide(close, close + 1);
    } else if (NON_PRINTING_ARGUMENT.test(token)) {
      const arg = argument.exec(source.slice(end));
      hide(start, end + (arg?.[0].length ?? 0));
    } else if (token === '\\newif') {
      const declaration = /^\s*\\if[A-Za-z@]+/.exec(source.slice(end));
      hide(start, end + (declaration?.[0].length ?? 0));
    } else if (/^\\[A-Za-z@]+$/.test(token)) {
      hide(start, end);
    }
    if (hidden) {
      // The next conditional token may share this line with skipped prose.
      tokens.lastIndex = copied;
      const next = tokens.exec(source);
      const stop = next?.index ?? source.length;
      if (copied < stop) hide(copied, stop);
    }
  }
  parts.push(source.slice(copied));
  return parts.join('').split(LINE_BREAK);
}

function wordSpans(lines, start, end) {
  const words = [];
  for (let line = start; line < end; line++) {
    for (const { segment, index, isWordLike } of WORDS.segment(lines[line])) {
      const text = isWordLike && normalizeWord(segment);
      if (text) words.push({ text, line, column: index + 1, end: index + segment.length + 1 });
    }
  }
  return words;
}

// A PDF word can be a single glyph in a tate column. Use more of the
// surrounding printed sequence when the same word occurs twice on a line.
function clickedWord(words, start, end, { word, prev, next, column }) {
  const target = normalizeWord(word);
  const left = normalizeWord(prev), right = normalizeWord(next);
  let best = -1, bestScore = 0, tied = false;
  for (let i = start; target && i < end; i++) {
    const item = words[i].text;
    const first = item.indexOf(target);
    if (first < 0) continue;
    const before = words.slice(Math.max(0, i - 8), i).map(value => value.text).join('');
    const after = words.slice(i + 1, i + 9).map(value => value.text).join('');
    for (let at = first; at >= 0; at = item.indexOf(target, at + target.length)) {
      const prior = before + item.slice(0, at);
      const following = item.slice(at + target.length) + after;
      const score = 1 + Number(item === target) + 2 * (
        Number(Boolean(left) && prior.endsWith(left)) +
        Number(Boolean(right) && following.startsWith(right)) +
        Number(column > 1 && words[i].column <= column && column < words[i].end));
      if (score > bestScore) {
        best = i;
        bestScore = score;
        tied = false;
      } else if (score === bestScore && best !== i) tied = true;
    }
  }
  if (best >= 0 && !tied) return best;
  if (column > 1) {
    for (let i = start; i < end; i++) {
      if (words[i].column <= column && column < words[i].end) return i;
    }
  }
  return -1;
}

export function findSourceWord(text, range, context) {
  if (!context?.word || typeof text !== 'string') return null;
  const { start, end } = range;
  const lines = printingLines(text);
  const words = wordSpans(lines, start.line - 1, Math.min(end.line, lines.length))
    .filter(item => (item.line + 1 !== start.line || item.end > start.column) &&
      (item.line + 1 !== end.line || item.column < end.column));
  const word = words[clickedWord(words, 0, words.length, context)];
  return word ? { line: word.line + 1, column: word.column } : null;
}

function uniqueUnmatched(lines, isMatched) {
  const counts = new Map();
  lines.forEach((text, index) => {
    if (text.trim() && !isMatched(index)) counts.set(text, counts.has(text) ? -1 : index);
  });
  return counts;
}

function matchedWord(oldWords, newWords, matches, clicked) {
  if (clicked < 0 || matches[clicked] < 0) return null;
  // Restrict the search to the gap between its surviving neighbours. If the
  // diff can place the same word on several lines here, require context.
  let previous = clicked - 1, next = clicked + 1;
  while (previous >= 0 && matches[previous] < 0) previous--;
  while (next < matches.length && matches[next] < 0) next++;
  const start = previous < 0 ? 0 : matches[previous] + 1;
  const end = next === matches.length ? newWords.length : matches[next];
  let result = null, bestScore = -1, tied = false;
  for (let i = start; i < end; i++) {
    const candidate = newWords[i];
    if (candidate.text !== oldWords[clicked].text) continue;
    const score = Number(oldWords[clicked - 1]?.text != null && oldWords[clicked - 1].text === newWords[i - 1]?.text) +
      Number(oldWords[clicked + 1]?.text != null && oldWords[clicked + 1].text === newWords[i + 1]?.text);
    if (score > bestScore) {
      result = candidate;
      bestScore = score;
      tied = false;
    } else if (score === bestScore && result.line !== candidate.line) tied = true;
  }
  return tied ? null : result;
}

export function mapSourceLines(previous, current) {
  const before = previous.split(LINE_BREAK);
  const after = current.split(LINE_BREAK);
  const oldInk = printingLines(previous);
  const newInk = printingLines(current);
  const inkKey = line => line.trim().replace(/\s+/g, ' ');
  let uniqueOld, uniqueNew;
  let allNewWords, byWord;
  function contextMatch(line, options) {
    if (!options.word) return null;
    const words = wordSpans(oldInk, line, line + 1);
    const clicked = clickedWord(words, 0, words.length, options);
    if (clicked < 0) return null;
    if (!byWord) {
      allNewWords = wordSpans(newInk, 0, newInk.length);
      byWord = new Map();
      allNewWords.forEach(({ text }, index) => {
        if (!byWord.has(text)) byWord.set(text, []);
        byWord.get(text).push(index);
      });
    }
    let best, score = 0, tied = false;
    for (const index of byWord.get(words[clicked].text) ?? []) {
      let matches = 0;
      for (const direction of [-1, 1]) {
        for (let step = direction; words[clicked + step]?.text === allNewWords[index + step]?.text &&
          words[clicked + step] && Math.abs(step) <= 8; step += direction) matches++;
        const neighbour = normalizeWord(direction === -1 ? options.prev : options.next);
        if (neighbour && allNewWords[index + direction]?.text === neighbour) matches += 20;
      }
      if (matches > score) {
        best = allNewWords[index];
        score = matches;
        tied = false;
      } else if (best && matches === score && best.line !== allNewWords[index].line) tied = true;
    }
    return best && !tied ? { line: best.line + 1, column: best.column } : null;
  }
  const lines = new Int32Array(before.length + 1);
  const used = new Uint8Array(after.length);
  const anchors = [[-1, -1]];
  align(before, after, (i, j) => {
    lines[i + 1] = j + 1;
    used[j] = 1;
    anchors.push([i, j]);
  }, 8_000_000);
  // The suffix is found backwards. Ordered anchors delimit word diffs even
  // when a whole paragraph was moved across one of them.
  anchors.sort((a, b) => a[0] - b[0]);
  anchors.push([before.length, after.length]);
  const added = uniqueUnmatched(after, index => used[index]);
  for (const [text, index] of uniqueUnmatched(before, index => lines[index + 1])) {
    const newIndex = added.get(text);
    if (index >= 0 && newIndex >= 0) lines[index + 1] = newIndex + 1;
  }

  const hunks = new Map();
  function replacement(line) {
    let low = 0, high = anchors.length - 1;
    while (high - low > 1) {
      const middle = (low + high) >>> 1;
      if (anchors[middle][0] < line) low = middle;
      else high = middle;
    }
    if (!hunks.has(low)) {
      const [oldStart, newStart] = anchors[low];
      const [oldEnd, newEnd] = anchors[high];
      const oldWords = wordSpans(oldInk, oldStart + 1, oldEnd);
      const newWords = wordSpans(newInk, newStart + 1, newEnd);
      const matches = new Int32Array(oldWords.length).fill(-1);
      align(oldWords.map(item => item.text), newWords.map(item => item.text),
        (i, j) => { matches[i] = j; }, 2_000_000);
      hunks.set(low, { start: newStart + 2, oldWords, newWords, matches });
    }
    return hunks.get(low);
  }

  function changedLine(line, options) {
    const { oldWords, newWords, matches } = replacement(line);
    const start = oldWords.findIndex(item => item.line === line);
    if (start < 0) return null;
    let end = start;
    while (end < oldWords.length && oldWords[end].line === line) end++;
    const clicked = clickedWord(oldWords, start, end, options);
    const matched = matchedWord(oldWords, newWords, matches, clicked);
    if (matched) return { line: matched.line + 1, column: matched.column };

    const votes = new Map();
    for (let i = start; i < end; i++) {
      if (i === clicked) continue;
      const match = newWords[matches[i]];
      if (match) votes.set(match.line, (votes.get(match.line) ?? 0) + 1);
    }
    const ranked = [...votes].sort((a, b) => b[1] - a[1]);
    const [destination, count] = ranked[0] ?? [];
    if (count && count * 2 > end - start && count > (ranked[1]?.[1] ?? 0)) {
      return { line: destination + 1, column: 1 };
    }
    return null;
  }

  return {
    location(line, options = {}) {
      const oldLine = Math.max(1, Math.min(before.length, Number(line) || 1));
      const at = (destination, column = 1) => {
        const ink = newInk[destination - 1];
        if (!ink?.trim()) return null;
        return { line: destination, column: /\S/.test(ink[column - 1] ?? '') ? column : ink.search(/\S/) + 1 };
      };
      const direct = lines[oldLine];
      const previousInk = inkKey(oldInk[oldLine - 1]);
      if (direct && previousInk && inkKey(newInk[direct - 1]) === previousInk) return at(direct, options.column);
      if (previousInk) {
        uniqueOld ??= uniqueUnmatched(oldInk.map(inkKey), () => false);
        uniqueNew ??= uniqueUnmatched(newInk.map(inkKey), () => false);
        const occurrence = uniqueNew.get(previousInk);
        if (uniqueOld.get(previousInk) === oldLine - 1 && occurrence >= 0) {
          const offset = (options.column ?? 1) - oldInk[oldLine - 1].search(/\S/);
          return at(occurrence + 1, newInk[occurrence].search(/\S/) + offset);
        }
      }
      const changed = contextMatch(oldLine - 1, options) ?? changedLine(oldLine - 1, options);
      if (changed) return at(changed.line, changed.column);
      const { start = oldLine, end = oldLine, currentStart } = options.block ?? {};
      for (let distance = 1; oldLine - distance >= start || oldLine + distance <= end; distance++) {
        for (const candidate of [oldLine - distance, oldLine + distance]) {
          if (candidate < start || candidate > end) continue;
          const confirmed = at(lines[candidate]);
          if (confirmed) return confirmed;
          const surviving = changedLine(candidate - 1, {});
          if (surviving) return at(surviving.line, surviving.column);
        }
      }
      const fallback = Math.min(after.length, currentStart ?? (direct || replacement(start - 1).start));
      for (let distance = 0; fallback - distance >= 1 || fallback + distance <= after.length; distance++) {
        const printable = at(fallback - distance) ?? at(fallback + distance);
        if (printable) return printable;
      }
      return { line: fallback, column: 1 };
    },
  };
}
