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
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { promisify } from 'node:util';
import { CheckpointEngine } from './engine/checkpoint/engine-v3.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 4633);

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
// engines sharing one workdir would clobber each other's driver/canonical
const workDirName = /^[.a-z0-9_-]+$/i.test(process.env.TDOM_WORKDIR || '')
  ? process.env.TDOM_WORKDIR
  : '.tdom-v3';
// The work directory is a live process's private state (driver.tex, format,
// render jobs, canonical PDFs). TWO servers sharing one silently corrupt
// each other — a concurrently rewritten driver.tex reads back as NUL
// garbage and the boot demotes to opaque. A pid lockfile detects a living
// owner and moves this instance to a suffixed directory instead.
function claimWorkDir(base) {
  const dir = path.join(ROOT, base);
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
  return dir;
}
const engine = new CheckpointEngine({
  workDir: claimWorkDir(workDirName),
  docDir: path.join(ROOT, 'samples'),
});
// TDOM_SAMPLE picks the boot document (tests use the small demo — booting
// the 70-page stress doc takes ~2 minutes)
const sampleFile = /^[a-z0-9-]+\.tex$/i.test(process.env.TDOM_SAMPLE || '')
  ? process.env.TDOM_SAMPLE
  : 'stress-test-ja.tex';
const sample = readFileSync(path.join(ROOT, 'samples', sampleFile), 'utf8');
let lastReport = await engine.open(sample);
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
  const run = queue.then(fn);
  queue = run.catch(() => {});
  run
    .catch(() => {})
    .finally(() => {
      engineBusy--;
      if (engineBusy === 0) engineBusySince = 0;
    });
  return run;
}

const sseClients = new Set();
function broadcast(payload) {
  const data = `data: ${JSON.stringify(payload)}\n\n`;
  for (const res of sseClients) res.write(data);
}

// async patches (TikZ renders, late chain discoveries) from the checkpoint engine
engine.onAsyncPatches = (partial) => {
  broadcast({ kind: 'patches', rev: partial.rev, patches: partial.patches });
};
engine.onExternalChange = () => {
  withEngine(async () => {
    lastReport = await engine.refresh();
    broadcast({ kind: 'update', report: lastReport });
    return lastReport;
  }).catch(() => {});
};
// canonical compiles land asynchronously: tell every client so it can
// converge its pages to the exact LuaLaTeX render
engine.onCanonical = (info) => {
  broadcast({ kind: 'canonical', canonical: info, mode: engine.mode });
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
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
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

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
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

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  try {
    if (req.method === 'GET' && url.pathname === '/') return serveStatic(res, 'index.html');
    if (req.method === 'GET' && url.pathname === '/compare') return serveStatic(res, 'compare.html');
    if (
      req.method === 'GET' &&
      (url.pathname === '/app.js' ||
        url.pathname === '/style.css' ||
        url.pathname === '/compare.js')
    ) {
      return serveStatic(res, url.pathname.slice(1));
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
        progress: engine.progress ?? null,
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
    if (req.method === 'GET' && url.pathname === '/dom') return json(res, engine.getDOM());
    // canonical exact pages: lazy per-page SVG of the real lualatex PDF.
    // The client pins the compile id via ?c=<id>; a stale id 404s so the
    // client refetches against the current compile.
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
        // the URL carries the compile id — content under it never changes
        'Cache-Control': id ? 'public, max-age=31536000, immutable' : 'no-cache',
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
      const demoted = engine.demoteFontFamily ? engine.demoteFontFamily(String(body.family ?? '')) : false;
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
      lastReport = await withEngine(() => engine.edit(start, end, text));
      broadcast({ kind: 'update', report: lastReport });
      return json(res, lastReport);
    }
    if (req.method === 'POST' && url.pathname === '/open') {
      const raw = await readBody(req);
      let text = sample;
      if (raw) {
        const body = JSON.parse(raw);
        if (typeof body.text === 'string') text = body.text;
        else if (typeof body.template === 'string') {
          const t = readTemplate(body.template);
          if (t == null) return json(res, { error: 'unknown template' }, 404);
          text = t;
        }
      }
      lastReport = await withEngine(() => engine.open(text));
      broadcast({ kind: 'reset' });
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

process.on('SIGINT', async () => {
  if (engine.close) await engine.close();
  process.exit(0);
});
process.on('SIGTERM', async () => {
  if (engine.close) await engine.close();
  process.exit(0);
});
