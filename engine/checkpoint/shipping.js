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
import { createHash, randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { withProjectInputs } from '../project-inputs.js';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { segmentBody } from '../segmenter.js';
import { classifyStructuralAliases } from './structural-aliases.js';
import { ensureShim } from './forkshim.js';

const execFileP = promisify(execFile);
const DIR = path.dirname(fileURLToPath(import.meta.url));
const luaStr = (s) => s.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
const PLAIN_EDIT_UNSAFE = /[\\{}$%&#^_\r\n]/;
const DOCUMENT_EFFECT_UNSAFE = /\\(?:catcode|every(?:par|job|cr|math|display)|output|directlua|latelua|newwrite|openout|write|immediate|special|pdfextension|shipout)\b/;
const INPUT_IDENTITY_UNSAFE = /\\(?:jobname|inputlineno|everyeof|endinput|CurrentFile|currfilename)\b/;
// \today is intentionally allowed: in ordinary LaTeX it expands from the
// date registers already frozen in the checkpoint and a tail replay never
// reevaluates a shipped prefix. Direct clock/register observation remains
// outside the certified profile.
const NONDETERMINISM_UNSAFE = /\\(?:time|day|month|year|pdfelapsedtime|pdfrandomseed|uniformdeviate|openin|read|ifeof|filemoddate|filesize|mdfivesum|ShellEscape)\b|\\input\s*\|/;

function plainReplayEdit(before, after) {
  let start = 0;
  while (start < before.length && start < after.length && before[start] === after[start]) start++;
  let oldEnd = before.length;
  let newEnd = after.length;
  while (oldEnd > start && newEnd > start && before[oldEnd - 1] === after[newEnd - 1]) {
    oldEnd--;
    newEnd--;
  }
  const removed = before.slice(start, oldEnd);
  const inserted = after.slice(start, newEnd);
  if (PLAIN_EDIT_UNSAFE.test(removed) || PLAIN_EDIT_UNSAFE.test(inserted) ||
      DOCUMENT_EFFECT_UNSAFE.test(before) || INPUT_IDENTITY_UNSAFE.test(before) ||
      NONDETERMINISM_UNSAFE.test(before)) return false;

  // Conservative lexical state at the changed byte. A visible prose edit is
  // outside TeX groups/math/comments and is not part of a control word.
  let groups = 0;
  let math = null;
  let comment = false;
  for (let index = 0; index < start; index++) {
    const char = before[index];
    if (comment) {
      if (char === '\n') comment = false;
      continue;
    }
    if (char === '%') { comment = true; continue; }
    if (char === '\\') {
      const symbol = before[index + 1];
      if (symbol === '(' || symbol === '[') math = symbol;
      else if ((symbol === ')' && math === '(') || (symbol === ']' && math === '[')) math = null;
      index++;
      continue;
    }
    if (char === '{') groups++;
    else if (char === '}') groups = Math.max(0, groups - 1);
    else if (char === '$') math = math ? null : '$';
  }
  return !comment && groups === 0 && math === null &&
    !/\\[A-Za-z@]*$/.test(before.slice(0, start));
}

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
  constructor({ workDir, docDir, overlayDir = null }) {
    this.workDir = path.resolve(workDir);
    this.docDir = docDir ? path.resolve(docDir) : this.workDir;
    this.overlayDir = overlayDir ? path.resolve(overlayDir) : null;
    mkdirSync(this.workDir, { recursive: true });
    this.server = null;
    this.port = 0;
    this.root = null; // ChildProcess of the lualatex root
    this.rootPeer = null; // live feeder peer (root or a resumed checkpoint)
    this.peers = new Set(); // every connected fork, including superseded races
    this.gen = 0;
    this.lines = []; // current body lines (1-based via index+1)
    this.source = '';
    this.ships = []; // {page, nline, gen} in ship order for the LIVE lineage
    this.checkpoints = new Map(); // page -> Peer (state after that page)
    this.labels = new Map(); // key -> {val, page} captured this lineage
    this.pagePdf = new Map(); // page -> pdf path (current generation wins)
    this.pageGen = new Map(); // page -> generation owning pagePdf
    this.svgCache = new Map(); // `${gen}:${page}` -> svg
    this.done = false; // current run reached EOF
    this.onShip = null; // callback({page, nline, gen})
    this.onPaged = null; // callback({page, gen, pdf}) — pixels ready
    this.onWave = null; // callback({pages, gen, fromPage, elapsedMs}) — closure-ready set
    this.onLabel = null; // callback({key, val, page})
    this.onDone = null; // callback({pages, gen})
    this.onBaselineOutcome = null; // one-shot callback after terminal gen-0 validation
    this.chainId = randomUUID();
    this.baselineIdentity = null;
    this.baselineOutcomeEmitted = false;
    this.retryState = null; // manager-owned diagnostic state
    this.disposed = false;
    this.err = null;
    this.baselinePages = null;
    this.baselineManifest = null;
    this.rootOutputDir = this.workDir;
    this.waveFromPage = 1;
    this.waveStartedAt = 0;
    this.wavePublishedGen = -1;
    this.waveValidatingGen = -1;
    this.waveDeadlineTimer = null;
    this.wavePrefixPage = 0;
    this.publishedPdf = null; // complete wave-end PDF backing the visible generation
    this.pdfJsPromise = null;
    this.lastRejectReason = null;
    // Experimental hyperref-compatible lineage: each pager/checkpoint owns
    // a private clone of LuaTeX's already-open PDF descriptor. Kept behind a
    // flag until byte/raster stress tests prove it against cold canonical.
    this.privatePdf = process.env.TDOM_SHIP_PRIVATE_PDF !== '0';
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
    this.peers.add(peer);
    sock.on('data', (d) => {
      peer.buf = Buffer.concat([peer.buf, d]);
      this.#drain(peer);
    });
    // the live feeder ending its run through \enddocument closes its socket:
    // that IS completion (superseded feeders are replaced before their DIE)
    sock.on('close', () => {
      this.peers.delete(peer);
      if (this.disposed) return;
      // a pager's EXIT is the completion signal for its page: the PDF is
      // fully flushed exactly when the process is gone (an in-run message
      // races the final xref write)
      if (peer.role === 'pager' && peer.gen === this.gen &&
          !(this.wavePublishedGen === peer.gen && this.lastRejectReason === 'deadline-exceeded')) {
        const dir = path.join(this.workDir, `ship-g${peer.gen}-p${peer.idx}`);
        const pdf = path.join(dir, 'driver-ship.pdf');
        if (existsSync(pdf)) {
          this.pagePdf.set(peer.idx, pdf);
          this.pageGen.set(peer.idx, peer.gen);
          this.onPaged?.({ page: peer.idx, gen: peer.gen, pdf });
          this.#maybeWaveReady();
        }
      }
      if (peer === this.rootPeer && !this.done) {
        if (!peer.sentEnd) {
          this.err = new Error('shipping root exited before document end');
        } else {
          this.done = true;
          this.onDone?.({ pages: peer.reportedPages ?? this.ships.length, gen: this.gen });
          this.#maybeWaveReady();
        }
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
      peer.gen = parts[4] !== undefined ? Number(parts[4]) : this.gen;
      if (peer.role === 'root') {
        // An immutable checkpoint may have cloned generation R1 immediately
        // before R2 superseded it. Never let that late HELLO steal the live
        // feeder slot or ask for R2's source units with R1's TeX state.
        if (
          peer.gen !== this.gen ||
          (this.wavePublishedGen === peer.gen && this.lastRejectReason === 'deadline-exceeded')
        ) {
          peer.send('DIE\n');
          if (peer.pid) {
            try { process.kill(peer.pid, 'SIGKILL'); } catch { /* gone */ }
          }
          return;
        }
        this.rootPeer = peer;
      }
      if (peer.role === 'ckpt') {
        if (
          this.wavePublishedGen === peer.gen &&
          this.lastRejectReason === 'deadline-exceeded'
        ) {
          peer.send('DIE\n');
          if (peer.pid) {
            try { process.kill(peer.pid, 'SIGKILL'); } catch { /* gone */ }
          }
          return;
        }
        const retained = this.ships.some(
          (ship) => ship.page === peer.idx && ship.gen === peer.gen
        );
        // A checkpoint from a superseded continuation can announce after a
        // newer keystroke. Only the current generation or an explicitly
        // retained prefix frontier may enter the reusable checkpoint map.
        if (peer.gen !== this.gen && !retained) {
          peer.send('DIE\n');
          if (peer.pid) {
            try { process.kill(peer.pid, 'SIGKILL'); } catch { /* gone */ }
          }
          return;
        }
        const currentPage = this.ships.at(-1)?.page ?? 0;
        const recent = Number(process.env.TDOM_SHIP_RECENT ?? 16);
        const grid = Number(process.env.TDOM_SHIP_GRID ?? 8);
        if (peer.idx <= currentPage - recent && peer.idx % grid !== 0) {
          peer.send('DIE\n');
          if (peer.pid) {
            try { process.kill(peer.pid, 'SIGKILL'); } catch { /* gone */ }
          }
          return;
        }
        peer.outputDir = path.join(this.workDir, `ship-g${peer.gen}-ck${peer.idx}`);
        const previous = this.checkpoints.get(peer.idx);
        if (previous?.alive && previous.gen > peer.gen) {
          peer.send('DIE\n');
          if (peer.pid) {
            try { process.kill(peer.pid, 'SIGKILL'); } catch { /* gone */ }
          }
          return;
        }
        if (previous && previous !== peer && previous.gen <= peer.gen) {
          previous.send('DIE\n');
          if (previous.pid) {
            try { process.kill(previous.pid, 'SIGKILL'); } catch { /* gone */ }
          }
        }
        this.checkpoints.set(peer.idx, peer);
      }
      return;
    }
    if (kind === 'SNEED') {
      if (peer.role !== 'ckpt' && peer.gen !== this.gen) {
        peer.send('DIE\n');
        return;
      }
      const n = Number(parts[1]); // 1-based line wanted
      if (n <= this.lines.length) {
        const body = Buffer.from(this.lines[n - 1] ?? '', 'utf8');
        // The final unit is our fixed \end{document}. A normal source run
        // exits while processing it and therefore never asks for SEOF.
        if (n === this.lines.length) peer.sentEnd = true;
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
      const gen = Number(parts[3] ?? this.gen);
      if (gen !== this.gen) return; // a superseded lineage's late report
      this.ships.push({ page, nline, gen });
      // resource cap: resume checkpoints are resident processes. Keep the
      // RECENT pages densely (typing locality: a wave restarts at the
      // edited page) and every GRIDth boundary sparsely — a cold jump
      // replays at most GRID-1 extra pages, tens of ms each.
      const recent = Number(process.env.TDOM_SHIP_RECENT ?? 16);
      const grid = Number(process.env.TDOM_SHIP_GRID ?? 8);
      for (const [pg, ck] of [...this.checkpoints]) {
        if (pg > page - recent || pg % grid === 0) continue;
        ck.send('DIE\n');
        this.checkpoints.delete(pg);
      }
      this.onShip?.({ page, nline, gen });
      return;
    }
    if (kind === 'SPDFROOT') {
      this.err = new Error('pdf-opened-at-root (hyperref-class document)');
      this.done = true;
      return;
    }
    if (kind === 'SRESUMED') {
      if (peer.gen === this.gen) this.rootPeer = peer;
      return;
    }
    if (kind === 'SEND') {
      // This is EOF at the TeX feeder, not artifact completion. The PDF
      // backend, enddocument hooks and writable streams are authoritative
      // only once this root process closes its socket during normal exit.
      peer.sentEnd = true;
      peer.reportedPages = Number(parts[1]);
      return;
    }
  }

  async #validateCompletePdf(pdf, expectedPages) {
    if (!existsSync(pdf)) return false;
    try {
      if (!this.pdfJsPromise) {
        this.pdfJsPromise = (async () => {
          const configured = String(process.env.TDOM_PDFJS_PATH ?? '').trim();
          const local = path.join(DIR, '../../web/pdfjs/pdf.min.mjs');
          const specifier = configured
            ? (path.isAbsolute(configured) ? pathToFileURL(configured).href : configured)
            : pathToFileURL(local).href;
          const module = await import(specifier);
          if (typeof module?.getDocument !== 'function') throw new Error('pdf.js unavailable');
          if (module.GlobalWorkerOptions) {
            const worker = configured && path.isAbsolute(configured)
              ? path.join(path.dirname(configured), path.basename(configured).includes('.min.')
                ? 'pdf.worker.min.mjs'
                : 'pdf.worker.mjs')
              : path.join(DIR, '../../web/pdfjs/pdf.worker.min.mjs');
            module.GlobalWorkerOptions.workerSrc = pathToFileURL(worker).href;
          }
          return module;
        })();
      }
      const pdfjs = await this.pdfJsPromise;
      const task = pdfjs.getDocument({
        data: new Uint8Array(readFileSync(pdf)),
        disableWorker: true,
        stopAtErrors: true,
        isEvalSupported: false,
      });
      const document = await task.promise;
      const valid = document.numPages === expectedPages;
      await document.destroy().catch(() => {});
      return valid;
    } catch {
      return false;
    }
  }

  #outputManifest(dir) {
    const out = {};
    if (!dir || !existsSync(dir)) return out;
    for (const name of readdirSync(dir).sort()) {
      if (name === 'driver-ship.pdf' || name === 'driver-ship.log' ||
          name === 'driver-ship.tex' || name === 'tdomfork.so' ||
          name === 'tdomfork.so.sha256' ||
          /^driver-ship(?:-g\d+-p\d+)?\.svg$/.test(name) ||
          /^feed-u\d+\.tex$/.test(name)) continue;
      const file = path.join(dir, name);
      let stat;
      try { stat = statSync(file); } catch { continue; }
      if (!stat.isFile()) continue;
      out[name] = createHash('sha256').update(readFileSync(file)).digest('hex');
    }
    return out;
  }

  #maybeWaveReady() {
    if (!this.done || this.wavePublishedGen === this.gen) return;
    const waveShips = this.ships.filter((ship) => ship.gen === this.gen);
    if (!waveShips.length) return;
    const pageCount = this.ships.length;
    const manifest = this.#outputManifest(this.rootOutputDir);
    const completePdf = path.join(this.rootOutputDir, 'driver-ship.pdf');
    // Initial sound profile: no rejoin. The replay must reach document end,
    // preserve the physical page sequence and reproduce every non-PDF output
    // byte before any page is announced to the renderer.
    if (this.gen !== 0 && pageCount !== this.baselinePages) {
      clearTimeout(this.waveDeadlineTimer);
      this.waveDeadlineTimer = null;
      this.lastRejectReason = 'page-count-changed';
      this.wavePublishedGen = this.gen; // fail closed for this generation
      return;
    }
    if (this.gen !== 0 &&
        JSON.stringify(manifest) !== JSON.stringify(this.baselineManifest)) {
      clearTimeout(this.waveDeadlineTimer);
      this.waveDeadlineTimer = null;
      this.lastRejectReason = 'output-manifest-changed';
      this.wavePublishedGen = this.gen; // fail closed for this generation
      return;
    }
    const expected = [];
    for (let page = this.waveFromPage; page <= pageCount; page++) expected.push(page);
    const cutoffMs = Number(process.env.TDOM_SHIP_WAVE_CUTOFF ?? 700);
    const validatingGen = this.gen;
    if (this.waveValidatingGen === validatingGen) return;
    this.waveValidatingGen = validatingGen;
    void this.#validateCompletePdf(completePdf, pageCount).then((valid) => {
      if (this.disposed || validatingGen !== this.gen || this.wavePublishedGen === validatingGen) return;
      this.wavePublishedGen = validatingGen;
      clearTimeout(this.waveDeadlineTimer);
      this.waveDeadlineTimer = null;
      if (!valid) {
        this.lastRejectReason = 'complete-pdf-invalid';
        if (validatingGen === 0) {
          this.#emitBaselineOutcome({
            outcome: 'FAILED_INVARIANT',
            failureClass: 'complete-pdf-invalid',
          });
        }
        return;
      }
      if (validatingGen === 0) {
        this.baselinePages = pageCount;
        this.baselineManifest = manifest;
        this.publishedPdf = completePdf;
        const pdfHash = createHash('sha256').update(readFileSync(completePdf)).digest('hex');
        const manifestHash = createHash('sha256')
          .update(JSON.stringify(manifest))
          .digest('hex');
        this.#emitBaselineOutcome({
          outcome: 'CERTIFIED',
          pdfCertificateId: `${pdfHash}:${manifestHash}:${pageCount}`,
          pdfHash,
          manifestHash,
          pageCount,
        });
        return;
      }
      const elapsedMs = Date.now() - this.waveStartedAt;
      if (elapsedMs >= cutoffMs) {
        this.lastRejectReason = 'deadline-exceeded';
        return; // never land a late "fast" result
      }
      // Native replay must certify within the tighter engine budget, while
      // the user-facing contract includes fetching/decoding every visible
      // SVG and one atomic browser commit.  Sharing the 700ms engine cutoff
      // left only ~150ms for a 21-page stress document and cancelled an
      // otherwise valid 552ms wave.  Keep the proof budget strict but give
      // the renderer the remainder of the one-second input-to-pixels SLA.
      const visibleCutoffMs = Number(process.env.TDOM_SHIP_VISIBLE_CUTOFF ?? 1000);
      // The generation authority is the replay root's one complete PDF,
      // never a tail-page pager artifact. Prefix pages may reference objects
      // finalized after the checkpoint (fonts, links, destinations).
      this.publishedPdf = completePdf;
      this.svgCache.clear();
      this.onWave?.({
        pages: Array.from({ length: pageCount }, (_, index) => index + 1),
        changedPages: expected,
        gen: validatingGen,
        fromPage: this.waveFromPage,
        elapsedMs,
        acceptedAt: this.waveStartedAt,
        deadlineAt: this.waveStartedAt + visibleCutoffMs,
      });
    });
  }

  /** \par-complete feed units: segmenter blocks, then \end{document}. */
  #unitsOf(source) {
    const b = source.indexOf('\\begin{document}');
    const e = source.indexOf('\\end{document}', b);
    const bodyStart = b + '\\begin{document}'.length;
    const body = source.slice(bodyStart, e < 0 ? source.length : e);
    const structural = classifyStructuralAliases(source.slice(0, b), body);
    const segments = segmentBody(body, 0, { structuralEvents: structural.segmentEvents });
    // Preserve every source byte, including the blank lines that terminate
    // paragraphs. The segmenter's `text` intentionally excludes separators;
    // rebuilding from those strings and adding an artificial `\\par` is not
    // equivalent for input-buffer callbacks such as LuaTeX-ja. Slice at the
    // same safe boundaries instead, so concatenating the units reconstructs
    // the original body exactly.
    const units = segments.map((segment, index) => {
      const start = index === 0 ? 0 : segment.start;
      const end = segments[index + 1]?.start ?? body.length;
      return body.slice(start, end);
    });
    units.push('\\end{document}');
    return units;
  }

  #driverSource(preamble, labelSeed, hasCanonicalAux = false) {
    const L = [];
    L.push(preamble.trimEnd());
    L.push('\\newcount\\TDOMdiscard');
    L.push(
      '\\AddToHook{shipout/before}{\\directlua{tdom_ship_before()}' +
        '\\ifnum\\TDOMdiscard=1 \\DiscardShipoutBox\\fi}'
    );
    L.push('\\AddToHook{shipout/after}{\\directlua{tdom_ship_after()}}');
    if (this.privatePdf) {
      // Boot before \begin{document}: hyperref may open the PDF from a begin
      // hook, and the fork shim must know that descriptor's original path.
      L.push(`\\directlua{dofile('${luaStr(path.join(DIR, 'shipd.lua'))}')}`);
      L.push(`\\directlua{tdom_ship_boot(${this.port}, '${luaStr(this.workDir)}', 1)}`);
    }
    L.push('\\begin{document}');
    if (!this.privatePdf) {
      L.push(`\\directlua{dofile('${luaStr(path.join(DIR, 'shipd.lua'))}')}`);
      L.push(`\\directlua{tdom_ship_boot(${this.port}, '${luaStr(this.workDir)}', 0)}`);
    }
    L.push('\\makeatletter');
    if (!hasCanonicalAux) {
      for (const [key, val] of labelSeed ?? []) {
        if (key.startsWith('cite:')) {
          L.push(`\\global\\@namedef{b@${key.slice(5)}}{${val}}`);
        } else {
          const v = Array.isArray(val) ? val : [val, 1];
          L.push(`\\global\\@namedef{r@${key}}{{${v[0]}}{${v[1] ?? 1}}}`);
        }
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
  async open(source, { labelSeed, contents, seedFiles, baselineIdentity = null } = {}) {
    // Generation directory names restart at zero with each server process.
    // Remove an older chain's private branches before Lua creates this
    // chain's branches, otherwise viewer SVGs or partially written outputs
    // from a previous process can contaminate the semantic manifest.
    for (const name of readdirSync(this.workDir)) {
      if (/^ship-g\d+-(?:p\d+|ck\d+|root-from-\d+)$/.test(name)) {
        rmSync(path.join(this.workDir, name), { recursive: true, force: true });
      } else if (/^driver-ship(?:-g\d+-p\d+)?\.svg$/.test(name)) {
        rmSync(path.join(this.workDir, name), { force: true });
      }
    }
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
    this.source = source;
    this.gen = 0;
    this.ships = [];
    this.labels.clear();
    this.pagePdf.clear();
    this.pageGen.clear();
    this.svgCache.clear();
    this.done = false;
    this.baselineIdentity = baselineIdentity ? Object.freeze({ ...baselineIdentity }) : null;
    this.baselineOutcomeEmitted = false;
    this.baselinePages = null;
    this.baselineManifest = null;
    this.rootOutputDir = this.workDir;
    this.waveFromPage = 1;
    this.waveStartedAt = Date.now();
    this.wavePublishedGen = -1;
    this.waveValidatingGen = -1;
    this.publishedPdf = null;
    this.lastRejectReason = null;
    writeFileSync(
      path.join(this.workDir, 'driver-ship.tex'),
      this.#driverSource(preamble, labelSeed, seedFiles?.aux !== undefined)
    );
    for (const ext of ['aux', 'toc', 'lof', 'lot', 'out']) {
      rmSync(path.join(this.workDir, `driver-ship.${ext}`), { force: true });
    }
    // Prefer the converged canonical files verbatim. In particular,
    // hyperref stores destination names and link metadata in the additional
    // fields of \newlabel; synthesizing only value/page silently changes the
    // painted color/link state even when extracted text is identical.
    for (const [ext, content] of Object.entries(seedFiles ?? {})) {
      if (!['aux', 'toc', 'lof', 'lot', 'out'].includes(ext)) continue;
      writeFileSync(path.join(this.workDir, `driver-ship.${ext}`), content);
    }
    // contents seeds: \tableofcontents & friends read these ONCE at their
    // position in the run — the caller provides converged content (the
    // engine's #computeToc output, or a previous authority's files)
    for (const [ext, content] of Object.entries(contents ?? {})) {
      if (seedFiles?.[ext] !== undefined) continue;
      writeFileSync(path.join(this.workDir, `driver-ship.${ext}`), content);
    }
    // --shell-escape: package.loadlib (the fork shim) is blocked in
    // restricted mode, same reason the resident root runs unrestricted
    this.root = spawn('lualatex', ['--shell-escape', '-interaction=nonstopmode', 'driver-ship.tex'], {
      cwd: this.workDir,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: withProjectInputs(process.env, { docDir: this.docDir, overlayDir: this.overlayDir }),
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
        if (this.gen === 0) {
          this.#emitBaselineOutcome({
            outcome: 'FAILED_DETERMINISTIC',
            failureClass: 'root-exit',
            error: this.err.message,
          });
        }
      }
    });
  }

  #emitBaselineOutcome(event) {
    if (this.baselineOutcomeEmitted) return false;
    this.baselineOutcomeEmitted = true;
    this.onBaselineOutcome?.({
      ...event,
      ...this.baselineIdentity,
      chainId: this.chainId,
      baselineGeneration: 0,
    });
    return true;
  }

  /**
   * Apply a new source. Returns {mode:'resumed', fromPage} when a checkpoint
   * covers the edit, {mode:'reboot-needed'} when the change reaches page-1
   * material (caller decides: full reboot or cold canonical only).
   */
  resume(newSource) {
    if (this.gen === 0 && this.baselinePages === null) {
      this.lastRejectReason = 'baseline-not-certified';
      return { mode: 'reboot-needed', reason: 'baseline-not-certified' };
    }
    if (!plainReplayEdit(this.source, newSource)) {
      this.lastRejectReason = 'non-plain-edit';
      return { mode: 'reboot-needed', reason: 'non-plain-edit' };
    }
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
    this.source = newSource;
    if (!best) return { mode: 'reboot-needed', firstChanged };
    // kill everything in the stale tail
    clearTimeout(this.waveDeadlineTimer);
    this.waveDeadlineTimer = null;
    this.gen++;
    for (const [page, peer] of [...this.checkpoints]) {
      if (page > best.page) {
        peer.send('DIE\n');
        this.checkpoints.delete(page);
      }
    }
    const old = this.rootPeer;
    this.rootPeer = null; // a superseded feeder's close is not completion
    if (old?.alive) {
      old.send('DIE\n');
      // a feeder deep inside typesetting reads the socket only at its next
      // SNEED — kill it outright so the wave preempts instantly
      if (old.pid) {
        try { process.kill(old.pid, 'SIGKILL'); } catch { /* gone */ }
      }
    }
    this.ships = this.ships.filter((s) => s.page <= best.page);
    for (const [page] of [...this.pagePdf]) {
      if (page > best.page) {
        this.pagePdf.delete(page);
        this.pageGen.delete(page);
      }
    }
    this.done = false;
    this.lastRejectReason = null;
    const peer = this.checkpoints.get(best.page);
    this.rootOutputDir = path.join(this.workDir, `ship-g${this.gen}-root-from-${best.page}`);
    this.waveFromPage = best.page + 1;
    this.wavePrefixPage = best.page;
    this.waveStartedAt = Date.now();
    peer.send(`RESUME ${this.gen}\n`);
    const cutoffMs = Math.max(1, Number(process.env.TDOM_SHIP_WAVE_CUTOFF ?? 700));
    const deadlineGen = this.gen;
    this.waveDeadlineTimer = setTimeout(() => {
      if (
        this.disposed ||
        this.gen !== deadlineGen ||
        this.wavePublishedGen === deadlineGen
      ) return;
      // A provisional generation that can no longer be published must stop
      // consuming the very CPU needed by the next keystroke. Preserve only
      // the certified prefix checkpoint; the cold canonical remains the
      // eventual authority for this source revision.
      this.lastRejectReason = 'deadline-exceeded';
      this.wavePublishedGen = deadlineGen;
      this.done = true;
      const root = this.rootPeer;
      this.rootPeer = null;
      if (root?.alive) {
        root.send('DIE\n');
        if (root.pid) {
          try { process.kill(root.pid, 'SIGKILL'); } catch { /* gone */ }
        }
      }
      for (const [page, checkpoint] of [...this.checkpoints]) {
        if (page <= this.wavePrefixPage || checkpoint.gen !== deadlineGen) continue;
        checkpoint.send('DIE\n');
        if (checkpoint.pid) {
          try { process.kill(checkpoint.pid, 'SIGKILL'); } catch { /* gone */ }
        }
        this.checkpoints.delete(page);
      }
      // Pager sockets can have closed before the deadline and installed
      // page paths from this incomplete generation. They are not a
      // "certified prefix": only the prefix that existed before resume is
      // reusable. Remove every current-generation artifact, and make the
      // socket-close handler above drain-only for any pager that exits late.
      for (const [page, pageGen] of [...this.pageGen]) {
        if (pageGen !== deadlineGen) continue;
        this.pageGen.delete(page);
        this.pagePdf.delete(page);
      }
      for (const key of [...this.svgCache.keys()]) {
        if (key.startsWith(`${deadlineGen}:`)) this.svgCache.delete(key);
      }
      this.ships = this.ships.filter((ship) => ship.page <= this.wavePrefixPage);
    }, cutoffMs);
    this.waveDeadlineTimer.unref?.();
    return { mode: 'resumed', fromPage: best.page + 1, firstChanged };
  }

  /** Lazy per-page SVG of a shipped page. */
  async pageSVG(page) {
    const pdf = this.publishedPdf ?? this.pagePdf.get(page);
    if (!pdf || !existsSync(pdf)) return null;
    const key = `${this.gen}:${page}`;
    const hit = this.svgCache.get(key);
    if (hit) return hit;
    // Visible pages are requested concurrently.  A shared driver-ship.svg
    // made page N and N+1 overwrite each other before readFileSync, which
    // either cancelled the atomic batch or returned the wrong page.
    const svgPath = path.join(path.dirname(pdf), `driver-ship-g${this.gen}-p${page}.svg`);
    await execFileP('pdftocairo', ['-svg', '-f', String(page), '-l', String(page), pdf, svgPath], { timeout: 30_000 });
    const svg = readFileSync(svgPath, 'utf8');
    this.svgCache.set(key, svg);
    if (this.svgCache.size > 200) {
      this.svgCache.delete(this.svgCache.keys().next().value);
    }
    return svg;
  }

  info() {
    const retry = this.retryState;
    return {
      gen: this.gen,
      pages: this.ships.length,
      shipped: [...new Set(this.ships.map((ship) => ship.page))].sort((a, b) => a - b),
      done: this.done,
      error: this.err?.message ?? null,
      waveFromPage: this.waveFromPage,
      waveReady: this.wavePublishedGen === this.gen,
      baselineReady: this.baselinePages !== null,
      completePdf: this.publishedPdf,
      rejectReason: this.lastRejectReason,
      retry: retry ? {
        state: retry.state,
        activeAttemptId: retry.activeAttemptId,
        activeChainId: retry.activeChainId,
        consecutiveFailures: retry.consecutiveFailures,
        lastOutcome: retry.lastOutcome,
        lastFailureClass: retry.lastFailureClass,
        lastFailureFingerprint: retry.lastFailureFingerprint,
        cooldownUntil: retry.cooldownUntil,
        lastCertifiedSnapshot: retry.lastCertifiedSnapshot,
        desiredSnapshot: retry.desiredSnapshot,
        recoveryReason: retry.recoveryReason,
      } : null,
    };
  }

  async close() {
    this.disposed = true;
    clearTimeout(this.waveDeadlineTimer);
    this.waveDeadlineTimer = null;
    for (const peer of this.peers) {
      peer.send('DIE\n');
      if (peer.pid) {
        try { process.kill(peer.pid, 'SIGKILL'); } catch { /* gone */ }
      }
      peer.socket.destroy();
    }
    this.peers.clear();
    this.checkpoints.clear();
    if (this.root) {
      try {
        this.root.kill('SIGKILL');
      } catch {
        /* gone */
      }
      if (this.root.pid) {
        try { process.kill(-this.root.pid, 'SIGKILL'); } catch { /* gone */ }
      }
    }
    if (this.server) {
      const server = this.server;
      this.server = null;
      await new Promise((resolve) => server.close(resolve));
    }
  }
}
