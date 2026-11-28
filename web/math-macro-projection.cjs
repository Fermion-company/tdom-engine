// Both the source inspector and the paper editor use TeX's recorded macro
// templates. Each editable piece retains its offsets in the original file.
(function install() {
  const structural = /^(?:frac|dfrac|tfrac|sqrt)$/;
  function project(raw, definitions) {
    if (!definitions || typeof raw !== 'string' || raw.length > 4096 || /%|\\(?:csname|verb)\b/.test(raw)) return null;
    const spans = [], calls = [], used = Object.create(null);
    let text = '', expansions = 0;
    function emit(value, from = null) {
      // A parameter substitutes tokens. A control word at the end of one
      // piece cannot consume a letter from the following piece.
      if (/^[A-Za-z]/.test(value) && /(?:^|[^\\])(?:\\\\)*\\[A-Za-z]+$/.test(text)) text += ' ';
      const start = text.length;
      text += value;
      if (from !== null) spans.push({ start, end: text.length, from });
      return text.length <= 8192;
    }
    function group(from, limit) {
      while (from < limit && /\s/.test(raw[from])) from++;
      if (raw[from] !== '{') return null;
      let depth = 1;
      for (let i = from + 1; i < limit; i++) {
        if (raw[i] === '\\') i++;
        else if (raw[i] === '{') depth++;
        else if (raw[i] === '}' && --depth === 0) return { from: from + 1, end: i };
      }
      return null;
    }
    function optionalGroup(open, limit) {
      // TeX ends [#1] at the first unbraced closing bracket. Brackets
      // themselves do not nest. A single outer brace pair is stripped.
      const from = open + 1;
      for (let i = from; i < limit; i++) {
        if (raw[i] === '\\') i++;
        else if (raw[i] === '{') {
          const nested = group(i, limit);
          if (!nested) return null;
          i = nested.end;
        } else if (raw[i] === '}') return null;
        else if (raw[i] === ']') {
          const sole = raw[from] === '{' && group(from, i);
          return sole && sole.end === i - 1 ? { ...sole, next: i + 1 } : { from, end: i, next: i + 1 };
        }
      }
      return null;
    }
    function read(from, limit, depth) {
      if (depth > 12) return false;
      const commands = /\\([A-Za-z]+|[\s\S])/g;
      commands.lastIndex = from;
      let pos = from, match;
      while ((match = commands.exec(raw)) && match.index < limit) {
        const name = match[1];
        // Label keys, operator names, tags and text have their own rules.
        // Keep the entire group verbatim, including any user commands in it.
        if (/^(?:text[a-z]*|operatorname|label|tag)$/.test(name)) {
          const offset = commands.lastIndex + (raw[commands.lastIndex] === '*' ? 1 : 0);
          const arg = group(offset, limit);
          if (!arg) return false;
          commands.lastIndex = arg.end + 1;
          continue;
        }
        if (!Object.hasOwn(definitions, name) || structural.test(name)) continue;
        const def = definitions[name], args = [];
        if (++expansions > 64 || !emit(raw.slice(pos, match.index), pos)) return false;
        let end = commands.lastIndex;
        if (Object.hasOwn(def, 'default')) {
          let open = end;
          while (open < limit && /\s/.test(raw[open])) open++;
          if (open < limit && raw[open] === '[') {
            const arg = optionalGroup(open, limit);
            if (!arg) return false;
            args.push(arg);
            end = arg.next;
          } else args.push({ defaultAt: end, value: def.default });
        }
        for (let n = args.length; n < def.args; n++) {
          const arg = group(end, limit);
          if (!arg) return false;
          args.push(arg);
          end = arg.end + 1;
        }
        used[name] = def;
        const start = text.length;
        let literal = 0;
        for (const parameter of def.body.matchAll(/#([1-9])/g)) {
          const arg = args[Number(parameter[1]) - 1];
          if (!arg || !emit(def.body.slice(literal, parameter.index))) return false;
          if (arg.defaultAt !== undefined) {
            if (!emit(arg.value)) return false;
            spans.push({ start: text.length - arg.value.length, end: text.length, defaultAt: arg.defaultAt });
          } else if (!read(arg.from, arg.end, depth + 1)) return false;
          literal = parameter.index + 2;
        }
        if (!emit(def.body.slice(literal))) return false;
        if (depth === 0) calls.push({ start, end: text.length, from: match.index, to: end });
        pos = end;
        commands.lastIndex = end;
      }
      return emit(raw.slice(pos, limit), pos);
    }
    if (!read(0, raw.length, 0) || !calls.length) return null;
    return { text, spans, calls, definitions: used };
  }

  // A change in an argument normally has one contiguous source interval.
  // If the user edits a literal in the definition (or just one printed
  // copy of a repeated argument), expand only the affected invocation.
  function rewrite(raw, projection, next) {
    const prev = projection.text;
    if (prev === next) return raw;
    let start = 0, end = prev.length, to = next.length;
    while (start < end && start < to && prev[start] === next[start]) start++;
    while (end > start && to > start && prev[end - 1] === next[to - 1]) { end--; to--; }
    const inserted = next.slice(start, to);
    const matches = value => (project(value, projection.definitions)?.text ?? value) === next;
    for (const span of projection.spans) {
      if (span.start > start || span.end < end) continue;
      if (span.defaultAt !== undefined) {
        const value = prev.slice(span.start, start) + inserted + prev.slice(end, span.end);
        for (const option of [value, '{' + value + '}']) {
          const candidate = raw.slice(0, span.defaultAt) + '[' + option + ']' + raw.slice(span.defaultAt);
          if (matches(candidate)) return candidate;
        }
        continue;
      }
      const at = span.from + start - span.start;
      const candidate = raw.slice(0, at) + inserted + raw.slice(at + end - start);
      if (matches(candidate)) return candidate;
    }
    // Rebuild the changed expanded string while retaining every complete
    // unchanged call outside the edited interval, including its raw spacing.
    let source = next;
    for (const call of projection.calls.slice().reverse()) {
      const shift = call.start >= end ? to - end : 0;
      if (call.start < end && call.end > start) continue;
      source = source.slice(0, call.start + shift) + raw.slice(call.from, call.to) + source.slice(call.end + shift);
    }
    return matches(source) ? source : next;
  }
  function withoutComments(raw) {
    if (!raw.includes('%')) return raw;
    const tokens = /\\(?:[A-Za-z@]+|[\s\S])|%[^\n]*(?:\n[ \t]*)?/gu;
    let out = '', from = 0;
    for (let m; (m = tokens.exec(raw));) {
      if (m[0] === '\\verb') {
        const at = tokens.lastIndex + (raw[tokens.lastIndex] === '*' ? 1 : 0);
        const end = raw.indexOf(raw[at], at + 1), eol = raw.indexOf('\n', at);
        tokens.lastIndex = end >= 0 && (eol < 0 || end < eol) ? end + 1 : eol < 0 ? raw.length : eol;
      }
      if (m[0][0] !== '%') continue;
      out += raw.slice(from, m.index);
      from = tokens.lastIndex;
      if (/(?:^|[^\\])(?:\\\\)*\\[A-Za-z@]+$/u.test(out) && /^[A-Za-z@]/u.test(raw[from] ?? '')) out += ' ';
    }
    return from ? out + raw.slice(from) : raw;
  }
  const api = { project, rewrite, withoutComments };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else globalThis.TdomMathMacros = api;
})();
