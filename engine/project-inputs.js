import { existsSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const inside = (root, candidate) => {
  const rel = path.relative(root, candidate);
  return rel === '' || (!rel.startsWith(`..${path.sep}`) && rel !== '..' && !path.isAbsolute(rel));
};

// Kpathsea interprets these characters before it opens directories. Keep
// the links outside the project so recursive searches cannot follow a cycle.
const inputLinks = new Map();
const linkedDirectories = new Map();
let linkRoot;
function needsInputLink(dir) {
  return /[{};$:~]/.test(process.platform === 'win32' ? dir.replace(/^[A-Za-z]:/, '') : dir);
}
function searchDirectory(dir) {
  if (!needsInputLink(dir)) return dir;
  if (!linkRoot) {
    let parent = tmpdir();
    if (needsInputLink(parent)) parent = process.platform === 'win32' ? path.join(process.env.SystemRoot, 'Temp') : '/tmp';
    linkRoot = mkdtempSync(path.join(realpathSync(parent), 'tdom-inputs-'));
    process.once('exit', () => rmSync(linkRoot, { recursive: true, force: true }));
  }
  if (!inputLinks.has(dir)) {
    const link = path.join(linkRoot, String(inputLinks.size));
    symlinkSync(dir, link, process.platform === 'win32' ? 'junction' : 'dir');
    inputLinks.set(dir, link);
    linkedDirectories.set(link, dir);
  }
  return inputLinks.get(dir);
}

export function originalSearchInput(file) {
  if (!linkRoot || !inside(linkRoot, file)) return file;
  const [id, ...parts] = path.relative(linkRoot, file).split(path.sep);
  const directory = linkedDirectories.get(path.join(linkRoot, id));
  return directory ? path.join(directory, ...parts) : file;
}

export function withProjectInputs(env, { docDir, overlayDir = null, sourceDir = docDir, recursive = false } = {}) {
  const roots = [overlayDir, docDir].filter(Boolean).map(dir => path.resolve(dir));
  const paths = roots.map(dir => searchDirectory(dir) + (recursive ? '//' : ''));
  // Staged Build searches beside the root manuscript before the workspace.
  // An unsaved file shadows only the disk copy at the same logical path.
  if (sourceDir && docDir && path.resolve(sourceDir) !== path.resolve(docDir) && inside(docDir, sourceDir)) {
    const relative = path.relative(docDir, sourceDir);
    paths.unshift(...roots.map(dir => searchDirectory(path.join(dir, relative))), ...roots.map(searchDirectory));
  }
  const prefix = [...new Set(paths)].join(path.delimiter);
  const prepend = (current) => prefix ? `${prefix}${path.delimiter}${current || ''}` : current || '';
  return {
    ...env,
    TEXINPUTS: prepend(env?.TEXINPUTS),
    LUAINPUTS: prepend(env?.LUAINPUTS),
    BIBINPUTS: prepend(env?.BIBINPUTS),
    BSTINPUTS: prepend(env?.BSTINPUTS),
    TEXPICTS: prepend(env?.TEXPICTS),
  };
}

/** Resolve a project input while allowing an unsaved overlay to shadow disk.
 * `actualPath` stays stable for source identity; `readPath` is the bytes TeX
 * and the JS scanners must consume right now. */
export function resolveProjectInput(
  raw,
  { docDir, overlayDir = null, sourceDir = docDir, baseDir = sourceDir, extensions = [], searchDirs = [], onMissing } = {}
) {
  const value = String(raw || '').trim();
  if (!value || /[\\#{}]/.test(value)) return null;
  const root = path.resolve(docDir);
  const bases = [baseDir, sourceDir, root, ...searchDirs]
    .filter(Boolean)
    .map((dir) => path.resolve(dir))
    .filter((dir, index, all) => all.indexOf(dir) === index);
  const missing = onMissing ? [] : null;
  for (const baseDirPath of bases) {
    const base = path.isAbsolute(value) ? path.resolve(value) : path.resolve(baseDirPath, value);
    const candidates = [base];
    if (!path.extname(base)) for (const ext of extensions) candidates.push(base + ext);
    for (const actualPath of candidates) {
      const overlayPath = overlayDir && inside(root, actualPath)
        ? path.join(overlayDir, path.relative(root, actualPath)) : null;
      const overlay = Boolean(overlayPath && existsSync(overlayPath));
      if (overlay || existsSync(actualPath)) {
        for (const candidate of missing ?? []) onMissing(candidate);
        return { actualPath, readPath: overlay ? overlayPath : actualPath, overlay };
      }
    }
    if (missing) for (const candidate of candidates) {
      if (inside(root, candidate)) missing.push(candidate);
    }
  }
  for (const candidate of missing ?? []) onMissing(candidate);
  return null;
}

export function isPathInside(root, candidate) {
  return inside(path.resolve(root), path.resolve(candidate));
}
