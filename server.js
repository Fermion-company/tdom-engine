// Resident engine server.
//
// The TDOM engine lives in this process, holding the full document state
// between requests. Two display layers, strictly ranked:
//   - canonical: real lualatex output (async, always wins — /canonical/:n.svg)
//   - provisional: the fork-checkpointed resident lualatex chain painting
//     keystroke-synchronous display-list patches
//
// Clients are thin: the editor POSTs text deltas, the viewer applies
// display-list patches and converges each page to the canonical render
// (from the POST response and/or the SSE stream).
//
// lualatex + poppler are REQUIRED: the engine's first absolute condition is
// that the final display equals LuaLaTeX's real output, which no fallback
// engine can promise.

import http from 'node:http';
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, watch, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { promisify } from 'node:util';
import { CheckpointEngine } from './engine/checkpoint/engine-v3.js';
import {
  describeExternalBibliography,
  prepareExternalBibliography,
} from './engine/project-bibliography.js';
import { isPathInside } from './engine/project-inputs.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 4633);
const HOST_WEB_ROOT = path.isAbsolute(process.env.TDOM_HOST_WEB_ROOT || '')
  ? path.resolve(process.env.TDOM_HOST_WEB_ROOT)
  : null;

const TEMPLATES_DIR = path.join(ROOT, 'templates');
const CUSTOM_TEMPLATES_DIR = path.join(TEMPLATES_DIR, 'custom');
const UPLOADS_DIR = path.join(ROOT, 'samples', 'uploads');
const AI_PREVIEWS_DIR = path.join(ROOT, '.ai-previews');
const execFileP = promisify(execFile);

function templateFiles() {
  const out = [];
  function walk(dir, prefix = '') {
    try {
      for (const f of readdirSync(dir, { withFileTypes: true })) {
        if (f.isDirectory()) {
          walk(path.join(dir, f.name), `${prefix}${f.name}/`);
          continue;
        }
        if (f.isFile() && f.name.endsWith('.tex')) out.push({ id: `${prefix}${f.name.slice(0, -4)}`, file: path.join(dir, f.name) });
      }
    } catch {
      /* no templates dir */
    }
  }
  walk(TEMPLATES_DIR);
  return out;
}

function listTemplates() {
  const out = [];
  for (const entry of templateFiles()) {
    const head = readFileSync(entry.file, 'utf8').slice(0, 400);
    const name = head.match(/^%% name:\s*(.+)$/m)?.[1]?.trim() ?? entry.id;
    const desc = head.match(/^%% desc:\s*(.+)$/m)?.[1]?.trim() ?? '';
    out.push({ id: entry.id, name, desc, custom: entry.id.startsWith('custom/') });
  }
  out.sort((a, b) => a.id.localeCompare(b.id));
  return out;
}

function readTemplate(id) {
  if (!/^(?:custom\/)?[a-z0-9-]+$/i.test(id)) return null;
  const file = path.resolve(TEMPLATES_DIR, id + '.tex');
  if (!file.startsWith(TEMPLATES_DIR + path.sep)) return null;
  try {
    return readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

function slugifyTemplateName(name) {
  const ascii = String(name || 'template')
    .normalize('NFKD')
    .replace(/[^\w\s-]/g, '')
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  return ascii || `template-${Date.now()}`;
}

function saveCustomTemplate({ name, desc = '', source }) {
  if (typeof source !== 'string' || !source.trim()) throw new Error('template source is empty');
  if (source.length > 1_000_000) throw new Error('template source is too large');
  const cleanName = String(name || 'Custom template').trim().slice(0, 120) || 'Custom template';
  const cleanDesc = String(desc || '').replace(/\r?\n/g, ' ').trim().slice(0, 240);
  mkdirSync(CUSTOM_TEMPLATES_DIR, { recursive: true });
  const base = slugifyTemplateName(cleanName);
  let id = `custom/${base}`;
  let file = path.join(TEMPLATES_DIR, id + '.tex');
  let suffix = 2;
  while (existsSync(file)) {
    id = `custom/${base}-${suffix++}`;
    file = path.join(TEMPLATES_DIR, id + '.tex');
  }
  const body = source.replace(/^%% (?:name|desc):.*\n/gm, '').replace(/\s*$/, '\n');
  writeFileSync(file, `%% name: ${cleanName}\n%% desc: ${cleanDesc || 'ユーザー作成テンプレート'}\n${body}`, 'utf8');
  return { id, name: cleanName, desc: cleanDesc, custom: true };
}

function slugifyAssetName(name) {
  const parsed = path.parse(String(name || 'image.png'));
  const ext = parsed.ext.toLowerCase();
  const base =
    parsed.name
      .normalize('NFKD')
      .replace(/[^\w\s-]/g, '')
      .trim()
      .toLowerCase()
      .replace(/[\s_]+/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '') || `asset-${Date.now()}`;
  return { base, ext };
}

function saveUploadedAsset({ name, data }) {
  if (typeof data !== 'string' || !data) throw new Error('asset data is empty');
  const { base, ext } = slugifyAssetName(name);
  const allowed = new Set(['.png', '.jpg', '.jpeg', '.pdf']);
  if (!allowed.has(ext)) throw new Error('only png, jpg, jpeg, and pdf assets are supported');
  const bytes = Buffer.from(data, 'base64');
  if (!bytes.length) throw new Error('asset data is empty');
  if (bytes.length > 8 * 1024 * 1024) throw new Error('asset is too large');
  mkdirSync(UPLOADS_DIR, { recursive: true });
  let filename = `${base}${ext}`;
  let file = path.join(UPLOADS_DIR, filename);
  let suffix = 2;
  while (existsSync(file)) {
    filename = `${base}-${suffix++}${ext}`;
    file = path.join(UPLOADS_DIR, filename);
  }
  writeFileSync(file, bytes);
  return { filename, texPath: `uploads/${filename}`, url: `/assets/${filename}`, size: bytes.length };
}

function cleanTexPath(name) {
  const raw = String(name || 'part.tex').replace(/\\/g, '/').replace(/^\/+/, '');
  const parts = raw
    .split('/')
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const parsed = path.parse(part);
      const base =
        parsed.name
          .normalize('NFKD')
          .replace(/[^\w\s-]/g, '')
          .trim()
          .toLowerCase()
          .replace(/[\s_]+/g, '-')
          .replace(/-+/g, '-')
          .replace(/^-|-$/g, '') || 'file';
      return `${base}${parsed.ext.toLowerCase()}`;
    });
  const rel = parts.join('/') || 'part.tex';
  const ext = path.extname(rel).toLowerCase();
  const allowed = new Set(['.tex', '.sty', '.cls', '.bib']);
  if (!allowed.has(ext)) throw new Error('only tex, sty, cls, and bib files are supported');
  return rel;
}

function packageNameForTexPath(texPath) {
  return texPath.replace(/\.(sty|cls)$/i, '');
}

function saveUploadedTexFile({ name, text = '' }) {
  const rel = cleanTexPath(name);
  const body = String(text ?? '');
  if (body.length > 1_000_000) throw new Error('tex file is too large');
  mkdirSync(UPLOADS_DIR, { recursive: true });
  const file = path.resolve(UPLOADS_DIR, rel);
  if (!file.startsWith(UPLOADS_DIR + path.sep)) throw new Error('bad tex file path');
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, body.replace(/\r\n?/g, '\n'), 'utf8');
  const texPath = `uploads/${rel}`;
  return {
    filename: rel,
    texPath,
    packageName: packageNameForTexPath(texPath),
    size: Buffer.byteLength(body, 'utf8'),
  };
}

function listUploadedTexFiles() {
  const out = [];
  function walk(dir, prefix = '') {
    try {
      for (const f of readdirSync(dir, { withFileTypes: true })) {
        if (f.isDirectory()) {
          walk(path.join(dir, f.name), `${prefix}${f.name}/`);
          continue;
        }
        if (!f.isFile()) continue;
        const ext = path.extname(f.name).toLowerCase();
        if (!['.tex', '.sty', '.cls', '.bib'].includes(ext)) continue;
        const filename = `${prefix}${f.name}`;
        const texPath = `uploads/${filename}`;
        out.push({ filename, texPath, packageName: packageNameForTexPath(texPath) });
      }
    } catch {
      /* no uploaded tex files */
    }
  }
  walk(UPLOADS_DIR);
  out.sort((a, b) => a.filename.localeCompare(b.filename));
  return out;
}

function readUploadedTexFile(texPath) {
  const raw = String(texPath || '').replace(/^uploads\//, '');
  const rel = cleanTexPath(raw);
  const file = path.resolve(UPLOADS_DIR, rel);
  if (!file.startsWith(UPLOADS_DIR + path.sep)) throw new Error('bad tex file path');
  const text = readFileSync(file, 'utf8');
  return {
    filename: rel,
    texPath: `uploads/${rel}`,
    packageName: packageNameForTexPath(`uploads/${rel}`),
    text,
    size: Buffer.byteLength(text, 'utf8'),
  };
}

function previewId() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function texErrorExcerpt(log) {
  const lines = String(log || '').split(/\r?\n/);
  const start = lines.findIndex((line) => /^! /.test(line));
  if (start >= 0) return lines.slice(start, start + 8).join('\n');
  return lines.slice(-18).join('\n');
}

function serveAiPreview(res, name) {
  try {
    if (!/^[a-z0-9-]+\.pdf$/i.test(name)) throw new Error('bad preview name');
    const file = path.resolve(AI_PREVIEWS_DIR, name);
    if (!file.startsWith(AI_PREVIEWS_DIR + path.sep)) throw new Error('bad preview path');
    const body = readFileSync(file);
    res.writeHead(200, {
      'Content-Type': 'application/pdf',
      'Cache-Control': 'no-cache',
      'Content-Disposition': 'inline; filename="ai-style-preview.pdf"',
    });
    res.end(body);
  } catch {
    res.writeHead(404);
    res.end('not found');
  }
}

async function compilePreviewPdf(source) {
  const body = String(source || '');
  if (!body.trim()) throw new Error('preview source is empty');
  if (body.length > 1_000_000) throw new Error('preview source is too large');
  mkdirSync(AI_PREVIEWS_DIR, { recursive: true });
  const work = mkdtempSync(path.join(tmpdir(), 'fermion-ai-preview-'));
  try {
    const tex = path.join(work, 'preview.tex');
    writeFileSync(tex, body.replace(/\r\n?/g, '\n'), 'utf8');
    try {
      await execFileP('lualatex', ['-interaction=nonstopmode', '-halt-on-error', '-output-directory', work, tex], {
        cwd: path.join(ROOT, 'samples'),
        timeout: 60_000,
        env: {
          ...process.env,
          TEXINPUTS: `${path.join(ROOT, 'samples')}//:${ROOT}//:${process.env.TEXINPUTS || ''}`,
          LUAINPUTS: `${path.join(ROOT, 'samples')}//:${ROOT}//:${process.env.LUAINPUTS || ''}`,
        },
      });
    } catch (err) {
      const log = existsSync(path.join(work, 'preview.log')) ? readFileSync(path.join(work, 'preview.log'), 'utf8') : err.stderr || err.stdout || err.message;
      throw new Error(texErrorExcerpt(log));
    }
    const pdf = path.join(work, 'preview.pdf');
    if (!existsSync(pdf)) throw new Error('preview compile produced no PDF');
    const id = previewId();
    const dest = path.join(AI_PREVIEWS_DIR, `${id}.pdf`);
    writeFileSync(dest, readFileSync(pdf));
    return { id, url: `/ai-preview/${id}.pdf` };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

async function requireToolchain() {
  const missing = [];
  for (const [cmd, hint] of [
    ['lualatex', 'TeX Live (brew install --cask mactex-no-gui / apt install texlive-luatex)'],
    ['pdftocairo', 'poppler (brew install poppler / apt install poppler-utils)'],
  ]) {
    try {
      await execFileP(cmd, ['-v'], { timeout: 15_000 });
    } catch (err) {
      if (err?.code === 'ENOENT') missing.push(`${cmd} — ${hint}`);
      // any other exit means the binary exists and answered
    }
  }
  if (missing.length) {
    console.error(
      '[tdom] required toolchain missing (the final display must equal real LuaLaTeX output):\n' +
        missing.map((m) => `  - ${m}`).join('\n')
    );
    process.exit(1);
  }
}

await requireToolchain();
const backend = 'checkpoint';
// TDOM_WORKDIR isolates parallel instances (benchmarks, tests) — two
// engines sharing one workdir would clobber each other's driver/canonical.
// An absolute path is accepted verbatim so an embedding app (TeX64) can put
// the live state outside a read-only install location.
const rawWorkDir = (process.env.TDOM_WORKDIR || '').trim();
const workDirName = path.isAbsolute(rawWorkDir)
  ? rawWorkDir
  : /^[.a-z0-9_-]+$/i.test(rawWorkDir)
    ? rawWorkDir
    : '.tdom-v3';
// The work directory is a live process's private state (driver.tex, format,
// render jobs, canonical PDFs). TWO servers sharing one silently corrupt
// each other — a concurrently rewritten driver.tex reads back as NUL
// garbage and the boot demotes to opaque. A pid lockfile detects a living
// owner and moves this instance to a suffixed directory instead.
function claimWorkDir(base) {
  const dir = path.isAbsolute(base) ? base : path.join(ROOT, base);
  const lock = path.join(dir, '.tdom-owner');
  try {
    const pid = Number(readFileSync(lock, 'utf8'));
    if (pid && pid !== process.pid) {
      process.kill(pid, 0); // throws when the owner is gone
      const fallback = `${base}-${process.pid}`;
      console.warn(
        `[tdom] work dir ${base} is owned by live pid ${pid} — using ${fallback} instead`
      );
      return claimWorkDir(fallback);
    }
  } catch {
    /* no lock, stale lock, or unreadable — claim it */
  }
  mkdirSync(dir, { recursive: true });
  writeFileSync(lock, String(process.pid));
  sweepStaleArtifacts(dir, base);
  return dir;
}

// Previous sessions leave per-job artifacts behind (render/rescue job dirs,
// superseded canonical PDFs, fallback workdirs whose owner died). None are
// live state — the engine reconstructs everything — so reclaim the disk at
// boot instead of growing forever (observed: 464 render dirs / 73MB).
function sweepStaleArtifacts(dir, base) {
  try {
    for (const f of readdirSync(dir, { withFileTypes: true })) {
      if (f.isDirectory() && /^(render|rescue|iso)-/.test(f.name)) {
        rmSync(path.join(dir, f.name), { recursive: true, force: true });
      }
    }
  } catch { /* fresh dir */ }
  try {
    const canonDir = path.join(dir, 'canonical');
    for (const f of readdirSync(canonDir)) {
      if (/^canon(-\d+)?\.(pdf|svg)$/.test(f) || /^canon-\d+-p\d+\.svg$/.test(f)) {
        rmSync(path.join(canonDir, f), { force: true });
      }
    }
  } catch { /* no canonical dir yet */ }
  // sibling PID-fallback workdirs (.tdom-v3-<pid>) whose owner is gone.
  // Strictly `${base}-<digits>` WITH a dead-owner lockfile: anything else
  // (test workdirs like .tdom-v3-test carry no lock) is not ours to touch.
  try {
    const parent = path.isAbsolute(base) ? path.dirname(base) : ROOT;
    const baseName = path.basename(base);
    const fallbackRe = new RegExp(`^${baseName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}-\\d+$`);
    for (const f of readdirSync(parent, { withFileTypes: true })) {
      if (!f.isDirectory() || !fallbackRe.test(f.name)) continue;
      const sib = path.join(parent, f.name);
      let dead = false;
      try {
        const pid = Number(readFileSync(path.join(sib, '.tdom-owner'), 'utf8'));
        if (!pid) continue;
        process.kill(pid, 0); // throws when the owner is gone
      } catch (err) {
        dead = err?.code === 'ESRCH' || err?.code === 'ENOENT' ? err.code === 'ESRCH' : false;
      }
      if (dead) rmSync(sib, { recursive: true, force: true });
    }
  } catch { /* nothing to sweep */ }
  // AI style previews: keep only the newest handful
  try {
    const previews = readdirSync(AI_PREVIEWS_DIR)
      .filter((f) => f.endsWith('.pdf'))
      .sort();
    for (const f of previews.slice(0, Math.max(0, previews.length - 20))) {
      rmSync(path.join(AI_PREVIEWS_DIR, f), { force: true });
    }
  } catch { /* no previews dir */ }
}
const engine = new CheckpointEngine({
  workDir: claimWorkDir(workDirName),
  docDir: path.join(ROOT, 'samples'),
});
const PROJECT_OVERLAY_DIR = path.join(engine.workDir, 'project-overlay');
// TDOM_SAMPLE picks the boot document (tests use the small demo — booting
// the 70-page stress doc takes ~2 minutes)
const sampleFile = /^[a-z0-9-]+\.tex$/i.test(process.env.TDOM_SAMPLE || '')
  ? process.env.TDOM_SAMPLE
  : 'stress-test-ja.tex';
const sample = readFileSync(path.join(ROOT, 'samples', sampleFile), 'utf8');
let lastReport = await engine.open(sample);
// Monotonic identity of the document loaded into this resident process.
// Ordinary source edits stay within an epoch. A new root or a preamble
// reboot advances it before any client is allowed to discard old pixels.
let documentEpoch = 1;
let activeProject = {
  docDir: path.join(ROOT, 'samples'),
  file: sampleFile,
  filePath: path.join(ROOT, 'samples', sampleFile),
  overlayDir: null,
  overlays: new Map(),
  bibliography: describeExternalBibliography(sample, path.join(ROOT, 'samples')),
};
console.log(
  `[tdom] engine resident (${backend}): ${lastReport.stats.pageCount} pages, ` +
    `${lastReport.stats.blocksTotal} blocks, initial build ${(lastReport.stats.totalUs / 1000).toFixed(0)}ms`
);

// Serialize all engine mutations (compiles can take a while).
let queue = Promise.resolve();
// Engine-queue liveness for the /status pill: how many mutations are
// queued/running right now, and since when. This must be readable WITHOUT
// entering the queue — its whole point is telling a "long compile" apart
// from a dead server while the queue is occupied.
let engineBusy = 0;
let engineBusySince = 0;
function withEngine(fn) {
  engineBusy++;
  if (engineBusy === 1) engineBusySince = Date.now();
  const run = queue.then(fn).catch((error) => {
    // A failed open/reboot must not strand both frames in reset-pending.
    // The reset event lets the child resnapshot the last state it can
    // honestly render; its ready gate still keeps the host's static PDF up
    // when no complete exact page exists.
    completeDocumentReset();
    throw error;
  });
  queue = run.catch(() => {});
  run
    .catch(() => {})
    .finally(() => {
      engineBusy--;
      if (engineBusy === 0) engineBusySince = 0;
    });
  return run;
}

const bibliographyWatchers = new Map();
let bibliographyRefreshTimer = null;

function closeBibliographyWatchers() {
  clearTimeout(bibliographyRefreshTimer);
  bibliographyRefreshTimer = null;
  for (const watcher of bibliographyWatchers.values()) {
    try { watcher.close(); } catch { /* already closed */ }
  }
  bibliographyWatchers.clear();
}

function watchProjectBibliography(descriptor) {
  closeBibliographyWatchers();
  for (const file of descriptor?.files ?? []) {
    if (!existsSync(file) || bibliographyWatchers.has(file)) continue;
    try {
      const watcher = watch(file, () => {
        scheduleProjectBibliographyRefresh(file, 120);
      });
      bibliographyWatchers.set(file, watcher);
    } catch {
      /* watching is best-effort */
    }
  }
}

function scheduleProjectBibliographyRefresh(changedFile, delay = 450) {
  clearTimeout(bibliographyRefreshTimer);
  bibliographyRefreshTimer = setTimeout(() => refreshProjectBibliography(changedFile), delay);
}

async function materializeProjectBibliography(source, context) {
  const descriptor = describeExternalBibliography(source, context.docDir, context.overlayDir);
  const result = await prepareExternalBibliography({
    source,
    descriptor,
    docDir: context.docDir,
    documentFile: context.file,
    workDir: engine.workDir,
    canonicalWorkDir: engine.canonical.workDir,
    overlayDir: context.overlayDir,
  });
  if (result.warning) console.warn('[tdom] bibliography kept last-good output:', result.warning);
  context.bibliography = descriptor;
  watchProjectBibliography(descriptor);
  return descriptor;
}

function applyProjectOverlays(context, { overlays = [], removeOverlays = [] } = {}, replace = false) {
  if (!context.overlayDir) return { changed: [], removed: [] };
  if (replace) {
    rmSync(context.overlayDir, { recursive: true, force: true });
    context.overlays.clear();
  }
  mkdirSync(context.overlayDir, { recursive: true });
  const changed = [];
  const removed = [];
  let totalBytes = 0;
  for (const item of Array.isArray(overlays) ? overlays : []) {
    const filePath = typeof item?.filePath === 'string' ? path.resolve(item.filePath) : null;
    const text = typeof item?.text === 'string' ? item.text : null;
    if (!filePath || text === null || !isPathInside(context.docDir, filePath)) continue;
    const bytes = Buffer.byteLength(text);
    totalBytes += bytes;
    if (bytes > 8 * 1024 * 1024 || totalBytes > 32 * 1024 * 1024) {
      throw new Error('project overlay exceeds the live-preview text limit');
    }
    if (context.overlays.get(filePath) === text) continue;
    const rel = path.relative(context.docDir, filePath);
    const target = path.join(context.overlayDir, rel);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, text, 'utf8');
    context.overlays.set(filePath, text);
    changed.push(filePath);
  }
  for (const raw of Array.isArray(removeOverlays) ? removeOverlays : []) {
    const filePath = typeof raw === 'string' ? path.resolve(raw) : null;
    if (!filePath || !isPathInside(context.docDir, filePath) || !context.overlays.has(filePath)) continue;
    context.overlays.delete(filePath);
    const target = path.join(context.overlayDir, path.relative(context.docDir, filePath));
    rmSync(target, { force: true });
    removed.push(filePath);
  }
  return { changed, removed };
}

function ensureProjectOutputDirectories(source) {
  // \include{sections/foo} writes sections/foo.aux relative to the TeX
  // output directory. Both the resident driver and sandboxed canonical
  // compiler need that directory even though the source file itself is read
  // from docDir through TEXINPUTS.
  const roots = [engine.workDir, engine.canonical.workDir];
  for (const match of String(source || '').matchAll(/^[^%\n]*\\include\s*\{([^}]+)\}/gm)) {
    const relDir = path.dirname(match[1].trim().replace(/\\/g, '/'));
    if (!relDir || relDir === '.') continue;
    for (const root of roots) {
      const target = path.resolve(root, relDir);
      if (target === root || !target.startsWith(root + path.sep)) continue;
      mkdirSync(target, { recursive: true });
    }
  }
}

function refreshProjectBibliography(changedFile) {
  bibliographyRefreshTimer = null;
  withEngine(async () => {
    const source = engine.getSource();
    const descriptor = describeExternalBibliography(
      source,
      activeProject.docDir,
      activeProject.overlayDir
    );
    if (descriptor?.kind === 'biblatex') {
      const resetEpoch = beginDocumentReset('bibliography-refresh');
      await engine.setDocumentContext({
        docDir: activeProject.docDir,
        overlayDir: activeProject.overlayDir,
        force: true,
      });
      ensureProjectOutputDirectories(source);
      await materializeProjectBibliography(source, activeProject);
      lastReport = await engine.open(source, activeProject.file);
      completeDocumentReset(resetEpoch);
    } else {
      await materializeProjectBibliography(source, activeProject);
      engine.invalidateProjectInputs?.([path.join(engine.workDir, 'driver.bbl')]);
      lastReport = await engine.refresh();
    }
    completeDocumentReset();
    broadcast({ kind: 'update', report: lastReport });
  }).catch((error) => {
    console.warn(`[tdom] bibliography refresh failed (${changedFile}):`, error?.message || error);
  });
}

const sseClients = new Set();
// A stalled client (suspended tab, slept laptop) must not buffer every
// patch payload in this process forever: past the high-water mark we drop
// the connection — EventSource reconnects and resyncs by itself.
const SSE_MAX_BUFFER = 8 * 1024 * 1024;
function broadcastRaw(jsonStr) {
  const data = `data: ${jsonStr}\n\n`;
  for (const res of sseClients) {
    try {
      res.write(data);
      if (res.writableLength > SSE_MAX_BUFFER) {
        sseClients.delete(res);
        res.destroy();
      }
    } catch {
      sseClients.delete(res);
    }
  }
}
function broadcast(payload) {
  broadcastRaw(JSON.stringify({ documentEpoch, ...payload }));
}

let pendingDocumentReset = null;

function beginDocumentReset(reason) {
  documentEpoch += 1;
  pendingDocumentReset = { epoch: documentEpoch, reason };
  broadcast({ kind: 'reset-pending', reason });
  return documentEpoch;
}

function ensureDocumentReset(reason) {
  return pendingDocumentReset?.epoch ?? beginDocumentReset(reason);
}

function completeDocumentReset(expectedEpoch = null) {
  if (!pendingDocumentReset) return null;
  if (expectedEpoch !== null && pendingDocumentReset.epoch !== expectedEpoch) return null;
  const { epoch } = pendingDocumentReset;
  pendingDocumentReset = null;
  broadcast({ kind: 'reset', documentEpoch: epoch });
  return epoch;
}

// `open()` is announced explicitly by the HTTP route. Incremental edits can
// decide to reboot only after the engine has inspected the updated source,
// and a foreground failure can trigger the same boot on its retry. In both
// cases this callback runs synchronously before bootRoot tears down old
// pixels; an explicit reset already in flight is deliberately reused.
engine.onDocumentResetPending = ({ reason } = {}) => {
  ensureDocumentReset(reason || 'engine-root-reboot');
};
engine.onDocumentResetComplete = ({ report } = {}) => {
  // Engine-internal reboots (including the delayed structured re-probe) do
  // not necessarily return through an HTTP route that can assign lastReport.
  // Publish the completed report here before reset wakes clients to /doc.
  if (report) lastReport = report;
  completeDocumentReset();
};

// async patches (TikZ renders, late chain discoveries) from the checkpoint engine
engine.onAsyncPatches = (partial) => {
  broadcast({ kind: 'patches', rev: partial.rev, fonts: partial.fonts, patches: partial.patches });
};
engine.onExternalChange = () => {
  withEngine(async () => {
    const source = engine.getSource();
    const nextBibliography = describeExternalBibliography(source, activeProject.docDir, activeProject.overlayDir);
    const previousBibliography = activeProject.bibliography;
    const bibliographyChanged = nextBibliography?.signature !== previousBibliography?.signature ||
      nextBibliography?.kind !== previousBibliography?.kind;
    if (bibliographyChanged &&
        (nextBibliography?.kind === 'biblatex' || previousBibliography?.kind === 'biblatex')) {
      const resetEpoch = beginDocumentReset('project-bibliography-change');
      await engine.setDocumentContext({
        docDir: activeProject.docDir,
        overlayDir: activeProject.overlayDir,
        force: true,
      });
      ensureProjectOutputDirectories(source);
      await materializeProjectBibliography(source, activeProject);
      lastReport = await engine.open(source, activeProject.file);
      completeDocumentReset(resetEpoch);
      broadcast({ kind: 'update', report: lastReport });
      return lastReport;
    }
    lastReport = await engine.refresh();
    if (bibliographyChanged) {
      broadcast({ kind: 'update', report: lastReport });
      await materializeProjectBibliography(source, activeProject);
      engine.invalidateProjectInputs?.([path.join(engine.workDir, 'driver.bbl')]);
      lastReport = await engine.refresh();
    }
    completeDocumentReset();
    broadcast({ kind: 'update', report: lastReport });
    return lastReport;
  }).catch((error) => {
    console.warn('[tdom] project input refresh failed:', error?.message || error);
  });
};
// canonical compiles land asynchronously: tell every client so it can
// converge its pages to the exact LuaLaTeX render
engine.onCanonical = (info) => {
  broadcast({ kind: 'canonical', canonical: info, mode: engine.mode });
};
// incremental authority (TDOM_SHIP=1): a page's real pixels landed — the
// client swaps just that page, without waiting for the cold compile
engine.onShipPage = (info) => {
  broadcast({ kind: 'ship', ...info });
};

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.pdf': 'application/pdf',
  '.woff2': 'font/woff2',
};

function serveStatic(res, rel) {
  try {
    const file = path.join(ROOT, 'web', path.normalize(rel).replace(/^(\.\.[/\\])+/, ''));
    const body = readFileSync(file);
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
      // app.js/style.css are edited live in development and the embedded
      // origin commonly reuses the same localhost port across app restarts.
      // Heuristic browser caching here silently ran an older direct-edit
      // handler against a newer engine.
      'Cache-Control': 'no-cache',
    });
    res.end(body);
  } catch {
    res.writeHead(404);
    res.end('not found');
  }
}

function serveHostMathLive(res, rel) {
  try {
    if (!HOST_WEB_ROOT) throw new Error('host assets unavailable');
    const mathRoot = path.join(HOST_WEB_ROOT, 'mathlive');
    const file = path.resolve(mathRoot, rel);
    if (file !== mathRoot && !file.startsWith(mathRoot + path.sep)) throw new Error('bad host asset path');
    const body = readFileSync(file);
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
      // The localhost origin/port is reused across engine and app restarts;
      // these stable URLs therefore are not content-addressed.
      'Cache-Control': 'no-store',
    });
    res.end(body);
  } catch {
    res.writeHead(404);
    res.end('not found');
  }
}

function serveHostWebModule(res, rel) {
  try {
    if (!HOST_WEB_ROOT) throw new Error('host assets unavailable');
    const normalized = String(rel || '').replace(/\\/g, '/').replace(/^\/+/, '');
    const allowed =
      /^math\/[A-Za-z0-9_./-]+\.js$/.test(normalized) ||
      normalized === 'app/blocks/math-input-utils.js' ||
      normalized === 'app/math-keyboard-data.js';
    if (!allowed || normalized.split('/').includes('..')) throw new Error('bad host module path');
    const file = path.resolve(HOST_WEB_ROOT, normalized);
    if (!file.startsWith(path.resolve(HOST_WEB_ROOT) + path.sep)) throw new Error('bad host module path');
    const body = readFileSync(file);
    res.writeHead(200, {
      'Content-Type': 'text/javascript; charset=utf-8',
      'Cache-Control': 'no-store',
    });
    res.end(body);
  } catch {
    res.writeHead(404);
    res.end('not found');
  }
}

function serveAsset(res, name) {
  try {
    if (!/^[a-z0-9_.-]+$/i.test(name)) throw new Error('bad asset name');
    const file = path.resolve(UPLOADS_DIR, name);
    if (!file.startsWith(UPLOADS_DIR + path.sep)) throw new Error('bad asset path');
    const body = readFileSync(file);
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream' });
    res.end(body);
  } catch {
    res.writeHead(404);
    res.end('not found');
  }
}

function json(res, obj, status = 200) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}

const MAX_BODY = 32 * 1024 * 1024;
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let done = false;
    const finish = (fn, v) => {
      if (done) return;
      done = true;
      fn(v);
    };
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        finish(reject, new Error('request body too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => finish(resolve, Buffer.concat(chunks).toString('utf8')));
    req.on('error', (err) => finish(reject, err));
    // an aborted POST fires close without end — without this the promise
    // never settles and the handler (plus its buffers) leaks per abort
    req.on('close', () => finish(reject, new Error('client aborted request')));
  });
}

function geometry() {
  // opaque documents may never have booted the structured layer — take the
  // paper size from the canonical PDF instead
  const g = engine.getGeometry();
  if (g) return g;
  const paper = engine.canonical.info().paper;
  return paper
    ? { paperwidth: paper.w, paperheight: paper.h }
    : { paperwidth: 612, paperheight: 792 };
}

function docPayload() {
  return {
    documentEpoch,
    backend,
    mode: engine.mode,
    modeReasons: engine.modeReasons,
    canonical: engine.canonical.info(),
    source: engine.getSource(),
    pages: engine.getDisplayLists(),
    geometry: geometry(),
    fonts: engine.getFontManifest(),
    report: lastReport,
  };
}

function bibliographySourceLocation(generatedText, generatedLine = null) {
  const lines = String(generatedText || '').split(/\r?\n/);
  const limit = Number.isFinite(generatedLine)
    ? Math.max(1, Math.min(lines.length, Math.floor(generatedLine)))
    : lines.length;
  const prefix = lines.slice(0, limit).join('\n');
  const keys = [
    ...prefix.matchAll(/\\bibitem(?:\[[^\]]*\])?\s*\{([^}]+)\}/g),
    ...prefix.matchAll(/\\entry\s*\{([^}]+)\}/g),
  ];
  const key = keys.at(-1)?.[1]?.trim() || null;
  const files = activeProject.bibliography?.files ?? [];
  for (const file of files) {
    let text;
    try {
      text = activeProject.overlays.get(path.resolve(file)) ?? readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    if (!key) return { file: path.resolve(file), line: 1, column: 1 };
    const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const entry = new RegExp(`^\\s*@[A-Za-z]+\\s*\\{\\s*${escaped}\\s*,`, 'i');
    const index = String(text).split(/\r?\n/).findIndex((line) => entry.test(line));
    if (index >= 0) return { file: path.resolve(file), line: index + 1, column: 1 };
  }
  return null;
}

function domPayload() {
  const dom = engine.getDOM();
  const byId = new Map(engine.blocks.map((block) => [block.id, block]));
  for (const item of dom.blocks ?? []) {
    if (path.resolve(item.source?.file || '') !== path.join(engine.workDir, 'driver.bbl')) continue;
    // A .bbl is generated output.  Its rendered prose can be navigated back
    // to the owning .bib entry, but it must never be offered as inline text:
    // replacing a title/author fragment in driver.bbl would be overwritten
    // by the next Biber run and could target the wrong field.
    item.editRegions = [];
    const location = bibliographySourceLocation(byId.get(item.id)?.text || '');
    if (!location) continue;
    item.source = {
      file: location.file,
      start: { line: location.line, column: location.column },
      end: { line: location.line, column: location.column },
    };
    item.file = location.file;
  }
  return dom;
}

function canonicalInputForProjectFile(rawFile) {
  if (typeof rawFile !== 'string' || !rawFile) return null;
  const projectFile = path.isAbsolute(rawFile)
    ? path.resolve(rawFile)
    : path.resolve(activeProject.docDir, rawFile);
  if (projectFile === path.resolve(activeProject.filePath)) {
    return path.join(engine.canonical.workDir, 'canon.tex');
  }
  if (!isPathInside(activeProject.docDir, projectFile)) return null;
  if (activeProject.overlayDir) {
    const overlay = path.join(activeProject.overlayDir, path.relative(activeProject.docDir, projectFile));
    if (existsSync(overlay)) return overlay;
  }
  return projectFile;
}

function activeSourceLine(file, line) {
  if (!Number.isInteger(line) || line < 1) return '';
  const projectFile = path.resolve(file);
  let text = null;
  if (projectFile === path.resolve(activeProject.filePath)) text = engine.getSource();
  else text = activeProject.overlays.get(projectFile) ?? null;
  if (text == null) {
    try { text = readFileSync(projectFile, 'utf8'); } catch { return ''; }
  }
  return String(text).split(/\r?\n/)[line - 1] ?? '';
}

async function validatedForwardSyncAll(location, id) {
  const file = canonicalInputForProjectFile(location?.file);
  const line = Number(location?.line);
  if (!file || !Number.isFinite(line)) return null;
  const candidates = await engine.canonical.forwardSyncAll({
    file,
    line,
    column: Number(location?.column) || 1,
    id,
  });
  const plausible = candidates
    .filter((item) => item.box.right - item.box.left > 1 && item.box.bottom - item.box.top > 1)
    .sort((a, b) => {
      const aa = (a.box.right - a.box.left) * (a.box.bottom - a.box.top);
      const ba = (b.box.right - b.box.left) * (b.box.bottom - b.box.top);
      return aa - ba;
    });
  const validated = [];
  for (const candidate of plausible.slice(0, 16)) {
    const reverse = await engine.canonical.reverseSync({
      page: candidate.page,
      x: candidate.x,
      y: candidate.y,
      id,
    });
    if (reverse && path.resolve(reverse.file) === path.resolve(file) && Number(reverse.line) === line) {
      validated.push(candidate);
    }
  }
  return validated.length ? validated : plausible.length ? plausible : candidates;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  try {
    if (req.method === 'GET' && url.pathname === '/') return serveStatic(res, 'index.html');
    if (req.method === 'GET' && url.pathname.startsWith('/host/web/')) {
      return serveHostWebModule(res, url.pathname.slice('/host/web/'.length));
    }
    if (req.method === 'GET' && url.pathname === '/compare') return serveStatic(res, 'compare.html');
    if (
      req.method === 'GET' &&
      (url.pathname === '/app.js' ||
        url.pathname === '/reset-coordinator.js' ||
        url.pathname === '/opaque-editor-coordinator.js' ||
        url.pathname === '/style.css' ||
        url.pathname === '/compare.js')
    ) {
      return serveStatic(res, url.pathname.slice(1));
    }
    if (req.method === 'GET' && url.pathname.startsWith('/host/mathlive/')) {
      return serveHostMathLive(res, decodeURIComponent(url.pathname.slice('/host/mathlive/'.length)));
    }
    // vendored pdf.js (used by the side-by-side compare page)
    if (req.method === 'GET' && url.pathname.startsWith('/pdfjs/')) {
      return serveStatic(res, url.pathname.slice(1));
    }
    // liveness probe for the status pill: cheap, engine-queue-free, safe to
    // poll every second. A hung/killed server simply stops answering this.
    if (req.method === 'GET' && url.pathname === '/status') {
      res.setHeader('Cache-Control', 'no-store');
      return json(res, {
        up: true,
        pid: process.pid,
        port: PORT,
        busy: engineBusy > 0,
        queued: engineBusy,
        busyMs: engineBusy > 0 ? Date.now() - engineBusySince : 0,
        mode: engine.mode,
        rev: engine.rev,
        srcRev: engine.srcRev,
        documentEpoch,
        progress: engine.progress ?? null,
        render: {
          queued: [...engine.renderWant.keys()],
          pumping: engine.renderPumping,
          active: [...(engine.rendering ?? [])],
          pids: Object.fromEntries(engine.renderPids ?? []),
          stats: engine.renderStats,
        },
        canonical: engine.canonical.info(),
      });
    }
    if (req.method === 'GET' && url.pathname === '/doc') return json(res, docPayload());
    if (req.method === 'GET' && url.pathname === '/templates') return json(res, listTemplates());
    if (req.method === 'POST' && url.pathname === '/templates') {
      const body = JSON.parse(await readBody(req));
      const saved = saveCustomTemplate(body);
      return json(res, saved, 201);
    }
    if (req.method === 'POST' && url.pathname === '/assets') {
      const body = JSON.parse(await readBody(req));
      const saved = saveUploadedAsset(body);
      return json(res, saved, 201);
    }
    if (req.method === 'GET' && url.pathname === '/texfiles') return json(res, listUploadedTexFiles());
    if (req.method === 'GET' && url.pathname.startsWith('/texfiles/')) {
      return json(res, readUploadedTexFile(decodeURIComponent(url.pathname.slice('/texfiles/'.length))));
    }
    if (req.method === 'POST' && url.pathname === '/texfiles') {
      const body = JSON.parse(await readBody(req));
      const saved = saveUploadedTexFile(body);
      return json(res, saved, 201);
    }
    if (req.method === 'POST' && url.pathname === '/ai-preview') {
      const body = JSON.parse(await readBody(req));
      const preview = await compilePreviewPdf(body.source);
      return json(res, preview, 201);
    }
    if (req.method === 'GET' && url.pathname.startsWith('/ai-preview/')) {
      return serveAiPreview(res, decodeURIComponent(url.pathname.slice('/ai-preview/'.length)));
    }
    if (req.method === 'GET' && url.pathname.startsWith('/assets/')) {
      return serveAsset(res, decodeURIComponent(url.pathname.slice('/assets/'.length)));
    }
    if (req.method === 'GET' && url.pathname === '/dom') return json(res, domPayload());
    if (req.method === 'POST' && url.pathname === '/synctex') {
      const body = JSON.parse(await readBody(req));
      const hit = await engine.canonical.reverseSync({
        page: Number(body.page),
        x: Number(body.x),
        y: Number(body.y),
        id: body.id == null ? null : Number(body.id),
      });
      if (!hit) return json(res, { error: 'source location not found' }, 404);
      const anchors = await engine.canonical.forwardSyncAll({
        file: hit.file,
        line: hit.line,
        column: hit.column,
        id: body.id == null ? null : Number(body.id),
      });
      const page = Number(body.page);
      const px = Number(body.x);
      const py = Number(body.y);
      const distance = (item) => {
        const box = item.box;
        const dx = px < box.left ? box.left - px : px > box.right ? px - box.right : 0;
        const dy = py < box.top ? box.top - py : py > box.bottom ? py - box.bottom : 0;
        return dx * dx + dy * dy;
      };
      const anchor = anchors.filter((item) => item.page === page).sort((a, b) => distance(a) - distance(b))[0] ??
        anchors[0] ?? null;
      let file = path.resolve(hit.file);
      const canonicalSource = path.join(engine.canonical.workDir, 'canon.tex');
      if (file === canonicalSource) file = activeProject.filePath;
      else if (file === path.join(engine.canonical.workDir, 'canon.bbl')) {
        const location = bibliographySourceLocation(readFileSync(file, 'utf8'), hit.line);
        if (location) return json(res, { ...location, anchor, anchors });
      }
      else if (activeProject.overlayDir && isPathInside(activeProject.overlayDir, file)) {
        file = path.join(activeProject.docDir, path.relative(activeProject.overlayDir, file));
      }
      if (!isPathInside(activeProject.docDir, file)) {
        return json(res, { error: 'source location is outside the project' }, 404);
      }
      return json(res, {
        file,
        line: hit.line,
        column: hit.column,
        lineText: activeSourceLine(file, hit.line),
        anchor,
        anchors,
      });
    }
    if (req.method === 'POST' && url.pathname === '/synctex/forward') {
      const body = JSON.parse(await readBody(req));
      const locations = Array.isArray(body.locations) ? body.locations.slice(0, 24) : [];
      const id = body.id == null ? null : Number(body.id);
      const groups = await Promise.all(locations.map((location) => validatedForwardSyncAll(location, id)));
      return json(res, {
        results: groups.flatMap((items, locationIndex) =>
          items.map((item) => ({ ...item, locationIndex })))
      });
    }
    if (req.method === 'GET' && url.pathname === '/canonical/text') {
      const id = url.searchParams.get('c');
      const pages = await engine.canonical.pageTexts(id ? Number(id) : null);
      if (!pages) return json(res, { pages: [] }, 404);
      return json(res, { pages });
    }
    if (req.method === 'GET' && url.pathname === '/canonical/boxes') {
      const id = url.searchParams.get('c');
      const pages = await engine.canonical.pageTextBoxes(id ? Number(id) : null);
      if (!pages) return json(res, { pages: [] }, 404);
      return json(res, { pages });
    }
    // canonical exact pages: lazy per-page SVG of the real lualatex PDF.
    // The client pins the compile id via ?c=<id>. The latest few generations
    // remain addressable while a decoded old page is still presented; only a
    // pruned/unknown id returns 404.
    if (req.method === 'GET' && url.pathname.startsWith('/canonical/')) {
      const n = Number(url.pathname.slice('/canonical/'.length).replace(/\.svg$/, ''));
      const id = url.searchParams.get('c');
      const svg = await engine.canonical.pageSVG(n, id).catch(() => null);
      if (!svg) {
        res.writeHead(404, { 'Cache-Control': 'no-store' });
        return res.end('no canonical page');
      }
      res.writeHead(200, {
        'Content-Type': 'image/svg+xml',
        // Compile IDs restart with each local engine process, while the same
        // localhost origin is reused. Disk-caching c=1 could otherwise show
        // another document after a restart.
        'Cache-Control': 'no-store',
      });
      return res.end(svg);
    }
    if (req.method === 'GET' && url.pathname.startsWith('/ship/')) {
      const n = Number(url.pathname.slice('/ship/'.length).replace(/\.svg$/, ''));
      const requestedGen = Number(url.searchParams.get('g'));
      const requestedRev = Number(url.searchParams.get('r'));
      const currentGen = Number(engine.shipping?.gen);
      const currentRev = Number(engine.shipGenRev?.get?.(currentGen));
      const generationMatches = Number.isFinite(requestedGen) && requestedGen === currentGen &&
        Number.isFinite(requestedRev) && requestedRev === currentRev;
      const svg = engine.shipping && generationMatches
        ? await engine.shipping.pageSVG(n).catch(() => null)
        : null;
      if (!svg) {
        res.writeHead(404, { 'Cache-Control': 'no-store' });
        return res.end('no shipped page');
      }
      res.writeHead(200, {
        'Content-Type': 'image/svg+xml',
        'Cache-Control': 'no-store',
      });
      return res.end(svg);
    }
    if (req.method === 'GET' && url.pathname.startsWith('/chunk/')) {
      const id = decodeURIComponent(url.pathname.slice('/chunk/'.length)).replace(/\.svg$/, '');
      const svg = engine.getChunkSVG ? engine.getChunkSVG(id) : null;
      if (!svg) {
        res.writeHead(404);
        return res.end('unknown chunk');
      }
      res.writeHead(200, {
        'Content-Type': 'image/svg+xml',
        'Cache-Control': 'no-cache', // chunk content changes under a stable block id
      });
      return res.end(svg);
    }
    if (req.method === 'GET' && url.pathname.startsWith('/font/')) {
      const key = decodeURIComponent(url.pathname.slice('/font/'.length));
      const body = engine.getFontFile ? engine.getFontFile(key) : null;
      if (!body) {
        res.writeHead(404);
        return res.end('unknown font');
      }
      const type = key.endsWith('.ttf') ? 'font/ttf' : 'font/otf';
      res.writeHead(200, {
        'Content-Type': type,
        'Cache-Control': 'public, max-age=31536000, immutable',
      });
      return res.end(body);
    }
    // fidelity gate feedback: the browser could not LOAD a served font
    // (@font-face failure = silent fallback to a default browser font).
    // Demote the family so affected lines switch to exact preview chunks.
    if (req.method === 'POST' && url.pathname === '/font-fail') {
      const body = JSON.parse(await readBody(req));
      // demotion repaginates the whole document — run it on the engine
      // queue like every other mutation, never between an update's awaits
      const demoted = await withEngine(() =>
        engine.demoteFontFamily ? engine.demoteFontFamily(String(body.family ?? '')) : false
      );
      return json(res, { demoted });
    }
    // the last LANDED canonical compile, byte-identical to what the main
    // preview converged to — never triggers a compile (the compare view's
    // left column auto-refreshes from here on every canonical SSE event)
    if (req.method === 'GET' && url.pathname === '/canonical.pdf') {
      const body = engine.canonical.pdfBytes();
      if (!body) {
        res.writeHead(404, { 'Cache-Control': 'no-store' });
        return res.end('no canonical compile yet');
      }
      res.writeHead(200, {
        'Content-Type': 'application/pdf',
        'Cache-Control': 'no-cache',
      });
      return res.end(body);
    }
    if (req.method === 'GET' && url.pathname === '/pdf') {
      // served by the canonical layer (cached when the source is unchanged);
      // deliberately NOT serialized behind engine edits — a full compile
      // must never block the editing hot path
      const pdf = await engine.exportPDF();
      res.writeHead(200, {
        'Content-Type': 'application/pdf',
        'Content-Disposition': 'inline; filename="tdom-export.pdf"',
      });
      return res.end(pdf);
    }
    if (req.method === 'GET' && url.pathname === '/events') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      });
      res.write(':ok\n\n');
      sseClients.add(res);
      req.on('close', () => sseClients.delete(res));
      return;
    }
    if (req.method === 'POST' && url.pathname === '/edit') {
      const body = JSON.parse(await readBody(req));
      const { start, end, text } = body;
      if (typeof start !== 'number' || typeof end !== 'number' || typeof text !== 'string') {
        return json(res, { error: 'edit requires {start, end, text}' }, 400);
      }
      let resetEpoch = null;
      try {
        lastReport = await withEngine(async () => {
          // optional optimistic-concurrency guard: a client that states the
          // source revision its offsets were computed against gets a 409
          // instead of a silent mis-application when it fell behind
          // (editor integrations with retries/multiple sources of edits)
          if (typeof body.rev === 'number' && body.rev !== engine.srcRev) {
            const err = new Error('revision mismatch');
            err.status = 409;
            err.srcRev = engine.srcRev;
            throw err;
          }
          const current = engine.getSource();
          const next = current.slice(0, start) + text + current.slice(end);
          const overlayDelta = applyProjectOverlays(activeProject, body);
          const changedInputs = [...overlayDelta.changed, ...overlayDelta.removed];
          const rootChanged = next !== current;
          ensureProjectOutputDirectories(next);
          const nextBibliography = describeExternalBibliography(
            next,
            activeProject.docDir,
            activeProject.overlayDir
          );
          const previousBibliography = activeProject.bibliography;
          const bibliographyInputChanged = changedInputs.some((file) => /\.(?:bib|bst|bbx|cbx)$/i.test(file));
          const bibliographyChanged = bibliographyInputChanged ||
            nextBibliography?.signature !== previousBibliography?.signature ||
            nextBibliography?.kind !== previousBibliography?.kind;
          const bibliographyNeedsReboot = bibliographyChanged &&
            (nextBibliography?.kind === 'biblatex' || previousBibliography?.kind === 'biblatex');
          const deferBiblatex = bibliographyNeedsReboot &&
            nextBibliography?.kind === 'biblatex' &&
            previousBibliography?.kind === 'biblatex' &&
            existsSync(path.join(engine.workDir, 'driver.bbl'));
          if (deferBiblatex) {
            // Biber is orders of magnitude slower than a checkpoint edit.
            // Keep the last-good bibliography while the user is typing and
            // run only the latest snapshot after a short idle window.
            const report = rootChanged
              ? await engine.edit(start, end, text)
              : changedInputs.length
                ? await engine.refresh()
                : await engine.edit(start, end, text);
            scheduleProjectBibliographyRefresh('unsaved biblatex input', 450);
            return report;
          }
          if (bibliographyNeedsReboot) {
            resetEpoch = beginDocumentReset('edit-bibliography-reboot');
            await engine.setDocumentContext({
              docDir: activeProject.docDir,
              overlayDir: activeProject.overlayDir,
              force: true,
            });
            await materializeProjectBibliography(next, activeProject);
            const report = await engine.open(next, activeProject.file);
            return report;
          }
          const preambleInputChanged = changedInputs.some((file) =>
            /\.(?:sty|cls|clo|cfg|def|ldf|lbx|bbx|cbx)$/i.test(file)
          );
          if (preambleInputChanged) {
            resetEpoch = beginDocumentReset('edit-preamble-reboot');
            await engine.setDocumentContext({
              docDir: activeProject.docDir,
              overlayDir: activeProject.overlayDir,
              force: true,
            });
            await materializeProjectBibliography(next, activeProject);
            const report = await engine.open(next, activeProject.file);
            return report;
          }
          let primaryReport;
          if (rootChanged) primaryReport = await engine.edit(start, end, text);
          else if (changedInputs.length) primaryReport = await engine.refresh();
          else primaryReport = await engine.edit(start, end, text);
          if (!bibliographyChanged) return primaryReport;

          // Keep disjoint project changes cheap: first update the edited
          // chapter against the last-good bibliography, then update only the
          // generated bibliography block. Walking every block between an
          // early chapter and a tail bibliography would turn one child-file
          // keystroke into O(document length) work.
          broadcast({ kind: 'update', report: primaryReport });
          await materializeProjectBibliography(next, activeProject);
          engine.invalidateProjectInputs?.([path.join(engine.workDir, 'driver.bbl')]);
          return engine.refresh();
        });
      } catch (err) {
        if (err?.status === 409) {
          return json(res, { error: 'revision mismatch', srcRev: err.srcRev }, 409);
        }
        throw err;
      }
      // one serialization for both consumers: the SSE fanout and the HTTP
      // response used to stringify the full report (all patches) twice
      const reportJson = JSON.stringify(lastReport);
      completeDocumentReset(resetEpoch);
      broadcastRaw(`{"kind":"update","documentEpoch":${documentEpoch},"report":${reportJson}}`);
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      return res.end(reportJson);
    }
    if (req.method === 'POST' && url.pathname === '/open') {
      const raw = await readBody(req);
      let text = sample;
      let filePath = path.join(ROOT, 'samples', sampleFile);
      let projectRoot = null;
      let body = {};
      if (raw) {
        body = JSON.parse(raw);
        if (typeof body.text === 'string') text = body.text;
        else if (typeof body.template === 'string') {
          const t = readTemplate(body.template);
          if (t == null) return json(res, { error: 'unknown template' }, 404);
          text = t;
        }
        if (typeof body.filePath === 'string' && path.isAbsolute(body.filePath)) {
          filePath = path.resolve(body.filePath);
        }
        if (typeof body.projectRoot === 'string' && path.isAbsolute(body.projectRoot)) {
          const candidate = path.resolve(body.projectRoot);
          if (isPathInside(candidate, filePath)) projectRoot = candidate;
        }
      }
      const docDir = projectRoot || path.dirname(filePath);
      const context = {
        docDir,
        file: path.relative(docDir, filePath) || path.basename(filePath) || 'main.tex',
        filePath,
        overlayDir: PROJECT_OVERLAY_DIR,
        overlays: new Map(),
        bibliography: null,
      };
      applyProjectOverlays(context, body, true);
      let resetEpoch = null;
      lastReport = await withEngine(async () => {
        resetEpoch = beginDocumentReset('open');
        await engine.setDocumentContext({
          docDir: context.docDir,
          overlayDir: context.overlayDir,
          force: true,
        });
        activeProject = context;
        ensureProjectOutputDirectories(text);
        await materializeProjectBibliography(text, activeProject);
        return engine.open(text, context.file);
      });
      // Keep the previous exact document intact while the new root boots,
      // then tell every client to fetch one complete, already-adoptable
      // snapshot. Broadcasting before engine.open completed let /doc return
      // the old project and later overwrite newer SSE state.
      completeDocumentReset(resetEpoch);
      return json(res, docPayload());
    }
    res.writeHead(404);
    res.end('not found');
  } catch (err) {
    console.error('[tdom] request error:', err);
    if (!res.headersSent) json(res, { error: String(err?.message || err) }, 500);
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[tdom] Fermion TeX Engine (${backend}) listening on http://127.0.0.1:${PORT}`);
});

// Shutdown: close the engine (kills the resident tree, canonical children,
// isolated compiles), but never hang — a stuck child must not keep the
// process alive, so a watchdog force-exits after a grace period.
let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  const watchdog = setTimeout(() => {
    console.error(`[tdom] ${signal}: shutdown watchdog fired — forcing exit`);
    process.exit(1);
  }, 5000);
  watchdog.unref?.();
  try {
    closeBibliographyWatchers();
    if (engine.close) await engine.close();
  } catch (err) {
    console.error('[tdom] shutdown error:', err);
  }
  process.exit(0);
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGHUP', () => shutdown('SIGHUP'));
