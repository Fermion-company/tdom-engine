import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { fnv1a } from './hash.js';
import { resolveProjectInput, withProjectInputs } from './project-inputs.js';

const execFileP = promisify(execFile);

export function describeExternalBibliography(source, docDir, overlayDir = null) {
  const clean = collectProjectSource(String(source || ''), docDir, overlayDir);
  const addResources = [...clean.matchAll(/\\addbibresource\s*(?:\[[^\]]*\]\s*)?\{([^}]+)\}/g)]
    .map((m) => m[1].trim())
    .filter(Boolean);
  const classic = [...clean.matchAll(/\\bibliography\s*\{([^}]+)\}/g)]
    .flatMap((m) => m[1].split(','))
    .map((name) => name.trim())
    .filter(Boolean);
  const kind = addResources.length ? 'biblatex' : classic.length ? 'bibtex' : null;
  if (!kind) return null;

  const data = kind === 'biblatex' ? addResources : classic;
  const style = clean.match(/\\bibliographystyle\s*\{([^}]+)\}/)?.[1]?.trim() || 'plain';
  const citations = [];
  for (const m of clean.matchAll(/\\[a-zA-Z]*[cC]ite[a-zA-Z]*\*?\s*(?:\[[^\]]*\]\s*)*\{([^}]+)\}/g)) {
    for (const key of m[1].split(',')) {
      const trimmed = key.trim();
      if (trimmed && !citations.includes(trimmed)) citations.push(trimmed);
    }
  }
  const files = data.map((name) => {
    const withExt = /\.bib$/i.test(name) ? name : `${name}.bib`;
    return path.resolve(docDir, withExt);
  });
  const backend = kind === 'biblatex' && /backend\s*=\s*bibtex\b/i.test(clean) ? 'bibtex' : 'biber';
  const signature = fnv1a(JSON.stringify({ kind, data, style, citations, backend }));
  return { kind, data, style, citations, files, backend, signature };
}

function collectProjectSource(source, docDir, overlayDir, seen = new Set(), depth = 0) {
  const clean = stripComments(source);
  if (depth >= 8) return clean;
  const parts = [clean];
  for (const match of clean.matchAll(/\\(?:input|include)\s*\{([^}]+)\}/g)) {
    let rel = match[1].trim();
    if (!rel || /[\\#{}]/.test(rel)) continue;
    const resolved = resolveProjectInput(rel, { docDir, overlayDir, extensions: ['.tex'] });
    if (!resolved || seen.has(resolved.actualPath)) continue;
    seen.add(resolved.actualPath);
    try {
      parts.push(collectProjectSource(readFileSync(resolved.readPath, 'utf8'), docDir, overlayDir, seen, depth + 1));
    } catch {
      /* TeX reports the missing include; bibliography stays last-good */
    }
  }
  return parts.join('\n');
}

export async function prepareExternalBibliography({
  source,
  descriptor,
  docDir,
  documentFile = 'main.tex',
  workDir,
  canonicalWorkDir,
  overlayDir = null,
}) {
  mkdirSync(workDir, { recursive: true });
  mkdirSync(canonicalWorkDir, { recursive: true });
  const driverBbl = path.join(workDir, 'driver.bbl');
  const canonBbl = path.join(canonicalWorkDir, 'canon.bbl');
  if (!descriptor) {
    rmSync(driverBbl, { force: true });
    rmSync(canonBbl, { force: true });
    return { prepared: false, files: [] };
  }

  try {
    if (descriptor.kind === 'bibtex') {
      await prepareClassicBibtex(descriptor, docDir, overlayDir, workDir, driverBbl);
    } else {
      await prepareBiblatex(source, descriptor, docDir, overlayDir, workDir, driverBbl);
    }
    copyFileSync(driverBbl, canonBbl);
    return { prepared: true, files: descriptor.files };
  } catch (error) {
    // A normal build may already have produced the exact .bbl. It is a safe
    // last-good fallback when BibTeX/Biber is temporarily unavailable or the
    // editor is between two valid citation-key states.
    const base = path.basename(documentFile, path.extname(documentFile));
    const existing = path.join(docDir, `${base}.bbl`);
    if (existsSync(driverBbl)) {
      if (!existsSync(canonBbl)) copyFileSync(driverBbl, canonBbl);
      return { prepared: true, files: descriptor.files, warning: String(error?.message || error) };
    }
    if (existsSync(existing)) {
      copyFileSync(existing, driverBbl);
      copyFileSync(existing, canonBbl);
      return { prepared: true, files: descriptor.files, warning: String(error?.message || error) };
    }
    throw error;
  }
}

async function prepareClassicBibtex(descriptor, docDir, overlayDir, workDir, driverBbl) {
  const stage = path.join(workDir, 'bibtex');
  rmSync(stage, { recursive: true, force: true });
  mkdirSync(stage, { recursive: true });
  const job = 'tdom-bibtex';
  const aux = ['\\relax'];
  if (descriptor.citations.length) aux.push(`\\citation{${descriptor.citations.join(',')}}`);
  aux.push(`\\bibstyle{${descriptor.style}}`);
  aux.push(`\\bibdata{${descriptor.data.map((name) => name.replace(/\.bib$/i, '')).join(',')}}`);
  aux.push('');
  writeFileSync(path.join(stage, `${job}.aux`), aux.join('\n'), 'utf8');
  try {
    await execFileP('bibtex', [job], {
      cwd: stage,
      timeout: Number(process.env.TDOM_BIB_TIMEOUT || 60_000),
      maxBuffer: 16 * 1024 * 1024,
      env: bibliographyEnv(docDir, overlayDir),
    });
  } catch (error) {
    // BibTeX returns failure for an empty citation set. The correct visible
    // result is an empty bibliography, not a stale list from another file.
    if (!descriptor.citations.length) {
      writeFileSync(driverBbl, '\\begin{thebibliography}{1}\n\\end{thebibliography}\n', 'utf8');
      return;
    }
    throw new Error(bibliographyError('BibTeX', error));
  }
  const generated = path.join(stage, `${job}.bbl`);
  if (!existsSync(generated)) throw new Error('BibTeX produced no bibliography output');
  copyFileSync(generated, driverBbl);
}

async function prepareBiblatex(source, descriptor, docDir, overlayDir, workDir, driverBbl) {
  const stage = path.join(workDir, 'biblatex');
  rmSync(stage, { recursive: true, force: true });
  mkdirSync(stage, { recursive: true });
  const tex = path.join(stage, 'tdom-bib.tex');
  writeFileSync(tex, String(source || '').replace(/\r\n?/g, '\n'), 'utf8');
  const common = {
    cwd: docDir,
    timeout: Number(process.env.TDOM_BIB_TIMEOUT || 60_000),
    maxBuffer: 32 * 1024 * 1024,
    env: bibliographyEnv(docDir, overlayDir),
  };
  try {
    await execFileP(
      'lualatex',
      ['-interaction=nonstopmode', '-halt-on-error', '-draftmode', '-jobname=tdom-bib', `-output-directory=${stage}`, tex],
      common
    );
    const backend = descriptor.backend === 'bibtex' ? 'bibtex' : 'biber';
    await execFileP(backend, ['tdom-bib'], { ...common, cwd: stage });
  } catch (error) {
    throw new Error(bibliographyError(descriptor.backend === 'bibtex' ? 'BibTeX' : 'Biber', error));
  }
  const generated = path.join(stage, 'tdom-bib.bbl');
  if (!existsSync(generated)) throw new Error('Biber produced no tdom-bib.bbl');
  copyFileSync(generated, driverBbl);
}

function bibliographyEnv(docDir, overlayDir) {
  return withProjectInputs(process.env, { docDir, overlayDir, recursive: true });
}

function bibliographyError(tool, error) {
  const output = `${error?.stdout || ''}\n${error?.stderr || ''}`.trim();
  const tail = output.split(/\r?\n/).slice(-12).join('\n');
  return `${tool} failed${tail ? `: ${tail}` : `: ${error?.message || error}`}`;
}

function stripComments(source) {
  return source
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
