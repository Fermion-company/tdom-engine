import { existsSync } from 'node:fs';
import path from 'node:path';

const inside = (root, candidate) => {
  const rel = path.relative(root, candidate);
  return rel === '' || (!rel.startsWith(`..${path.sep}`) && rel !== '..' && !path.isAbsolute(rel));
};

export function withProjectInputs(env, { docDir, overlayDir = null, recursive = false } = {}) {
  const roots = [overlayDir, docDir].filter(Boolean).map((dir) => path.resolve(dir));
  const suffix = recursive ? '//' : '';
  const prefix = roots.map((dir) => `${dir}${suffix}`).join(path.delimiter);
  const prepend = (current) => prefix ? `${prefix}${path.delimiter}${current || ''}` : current || '';
  return {
    ...env,
    TEXINPUTS: prepend(env?.TEXINPUTS),
    LUAINPUTS: prepend(env?.LUAINPUTS),
    BIBINPUTS: prepend(env?.BIBINPUTS),
    BSTINPUTS: prepend(env?.BSTINPUTS),
  };
}

/** Resolve a project input while allowing an unsaved overlay to shadow disk.
 * `actualPath` stays stable for source identity; `readPath` is the bytes TeX
 * and the JS scanners must consume right now. */
export function resolveProjectInput(
  raw,
  { docDir, overlayDir = null, baseDir = docDir, extensions = [] } = {}
) {
  const value = String(raw || '').trim();
  if (!value || /[\\#{}]/.test(value)) return null;
  const root = path.resolve(docDir);
  const bases = [baseDir, root]
    .filter(Boolean)
    .map((dir) => path.resolve(dir))
    .filter((dir, index, all) => all.indexOf(dir) === index);
  for (const baseDirPath of bases) {
    const base = path.isAbsolute(value) ? path.resolve(value) : path.resolve(baseDirPath, value);
    const candidates = [base];
    if (!path.extname(base)) for (const ext of extensions) candidates.push(base + ext);
    for (const actualPath of candidates) {
      if (overlayDir && inside(root, actualPath)) {
        const overlayPath = path.join(path.resolve(overlayDir), path.relative(root, actualPath));
        if (existsSync(overlayPath)) return { actualPath, readPath: overlayPath, overlay: true };
      }
      if (existsSync(actualPath)) return { actualPath, readPath: actualPath, overlay: false };
    }
  }
  return null;
}

export function isPathInside(root, candidate) {
  return inside(path.resolve(root), path.resolve(candidate));
}
