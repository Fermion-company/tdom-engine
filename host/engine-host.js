// Engine process lifecycle for a host application.
//
// The engine is a separate Node process: a host owns its lifetime, its port
// and its environment, and talks to it over local HTTP. This class covers
// only that — resolving a checkout, allocating a port, spawning, waiting for
// readiness, and tearing the resident TeX tree down again. The document
// stream lives in document-session.js.

import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { spawn as nodeSpawn } from 'node:child_process';
import { ENGINE_MARKER, NO_FILE_ACCESS, resolveEngineDir } from './engine-dir.js';

// Off the engine's own dev default (4633) so a checkout running `npm start`
// and an embedded engine never race for the same port.
export const DEFAULT_PORT = 4646;
// First boot compiles the fork shim with cc and boots a resident lualatex —
// far slower than a plain HTTP server coming up.
export const DEFAULT_START_TIMEOUT_MS = 90_000;
// One checkpoint is one forked lualatex (~100-300MB). The engine's own
// default of 64 is sized for a dedicated box, not for a host app sharing the
// machine with an editor, a language server and a browser.
export const DEFAULT_MAX_CHECKPOINTS = '8';

const isPortAvailable = (port) =>
  new Promise((resolve) => {
    const server = net.createServer();
    server.unref();
    server.once('error', () => resolve(false));
    server.listen(port, '127.0.0.1', () => server.close(() => resolve(true)));
  });

// `preferred = 0` means "any free port": useful when several engines may be
// started concurrently (tests), where a fixed preference is a guaranteed
// collision rather than a convenience.
export async function findAvailablePort(preferred = DEFAULT_PORT) {
  if (preferred && (await isPortAvailable(preferred))) return preferred;
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close(() => (port ? resolve(port) : reject(new Error('could not allocate a TDOM port'))));
    });
  });
}

const uniquePaths = (items) => {
  const seen = new Set();
  const result = [];
  for (const item of items) {
    if (typeof item !== 'string' || !item || seen.has(item)) continue;
    seen.add(item);
    result.push(item);
  }
  return result;
};

export class EngineHost {
  constructor(options = {}) {
    const envDir =
      typeof options.envDir === 'string'
        ? options.envDir.trim()
        : (process.env.TDOM_ENGINE_DIR || '').trim();
    this.existsSync = options.existsSync || fs.existsSync;
    this.fileAccess = options.fileAccess || NO_FILE_ACCESS;
    this.envEngineDir = envDir;
    this.explicitEngineDir = options.engineDir;
    this.vendoredDir = options.vendoredDir || null;
    this.candidates = options.candidates;
    this.homeDir = options.homeDir;

    this.preferredPort = options.port ?? DEFAULT_PORT;
    this.startTimeoutMs = options.startTimeoutMs ?? DEFAULT_START_TIMEOUT_MS;
    this.pollIntervalMs = options.pollIntervalMs ?? 150;
    this.spawnImpl = options.spawnImpl || nodeSpawn;
    this.requestImpl = options.requestImpl;
    // Electron hosts pass their own binary here together with
    // `extraEnv: { ELECTRON_RUN_AS_NODE: '1' }` instead of shipping a second
    // Node runtime beside the app.
    this.execPath = options.execPath || process.execPath;

    this.workDir = options.workDir || null;
    this.hostWebRoot = options.hostWebRoot || null;
    this.pdfjsPath = options.pdfjsPath || null;
    this.bootSample = options.bootSample || null;
    // lualatex, and poppler's pdftocairo/pdftotext/pdfinfo, and the cc used
    // for the fork shim. A GUI-launched app inherits a minimal PATH, so a
    // host that manages its own TeX passes those bin directories here.
    this.binDirs = Array.isArray(options.binDirs) ? options.binDirs : [];
    this.maxCheckpoints = options.maxCheckpoints ?? DEFAULT_MAX_CHECKPOINTS;
    this.ship = options.ship ?? '1';
    this.shipPrivatePdf = options.shipPrivatePdf ?? '1';
    this.canonicalAnchor = options.canonicalAnchor ?? '1';
    this.extraEnv = options.extraEnv || {};

    this.onStdout = options.onStdout || ((text) => console.log('[tdom]', text));
    this.onStderr = options.onStderr || ((text) => console.warn('[tdom]', text));

    const resolved = this.resolveDirectory();
    this.engineDir = resolved.dir;
    this.needsAccess = resolved.needsAccess;
    this.proc = null;
    this.startPromise = null;
    this.port = null;
    this.state = 'stopped';
    this.lastError = null;
    this.stderrTail = [];
  }

  resolveDirectory() {
    return resolveEngineDir({
      envDir: this.envEngineDir,
      explicitDir: this.explicitEngineDir,
      candidates: this.candidates,
      vendoredDir: this.vendoredDir,
      ...(this.homeDir ? { homeDir: this.homeDir } : {}),
      existsSync: this.existsSync,
      fileAccess: this.fileAccess,
    });
  }

  refreshDirectory() {
    const resolved = this.resolveDirectory();
    this.engineDir = resolved.dir;
    this.needsAccess = resolved.needsAccess;
  }

  isAvailable() {
    return (
      this.fileAccess.probeIfAllowed(this.engineDir, () =>
        this.existsSync(path.join(this.engineDir, ENGINE_MARKER))
      ) === true
    );
  }

  isRunning() {
    return Boolean(this.proc && this.proc.exitCode === null && !this.proc.killed);
  }

  get url() {
    return this.port ? `http://127.0.0.1:${this.port}` : null;
  }

  getStatus() {
    return {
      available: this.isAvailable(),
      running: this.isRunning(),
      state: this.state,
      url: this.url,
      engineDir: this.engineDir,
      needsAccess: this.needsAccess,
      error: this.lastError,
    };
  }

  // The engine refuses to boot when TDOM_SAMPLE names a file that is not in
  // <engineDir>/samples, and the sample set is the engine's business — pick a
  // small one that actually exists instead of hardcoding a name. The default
  // stress-test document takes minutes to boot.
  pickBootSample() {
    if (this.bootSample) return this.bootSample;
    const samplesDir = path.join(this.engineDir, 'samples');
    for (const name of ['demo-lua.tex', 'minimal.tex', 'demo.tex']) {
      if (this.existsSync(path.join(samplesDir, name))) return name;
    }
    try {
      const candidates = fs
        .readdirSync(samplesDir)
        .filter((name) => name.endsWith('.tex'))
        .map((name) => {
          let size = Infinity;
          try {
            size = fs.statSync(path.join(samplesDir, name)).size;
          } catch {}
          return { name, size };
        })
        .sort((a, b) => a.size - b.size);
      if (candidates.length) return candidates[0].name;
    } catch {
      /* no samples dir — let the engine report it */
    }
    return 'demo-lua.tex';
  }

  buildSpawnEnv() {
    const pathParts = uniquePaths([
      ...this.binDirs,
      ...(process.env.PATH || '').split(path.delimiter),
      '/opt/homebrew/bin',
      '/usr/local/bin',
      '/usr/bin',
      '/bin',
    ]);
    const env = {
      ...process.env,
      ...this.extraEnv,
      PORT: String(this.port),
      PATH: pathParts.join(path.delimiter),
      // Boot on a small sample; the host's real document arrives via
      // POST /open immediately afterwards.
      TDOM_SAMPLE: process.env.TDOM_SAMPLE || this.pickBootSample(),
      TDOM_MAX_CHECKPOINTS: process.env.TDOM_MAX_CHECKPOINTS || String(this.maxCheckpoints),
      // Output-routine shipping is the exact-page successor to glyph
      // overlays. It runs off the keystroke path and fails closed to the
      // ordinary canonical compile for unsupported preambles.
      TDOM_SHIP: process.env.TDOM_SHIP ?? String(this.ship),
      TDOM_SHIP_PRIVATE_PDF: process.env.TDOM_SHIP_PRIVATE_PDF ?? String(this.shipPrivatePdf),
      // Certified plain-text anchoring maps resident LuaLaTeX line output
      // onto the last canonical PDF, and fails closed to ordinary shipping.
      TDOM_CANONICAL_ANCHOR:
        process.env.TDOM_CANONICAL_ANCHOR ?? String(this.canonicalAnchor),
    };
    // The engine stays dependency-free standalone, so a host that already
    // ships pdf.js passes the resolved module path instead of making the
    // engine install a second copy.
    if (this.pdfjsPath) env.TDOM_PDFJS_PATH = this.pdfjsPath;
    // Absolute work dir keeps engine scratch out of a read-only or vendored
    // checkout.
    if (this.workDir) env.TDOM_WORKDIR = this.workDir;
    // The engine frame stays an isolated localhost origin, but it may serve
    // a host's already-vendored assets below this root.
    if (this.hostWebRoot) env.TDOM_HOST_WEB_ROOT = this.hostWebRoot;
    return env;
  }

  async start() {
    if (this.isRunning() && this.state === 'ready') return { ok: true, url: this.url };
    if (this.startPromise) return this.startPromise;

    const allowed = await this.fileAccess.ensureAccess(this.engineDir, { reason: 'tdom' });
    if (!allowed) {
      const root = this.fileAccess.classify(this.engineDir)?.root || this.engineDir;
      const error = new Error(
        `the real-time preview engine cannot start: no permission to access ${root}.`
      );
      this.state = 'unavailable';
      this.lastError = error.message;
      throw error;
    }
    this.refreshDirectory();
    if (this.startPromise) return this.startPromise;
    if (!this.isAvailable()) {
      const error = new Error(
        `tdom engine was not found at ${this.engineDir}. Set TDOM_ENGINE_DIR to a checkout.`
      );
      this.state = 'unavailable';
      this.lastError = error.message;
      throw error;
    }

    this.state = 'starting';
    this.lastError = null;
    this.startPromise = this.startProcess();
    try {
      return await this.startPromise;
    } finally {
      this.startPromise = null;
    }
  }

  async startProcess() {
    this.port = await findAvailablePort(this.preferredPort);
    this.stderrTail = [];
    let proc;
    try {
      proc = this.spawnImpl(this.execPath, [path.join(this.engineDir, ENGINE_MARKER)], {
        cwd: this.engineDir,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: this.buildSpawnEnv(),
      });
      this.proc = proc;
    } catch (error) {
      this.handleEnd(proc, error);
      throw error;
    }
    proc.stdout.on('data', (chunk) => {
      const text = chunk.toString('utf8').trim();
      if (text) this.onStdout(text);
    });
    proc.stderr.on('data', (chunk) => {
      const text = chunk.toString('utf8').trim();
      if (!text) return;
      this.onStderr(text);
      this.stderrTail = [...this.stderrTail, ...text.split('\n')].slice(-8);
    });
    proc.on('error', (error) => this.handleEnd(proc, error));
    proc.on('exit', (code, signal) =>
      this.handleEnd(proc, new Error(`tdom engine exited (code=${code} signal=${signal})`))
    );

    const request = await this.getRequest();
    const deadline = Date.now() + this.startTimeoutMs;
    let lastError;
    while (this.proc === proc && Date.now() < deadline) {
      try {
        await request(`${this.url}/status`, { timeoutMs: 1_000 });
        this.state = 'ready';
        this.onReady?.();
        return { ok: true, url: this.url };
      } catch (error) {
        lastError = error;
      }
      await new Promise((resolve) => setTimeout(resolve, this.pollIntervalMs));
    }
    const detail = this.stderrTail.length ? ` — ${this.stderrTail.join(' / ')}` : '';
    const error =
      this.proc === proc
        ? new Error(
            `tdom engine did not become ready within ${this.startTimeoutMs}ms${
              lastError ? `: ${lastError.message}` : ''
            }${detail}`
          )
        : new Error(
            `tdom engine failed to start${detail || (this.lastError ? ` — ${this.lastError}` : '')}`
          );
    if (this.proc === proc) {
      try {
        proc.kill('SIGTERM');
      } catch {}
    }
    this.handleEnd(proc, error);
    throw error;
  }

  async getRequest() {
    if (this.requestImpl) return this.requestImpl;
    const { requestJson } = await import('./http-json.js');
    this.requestImpl = requestJson;
    return requestJson;
  }

  handleEnd(proc, error) {
    // A late exit event from an already-replaced process must not clear the
    // state of the process that replaced it.
    if (proc && this.proc !== proc) return;
    this.proc = null;
    this.port = null;
    this.state = 'stopped';
    this.lastError = error?.message || null;
    this.onEnd?.();
  }

  stop() {
    const proc = this.proc;
    this.proc = null;
    this.port = null;
    this.state = 'stopped';
    this.onEnd?.();
    // SIGTERM: the engine's own shutdown reaps the resident lualatex tree.
    // Killing it any harder leaks forked TeX processes.
    if (proc) {
      try {
        proc.kill('SIGTERM');
      } catch {}
    }
    return { ok: true };
  }

  shutdown() {
    return this.stop();
  }
}
