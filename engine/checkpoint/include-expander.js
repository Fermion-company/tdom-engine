import { readFileSync, statSync, watch, watchFile, unwatchFile } from 'node:fs';
import path from 'node:path';
import { fnv1a } from '../hash.js';
import { segmentBody } from '../segmenter.js';
import { isPathInside, resolveProjectInput } from '../project-inputs.js';
import { expandInputParagraphs } from './mapped-inputs.js';
import { cacheIncludeRead, includeTextCurrent, overlayContentSig, resourceContentSig } from './include-cache.js';
import { documentBodyRange } from './subfile.js';

export function expandIncludes(segs, depth, context) {
  if (depth > 3) return segs;
  if (depth === 0) {
    // Share the root's graphics search path across chapters. Most documents
    // use no such directive; parse it only when an image asks for it.
    const root = context.docDir ?? context.workDir;
    let paths;
    context = { ...context, graphicDirs: () => paths ??= projectGraphicDirs(context.source, root, context.sourceDir ?? root) };
    segs = expandInputParagraphs(segs, context);
  }
  const out = [];
  for (let segmentIndex = 0; segmentIndex < segs.length; segmentIndex++) {
    const seg = segs[segmentIndex];
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
    const m = seg.text.match(/^\s*\\(input|include|subfile)\s*\{([^}]+)\}\s*$/);
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
      sourceDir: context.sourceDir,
      baseDir: seg.resourceBaseDir ?? context.sourceDir ?? context.docDir ?? context.workDir,
      extensions: ['.tex'],
      onMissing: context.watchInclude,
    });
    const expanded = resolved
      ? expandTextFile(
          resolved.actualPath,
          depth,
          context,
          resolved.readPath,
          resolved.overlay,
          depth === 0 ? segmentIndex + 1 : context.rootUnit,
          command === 'subfile'
        )
      : null;
    if (resolved) {
      context.includeTrace?.push({
        actualPath: resolved.actualPath,
        readPath: resolved.readPath,
        command,
        raw: rel,
        depth,
        parentFile: path.resolve(context.docDir ?? context.workDir, seg.file ?? context.file),
        rootUnit: depth === 0 ? segmentIndex + 1 : context.rootUnit ?? null,
      });
    }
    if (!expanded) {
      context.diagnostics.push(`\\${command} file not found: ${rel} (typeset literally)`);
      out.push(seg);
      continue;
    }
    if (command === 'subfile') {
      // subfiles.sty: the chapter's own preamble and \end{document} are
      // skipped, the body runs in a group with the chapter's folder on the
      // input paths. Without the expansion a book made of \subfile lines was
      // one block, and every keystroke re-typeset all of it.
      out.push(...wrapSubfileBlocks(expanded, rel, path.dirname(resolved.actualPath) + path.sep));
    } else if (command === 'include') {
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
  const text = String(source || '');
  // (asked with every keystroke of the whole root: a source that does not
  // say the word is not read line by line for it. 0.45 ms on an 826 KB file.)
  if (!text.includes('\\includeonly')) return null;
  const match = text.match(/^[^%\n]*\\includeonly\s*\{([^}]*)\}/m);
  if (!match) return null;
  return new Set(match[1].split(',').map(normalizeIncludeName).filter(Boolean));
}

function normalizeIncludeName(value) {
  return String(value || '').trim().replace(/\\/g, '/').replace(/\.tex$/i, '').replace(/^\.\//, '');
}

// Per project (keyed by its include cache): the expansion of each file that
// reads no other file, for as long as its text stays the same.
const leafExpansions = new WeakMap();
const READS_ANOTHER_FILE = /\\(?:input|include|includeonly|subfile|subfileinclude|import|subimport|inputfrom|subinputfrom|includefrom|subincludefrom|InputIfFileExists|IfFileExists|printindex|bibliography|printbibliography|verbatiminput|lstinputlisting|inputminted)(?![A-Za-z@])/;

function expandTextFile(full, depth, context, readPath = full, overlay = false, rootUnit = null, documentBody = false) {
  try {
    const st = statSync(readPath);
    const cached = context.includes.get(full);
    const text = includeTextCurrent(cached, st, readPath, overlay)
      ? cached.text
      : readFileSync(readPath, 'utf8');
    cacheIncludeRead(context.includes, full, { mtime: st.mtimeMs, size: st.size, readPath, text });
    context.watchInclude(readPath);
    // A \subfile contributes only its document body; offsets stay those of
    // the whole file so every block still maps to its real lines.
    const range = documentBody ? documentBodyRange(text) : null;
    const bodyStart = range ? range.start : 0;
    const bodyText = range ? text.slice(range.start, range.end) : text;
    // A keystroke re-expands the whole project. A file that reads no other
    // file expands to the same blocks while its text is the same: a book of
    // thirty chapters re-segmented all of them (1.6 MB) for one letter.
    const leaf = !READS_ANOTHER_FILE.test(bodyText);
    const memoKey = leaf ? `${readPath}|${documentBody ? 1 : 0}|${depth}|${JSON.stringify([...(context.literalEnvs ?? [])])}` : null;
    const memos = leaf ? leafExpansions.get(context.includes) ?? leafExpansions.set(context.includes, new Map()).get(context.includes) : null;
    const memo = memos?.get(full);
    if (memo && memo.key === memoKey && memo.text === text && memo.rootUnit === rootUnit) {
      return memo.segs.map((seg, i) => {
        const resource = memo.resources?.get(i);
        if (!resource) return { ...seg };
        // The chapter text and source ranges are unchanged, but the bytes
        // read by a figure or plot may have changed since its segmentation.
        const current = decorateExternalResources(resource, context);
        return { ...seg, hash: fnv1a(`${full}|${current.hash}`) };
      });
    }
    const diagnosticsBefore = context.diagnostics?.length ?? 0;
    const local = expandInputParagraphs(segmentBody(bodyText, bodyStart, { literalEnvs: context.literalEnvs }), {
      ...context,
      source: text,
      file: full,
      rootUnit,
      structuralEvents: [],
    }).map(seg => ({ ...seg, resourceBaseDir: seg.resourceBaseDir ?? path.dirname(full) }));
    const subs = expandIncludes(local, depth + 1, { ...context, file: full, rootUnit });
    const starts = lineStarts(text);
    const expanded = subs.map((s) => {
      const direct = !s.file;
      return {
        ...s,
        file: s.file ?? full,
        sourceStart: s.sourceStart ?? (direct ? offsetPosition(text, starts, s.start) : undefined),
        sourceEnd: s.sourceEnd ?? (direct ? offsetPosition(text, starts, s.end) : undefined),
        hash: fnv1a(`${full}|${s.hash}`),
      };
    });
    if (memos) {
      // only what came from this file's own text, and said nothing while it did
      if (local.length === subs.length && subs.every((seg) => !seg.file) && (context.diagnostics?.length ?? 0) === diagnosticsBefore) {
        let resources;
        local.forEach((seg, i) => {
          if (READS_A_RESOURCE.test(seg.text)) (resources ??= new Map()).set(i, seg);
        });
        memos.set(full, { key: memoKey, text, rootUnit, resources, segs: expanded.map((seg) => ({ ...seg })) });
      } else {
        memos.delete(full);
      }
    }
    return expanded;
  } catch {
    return null;
  }
}

function wrapSubfileBlocks(expanded, rel, dir) {
  if (!expanded.length) return [];
  const blocks = expanded.map((block) => ({ ...block, importDir: block.importDir ?? dir }));
  blocks[0].subfileStart = true;
  blocks[0].hash = fnv1a(`subfile-open|${rel}|${blocks[0].hash}`);
  const last = blocks.length - 1;
  blocks[last].subfileEnd = true;
  blocks[last].hash = fnv1a(`subfile-close|${rel}|${blocks[last].hash}`);
  return blocks;
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

// Every keystroke re-expands every \input file; counting newlines from the
// file's start for each block was quadratic per file (about 10 ms a
// keystroke on the 316-page book, tex64-internal #85).
function lineStarts(text) {
  const starts = [0];
  for (let at = text.indexOf('\n'); at >= 0; at = text.indexOf('\n', at + 1)) starts.push(at + 1);
  return starts;
}

function offsetPosition(text, starts, offset) {
  const safe = Math.max(0, Math.min(text.length, Number(offset) || 0));
  let lo = 0;
  let hi = starts.length;
  while (lo + 1 < hi) {
    const mid = (lo + hi) >>> 1;
    if (starts[mid] <= safe) lo = mid;
    else hi = mid;
  }
  return { line: lo + 1, column: safe - starts[lo] + 1 };
}

// Files consumed by TeX without entering the source DOM still participate in
// block identity, by content (a touch changes nothing). A replacement
// PNG/PDF/listing marks only its owning block dirty; the watcher then calls
// engine.refresh(), preserving stale pixels until the fresh exact chunk lands.
// Every command the scan below looks for; a block naming none of them (nearly
// all of a book's 3,400) is returned as it is, without the comment strip and
// the seven sweeps that ran for each one on every keystroke.
const READS_A_RESOURCE = /\\(?:includegraphics|includepdf|lstinputlisting|verbatiminput|inputminted|addplot|input|include|printindex)/;

function projectGraphicDirs(source, root, sourceDir) {
  if (!source?.includes('\\graphicspath')) return [];
  const dirs = new Set();
  const literal = /\\graphicspath\s*\{\s*((?:\{[^{}\\%#]*\}\s*)+)\}/g;
  for (const declaration of stripTexComments(source).matchAll(literal)) {
    for (const entry of declaration[1].matchAll(/\{([^{}]+)\}/g)) {
      const dir = path.resolve(sourceDir, entry[1].trim());
      if (isPathInside(root, dir)) dirs.add(dir);
    }
  }
  return [...dirs];
}

function decorateExternalResources(seg, context) {
  if (!READS_A_RESOURCE.test(seg.text)) return seg;
  const specs = [];
  const seenTex = new Set();
  let externalGraphics = false;
  const add = (raw, extensions = [], baseDir = context.docDir ?? context.workDir, searchDirs = []) => {
    const resolved = resolveProjectInput(raw, {
      docDir: context.docDir ?? context.workDir,
      overlayDir: context.overlayDir,
      sourceDir: context.sourceDir,
      baseDir,
      extensions, searchDirs,
      onMissing: context.watchInclude,
    });
    if (!resolved) return null;
    try {
      const st = statSync(resolved.readPath);
      if (!st.isFile()) return null;
      context.watchInclude(resolved.readPath);
      const contentSig = resolved.overlay
        ? overlayContentSig(context.includes, resolved.actualPath, resolved.readPath, st)
        : resourceContentSig(context.resources, resolved.readPath, st);
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
      add(m[1], ['.pdf', '.png', '.jpg', '.jpeg', '.mps', '.eps'], baseDir, context.graphicDirs?.());
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
  scan(seg.text, seg.resourceBaseDir ?? context.sourceDir ?? context.docDir ?? context.workDir);
  // \printindex reads \jobname.ind, which the engine copies from canonical's
  // makeindex run. Its signature makes the index block dirty when the index
  // arrives or changes, so the resident retypesets it on the next update.
  if (context.workDir && /\\printindex\b/.test(stripTexComments(seg.text))) {
    try {
      const st = statSync(path.join(context.workDir, 'driver.ind'));
      specs.push(`index:${st.mtimeMs}:${st.size}`);
    } catch {
      specs.push('index:none');
    }
  }
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

// A missing chapter or figure has no inode to watch. Share one inexpensive
// directory stat poll among missing siblings, including when the directory
// itself has not been created yet. Existing files keep native notifications.
const missingDirectories = new WeakMap();
function waitForInput(full, watchers, found) {
  let dirs = missingDirectories.get(watchers);
  if (!dirs) missingDirectories.set(watchers, dirs = new Map());
  const dir = path.dirname(full);
  let group = dirs.get(dir);
  if (!group) {
    const probes = new Set();
    const check = () => { for (const probe of [...probes]) probe(); };
    group = { probes, check };
    dirs.set(dir, group);
    watchFile(dir, { persistent: false, interval: 600 }, check);
  }
  const probe = () => { if (fileIdentity(full)) found(); };
  group.probes.add(probe);
  return () => {
    group.probes.delete(probe);
    if (group.probes.size) return;
    unwatchFile(dir, group.check);
    dirs.delete(dir);
  };
}

export function watchInclude(full, watchers, onExternalChange) {
  if (watchers.has(full)) return;
  let timer = null, live = null, stopWaiting = null, closed = false;
  const handle = {
    close() {
      closed = true;
      clearTimeout(timer);
      live?.close();
      stopWaiting?.();
    },
  };
  const signal = () => {
    clearTimeout(timer);
    timer = setTimeout(() => { if (!closed) onExternalChange?.(full); }, 120);
  };
  const arm = () => {
    if (closed) return;
    const identity = fileIdentity(full);
    try {
      const w = watch(full, event => {
        if (closed || w !== live) return;
        if (event === 'rename' || fileIdentity(full) !== identity) {
          w.close();
          live = null;
          arm();
        }
        signal();
      });
      live = w;
    } catch (error) {
      if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') return;
      const found = () => {
        if (closed || !stopWaiting) return;
        stopWaiting();
        stopWaiting = null;
        arm();
        signal();
      };
      stopWaiting = waitForInput(full, watchers, found);
      // The file may have appeared between the failed watch and subscription.
      if (fileIdentity(full)) found();
    }
  };
  arm();
  if (live || stopWaiting) watchers.set(full, handle);
}

function fileIdentity(file) {
  try {
    const st = statSync(file);
    return `${st.dev}:${st.ino}`;
  } catch {
    return null;
  }
}
