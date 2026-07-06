// ShippingChain — the incremental canonical (docs: goal "invisible
// canonical", phase 1). A second resident lualatex runs the document with
// the REAL output routine; the body is fed line-by-line over a socket. At
// every \shipout a pager child writes THAT page as a single-page PDF (real
// LuaLaTeX pixels) and a checkpoint child freezes the state right after the
// page, together with the consumed-line cursor. An edit whose first changed
// line lies beyond a checkpoint's cursor resumes from it: only the pages
// after the edit are re-shipped — the authority becomes a wave that follows
// the edit instead of a whole-document recompile.
//
// This class is display-agnostic: it reports shipped pages and captured
// labels; the engine decides when a resume is valid and when to fall back
// to the cold CanonicalRenderer (backward effects: a changed label value
// consumed by EARLIER pages).

import net from 'node:net';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { segmentBody } from '../segmenter.js';
import { ensureShim } from './forkshim.js';

const execFileP = promisify(execFile);
const DIR = path.dirname(fileURLToPath(import.meta.url));
const luaStr = (s) => s.replace(/\\/g, '\\\\').replace(/'/g, "\\'");

class Peer {
  constructor(socket) {
    this.socket = socket;
    this.buf = Buffer.alloc(0);
    this.role = null;
    this.idx = 0;
    this.pid = 0;
    this.alive = true;
    socket.on('close', () => (this.alive = false));
    socket.on('error', () => (this.alive = false));
  }
  send(s) {
    if (this.alive) this.socket.write(s);
  }
}

export class ShippingChain {
  constructor({ workDir, docDir }) {
    this.workDir = path.resolve(workDir);
    this.docDir = docDir ? path.resolve(docDir) : this.workDir;
    mkdirSync(this.workDir, { recursive: true });
    this.server = null;
    this.port = 0;
    this.root = null; // ChildProcess of the lualatex root
    this.rootPeer = null; // live feeder peer (root or a resumed checkpoint)
    this.gen = 0;
    this.lines = []; // current body lines (1-based via index+1)
    this.ships = []; // {page, nline, gen} in ship order for the LIVE lineage
    this.checkpoints = new Map(); // page -> Peer (state after that page)
    this.labels = new Map(); // key -> {val, page} captured this lineage
    this.pagePdf = new Map(); // page -> pdf path (current generation wins)
    this.svgCache = new Map(); // `${gen}:${page}` -> svg
    this.done = false; // current run reached EOF
    this.onShip = null; // callback({page, nline, gen})
    this.onLabel = null; // callback({key, val, page})
    this.onDone = null; // callback({pages, gen})
    this.disposed = false;
    this.err = null;
  }

  async #ensureServer() {
    if (this.server) return;
    await new Promise((resolve) => {
      this.server = net.createServer((sock) => this.#accept(sock));
      this.server.listen(0, '127.0.0.1', () => {
        this.port = this.server.address().port;
        resolve();
      });
    });
  }

  #accept(sock) {
    const peer = new Peer(sock);
    sock.on('data', (d) => {
      peer.buf = Buffer.concat([peer.buf, d]);
      this.#drain(peer);
    });
    // the live feeder ending its run through \enddocument closes its socket:
    // that IS completion (superseded feeders are replaced before their DIE)
    sock.on('close', () => {
      if (!this.disposed && peer === this.rootPeer && !this.done) {
        this.done = true;
        this.onDone?.({ pages: this.ships.length, gen: this.gen });
      }
    });
  }

  #drain(peer) {
    for (;;) {
      const nl = peer.buf.indexOf(0x0a);
      if (nl < 0) return;
      const line = peer.buf.slice(0, nl).toString('utf8');
      const parts = line.split(' ');
      const kind = parts[0];
      // messages with trailing byte payloads
      if (kind === 'SLABEL') {
        const page = Number(parts[1]);
        const kl = Number(parts[2]);
        const vl = Number(parts[3]);
        if (peer.buf.length < nl + 1 + kl + vl) return; // wait for payload
        const key = peer.buf.slice(nl + 1, nl + 1 + kl).toString('utf8');
        const val = peer.buf.slice(nl + 1 + kl, nl + 1 + kl + vl).toString('utf8');
        peer.buf = peer.buf.slice(nl + 1 + kl + vl);
        this.labels.set(key, { val, page });
        this.onLabel?.({ key, val, page });
        continue;
      }
      peer.buf = peer.buf.slice(nl + 1);
      this.#onMessage(peer, parts);
    }
  }

  #onMessage(peer, parts) {
    const kind = parts[0];
    if (kind === 'SHELLO') {
      peer.role = parts[1];
      peer.idx = Number(parts[2]);
      peer.pid = Number(parts[3]);
      if (peer.role === 'root') this.rootPeer = peer;
      if (peer.role === 'ckpt') this.checkpoints.set(peer.idx, peer);
      return;
    }
    if (kind === 'SNEED') {
      const n = Number(parts[1]); // 1-based line wanted
      if (n <= this.lines.length) {
        const body = Buffer.from(this.lines[n - 1] ?? '', 'utf8');
        peer.send(`SLINE ${body.length}\n`);
        peer.socket.write(body);
      } else {
        peer.send('SEOF\n');
      }
      return;
    }
    if (kind === 'SSHIP') {
      const page = Number(parts[1]);
      const nline = Number(parts[2]);
      this.ships.push({ page, nline, gen: this.gen });
      this.onShip?.({ page, nline, gen: this.gen });
      return;
    }
    if (kind === 'SPAGED') {
      const page = Number(parts[1]);
      const dir = path.join(this.workDir, `ship-g${this.gen}-p${page}`);
      this.pagePdf.set(page, path.join(dir, 'driver-ship.pdf'));
      return;
    }
    if (kind === 'SRESUMED') {
      this.rootPeer = peer;
      return;
    }
    if (kind === 'SEND') {
      this.done = true;
      this.onDone?.({ pages: Number(parts[1]), gen: this.gen });
      return;
    }
  }

  /** \par-complete feed units: segmenter blocks, then \end{document}. */
  #unitsOf(source) {
    const b = source.indexOf('\\begin{document}');
    const e = source.indexOf('\\end{document}', b);
    const bodyStart = b + '\\begin{document}'.length;
    const body = source.slice(bodyStart, e < 0 ? source.length : e);
    const units = segmentBody(body, 0).map((s) => s.text);
    units.push('\\end{document}');
    return units;
  }

  #driverSource(preamble, labelSeed) {
    const L = [];
    L.push(preamble.trimEnd());
    L.push('\\newcount\\TDOMdiscard');
    L.push(
      '\\AddToHook{shipout/before}{\\directlua{tdom_ship_before()}' +
        '\\ifnum\\TDOMdiscard=1 \\DiscardShipoutBox\\fi}'
    );
    L.push('\\AddToHook{shipout/after}{\\directlua{tdom_ship_after()}}');
    L.push('\\begin{document}');
    L.push(`\\directlua{dofile('${luaStr(path.join(DIR, 'shipd.lua'))}')}`);
    L.push(`\\directlua{tdom_ship_boot(${this.port}, '${luaStr(this.workDir)}')}`);
    L.push('\\makeatletter');
    for (const [key, val] of labelSeed ?? []) {
      if (key.startsWith('cite:')) {
        L.push(`\\global\\@namedef{b@${key.slice(5)}}{${val}}`);
      } else {
        L.push(`\\global\\@namedef{r@${key}}{{${val}}{1}}`);
      }
    }
    // capture labels at definition time (the aux is never read back)
    L.push('\\let\\TDOMshiplabel\\label');
    L.push(
      "\\renewcommand\\label[1]{\\TDOMshiplabel{#1}\\directlua{tdom_ship_label('\\luaescapestring{#1}','\\luaescapestring{\\@currentlabel}')}}"
    );
    L.push('\\makeatother');
    // TeX-side tail loop: one input level per fed line (see tdom_ship_feed)
    L.push('\\def\\TDOMshiploop{\\directlua{tdom_ship_feed()}\\TDOMshiploop}');
    L.push('\\TDOMshiploop');
    L.push('\\end{document}');
    L.push('');
    return L.join('\n');
  }

  /** Boot the chain on a full source. Body must be \par-line addressable. */
  async open(source, { labelSeed, contents } = {}) {
    await ensureShim(this.workDir);
    await this.#ensureServer();
    const b = source.indexOf('\\begin{document}');
    if (b < 0) throw new Error('shipping chain needs \\begin{document}');
    const preamble = source.slice(0, b);
    // Units are \par-complete blocks (the segmenter's invariant): an
    // environment never straddles a feeder-loop iteration, which keeps
    // \halign-style parsers (align, tabular) away from the loop macro.
    // The LAST unit is \end{document}: the run ends through \enddocument
    // (its final \clearpage ships the last partial page).
    this.lines = this.#unitsOf(source);
    this.gen = 0;
    this.ships = [];
    this.labels.clear();
    this.pagePdf.clear();
    this.svgCache.clear();
    this.done = false;
    writeFileSync(path.join(this.workDir, 'driver-ship.tex'), this.#driverSource(preamble, labelSeed));
    for (const ext of ['aux', 'toc', 'lof', 'lot', 'out']) {
      rmSync(path.join(this.workDir, `driver-ship.${ext}`), { force: true });
    }
    // contents seeds: \tableofcontents & friends read these ONCE at their
    // position in the run — the caller provides converged content (the
    // engine's #computeToc output, or a previous authority's files)
    for (const [ext, content] of Object.entries(contents ?? {})) {
      writeFileSync(path.join(this.workDir, `driver-ship.${ext}`), content);
    }
    // --shell-escape: package.loadlib (the fork shim) is blocked in
    // restricted mode, same reason the resident root runs unrestricted
    this.root = spawn('lualatex', ['--shell-escape', '-interaction=nonstopmode', 'driver-ship.tex'], {
      cwd: this.workDir,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        TEXINPUTS: `${this.docDir}:${process.env.TEXINPUTS || ''}`,
        LUAINPUTS: `${this.docDir}:${process.env.LUAINPUTS || ''}`,
      },
    });
    let log = '';
    this.root.stdout.on('data', (d) => {
      log += d;
      if (log.length > 65536) log = log.slice(-32768);
    });
    this.root.stderr.on('data', (d) => (log += d));
    this.rootLog = () => log;
    this.root.on('exit', (code) => {
      // a clean exit is the normal end of a run (completion is signaled by
      // the feeder peer's socket close); only a crash is an error
      if (!this.done && !this.disposed && code !== 0) {
        this.err = new Error(`shipping root exited (${code})`);
      }
    });
  }

  /**
   * Apply a new source. Returns {mode:'resumed', fromPage} when a checkpoint
   * covers the edit, {mode:'reboot-needed'} when the change reaches page-1
   * material (caller decides: full reboot or cold canonical only).
   */
  resume(newSource) {
    const newLines = this.#unitsOf(newSource);
    let first = 0;
    while (
      first < this.lines.length &&
      first < newLines.length &&
      this.lines[first] === newLines[first]
    ) {
      first++;
    }
    if (first >= this.lines.length && newLines.length === this.lines.length) {
      return { mode: 'unchanged' };
    }
    const firstChanged = first + 1; // 1-based
    // the newest checkpoint whose consumed-line cursor is strictly before
    // the first changed line can replay the tail exactly
    let best = null;
    for (const s of this.ships) {
      if (s.gen !== undefined && s.nline < firstChanged && this.checkpoints.get(s.page)?.alive) {
        if (!best || s.page > best.page) best = s;
      }
    }
    this.lines = newLines;
    if (!best) return { mode: 'reboot-needed', firstChanged };
    // kill everything in the stale tail
    this.gen++;
    for (const [page, peer] of [...this.checkpoints]) {
      if (page > best.page) {
        peer.send('DIE\n');
        this.checkpoints.delete(page);
      }
    }
    const old = this.rootPeer;
    this.rootPeer = null; // a superseded feeder's close is not completion
    if (old?.alive) old.send('DIE\n');
    this.ships = this.ships.filter((s) => s.page <= best.page);
    for (const [page] of [...this.pagePdf]) {
      if (page > best.page) this.pagePdf.delete(page);
    }
    this.done = false;
    const peer = this.checkpoints.get(best.page);
    peer.send(`RESUME ${this.gen}\n`);
    return { mode: 'resumed', fromPage: best.page + 1, firstChanged };
  }

  /** Lazy per-page SVG of a shipped page. */
  async pageSVG(page) {
    const pdf = this.pagePdf.get(page);
    if (!pdf || !existsSync(pdf)) return null;
    const key = `${this.gen}:${page}`;
    const hit = this.svgCache.get(key);
    if (hit) return hit;
    const svgPath = pdf.replace(/\.pdf$/, '.svg');
    await execFileP('pdftocairo', ['-svg', pdf, svgPath], { timeout: 30_000 });
    const svg = readFileSync(svgPath, 'utf8');
    this.svgCache.set(key, svg);
    if (this.svgCache.size > 200) {
      this.svgCache.delete(this.svgCache.keys().next().value);
    }
    return svg;
  }

  info() {
    return {
      gen: this.gen,
      pages: this.ships.length,
      shipped: [...this.pagePdf.keys()].sort((a, b) => a - b),
      done: this.done,
      error: this.err?.message ?? null,
    };
  }

  async close() {
    this.disposed = true;
    for (const peer of this.checkpoints.values()) peer.send('DIE\n');
    if (this.rootPeer?.alive) this.rootPeer.send('DIE\n');
    if (this.root) {
      try {
        this.root.kill('SIGKILL');
      } catch {
        /* gone */
      }
    }
    // reap pager/ckpt strays by pid is unnecessary: socket death exits them
    this.server?.close();
  }
}
