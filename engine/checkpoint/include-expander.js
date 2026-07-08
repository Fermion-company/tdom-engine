import { readFileSync, statSync, watch } from 'node:fs';
import path from 'node:path';
import { fnv1a } from '../hash.js';
import { segmentBody } from '../segmenter.js';

export function expandIncludes(segs, depth, context) {
  if (depth > 3) return segs;
  const out = [];
  for (const seg of segs) {
    const m = seg.text.match(/^\s*\\(input|include)\s*\{([^}]+)\}\s*$/);
    if (!m) {
      out.push(seg);
      continue;
    }
    let rel = m[2];
    if (!/\.tex$/i.test(rel)) rel += '.tex';
    const full = path.resolve(context.docDir ?? context.workDir, rel);
    let text = null;
    try {
      const st = statSync(full);
      const cached = context.includes.get(full);
      text = cached && cached.mtime === st.mtimeMs ? cached.text : readFileSync(full, 'utf8');
      context.includes.set(full, { mtime: st.mtimeMs, text });
      context.watchInclude(full);
    } catch {
      context.diagnostics.push(`\\input file not found: ${rel} (typeset literally)`);
      out.push(seg);
      continue;
    }
    const subs = expandIncludes(segmentBody(text, 0), depth + 1, context);
    for (const s of subs) out.push({ ...s, file: full, hash: fnv1a(full + '|' + s.text) });
  }
  return out;
}

export function watchInclude(full, watchers, onExternalChange) {
  if (watchers.has(full)) return;
  try {
    let timer = null;
    const w = watch(full, () => {
      clearTimeout(timer);
      timer = setTimeout(() => onExternalChange?.(full), 120);
    });
    watchers.set(full, w);
  } catch {
    /* watching is best-effort */
  }
}
