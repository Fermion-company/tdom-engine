import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { fnv1a } from './hash.js';
import { resolveProjectInput, withProjectInputs } from './project-inputs.js';

const execFileP = promisify(execFile);

export function describeExternalBibliography(source, docDir, overlayDir = null, sourceDir = docDir) {
  const facts = collectProjectFacts(String(source || ''), docDir, overlayDir, sourceDir);
  const addResources = facts.flatMap((file) => file.addResources);
  const classic = facts.flatMap((file) => file.classic);
  const kind = addResources.length ? 'biblatex' : classic.length ? 'bibtex' : null;
  if (!kind) return null;

  const data = kind === 'biblatex' ? addResources : classic;
  const style = facts.find((file) => file.style)?.style || 'plain';
  const citations = [];
  for (const file of facts) {
    for (const key of file.citations) if (!citations.includes(key)) citations.push(key);
  }
  const watchFiles = new Set();
  const files = data.map((name) => {
    const withExt = /\.bib$/i.test(name) ? name : `${name}.bib`;
    const found = resolveProjectInput(withExt, { docDir, overlayDir, sourceDir, onMissing: file => watchFiles.add(file) });
    const file = found?.actualPath ?? path.resolve(sourceDir, withExt);
    watchFiles.add(file);
    return file;
  });
  const backend = kind === 'biblatex' && facts.some((file) => file.bibtexBackend) ? 'bibtex' : 'biber';
  const signature = fnv1a(JSON.stringify({ kind, data, style, citations, backend }));
  return { kind, data, style, citations, files, watchFiles: [...watchFiles], backend, signature };
}

// What one file says about the bibliography and which files it reads in.
// The description is asked for at every edit, and it used to read and scan
// every \input and \include file of the project each time (a book of ten
// chapter files: 3.9 ms of every keystroke; the files of a larger one, more).
// A file's facts are kept until the file changes (its size or the time it was
// written: an unsaved overlay is written again at each edit of that file).
function sourceFacts(text) {
  const clean = stripComments(text);
  const citations = [];
  for (const m of clean.matchAll(/\\[a-zA-Z]*[cC]ite[a-zA-Z]*\*?\s*(?:\[[^\]]*\]\s*)*\{([^}]+)\}/g)) {
    for (const key of m[1].split(',')) {
      const trimmed = key.trim();
      if (trimmed && !citations.includes(trimmed)) citations.push(trimmed);
    }
  }
  return {
    includes: [...clean.matchAll(/\\(?:input|include)\s*\{([^}]+)\}/g)]
      .map((m) => m[1].trim())
      .filter((rel) => rel && !/[\\#{}]/.test(rel)),
    addResources: [...clean.matchAll(/\\addbibresource\s*(?:\[[^\]]*\]\s*)?\{([^}]+)\}/g)]
      .map((m) => m[1].trim())
      .filter(Boolean),
    classic: [...clean.matchAll(/\\bibliography\s*\{([^}]+)\}/g)]
      .flatMap((m) => m[1].split(','))
      .map((name) => name.trim())
      .filter(Boolean),
    style: clean.match(/\\bibliographystyle\s*\{([^}]+)\}/)?.[1]?.trim() || null,
    citations,
    bibtexBackend: /backend\s*=\s*bibtex\b/i.test(clean),
  };
}

const fileFacts = new Map(); // read path -> { size, mtimeMs, facts }
let rootFacts = null; // { source, facts } of the root text last described

function factsOfFile(readPath) {
  const stat = statSync(readPath);
  const held = fileFacts.get(readPath);
  if (held && held.size === stat.size && held.mtimeMs === stat.mtimeMs) return held.facts;
  const facts = sourceFacts(readFileSync(readPath, 'utf8'));
  if (fileFacts.size >= 2048) fileFacts.clear();
  fileFacts.set(readPath, { size: stat.size, mtimeMs: stat.mtimeMs, facts });
  return facts;
}

/** The facts of the root text and of every file it reads in, in reading order. */
function collectProjectFacts(source, docDir, overlayDir, sourceDir) {
  if (rootFacts?.source !== source) rootFacts = { source, facts: sourceFacts(source) };
  const all = [];
  const seen = new Set();
  const visit = (facts, depth) => {
    all.push(facts);
    if (depth >= 8) return;
    for (const rel of facts.includes) {
      const resolved = resolveProjectInput(rel, { docDir, overlayDir, sourceDir, extensions: ['.tex'] });
      if (!resolved || seen.has(resolved.actualPath)) continue;
      seen.add(resolved.actualPath);
      let child;
      try {
        child = factsOfFile(resolved.readPath);
      } catch {
        continue; /* TeX reports the missing include; bibliography stays last-good */
      }
      visit(child, depth + 1);
    }
  };
  visit(rootFacts.facts, 0);
  return all;
}

export async function prepareExternalBibliography({
  source,
  descriptor,
  docDir,
  documentFile = 'main.tex',
  sourceDir = path.dirname(path.resolve(docDir, documentFile)),
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

  const env = withProjectInputs(process.env, { docDir, overlayDir, sourceDir, recursive: true });
  try {
    if (descriptor.kind === 'bibtex') {
      await prepareClassicBibtex(descriptor, env, workDir, driverBbl);
    } else {
      await prepareBiblatex(source, descriptor, docDir, env, workDir, driverBbl);
    }
    replaceFile(canonBbl, driverBbl);
    return { prepared: true, files: descriptor.files };
  } catch (error) {
    // A normal build may already have produced the exact .bbl. It is a safe
    // last-good fallback when BibTeX/Biber is temporarily unavailable or the
    // editor is between two valid citation-key states.
    const base = path.basename(documentFile, path.extname(documentFile));
    const existing = path.join(sourceDir, `${base}.bbl`);
    if (existsSync(driverBbl)) {
      if (!existsSync(canonBbl)) replaceFile(canonBbl, driverBbl);
      return { prepared: true, files: descriptor.files, warning: String(error?.message || error) };
    }
    if (existsSync(existing)) {
      replaceFile(driverBbl, existing);
      replaceFile(canonBbl, existing);
      return { prepared: true, files: descriptor.files, warning: String(error?.message || error) };
    }
    throw error;
  }
}

async function prepareClassicBibtex(descriptor, env, workDir, driverBbl) {
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
      env,
    });
  } catch (error) {
    // BibTeX returns failure for an empty citation set. The correct visible
    // result is an empty bibliography, not a stale list from another file.
    if (!descriptor.citations.length) {
      replaceFile(driverBbl, null, '\\begin{thebibliography}{1}\n\\end{thebibliography}\n');
      return;
    }
    throw new Error(bibliographyError('BibTeX', error));
  }
  const generated = path.join(stage, `${job}.bbl`);
  if (!existsSync(generated)) throw new Error('BibTeX produced no bibliography output');
  replaceFile(driverBbl, generated);
}

async function prepareBiblatex(source, descriptor, docDir, env, workDir, driverBbl) {
  const stage = path.join(workDir, 'biblatex');
  rmSync(stage, { recursive: true, force: true });
  mkdirSync(stage, { recursive: true });
  const tex = path.join(stage, 'tdom-bib.tex');
  writeFileSync(tex, String(source || '').replace(/\r\n?/g, '\n'), 'utf8');
  const common = {
    cwd: docDir,
    timeout: Number(process.env.TDOM_BIB_TIMEOUT || 60_000),
    maxBuffer: 32 * 1024 * 1024,
    env,
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
  replaceFile(driverBbl, generated);
}

// The canonical compile reads canon.bbl and the resident driver re-expands
// driver.bbl while a citation edit regenerates them. An in-place write lets
// such a reader see a truncated file or split a UTF-8 sequence; a rename in
// the same directory swaps the whole file, so an open reader keeps the bytes
// it started with (same reason as the overlay writes in server.js).
function replaceFile(target, from, text = null) {
  const tmp = path.join(path.dirname(target), `.${path.basename(target)}.${process.pid}.tmp`);
  try {
    if (from) copyFileSync(from, tmp);
    else writeFileSync(tmp, text, 'utf8');
    renameSync(tmp, target);
  } catch (error) {
    rmSync(tmp, { force: true });
    throw error;
  }
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
