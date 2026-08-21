import { readFileSync, statSync, watch } from 'node:fs';
import path from 'node:path';
import { fnv1a } from '../hash.js';
import { segmentBody } from '../segmenter.js';
import { resolveProjectInput } from '../project-inputs.js';

export function expandIncludes(segs, depth, context) {
  if (depth > 3) return segs;
  const out = [];
  for (const seg of segs) {
    // Classic BibTeX's \bibliography command is just an input of
    // \jobname.bbl. The server materializes driver.bbl from the project's
    // real .bib files; expanding it here gives the existing live-bibliography
    // machinery real \bibitem blocks, so citations and the bibliography can
    // update incrementally instead of waiting for canonical LuaLaTeX.
    const bibliography = seg.text.match(/^\s*\\bibliography\s*\{[^}]+\}\s*$/);
    if (bibliography) {
      const full = path.join(context.workDir, 'driver.bbl');
      const expanded = expandTextFile(full, depth, context);
      if (expanded) {
        out.push(...expanded);
        continue;
      }
    }
    const m = seg.text.match(/^\s*\\(input|include)\s*\{([^}]+)\}\s*$/);
    if (!m) {
      out.push(decorateExternalResources(seg, context));
      continue;
    }
    const command = m[1];
    const rel = m[2];
    if (command === 'include' && context.includeOnly && !context.includeOnly.has(normalizeIncludeName(rel))) {
      continue;
    }
    const resolved = resolveProjectInput(rel, {
      docDir: context.docDir ?? context.workDir,
      overlayDir: context.overlayDir,
      baseDir: seg.resourceBaseDir ?? context.docDir ?? context.workDir,
      extensions: ['.tex'],
    });
    const expanded = resolved
      ? expandTextFile(resolved.actualPath, depth, context, resolved.readPath, resolved.overlay)
      : null;
    if (!expanded) {
      context.diagnostics.push(`\\${command} file not found: ${rel} (typeset literally)`);
      out.push(seg);
      continue;
    }
    if (command === 'include') {
      // LaTeX's \include is an input bracketed by page flushes.  Record the
      // two edges as block metadata; buildStream injects the same page-builder
      // ejects without asking an isolated block compile to ship the previous
      // page as part of the chapter.  The chapter stays paragraph-granular.
      out.push(...wrapIncludedBlocks(expanded, rel));
    } else {
      out.push(...expanded);
    }
  }
  return out;
}

export function includeOnlyFromSource(source) {
  const match = String(source || '').match(/^[^%\n]*\\includeonly\s*\{([^}]*)\}/m);
  if (!match) return null;
  return new Set(match[1].split(',').map(normalizeIncludeName).filter(Boolean));
}

function normalizeIncludeName(value) {
  return String(value || '').trim().replace(/\\/g, '/').replace(/\.tex$/i, '').replace(/^\.\//, '');
}

function expandTextFile(full, depth, context, readPath = full, overlay = false) {
  try {
    const st = statSync(readPath);
    const cached = context.includes.get(full);
    const text = !overlay && cached && cached.mtime === st.mtimeMs && cached.readPath === readPath
      ? cached.text
      : readFileSync(readPath, 'utf8');
    context.includes.set(full, { mtime: st.mtimeMs, readPath, text });
    context.watchInclude(readPath);
    const subs = expandIncludes(
      segmentBody(text, 0).map((seg) => ({ ...seg, resourceBaseDir: path.dirname(full) })),
      depth + 1,
      context
    );
    return subs.map((s) => {
      const direct = !s.file;
      return {
        ...s,
        file: s.file ?? full,
        sourceStart: s.sourceStart ?? (direct ? offsetPosition(text, s.start) : undefined),
        sourceEnd: s.sourceEnd ?? (direct ? offsetPosition(text, s.end) : undefined),
        hash: fnv1a(`${full}|${s.hash}`),
      };
    });
  } catch {
    return null;
  }
}

function wrapIncludedBlocks(expanded, rel) {
  if (!expanded.length) return [];
  const blocks = expanded.map((block) => ({ ...block }));
  blocks[0].includeStart = true;
  blocks[0].hash = fnv1a(`include-before|${rel}|${blocks[0].hash}`);
  const last = blocks.length - 1;
  blocks[last].includeEnd = true;
  blocks[last].hash = fnv1a(`include-after|${rel}|${blocks[last].hash}`);
  return blocks;
}

function offsetPosition(text, offset) {
  const safe = Math.max(0, Math.min(text.length, Number(offset) || 0));
  let line = 1;
  let lineStart = 0;
  for (let i = 0; i < safe; i++) {
    if (text.charCodeAt(i) === 10) {
      line++;
      lineStart = i + 1;
    }
  }
  return { line, column: safe - lineStart + 1 };
}

// Files consumed by TeX without entering the source DOM still participate in
// block identity. A replacement PNG/PDF/listing marks only its owning block
// dirty; the watcher then calls engine.refresh(), preserving stale pixels
// until the fresh exact chunk lands.
function decorateExternalResources(seg, context) {
  const specs = [];
  const seenTex = new Set();
  let externalGraphics = false;
  const add = (raw, extensions = [], baseDir = context.docDir ?? context.workDir) => {
    const resolved = resolveProjectInput(raw, {
      docDir: context.docDir ?? context.workDir,
      overlayDir: context.overlayDir,
      baseDir,
      extensions,
    });
    if (!resolved) return null;
    try {
      const st = statSync(resolved.readPath);
      if (!st.isFile()) return null;
      context.watchInclude(resolved.readPath);
      const contentSig = resolved.overlay
        ? fnv1a(readFileSync(resolved.readPath, 'utf8'))
        : `${st.mtimeMs}:${st.size}`;
      specs.push(`${resolved.actualPath}:${resolved.readPath}:${contentSig}`);
      return resolved;
    } catch {
      return null;
    }
  };
  const scan = (text, baseDir, depth = 0) => {
    const visible = stripTexComments(text);
    for (const m of visible.matchAll(/\\includegraphics\*?\s*(?:\[[^\]]*\]\s*)?\{([^}]+)\}/g)) {
      externalGraphics = true;
      add(m[1], ['.pdf', '.png', '.jpg', '.jpeg', '.mps', '.eps'], baseDir);
    }
    for (const m of visible.matchAll(/\\includepdf\s*(?:\[[^\]]*\]\s*)?\{([^}]+)\}/g)) {
      externalGraphics = true;
      add(m[1], ['.pdf'], baseDir);
    }
    for (const m of visible.matchAll(/\\(?:lstinputlisting|verbatiminput)\s*(?:\[[^\]]*\]\s*)?\{([^}]+)\}/g)) {
      add(m[1], [], baseDir);
    }
    for (const m of visible.matchAll(/\\inputminted\s*(?:\[[^\]]*\]\s*)?\{[^}]+\}\s*\{([^}]+)\}/g)) {
      add(m[1], [], baseDir);
    }
    for (const m of visible.matchAll(/\\addplot\s+table\s*(?:\[[^\]]*\]\s*)?\{([^}]+)\}/g)) {
      add(m[1], [], baseDir);
    }
    if (depth >= 8) return;
    for (const m of visible.matchAll(/\\(?:input|include)\s*\{([^}]+)\}/g)) {
      const resolved = add(m[1], ['.tex'], baseDir);
      if (!resolved || seenTex.has(resolved.actualPath)) continue;
      seenTex.add(resolved.actualPath);
      try {
        scan(readFileSync(resolved.readPath, 'utf8'), path.dirname(resolved.actualPath), depth + 1);
      } catch {
        /* the file disappeared after stat; the watcher will retry */
      }
    }
  };
  scan(seg.text, seg.resourceBaseDir ?? context.docDir ?? context.workDir);
  if (!specs.length && !externalGraphics) return seg;
  return {
    ...seg,
    externalGraphics,
    hash: fnv1a(`${seg.text}|resources|${specs.sort().join('|')}|gfx:${externalGraphics ? 1 : 0}`),
  };
}

function stripTexComments(text) {
  return String(text)
    .split(/\r?\n/)
    .map((line) => {
      for (let i = 0; i < line.length; i++) {
        if (line[i] !== '%') continue;
        let slashes = 0;
        for (let j = i - 1; j >= 0 && line[j] === '\\'; j--) slashes++;
        if (slashes % 2 === 0) return line.slice(0, i);
      }
      return line;
    })
    .join('\n');
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
