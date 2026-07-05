// CheckpointEngine — the endgame architecture.
//
// A single resident lualatex process tree holds the document. Every block
// boundary is a fork()ed checkpoint: a copy-on-write snapshot of the COMPLETE
// TeX state. An edit kills the stale suffix of the chain and resumes from the
// last valid snapshot, so the foreground cost of a keystroke is:
//
//   fork (~0.2ms) + typeset the changed block (+1 verification block)
//   + node-walk galley extraction + JSON over a local socket
//
// — typically single-digit milliseconds. There is no process start, no
// preamble reload, no font reload, no PDF and no external converter on the
// hot path: display lists carry TeX's own glyph positions and the browser
// draws them with the very font files TeX used.
//
// Graphics blocks (pdf literals: TikZ etc.) take an exact-render detour:
// a render child ships the block as a real PDF page which pdftocairo turns
// into an SVG chunk, swapped in asynchronously.

import net from 'node:net';
import { spawn, execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { SourceStore } from '../source-store.js';
import { fnv1a } from '../hash.js';
import { segmentBody, documentBounds, diffBlocks } from '../segmenter.js';
import { buildPages, reconcile, parsePlacement } from './pagebuilder.js';
import { mapLegacyFont, remapText } from './mathmap.js';
import { statSync, watch } from 'node:fs';

const execFileP = promisify(execFile);
const DIR = path.dirname(fileURLToPath(import.meta.url));

const BASE_COUNTERS = [
  'part', 'chapter', 'section', 'subsection', 'subsubsection', 'paragraph',
  'equation', 'figure', 'table', 'footnote',
];
const HEADING_RE = /^\s*\\(chapter|section|subsection|subsubsection|paragraph)\b/;
const JOB_TIMEOUT = Number(process.env.TDOM_JOB_TIMEOUT || 30_000);
const BOOT_TIMEOUT = 60_000;
// Environments that drive TeX's page builder themselves (own \output,
// column balancing against \vsize) or that MUST break across real pages
// (longtable's page-splitting, landscape's rotated geometry). On the
// dormant \vsize=\maxdimen page they yield garbage or a single giant
// galley — route them through the isolated exact-render rescue, where a
// real lualatex with the real \textheight typesets them exactly as print
// (taller-than-page material ships real pages → per-page chunks with
// forced breaks).
// environments the dormant galley cannot represent: output-routine swappers
// (multicols, longtable …) and page-context readers that split against
// \pagegoal-\pagetotal (mdframed, framed, breakable tcolorbox)
const OUTPUT_HIJACK_RE =
  /\\begin\{(multicols\*?|paracol|longtable|landscape|mdframed|framed|shaded)\}|\\begin\{tcolorbox\}\[[^\]]*breakable/;

export class CheckpointEngine {
  constructor({ workDir, docDir }) {
    this.workDir = path.resolve(workDir);
    this.docDir = docDir ? path.resolve(docDir) : this.workDir;
    mkdirSync(this.workDir, { recursive: true });
    this.store = new SourceStore();
    this.file = 'main.tex';
    this.blocks = [];
    this.idSeq = 1;
    this.rev = 0;

    this.server = null;
    this.port = 0;
    this.root = null; // ChildProcess of the root lualatex
    this.checkpoints = new Map(); // idx -> Peer (state after blocks[0..idx-1])
    this.peers = new Set();
    this.waiters = new Map(); // key -> {resolve, reject, timer}

    this.geometry = null;
    this.counters = [...BASE_COUNTERS];
    this.preHash = null;
    this.labelTable = new Map(); // key -> value (for reboot injection)
    this.hrefTable = new Map(); // key -> hyperref anchor (\@currentHref at \label)
    this.fonts = new Map(); // fid -> {file,name,size,fmt, family, remap}
    this.fontFiles = new Map(); // familyKey -> absolute path
    this.pages = [];
    this.chunks = new Map(); // chunkKey -> {svg, wBp, hBp, v} exact renders
    this.isoCache = new Map(); // rescue key -> isolated compile result
    this.poisoned = new Map(); // block.id -> fnv1a(text) that failed in-chain
    this.hf = new Map(); // page number -> {h: items, f: items} TeX-typeset header/footer
    this.hfSig = null; // page-spec signature the current hf map was built for
    this.hfPending = null; // spec signature of an in-flight header job
    this.initialStyle = 'plain'; // \pagestyle in effect at \begin{document}
    this.bgAbort = false;
    this.bgTask = Promise.resolve();
    this.onAsyncPatches = null; // callback(report-ish) for gfx swaps
    this.onExternalChange = null; // callback when an \input file changes
    this.backendName = 'checkpoint';
    this.diagnostics = [];
    this.tocHash = null;
    this.includes = new Map(); // path -> {mtime, text}
    this.watchers = new Map(); // path -> FSWatcher
    this.maxCheckpoints = 64;
  }

  // ------------------------------------------------------------ lifecycle

  async open(text, file = 'main.tex') {
    this.file = file;
    this.store.open(file, text);
    this.blocks = [];
    this.labelTable = new Map();
    this.hrefTable = new Map();
    this.pages = [];
    return this.#update({ editLabel: 'open' });
  }

  async edit(start, end, replacement, file = this.file) {
    const p1 = this.store.position(file, start);
    const p2 = this.store.position(file, end);
    const editLabel = `${file}:${p1.line}:${p1.column}-${p2.line}:${p2.column}`;
    this.store.applyEdit(file, start, end, replacement);
    return this.#update({ editLabel });
  }

  async close() {
    this.bgAbort = true;
    for (const w of this.watchers.values()) {
      try { w.close(); } catch { /* already closed */ }
    }
    this.watchers.clear();
    for (const peer of this.peers) {
      peer.send('DIE\n');
      if (peer.pid) {
        try { process.kill(peer.pid, 'SIGKILL'); } catch { /* already gone */ }
      }
    }
    if (this.root) {
      try { this.root.kill('SIGKILL'); } catch { /* gone */ }
    }
    if (this.server) this.server.close();
    this.checkpoints.clear();
    this.peers.clear();
  }

  getSource() {
    return this.store.get(this.file);
  }

  getDisplayLists() {
    return this.pages.map((p) => p.dl);
  }

  getGeometry() {
    return this.geometry;
  }

  getFontFile(key) {
    const p = this.fontFiles.get(key);
    if (!p || !existsSync(p)) return null;
    return readFileSync(p);
  }

  getFontManifest() {
    return [...this.fontFiles.keys()];
  }

  getChunkSVG(id) {
    return this.chunks.get(id)?.svg ?? null;
  }

  getDOM() {
    const blockPages = new Map();
    for (const page of this.pages) {
      for (const d of page.draw ?? []) {
        const bid = d.u?.blockId;
        if (!bid) continue;
        if (!blockPages.has(bid)) blockPages.set(bid, []);
        const arr = blockPages.get(bid);
        if (arr[arr.length - 1] !== page.number) arr.push(page.number);
      }
    }
    return {
      rev: this.rev,
      backend: this.backendName,
      pageCount: this.pages.length,
      checkpoints: [...this.checkpoints.keys()].sort((a, b) => a - b),
      blocks: this.blocks.map((b, i) => {
        const floatGfxChunks = (b.galley?.floats ?? []).filter((f) => f.gfx).map((f) => `${b.id}#${f.n}`);
        const gfxChunks = [...(b.gfx ? [b.id] : []), ...floatGfxChunks];
        return {
          id: b.id,
          index: i,
          type: b.kind ?? 'block',
          gfx: gfxChunks.length > 0,
          gfxChunks,
          source: {
            file: this.file,
            start: this.store.position(this.file, b.start),
            end: this.store.position(this.file, b.end),
          },
          labels: (b.galley?.labels ?? []).map((l) => l.k),
          refs: b.galley?.refs ?? [],
          pages: blockPages.get(b.id) ?? [],
          // raw offsets into the main buffer for in-preview box editing;
          // blocks expanded from \input files are not editable in-place
          file: b.file ?? null,
          span: b.file ? null : { start: b.start, end: b.end },
        };
      }),
      labels: Object.fromEntries(this.labelTable),
    };
  }

  async exportPDF() {
    // The honest full path: a real 2-pass lualatex over the actual source.
    const p = path.join(this.workDir, 'export.tex');
    writeFileSync(p, this.getSource());
    const run = () =>
      execFileP('lualatex', ['-interaction=nonstopmode', 'export.tex'], {
        cwd: this.workDir,
        timeout: 120_000,
      }).catch(() => {});
    await run();
    await run();
    const pdf = path.join(this.workDir, 'export.pdf');
    if (!existsSync(pdf)) throw new Error('full compile failed');
    return readFileSync(pdf);
  }

  // ---------------------------------------------------------- root/daemon

  async #ensureShim() {
    const so = path.join(this.workDir, 'tdomfork.so');
    const src = path.join(DIR, 'tdomfork.c');
    if (existsSync(so)) return;
    const args =
      process.platform === 'darwin'
        ? ['-O2', '-shared', '-undefined', 'dynamic_lookup', '-o', so, src]
        : ['-O2', '-shared', '-fPIC', '-o', so, src];
    await execFileP('cc', args, { timeout: 60_000 });
  }

  async #ensureServer() {
    if (this.server) return;
    this.server = net.createServer((sock) => this.#accept(sock));
    await new Promise((resolve) => this.server.listen(0, '127.0.0.1', resolve));
    this.port = this.server.address().port;
  }

  #accept(sock) {
    const peer = new Peer(sock, this);
    this.peers.add(peer);
    sock.on('close', () => {
      this.peers.delete(peer);
      for (const [idx, p] of this.checkpoints) {
        if (p === peer) this.checkpoints.delete(idx);
      }
      // fail fast: if the process carrying the in-flight job dies (TeX
      // emergency stop on a broken block, missing file, ...), reject its
      // waiters immediately instead of running out the 30s timeout
      const job = this.currentJob;
      if (job && (peer === job.parent || (job.pid && peer.pid === job.pid))) {
        const err = new Error('typesetting process died (TeX error in this block?)');
        this._reject(job.galleyKey, err);
        this._reject(job.ckptKey, err);
      }
    });
  }

  #await(key, timeout = JOB_TIMEOUT) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters.delete(key);
        reject(new Error(`timeout waiting for ${key}`));
      }, timeout);
      this.waiters.set(key, { resolve, reject, timer });
    });
  }

  _fulfill(key, value) {
    const w = this.waiters.get(key);
    if (w) {
      clearTimeout(w.timer);
      this.waiters.delete(key);
      w.resolve(value);
    }
  }

  _reject(key, err) {
    const w = this.waiters.get(key);
    if (w) {
      clearTimeout(w.timer);
      this.waiters.delete(key);
      w.reject(err);
    }
  }

  // message dispatch from Peer
  _onMessage(peer, msg) {
    switch (msg.kind) {
      case 'HELLO':
        peer.role = msg.role;
        peer.pid = msg.pid;
        peer.idxAnnounced = msg.idx;
        if (msg.role === 'ckpt' && msg.idx === 0) {
          this.checkpoints.set(0, peer);
          this._fulfill('ckpt:0', peer);
        }
        break;
      case 'GEO':
        this.geometry = msg.json;
        this._fulfill('geo', msg.json);
        break;
      case 'TWIN':
        this.twinMetrics = msg.json; // unicode -> [height, depth] bp at 10pt
        break;
      case 'GALLEY':
        this._fulfill('galley:' + msg.id, msg.json);
        break;
      case 'CKPT':
        this.checkpoints.set(msg.idx, peer);
        this._fulfill('ckpt:' + msg.idx, peer);
        break;
      case 'DONE':
        this._fulfill('render:' + msg.id, true);
        break;
      case 'FORKED':
        if (this.currentJob && this.currentJob.galleyKey === 'galley:' + msg.id) {
          this.currentJob.pid = msg.pid;
        }
        break;
    }
  }

  async #bootRoot() {
    await this.#ensureShim();
    await this.#ensureServer();
    // tear down any previous tree — DIE for the well-behaved residents plus
    // SIGKILL by pid, because a child stuck in a TeX loop never reads DIE
    for (const peer of this.peers) {
      peer.send('DIE\n');
      if (peer.pid) {
        try { process.kill(peer.pid, 'SIGKILL'); } catch { /* already gone */ }
      }
    }
    this.checkpoints.clear();
    if (this.root) {
      try { this.root.kill('SIGKILL'); } catch { /* gone */ }
      this.root = null;
    }
    this.fonts.clear();

    const text = this.store.get(this.file);
    const bounds = documentBounds(text);
    const preamble = text.slice(bounds.preamble.start, bounds.preamble.end);
    this.counters = [...BASE_COUNTERS, ...scanCounterDefs(preamble)];
    // \pagestyle set in the preamble runs before the driver shims exist —
    // scan for it; otherwise book-family classes default to 'headings'
    const psMatch = preamble.match(/^[^%\n]*\\pagestyle\s*\{(\w+)\}/m);
    this.initialStyle = psMatch
      ? psMatch[1]
      : /\\documentclass[^{]*\{[^}]*(book|report)[^}]*\}/.test(preamble)
        ? 'headings'
        : 'plain';
    this.hf = new Map();
    this.hfSig = null;
    writeFileSync(path.join(this.workDir, 'driver.tex'), this.#driverSource(preamble));

    rmSync(path.join(this.workDir, 'driver.pdf'), { force: true });
    const ckptReady = this.#await('ckpt:0', BOOT_TIMEOUT);
    const geoReady = this.#await('geo', BOOT_TIMEOUT);
    this.root = spawn(
      'lualatex',
      ['--shell-escape', '-interaction=nonstopmode', 'driver.tex'],
      { cwd: this.workDir, stdio: ['ignore', 'pipe', 'pipe'] }
    );
    let rootLog = '';
    this.root.stdout.on('data', (d) => { rootLog += d; if (rootLog.length > 65536) rootLog = rootLog.slice(-32768); });
    this.root.stderr.on('data', (d) => { rootLog += d; });
    const rootRef = this.root;
    this.root.on('exit', () => {
      if (this.root !== rootRef) return; // a superseded root dying is expected
      this.rootLog = rootLog;
      // a dead root can never announce ckpt:0 — fail the boot immediately
      // (a broken preamble in nonstopmode still prompts on missing files
      // and emergency-stops on EOF)
      const err = new Error('lualatex exited during preamble: ' + texErrorFrom(rootLog));
      this._reject('ckpt:0', err);
      this._reject('geo', err);
      this.checkpoints.clear();
    });
    this.rootLogRef = () => rootLog;

    await Promise.all([ckptReady, geoReady]).catch((err) => {
      throw new Error(`preamble build failed — ${texErrorFrom(rootLog) || err.message}`);
    });
    // hyperref (and friends) write PDF objects during \begin{document},
    // which opens the shared output file at the root — checkpoint children
    // can then no longer ship their own tight pages. Fall back to isolated
    // per-block compiles for the exact-render tier in that case.
    this.pdfOpenedAtRoot = existsSync(path.join(this.workDir, 'driver.pdf'));
  }

  #driverSource(preamble) {
    const L = [];
    L.push(preamble.trimEnd());
    L.push('\\begin{document}');
    L.push(`\\directlua{dofile('${luaStr(path.join(DIR, 'daemon.lua'))}')}`);
    L.push('\\makeatletter');
    L.push(
      `\\directlua{tdom_boot(${this.port}, '${luaStr(this.workDir)}', {${this.counters
        .map((c) => `'${c}'`)
        .join(',')}})}`
    );
    // label / ref recording shims (typesetting behavior unchanged).
    // cleveref resolves \cref through a SECOND aux macro (r@<key>@cref,
    // written next to every \newlabel) — capture its value at \label time
    // exactly like the plain one, or a resident run prints ?? forever.
    const crefCapture =
      '\\ifcsname cref@currentlabel\\endcsname' +
      "\\directlua{tdom_label_cref('\\luaescapestring{#1}'," +
      "'\\luaescapestring{\\detokenize\\expandafter{\\cref@currentlabel}}')}\\fi";
    L.push('\\let\\TDOMlabel\\label');
    L.push(
      "\\renewcommand\\label[1]{\\TDOMlabel{#1}\\directlua{tdom_label('\\luaescapestring{#1}','\\luaescapestring{\\@currentlabel}')}" +
        crefCapture + '}'
    );
    // amsmath routes display-math labels through \ltx@label (captured at
    // package load, before our shim) — intercept that path too
    L.push('\\ifdefined\\ltx@label\\let\\TDOMltxlabel\\ltx@label');
    L.push(
      "\\def\\ltx@label#1{\\TDOMltxlabel{#1}\\directlua{tdom_label('\\luaescapestring{#1}','\\luaescapestring{\\@currentlabel}')}" +
        crefCapture + '}\\fi'
    );
    L.push('\\let\\TDOMref\\ref');
    L.push("\\renewcommand\\ref[1]{\\directlua{tdom_ref('\\luaescapestring{#1}')}\\TDOMref{#1}}");
    L.push('\\let\\TDOMpageref\\pageref');
    L.push("\\renewcommand\\pageref[1]{\\directlua{tdom_ref('\\luaescapestring{#1}')}\\TDOMpageref{#1}}");
    L.push('\\ifdefined\\eqref\\let\\TDOMeqref\\eqref');
    L.push("\\renewcommand\\eqref[1]{\\directlua{tdom_ref('\\luaescapestring{#1}')}\\TDOMeqref{#1}}\\fi");
    // \cref/\Cref read r@<key>@cref — record the dependency under that key
    // so label movements retypeset the referencing block (comma lists split
    // Lua-side); resolution itself stays cleveref's
    L.push('\\ifdefined\\cref\\let\\TDOMcref\\cref');
    L.push("\\renewcommand\\cref[1]{\\directlua{tdom_ref_cref('\\luaescapestring{#1}')}\\TDOMcref{#1}}\\fi");
    L.push('\\ifdefined\\Cref\\let\\TDOMCref\\Cref');
    L.push("\\renewcommand\\Cref[1]{\\directlua{tdom_ref_cref('\\luaescapestring{#1}')}\\TDOMCref{#1}}\\fi");
    // toc/lof/lot entries are TeX's own: capture what \addcontentsline
    // would write, expanded exactly like \protected@write expands it (the
    // class's real \numberline{\thechapter.\thesection} formatting) — the
    // orchestrator later substitutes only the page argument it owns
    L.push('\\let\\TDOMaddcontentsline\\addcontentsline');
    L.push(
      '\\renewcommand\\addcontentsline[3]{' +
        // modern kernels route \addcontentsline through \addtocontents —
        // flag the window so the @raw capture skips the duplicate
        '\\directlua{tdom_in_acl=true}\\TDOMaddcontentsline{#1}{#2}{#3}\\directlua{tdom_in_acl=false}' +
        '{\\let\\label\\@gobble\\let\\index\\@gobble\\let\\glossary\\@gobble' +
        '\\protected@edef\\TDOM@tocentry{#3}' +
        "\\directlua{tdom_tocline('\\luaescapestring{#1}','\\luaescapestring{#2}'," +
        "'\\luaescapestring{\\detokenize\\expandafter{\\TDOM@tocentry}}')}}}"
    );
    // \addtocontents carries the NON-entry contents material (\chapter's
    // \addvspace{10pt} between groups in lof/lot/toc, tocloft adjustments…)
    // — captured verbatim and replayed in document order between the
    // \contentsline entries, or the contents pages come out compressed
    L.push('\\let\\TDOMaddtocontents\\addtocontents');
    L.push(
      '\\renewcommand\\addtocontents[2]{\\TDOMaddtocontents{#1}{#2}' +
        '{\\let\\label\\@gobble\\let\\index\\@gobble\\let\\glossary\\@gobble' +
        '\\protected@edef\\TDOM@tocentry{#2}' +
        "\\directlua{tdom_tocline('\\luaescapestring{#1}','@raw'," +
        "'\\luaescapestring{\\detokenize\\expandafter{\\TDOM@tocentry}}')}}}"
    );
    // page-style layer events: the orchestrator reconstructs each page's
    // exact header/footer state from these (the boxes themselves are later
    // typeset by TeX in a header job — nothing is invented)
    L.push('\\let\\TDOMpagestyle\\pagestyle');
    L.push(
      "\\renewcommand\\pagestyle[1]{\\TDOMpagestyle{#1}\\directlua{tdom_event('style','\\luaescapestring{#1}','')}}"
    );
    L.push('\\let\\TDOMthispagestyle\\thispagestyle');
    L.push(
      "\\renewcommand\\thispagestyle[1]{\\TDOMthispagestyle{#1}\\directlua{tdom_event('thisstyle','\\luaescapestring{#1}','')}}"
    );
    L.push('\\let\\TDOMpagenumbering\\pagenumbering');
    L.push(
      "\\renewcommand\\pagenumbering[1]{\\TDOMpagenumbering{#1}\\directlua{tdom_event('pagenum','\\luaescapestring{#1}','')}}"
    );
    L.push('\\let\\TDOMmarkboth\\markboth');
    L.push(
      '\\renewcommand\\markboth[2]{\\TDOMmarkboth{#1}{#2}' +
        '{\\protected@edef\\TDOM@mka{#1}\\protected@edef\\TDOM@mkb{#2}' +
        "\\directlua{tdom_event('mark','\\luaescapestring{\\detokenize\\expandafter{\\TDOM@mka}}'," +
        "'\\luaescapestring{\\detokenize\\expandafter{\\TDOM@mkb}}')}}}"
    );
    L.push('\\let\\TDOMmarkright\\markright');
    L.push(
      '\\renewcommand\\markright[1]{\\TDOMmarkright{#1}' +
        '{\\protected@edef\\TDOM@mka{#1}' +
        "\\directlua{tdom_event('markr','\\luaescapestring{\\detokenize\\expandafter{\\TDOM@mka}}','')}}}"
    );
    // \cleardoublepage decides on a blank verso via \ifodd\c@page — but the
    // dormant run never ships pages, so \c@page is meaningless here. Emit a
    // marker instead: the page builder OWNS folios and inserts the blank
    // (with \thispagestyle{empty}, as the classes do) exactly when the
    // assigned folio demands it.
    L.push(
      "\\renewcommand\\cleardoublepage{\\clearpage\\directlua{tdom_event('cleardouble','odd','')}}"
    );
    // jsclasses (ltjsbook & co) have a whole clear-to-parity family that
    // \frontmatter/\mainmatter/\chapter use directly — shim each with its
    // parity target (right/left mapping assumes yoko direction; tate docs
    // flip these — TODO when vertical typesetting lands)
    for (const [name, parity] of [
      ['pltx@cleartooddpage', 'odd'],
      ['pltx@cleartoevenpage', 'even'],
      ['pltx@cleartorightpage', 'odd'],
      ['pltx@cleartoleftpage', 'even'],
    ]) {
      L.push(
        `\\ifdefined\\${name}\\def\\${name}{\\clearpage\\directlua{tdom_event('cleardouble','${parity}','')}}\\fi`
      );
    }
    // \cite: record dependencies on bibliography keys
    L.push('\\let\\TDOMcite\\cite');
    L.push("\\renewcommand\\cite[2][]{\\directlua{tdom_cites('\\luaescapestring{#2}')}" +
      '\\ifx\\relax#1\\relax\\TDOMcite{#2}\\else\\TDOMcite[#1]{#2}\\fi}');
    // float capture: the environment body is typeset into a box with EXACTLY
    // the setup of LaTeX's \@xfloat (\hsize\columnwidth \@parboxrestore
    // \@floatboxreset — and no injected \centering), so the captured box is
    // byte-identical to what the real output routine would have placed. An
    // anchor \special marks the declaration point for the page builder.
    L.push('\\newbox\\TDOMfloatbox');
    L.push('\\directlua{TDOM_FLOATBOX=\\number\\TDOMfloatbox}');
    L.push('\\newcount\\TDOMfloatn');
    L.push('\\def\\TDOMHplacement{H}');
    for (const env of ['figure', 'table']) {
      // float.sty's [H] is NOT a float: \float@endH typesets the box inline
      // (\vskip\intextsep \box \vskip\intextsep) so it participates in page
      // breaking like any paragraph. Hand [H] back to the untouched original
      // environment — \@float@HH re-\lets \end<env> inside the group, so the
      // capture end-code below never runs for it.
      L.push(`\\expandafter\\let\\csname TDOMorig${env}\\expandafter\\endcsname\\csname ${env}\\endcsname`);
      L.push(
        `\\renewenvironment{${env}}[1][\\csname fps@${env}\\endcsname]` +
          `{\\gdef\\TDOMfp{#1}\\ifx\\TDOMfp\\TDOMHplacement` +
          `\\csname TDOMorig${env}\\endcsname[H]` +
          `\\else\\def\\@captype{${env}}\\ifhmode\\@bsphack\\fi` +
          '\\global\\setbox\\TDOMfloatbox\\vbox\\bgroup\\hsize\\columnwidth\\@parboxrestore\\@floatboxreset\\fi}' +
          `{\\par\\vskip\\z@skip\\egroup\\global\\advance\\TDOMfloatn\\@ne` +
          `\\special{tdomfloat:\\number\\TDOMfloatn}` +
          `\\directlua{tdom_float(\\number\\TDOMfloatn,'\\TDOMfp','${env}')}` +
          `\\ifhmode\\@Esphack\\fi}`
      );
    }
    // \tableofcontents reads the toc the orchestrator maintains; never write
    L.push('\\renewcommand\\@starttoc[1]{{\\makeatletter\\@input{\\jobname.#1}}}');
    // live bibliography: define \b@<key> as \bibitem runs so \cite resolves
    L.push('\\ifdefined\\@bibitem\\let\\TDOMbibitem\\@bibitem');
    L.push("\\def\\@bibitem#1{\\TDOMbibitem{#1}\\directlua{tdom_bib('\\luaescapestring{#1}','\\luaescapestring{\\the\\value{enumiv}}')}}\\fi");
    L.push('\\ifdefined\\@lbibitem\\let\\TDOMlbibitem\\@lbibitem');
    L.push("\\def\\@lbibitem[#1]#2{\\TDOMlbibitem[#1]{#2}\\directlua{tdom_bib('\\luaescapestring{#2}','\\luaescapestring{#1}')}}\\fi");
    // page-builder geometry: every parameter the output routine uses is read
    // from the live TeX run — glue parameters travel with their full
    // stretch/shrink specification (\gluestretch etc. are LuaTeX primitives)
    const glueParam = (name, expr) =>
      `\\directlua{tdom_glue('${name}',\\number\\dimexpr${expr}\\relax,` +
      `\\number\\gluestretch${expr},\\number\\glueshrink${expr},` +
      `\\number\\gluestretchorder${expr},\\number\\glueshrinkorder${expr})}`;
    L.push(glueParam('footinsskip', '\\skip\\footins'));
    L.push(glueParam('topskip', '\\topskip'));
    L.push(glueParam('floatsep', '\\floatsep'));
    L.push(glueParam('textfloatsep', '\\textfloatsep'));
    L.push(glueParam('intextsep', '\\intextsep'));
    L.push(glueParam('fptop', '\\@fptop'));
    L.push(glueParam('fpsep', '\\@fpsep'));
    L.push(glueParam('fpbot', '\\@fpbot'));
    L.push('\\directlua{tdom_num(\'topfraction\',\\topfraction)}');
    L.push('\\directlua{tdom_num(\'bottomfraction\',\\bottomfraction)}');
    L.push('\\directlua{tdom_num(\'textfraction\',\\textfraction)}');
    L.push('\\directlua{tdom_num(\'floatpagefraction\',\\floatpagefraction)}');
    L.push('\\directlua{tdom_num(\'topnumber\',\\value{topnumber})}');
    L.push('\\directlua{tdom_num(\'bottomnumber\',\\value{bottomnumber})}');
    L.push('\\directlua{tdom_num(\'totalnumber\',\\value{totalnumber})}');
    L.push('\\directlua{tdom_num(\'interlinepenalty\',\\interlinepenalty)}');
    L.push('\\directlua{tdom_num(\'footinsfactor\',\\count\\footins)}');
    L.push('\\directlua{tdom_dim(\'atmaxdepth\',\\number\\dimexpr\\@maxdepth\\relax)}');
    // \raggedbottom leaves \@textbottom = \vskip\z@\@plus.0001fil; flushbottom
    // keeps it \relax — the page builder needs to know which world it's in
    L.push('\\ifx\\@textbottom\\relax\\directlua{tdom_num(\'raggedbottom\',0)}' +
      '\\else\\directlua{tdom_num(\'raggedbottom\',1)}\\fi');
    L.push("\\if@twoside\\directlua{tdom_num('twoside',1)}\\else\\directlua{tdom_num('twoside',0)}\\fi");
    // hyperref changes the \r@… label format to five groups — the injection
    // sites must know which world they write for
    L.push("\\ifcsname Hy@Warning\\endcsname\\directlua{tdom_num('hyperref',1)}\\else\\directlua{tdom_num('hyperref',0)}\\fi");
    // the class's real \footnoterule, measured (kerns+rule items, verbatim)
    L.push('\\setbox0=\\vbox{\\hsize=\\textwidth\\footnoterule}');
    L.push('\\directlua{tdom_footrule(0)}');
    L.push('\\directlua{tdom_geo()}');
    // pre-known labels so forward references resolve in one pass after reboots
    for (const [key, val] of this.labelTable) {
      if (key.startsWith('cite:')) {
        L.push(`\\global\\@namedef{b@${key.slice(5)}}{${val}}`);
      } else {
        L.push(`\\global\\@namedef{r@${key}}${labelDefBody(key, val, this.geometry?.hyperref === 1, this.hrefTable?.get(key))}`);
      }
    }
    // font warmup: load the common face set into checkpoint 0
    L.push('\\setbox0=\\vbox{\\hsize=\\textwidth The quick brown fox 0123456789');
    L.push('\\textbf{bold} \\textit{italic} \\texttt{mono} \\textsc{Caps}');
    L.push('$a^2+b_i \\alpha\\beta\\gamma \\int_0^\\infty \\sum \\frac{1}{2} \\sqrt{x} \\left(\\frac{A}{B}\\right)$');
    L.push('\\scriptsize tiny \\normalsize}');
    // measure the unicode math twin so OMX substitutions align exactly
    L.push('\\font\\TDOMtwinmath={file:latinmodern-math.otf} at 10pt\\relax');
    L.push("\\directlua{pcall(function() tdom_twin_metrics(font.id('TDOMtwinmath')) end)}");
    L.push('\\makeatother');
    L.push('\\pagestyle{empty}');
    // cancel TeX's 1in shipout origin so render children produce tight pages
    L.push('\\hoffset=-1in');
    L.push('\\voffset=-1in');
    // Dormant page builder: blocks are typeset on the REAL main vertical
    // list (full state continuity — \prevdepth, \everypar, penalties), the
    // page never fills (\vsize=\maxdimen), inserts stay in the stream
    // (\holdinginserts), and a dummy box keeps the page "started" so TeX
    // never discards inter-block glue. tdom_report() harvests the nodes.
    // The output routine only ever fires on force-ejects (\newpage & co);
    // tdom_absorb_output puts the material back and plants a break marker.
    L.push('\\vsize=\\maxdimen');
    L.push('\\holdinginserts=1');
    L.push('\\maxdeadcycles=200');
    L.push('\\output={\\directlua{tdom_absorb_output()}}');
    // a real box first: flips the page builder's internal page_contents
    // flag to box_there (unreachable from Lua); tdom_seed then swaps the
    // list for the marker dummy
    L.push('\\hbox to0pt{}');
    L.push('\\prevdepth=-1000pt');
    L.push('\\directlua{tdom_seed()}');
    L.push('\\def\\TDOMloop{\\directlua{tdom_wait()}\\TDOMloop}');
    L.push('\\TDOMloop');
    L.push('\\end{document}');
    L.push('');
    return L.join('\n');
  }

  // ------------------------------------------------------------- typeset

  async #jobBlock(idx, override = null) {
    const block = this.blocks[idx];
    const ck = this.checkpoints.get(idx);
    if (!ck) throw new Error(`no checkpoint at ${idx} for block ${block.id}`);
    let body;
    let jobId;
    if (override) {
      // raw job (rescue continuation): caller supplies the exact body
      body = Buffer.from(override.body, 'utf8');
      jobId = override.id;
    } else {
      // Labels are defined in descendant lineages only; when resuming from an
      // ancestor snapshot, forward-referenced values must be injected so this
      // block sees the document-wide truth.
      const defs = [];
      for (const key of block.galley?.refs ?? []) {
        const val = this.labelTable.get(key);
        const cs = key.startsWith('cite:') ? `b@${key.slice(5)}` : `r@${key}`;
        if (val === undefined) {
          // vanished label: neutralize stale definitions in this lineage
          defs.push(`\\global\\expandafter\\let\\csname ${cs}\\endcsname\\relax`);
        } else if (key.startsWith('cite:')) {
          defs.push(`\\global\\@namedef{${cs}}{${val}}`);
        } else {
          defs.push(`\\global\\@namedef{${cs}}${labelDefBody(key, val, this.geometry?.hyperref === 1, this.hrefTable?.get(key))}`);
        }
      }
      // \lastskip primer: this block is typeset on a freshly-seeded page, so
      // \lastskip is 0 — but in a continuous run the previous block's trailing
      // \addvspace would still be present, and this block's leading \addvspace
      // MAXes against it. Re-establish \lastskip from the previous block's
      // exit tdom@ls (sp) so the merge is exact; the daemon marks the primer
      // and drops it from the harvest (it is already in the previous galley).
      // Prime ONLY when this block opens with an \addvspace-emitting construct
      // (sectioning, list/box environment, \vspace…) that MERGES against
      // \lastskip. A plain paragraph keeps \lastskip untouched and adds its own
      // material, so a primer there would just sit as extra height.
      let primer = '';
      if (idx > 0 && startsAddvspace(block.text)) {
        const pv = JSON.parse(this.blocks[idx - 1].stateVec ?? '[]');
        const ls = pv.length ? pv[pv.length - 1] : 0;
        if (ls) primer = `\\directlua{tdom_prime_lastskip(${Math.round(ls)})}`;
      }
      const prelude =
        (defs.length ? `\\makeatletter ${defs.join(' ')}\\makeatother\n` : '') + primer;
      // Mid-typing safety: an unclosed brace makes a \long macro argument
      // scan past the injected \par/report tokens to EOF and kills the child
      // (the old \vbox wrapper stopped it structurally). Auto-close the
      // imbalance — the source is transiently invalid anyway, and the exact
      // path resumes on the next balanced keystroke.
      const guard = '}'.repeat(Math.max(0, braceImbalance(block.text)));
      body = Buffer.from(prelude + block.text + guard, 'utf8');
      jobId = block.id;
    }
    const galleyKey = 'galley:' + jobId;
    const ckptKey = 'ckpt:' + (idx + 1);
    const galleyP = this.#await(galleyKey);
    const ckptP = this.#await(ckptKey);
    // mark both consumed so a late sibling rejection never surfaces as an
    // unhandled rejection after Promise.all already bailed on the first one
    galleyP.catch(() => {});
    ckptP.catch(() => {});
    this.currentJob = { galleyKey, ckptKey, parent: ck, ckptIdx: idx + 1 };
    try {
      ck.send(`JOB ${jobId} ${idx + 1} ${body.length}\n`);
      ck.sendRaw(body);
      const [galley] = await Promise.all([galleyP, ckptP]);
      this.#retireOffGrid(idx);
      return galley;
    } catch (err) {
      // A stuck fork child (e.g. a TeX infinite loop in this block) never
      // reads DIE from its socket — kill it hard or it spins at full CPU
      // forever. The pid arrived with the FORKED announcement.
      const pid = this.currentJob?.pid;
      if (pid) {
        try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
      }
      this._reject(galleyKey, err);
      this._reject(ckptKey, err);
      throw err;
    } finally {
      this.currentJob = null;
    }
  }

  /**
   * Rescue-aware typeset: the in-chain fork path for normal blocks, the
   * isolated exact-render path for blocks the dormant page cannot represent
   * (output-routine environments) or that failed/hung in-chain. The premise:
   * anything real lualatex compiles must render — worst case through a real
   * lualatex run whose pixels ARE the print output.
   */
  async #typesetBlock(idx) {
    const block = this.blocks[idx];
    const sig = fnv1a(block.text);
    if (this.#needsRescue(block.text)) {
      return this.#rescueBlock(idx, 'output-routine environment needs a real page');
    }
    if (this.poisoned.get(block.id) === sig) {
      return this.#rescueBlock(idx, 'previous in-chain failure');
    }
    try {
      return await this.#jobBlock(idx);
    } catch (err) {
      this.poisoned.set(block.id, sig);
      this.diagnostics.push(
        `${block.id}: in-chain typeset failed (${err.message}) — isolated exact-render rescue`
      );
      return this.#rescueBlock(idx, err.message);
    }
  }

  /**
   * Rescue triggers: the static hijack list plus breakable tcolorbox
   * environments the PREAMBLE defines (\newtcolorbox/\newtcbtheorem with
   * a `breakable` option create page-splitting envs under custom names).
   */
  #needsRescue(text) {
    if (OUTPUT_HIJACK_RE.test(text)) return true;
    if (this._breakableFor !== this.preHash) {
      const src = this.store.get(this.file) ?? '';
      const b = documentBounds(src);
      const pre = src.slice(b.preamble.start, b.preamble.end);
      const names = [];
      for (const m of pre.matchAll(/\\newtcolorbox\{([A-Za-z@]+)\}[^\n]*?breakable/g)) names.push(m[1]);
      for (const m of pre.matchAll(/\\newtcbtheorem(?:\[[^\]]*\])?\{([A-Za-z@]+)\}[^\n]*?breakable/g)) names.push(m[1]);
      this._breakableRe = names.length
        ? new RegExp(`\\\\begin\\{(?:${names.join('|')})\\}`)
        : null;
      this._breakableFor = this.preHash;
    }
    return this._breakableRe ? this._breakableRe.test(text) : false;
  }

  /**
   * Isolated rescue: compile ONLY this block in a standalone lualatex with
   * the document's real preamble, the entry counter/label/layout state, and
   * the REAL \textheight (a dormant absorb keeps material on one galley, so
   * column balancing sees true page geometry). The run reports exit
   * counters, labels, per-line galley dims and ships the galley as a PDF —
   * the preview chunk is therefore print-identical. A no-op state job then
   * creates the next checkpoint so the resident chain continues with the
   * exact exit state.
   */
  async #rescueBlock(idx, why) {
    const block = this.blocks[idx];
    // the key carries the CURRENT values of every label the block referenced
    // in its last compile: when a referenced label moves, the key misses and
    // the block re-rescues with fresh seeds (first compile has no refs yet —
    // the backward-reference pass supplies the second look)
    const refVals = (block.galley?.refs ?? []).map(
      (k) => k + '=' + (this.labelTable.get(k) ?? '')
    );
    // page-context: the block's on-page start offset changes where a
    // splitting environment (mdframed, breakable tcolorbox) breaks
    const pageOff = Math.round((block.pageOffset ?? 0) * 100) / 100;
    const cacheKey = fnv1a(
      JSON.stringify([block.text, this.blocks[idx - 1]?.stateVec ?? '', this.preHash, refVals, pageOff])
    );
    let iso = this.isoCache.get(cacheKey);
    if (!iso) {
      iso = await this.#isoCompile(block, idx, why);
      this.isoCache.set(cacheKey, iso);
    }
    // continuation checkpoint carrying the isolated run's exact exit state
    await this.#jobBlock(idx, { id: block.id + '@state', body: this.#stateJobBody(iso) });
    return {
      items: iso.items,
      floats: [],
      w: iso.w,
      h: iso.h,
      d: iso.d,
      gfx: true,
      state: iso.state,
      labels: iso.labels,
      toclines: iso.toclines,
      refs: iso.refs ?? [],
      fonts: {},
      tdomIsoChunks: iso.chunks,
    };
  }

  #stateJobBody(iso) {
    const L = ['\\makeatletter'];
    for (const name of this.counters) {
      const v = iso.state[name];
      if (v !== undefined) L.push(`\\ifcsname c@${name}\\endcsname\\setcounter{${name}}{${v}}\\fi`);
    }
    for (const l of iso.labels ?? []) {
      L.push(`\\global\\@namedef{r@${l.k}}${labelDefBody(l.k, l.v, this.geometry?.hyperref === 1, l.h)}`);
    }
    L.push(iso.state['tdom@nobreak'] === 1 ? '\\global\\@nobreaktrue' : '\\global\\@nobreakfalse');
    L.push('\\makeatother');
    L.push(`\\directlua{tex.nest[0].prevdepth=${Math.round(iso.state['tdom@pd'] ?? -65536000)}}`);
    return L.join('\n');
  }

  async #isoCompile(block, idx, why) {
    const entry = {};
    const prevVec = idx > 0 ? JSON.parse(this.blocks[idx - 1].stateVec ?? '[]') : [];
    this.counters.forEach((c, i) => {
      entry[c] = prevVec[i] ?? 0;
    });
    // tail layout: [...counters, tdom@pd, tdom@nobreak, tdom@ls]
    const prevPd = idx > 0 && prevVec.length >= 3 ? prevVec[prevVec.length - 3] : -65536000;
    const prevNobreak = idx > 0 && prevVec.length >= 2 ? prevVec[prevVec.length - 2] === 1 : false;
    const text = this.store.get(this.file);
    const bounds = documentBounds(text);
    const L = [];
    L.push(text.slice(bounds.preamble.start, bounds.preamble.end).trimEnd());
    L.push('\\begin{document}');
    L.push('\\makeatletter\\pagestyle{empty}\\hoffset=-1in\\voffset=-1in');
    for (const [key, val] of this.labelTable) {
      if (key.startsWith('cite:')) L.push(`\\global\\@namedef{b@${key.slice(5)}}{${val}}`);
      else L.push(`\\global\\@namedef{r@${key}}${labelDefBody(key, val)}`);
    }
    for (const [name, val] of Object.entries(entry)) {
      L.push(`\\ifcsname c@${name}\\endcsname\\setcounter{${name}}{${val}}\\fi`);
    }
    // capture labels the block defines (value = \@currentlabel at \label);
    // cleveref's r@<key>@cref companion is captured alongside, like the
    // resident driver does
    const isoCrefCapture =
      '\\ifcsname cref@currentlabel\\endcsname' +
      "\\directlua{tdom_iso_label_cref('\\luaescapestring{#1}'," +
      "'\\luaescapestring{\\detokenize\\expandafter{\\cref@currentlabel}}')}\\fi";
    const isoHref = "'\\luaescapestring{\\ifcsname @currentHref\\endcsname\\@currentHref\\fi}'";
    L.push('\\let\\TDOMlabel\\label');
    L.push(
      "\\renewcommand\\label[1]{\\TDOMlabel{#1}\\directlua{tdom_iso_label('\\luaescapestring{#1}','\\luaescapestring{\\@currentlabel}'," + isoHref + ')}' +
        isoCrefCapture + '}'
    );
    L.push('\\ifdefined\\ltx@label\\let\\TDOMltxlabel\\ltx@label');
    L.push(
      "\\def\\ltx@label#1{\\TDOMltxlabel{#1}\\directlua{tdom_iso_label('\\luaescapestring{#1}','\\luaescapestring{\\@currentlabel}'," + isoHref + ')}' +
        isoCrefCapture + '}\\fi'
    );
    // ref-use recording: a rescued block that references a label must be
    // re-rescued when that label's value changes (the cache key carries the
    // referenced values — see #rescueBlock)
    L.push('\\let\\TDOMref\\ref');
    L.push("\\renewcommand\\ref[1]{\\directlua{tdom_iso_ref('\\luaescapestring{#1}')}\\TDOMref{#1}}");
    L.push('\\let\\TDOMpageref\\pageref');
    L.push("\\renewcommand\\pageref[1]{\\directlua{tdom_iso_ref('\\luaescapestring{#1}')}\\TDOMpageref{#1}}");
    L.push('\\ifdefined\\eqref\\let\\TDOMeqref\\eqref');
    L.push("\\renewcommand\\eqref[1]{\\directlua{tdom_iso_ref('\\luaescapestring{#1}')}\\TDOMeqref{#1}}\\fi");
    L.push('\\ifdefined\\cref\\let\\TDOMcref\\cref');
    L.push("\\renewcommand\\cref[1]{\\directlua{tdom_iso_ref_cref('\\luaescapestring{#1}')}\\TDOMcref{#1}}\\fi");
    L.push('\\ifdefined\\Cref\\let\\TDOMCref\\Cref');
    L.push("\\renewcommand\\Cref[1]{\\directlua{tdom_iso_ref_cref('\\luaescapestring{#1}')}\\TDOMCref{#1}}\\fi");
    // toc/lof/lot entries born inside the rescued block (longtable captions,
    // sectioning inside output-hijack envs …) — captured exactly like the
    // resident driver captures them, or the contents pages miss the entry
    L.push('\\let\\TDOMaddcontentsline\\addcontentsline');
    L.push(
      '\\renewcommand\\addcontentsline[3]{' +
        '\\directlua{tdom_iso_in_acl=true}\\TDOMaddcontentsline{#1}{#2}{#3}\\directlua{tdom_iso_in_acl=false}' +
        '{\\let\\label\\@gobble\\let\\index\\@gobble\\let\\glossary\\@gobble' +
        '\\protected@edef\\TDOM@tocentry{#3}' +
        "\\directlua{tdom_iso_tocline('\\luaescapestring{#1}','\\luaescapestring{#2}'," +
        "'\\luaescapestring{\\detokenize\\expandafter{\\TDOM@tocentry}}')}}}"
    );
    L.push('\\let\\TDOMaddtocontents\\addtocontents');
    L.push(
      '\\renewcommand\\addtocontents[2]{\\TDOMaddtocontents{#1}{#2}' +
        '{\\let\\label\\@gobble\\let\\index\\@gobble\\let\\glossary\\@gobble' +
        '\\protected@edef\\TDOM@tocentry{#2}' +
        "\\directlua{tdom_iso_tocline('\\luaescapestring{#1}','@raw'," +
        "'\\luaescapestring{\\detokenize\\expandafter{\\TDOM@tocentry}}')}}}"
    );
    L.push('\\makeatother');
    // dormant page over the REAL \vsize: material stays on one galley (the
    // absorb hands it back), while \pagegoal/\vsize read true page geometry
    // so multicols & co. balance exactly as in print
    // NB: inline \directlua bodies are read with LaTeX catcodes — no '%'
    // (comment) and no '#' (macro parameter) may appear in the Lua source.
    L.push(
      '\\directlua{' +
        'tdom_iso = { labels = {}, counters = {}, toclines = {}, refs = {}, ntl = 0, fires = 0, ships = 0 } ' +
        'tdom_iso_in_acl = false ' +
        // amsmath hands \ltx@label the key WITH braces — strip one pair
        'function tdom_iso_unbrace(s) ' +
        'if s and s:sub(1, 1) == "{" and s:sub(-1) == "}" then return s:sub(2, -2) end ' +
        'return s end ' +
        'function tdom_iso_label(k, v, h) table.insert(tdom_iso.labels, { tdom_iso_unbrace(k), v, h }) end ' +
        'function tdom_iso_label_cref(k, v) table.insert(tdom_iso.labels, { tdom_iso_unbrace(k) .. "@cref", v }) end ' +
        'function tdom_iso_counter(k, v) tdom_iso.counters[k] = tonumber(v) or 0 end ' +
        'function tdom_iso_ref(k) table.insert(tdom_iso.refs, k) end ' +
        // comma-list split for \cref keys (inline Lua forbids a literal '%',
        // so the character class is assembled via string.char)
        'function tdom_iso_ref_cref(keys) ' +
        'local P = string.char(37) ' +
        'for k in string.gmatch(keys or "", "[^," .. P .. "s]+") do ' +
        'table.insert(tdom_iso.refs, k .. "@cref") end ' +
        'end ' +
        // tocline capture mirrors the resident daemon: record the expanded
        // entry AND drop a stream marker so multi-page rescues anchor each
        // entry to its true page (inline Lua: no '#'/'%', hence ntl counter)
        'function tdom_iso_tocline(e, l, t) ' +
        'if l == "@raw" and tdom_iso_in_acl then return end ' +
        'table.insert(tdom_iso.toclines, { e, l, t }) ' +
        'tdom_iso.ntl = tdom_iso.ntl + 1 ' +
        'pcall(function() ' +
        'local m = node.new("whatsit", node.subtype("special")) ' +
        'm.data = "tdom:tl:" .. (tdom_iso.ntl - 1) ' +
        'node.write(m) end) ' +
        'end ' +
        'function tdom_iso_absorb() ' +
        'tdom_iso.fires = tdom_iso.fires + 1 ' +
        'if tdom_iso.fires > 50 then tex.box[255] = nil return end ' +
        'tex.deadcycles = 0 ' +
        'if tdom_iso.ships == 0 then tdom_iso.preabsorbs = (tdom_iso.preabsorbs or 0) + 1 end ' +
        'local b = tex.box[255] ' +
        'local list = nil ' +
        'if b then list = b.list b.list = nil tex.box[255] = nil end ' +
        'if list then ' +
        // an absorbed fire IS a real page break: leave an eject marker at
        // the boundary so the harvested stream carries the break position
        'local mk = node.new("whatsit", node.subtype("special")) ' +
        'mk.data = "tdom:eject:-10000" ' +
        'local t0 = node.tail(list) t0.next = mk mk.prev = t0 ' +
        'local oldc = tex.lists.contrib_head ' +
        'if oldc then mk.next = oldc oldc.prev = mk end ' +
        'tex.lists.contrib_head = list ' +
        'end ' +
        'pcall(function() tex.pagetotal = 0 end) ' +
        'end}'
    );
    L.push('\\holdinginserts=1');
    L.push('\\maxdeadcycles=200');
    L.push('\\output={\\directlua{tdom_iso_absorb()}}');
    // material taller than the page inside an output-hijack env (multicols'
    // own routine) ships REAL pages — count them so the harvest knows the
    // pre-body machinery (and the isostart marker) left with page 1
    L.push('\\AddToHook{shipout/before}{\\directlua{tdom_iso.ships = tdom_iso.ships + 1}}');
    L.push('\\hbox to0pt{}');
    // page-context strut: reproduce the block's true on-page start position
    // so splitting environments (mdframed & co.) measure the same
    // \pagegoal-\pagetotal as in print. The iso page's own \topskip already
    // contributed, so the strut is the entry \pagetotal minus that.
    const entryOff = block.pageOffset ?? 0;
    const topskipW =
      typeof this.geometry?.topskip === 'object'
        ? this.geometry.topskip.w ?? 0
        : this.geometry?.topskip ?? 0;
    const strut = Math.max(0, entryOff - topskipW);
    if (strut > 0.01) L.push(`\\vskip ${strut.toFixed(4)}bp`);
    L.push('\\special{tdom:isostart}');
    L.push(`\\directlua{tex.nest[0].prevdepth=${Math.round(prevPd)}}`);
    // \lastskip primer: a rescued block opening an \addvspace-emitting env
    // (tcolorbox/mdframed before-skip) must MERGE against the previous block's
    // trailing skip, but the isostart whatsit above resets \lastskip to 0.
    // Re-establish it here (after isostart, marked with LASTSKIP_ATTR so the
    // harvest drops the primer — it is already in the previous block's galley).
    const prevLsSp = idx > 0 ? prevVec[prevVec.length - 1] ?? 0 : 0;
    if (prevLsSp > 0 && startsAddvspace(block.text)) {
      L.push(
        `\\directlua{local g=node.new('glue') g.width=${Math.round(prevLsSp)} ` +
          `node.set_attribute(g, 8124, 1) node.write(g)}`
      );
    }
    // \noindent only for blocks that CONTINUE a paragraph (start with text).
    // A block opening a vertical environment (\begin{tcolorbox|mdframed|…})
    // must NOT be forced into horizontal mode — that suppresses the env's own
    // \vskip before-skip (tcolorbox breakable) and drops leading glue. Carry
    // the real \if@nobreak flag instead so the env clears it exactly as print.
    if (prevNobreak) L.push(startsVertical(block.text) ? '\\makeatletter\\@nobreaktrue\\makeatother' : '\\noindent');
    L.push(block.text.trimEnd() + '}'.repeat(Math.max(0, braceImbalance(block.text))));
    L.push('\\par');
    for (const name of this.counters) {
      L.push(
        `\\ifcsname c@${name}\\endcsname\\directlua{tdom_iso_counter('${name}',\\number\\value{${name}})}\\fi`
      );
    }
    L.push(
      '\\makeatletter\\csname if@nobreak\\endcsname' +
        "\\directlua{tdom_iso_counter('tdom@nobreak',1)}\\else" +
        "\\directlua{tdom_iso_counter('tdom@nobreak',0)}\\fi\\makeatother"
    );
    // harvest: strip pre-body machinery + inserts, record per-item dims
    // (real break opportunities for the page builder), vpack and ship.
    // Same inline-Lua constraint: no '%'/'#' characters (LaTeX catcodes).
    L.push(
      '\\directlua{' +
        "tdom_iso_counter('tdom@pd', math.floor(tex.nest[0].prevdepth or 0)) " +
        'tex.triggerbuildpage() ' +
        'local head = tex.lists.page_head ' +
        'tex.lists.page_head = nil tex.lists.contrib_head = nil ' +
        'local INS = node.id("ins") local WH = node.id("whatsit") ' +
        'local HL = node.id("hlist") local VL = node.id("vlist") ' +
        'local GL = node.id("glue") local KE = node.id("kern") ' +
        'local SP = node.subtype("special") ' +
        // pre-body machinery precedes the marker ONLY when no page shipped;
        // otherwise it (and the marker) left with page 1 already
        'if tdom_iso.ships == 0 then ' +
        'while head do ' +
        'local ismark = head.id == WH and head.subtype == SP and head.data == "tdom:isostart" ' +
        'local nxt = head.next head.next = nil if nxt then nxt.prev = nil end node.free(head) head = nxt ' +
        'if ismark then break end end ' +
        'end ' +
        'local out, tail = nil, nil local n = head ' +
        'while n do local nxt = n.next n.next = nil n.prev = nil ' +
        // drop footnote inserts AND the \lastskip primer (attr 8124): the
        // primer only set \lastskip for the leading \addvspace merge
        'if n.id == INS or node.has_attribute(n, 8124) then node.free(n) else if tail then tail.next = n n.prev = tail else out = n end tail = n end n = nxt end ' +
        'local SP2BP = 65781.76 ' +
        'local function bp(sp) return math.floor(((sp or 0) / SP2BP) * 1000000 + 0.5) / 1000000 end ' +
        // no literal backslash may appear in inline Lua (TeX would tokenize
        // and expand it as a control sequence) — build it via string.char
        'local BS = string.char(92) local DQ = string.char(34) ' +
        'local function jq(s) ' +
        's = tostring(s) ' +
        's = s:gsub(BS, BS .. BS) ' +
        's = s:gsub(DQ, BS .. DQ) ' +
        'return DQ .. s .. DQ end ' +
        'local items = {} ' +
        'local m = out ' +
        'while m do ' +
        'if m.id == HL or m.id == VL then table.insert(items, \'{"k":"box","h":\' .. bp(m.height) .. \',"d":\' .. bp(m.depth) .. \'}\') ' +
        'elseif m.id == GL or m.id == KE then local a = (m.id == GL and m.width or m.kern) or 0 ' +
        'if a ~= 0 then table.insert(items, \'{"k":"glue","a":\' .. bp(a) .. \'}\') end ' +
        'elseif m.id == WH and m.subtype == SP and m.data and m.data:sub(1, 8) == "tdom:tl:" then ' +
        'table.insert(items, \'{"k":"tl","n":\' .. (tonumber(m.data:sub(9)) or 0) .. \'}\') ' +
        'elseif m.id == WH and m.subtype == SP and m.data and m.data:sub(1, 11) == "tdom:eject:" then ' +
        'table.insert(items, \'{"k":"eject","v":\' .. (tonumber(m.data:sub(12)) or -10000) .. \'}\') end ' +
        'm = m.next end ' +
        // empty remainder (env ended exactly at a page break): ship a
        // zero box so the last PDF page always exists for the node side
        'local b = out and node.vpack(out) or node.new("hlist") ' +
        'local f = io.open("state.json", "w") ' +
        'local labs = {} ' +
        'for _, kv in ipairs(tdom_iso.labels) do ' +
        'table.insert(labs, "[" .. jq(kv[1]) .. "," .. jq(kv[2]) .. ((kv[3] and kv[3] ~= "") and ("," .. jq(kv[3])) or "") .. "]") end ' +
        'local tls = {} ' +
        'for _, kv in ipairs(tdom_iso.toclines) do table.insert(tls, "[" .. jq(kv[1]) .. "," .. jq(kv[2]) .. "," .. jq(kv[3]) .. "]") end ' +
        'local rfs = {} ' +
        'for _, k in ipairs(tdom_iso.refs) do table.insert(rfs, jq(k)) end ' +
        'local cnts = {} ' +
        'for k, v in pairs(tdom_iso.counters) do table.insert(cnts, jq(k) .. ":" .. v) end ' +
        'f:write(\'{"w":\' .. bp(b.width) .. \',"h":\' .. bp(b.height) .. \',"d":\' .. bp(b.depth) .. ' +
        '\',"ships":\' .. tdom_iso.ships .. ' +
        '\',"preabsorbs":\' .. (tdom_iso.preabsorbs or 0) .. ' +
        '\',"labels":[\' .. table.concat(labs, ",") .. \'],"toclines":[\' .. table.concat(tls, ",") .. ' +
        '\'],"refs":[\' .. table.concat(rfs, ",") .. ' +
        '\'],"state":{\' .. table.concat(cnts, ",") .. ' +
        '\'},"items":[\' .. table.concat(items, ",") .. \']}\') ' +
        'f:close() ' +
        'tex.box[255] = b ' +
        'tex.pagewidth = math.max(b.width or 0, 65536) ' +
        'tex.pageheight = math.max((b.height or 0) + (b.depth or 0), 65536)}'
    );
    L.push('\\shipout\\box255');
    L.push('\\csname @@end\\endcsname');
    const jobdir = path.join(this.workDir, `rescue-${block.id}-${fnv1a(block.text)}`);
    mkdirSync(jobdir, { recursive: true });
    rmSync(path.join(jobdir, 'iso.pdf'), { force: true });
    rmSync(path.join(jobdir, 'state.json'), { force: true });
    writeFileSync(path.join(jobdir, 'iso.tex'), L.join('\n') + '\n');
    await execFileP('lualatex', ['-interaction=nonstopmode', 'iso.tex'], {
      cwd: jobdir,
      timeout: 120_000,
    }).catch(() => {});
    const pdf = path.join(jobdir, 'iso.pdf');
    const statePath = path.join(jobdir, 'state.json');
    if (!existsSync(pdf) || !existsSync(statePath)) {
      throw new Error(`isolated rescue failed for ${block.id} (${why})`);
    }
    const st = JSON.parse(readFileSync(statePath, 'utf8'));
    const ships = st.ships ?? 0;
    const geo = this.geometry ?? {};
    const chunks = [];
    const items = [];
    // fires absorbed BEFORE the first ship are real page breaks whose
    // material (pre-body machinery) left with page 1 — e.g. the \clearpage
    // opening a landscape env. Without them the first chunk page glues
    // itself to the preceding text and overfills.
    if (ships > 0) {
      for (let k = 0; k < (st.preabsorbs ?? 0); k++) items.push({ k: 'eject', v: -10000 });
    }
    // real shipped pages (material taller than the page inside an
    // output-hijack env): one full-textheight chunk per page + a forced
    // break — the preview page sequence mirrors print exactly
    for (let k = 1; k <= ships; k++) {
      const svgPath = path.join(jobdir, `page-${k}.svg`);
      await execFileP('pdftocairo', ['-svg', '-f', String(k), '-l', String(k), pdf, svgPath], {
        timeout: 30_000,
      });
      const x0 = geo.oddsidemargin ?? 0;
      const y0 = (geo.topmargin ?? 0) + (geo.headheight ?? 0) + (geo.headsep ?? 0);
      const w = geo.textwidth ?? st.w;
      const h = geo.textheight ?? st.h;
      const key = `${block.id}@p${k}`;
      chunks.push({ key, svg: cropSvgAt(readFileSync(svgPath, 'utf8'), x0, y0, w, h), wBp: w, hBp: h });
      items.push({ k: 'box', h, d: 0, chunk: key, coff: 0 });
      items.push({ k: 'eject', v: -10000 });
    }
    // remainder galley = the LAST pdf page (our manual shipout); its items
    // carry chunk-local offsets so page breaks inside it clip correctly
    const lastPage = ships + 1;
    const svgPath = path.join(jobdir, 'iso.svg');
    await execFileP(
      'pdftocairo',
      ['-svg', '-f', String(lastPage), '-l', String(lastPage), pdf, svgPath],
      { timeout: 30_000 }
    );
    const remainderKey = block.id;
    if ((st.h ?? 0) + (st.d ?? 0) > 0.01) {
      chunks.push({
        key: remainderKey,
        svg: cropSvg(readFileSync(svgPath, 'utf8'), st.w, st.h + st.d),
        wBp: st.w,
        hBp: st.h + st.d,
      });
      let coff = 0;
      for (const it of st.items ?? []) {
        if (it.k === 'box') {
          items.push({ ...it, chunk: remainderKey, coff });
          coff += (it.h ?? 0) + (it.d ?? 0);
        } else {
          items.push(it);
          if (it.k === 'glue' || it.k === 'kern') coff += it.a ?? 0;
        }
      }
    }
    if (!process.env.TDOM_ISO_KEEP) rmSync(jobdir, { recursive: true, force: true });
    else console.error('ISO_KEEP', block.id, jobdir);
    // trailing skip for the NEXT block's \addvspace merge: last glue item, sp
    const state = { ...(st.state ?? {}) };
    let trailLs = 0;
    for (const it of items) {
      if (it.k === 'glue' || it.k === 'kern') trailLs = it.a ?? 0;
      else if (it.k === 'box') trailLs = 0;
    }
    state['tdom@ls'] = Math.round(trailLs * 65781.76);
    return {
      w: Math.max(st.w ?? 0, ships ? (geo.textwidth ?? 0) : 0),
      h: st.h,
      d: st.d,
      items,
      labels: (st.labels ?? []).map(([k, v, h]) => (h != null ? { k, v, h } : { k, v })),
      toclines: (st.toclines ?? []).map(([e, l, t]) => ({ e, l, t })),
      refs: st.refs ?? [],
      state,
      chunks,
    };
  }

  // Sparse checkpoints: for large documents only every grid-th boundary
  // stays resident. Edits resume from the nearest kept snapshot and simply
  // retypeset a few extra clean blocks (~3ms each).
  #ckptGrid() {
    return Math.max(1, Math.ceil((this.blocks.length + 1) / this.maxCheckpoints));
  }

  #retireOffGrid(idx) {
    const grid = this.#ckptGrid();
    if (grid <= 1 || idx === 0 || idx % grid === 0) return;
    if (!this.checkpoints.has(idx + 1)) return; // successor must exist first
    const peer = this.checkpoints.get(idx);
    if (peer) {
      peer.send('DIE\n');
      this.checkpoints.delete(idx);
    }
  }

  #nearestCheckpoint(idx) {
    let best = 0;
    for (const k of this.checkpoints.keys()) {
      if (k <= idx && k > best) best = k;
    }
    return best;
  }

  /**
   * Retypeset blocks from `from` at least through `target`, then keep going
   * until a re-typeset block reproduces its previous galley AND exit state
   * (counters + prevdepth + \if@nobreak) exactly. Cross-block layout state
   * makes downstream galleys stale after ANY upstream re-typeset — the same
   * self-verifying convergence as the main edit path, factored out so the
   * toc and backward-reference passes cannot cut the chain short.
   * Returns the number of blocks typeset; reports (idx, changed) per block.
   */
  async #retypesetChain(from, target, onBlock) {
    let n = 0;
    for (let j = from; j < this.blocks.length; j++) {
      const block = this.blocks[j];
      const before = { hash: block.galleyHash, state: block.stateVec };
      const g = await this.#typesetBlock(j).catch(() => null);
      if (!g) break;
      this.#adoptGalley(block, g);
      n++;
      const changed = block.galleyHash !== before.hash || block.stateVec !== before.state;
      onBlock?.(j, changed);
      if (j >= target && !changed) break;
    }
    return n;
  }

  #adoptGalley(block, galley) {
    block.galley = galley;
    block.galleyHash = fnv1a(
      JSON.stringify([galley.items, galley.floats, galley.w, galley.h, galley.d, galley.events])
    );
    if (galley.tdomIsoChunks) {
      // rescued block: the isolated run's print-identical pixels are the
      // chunks — registered here so forGalley matches the adopted hash
      for (const c of galley.tdomIsoChunks) {
        const prev = this.chunks.get(c.key);
        this.chunks.set(c.key, {
          svg: c.svg,
          wBp: c.wBp,
          hBp: c.hBp,
          v: (prev?.v ?? 0) + 1,
          forGalley: block.galleyHash,
        });
      }
      delete galley.tdomIsoChunks;
      block.rescued = true;
    } else {
      block.rescued = false;
    }
    // exit state = tracked counters + cross-block layout state (prevdepth,
    // \if@nobreak) — any change forces the convergence chain onward
    block.stateVec = JSON.stringify([
      ...this.counters.map((c) => galley.state?.[c] ?? 0),
      galley.state?.['tdom@pd'] ?? 0,
      galley.state?.['tdom@nobreak'] ?? 0,
      galley.state?.['tdom@ls'] ?? 0,
    ]);
    block.gfx = !!galley.gfx;
    // rescued blocks already carry their print-identical chunks — the
    // resident RENDER path (dormant-page reship) must not overwrite them
    block.needsRender =
      !block.rescued && (block.gfx || (galley.floats ?? []).some((f) => f.gfx));
    block.consumesToc = /\\(tableofcontents|listoffigures|listoftables)\b/.test(block.text);
    block.kind = HEADING_RE.test(block.text)
      ? 'heading'
      : block.gfx
        ? 'graphics'
        : 'paragraph';
    block.units = null;
    for (const [fid, meta] of Object.entries(galley.fonts ?? {})) {
      this.#registerFont(Number(fid), meta);
    }
  }

  #registerFont(fid, meta) {
    if (this.fonts.has(fid)) return;
    const base = path.basename(meta.file || meta.name || '');
    const legacy = !/\.(otf|ttf)$/i.test(base) ? mapLegacyFont(meta.name) : null;
    let familyKey;
    if (legacy) {
      familyKey = 'twin-' + legacy.twin;
      if (!this.fontFiles.has(familyKey)) {
        this.fontFiles.set(familyKey, resolveFont(legacy.twin));
      }
    } else {
      familyKey = 'f-' + fnv1a(meta.file);
      if (!this.fontFiles.has(familyKey)) this.fontFiles.set(familyKey, meta.file);
    }
    this.fonts.set(fid, {
      ...meta,
      family: familyKey,
      remap: legacy?.map ?? null,
      omx: !!legacy?.omx,
    });
  }

  // ------------------------------------------------------------- update

  async #update(args) {
    // serialize async header-job arrivals against updates: an hf apply
    // between an update's prevHashes capture and its patch computation
    // would mark unrelated pages dirty
    this.updating = true;
    try {
      return await this.#updateInner(args);
    } finally {
      this.updating = false;
    }
  }

  async #updateInner({ editLabel, retry = false }) {
    const t = new Timer();
    const text = this.store.get(this.file);
    const diagnostics = [];

    // stop any in-flight background rebuild before touching the chain
    this.bgAbort = true;
    await this.bgTask.catch(() => {});
    this.bgAbort = false;

    const bounds = documentBounds(text);
    const preamble = text.slice(bounds.preamble.start, bounds.preamble.end);
    const preHash = fnv1a(preamble);
    let rebooted = false;
    if (preHash !== this.preHash) {
      // Structure-changing edit: the honest full-rebuild path.
      await this.#bootRoot();
      this.preHash = preHash;
      rebooted = true;
      for (const b of this.blocks) {
        b.galley = null;
        b.units = null;
      }
    }
    t.lap('boot');

    const oldBlocks = this.blocks;
    let segs = segmentBody(text.slice(bounds.body.start, bounds.body.end), bounds.body.start);
    segs = this.#expandIncludes(segs, 0);
    const diff = diffBlocks(this.blocks, segs, () => this.idSeq++);
    this.blocks = diff.blocks;
    const dirtySource = new Set(diff.dirty);
    t.lap('segment');

    // First index whose checkpoint chain is invalid. A checkpoint at idx
    // holds the state after blocks[0..idx-1], so it survives exactly when
    // that prefix is unchanged — pure deletions/insertions invalidate from
    // the end of the common prefix even when no block is "dirty".
    let commonPrefix = 0;
    while (
      commonPrefix < oldBlocks.length &&
      commonPrefix < this.blocks.length &&
      oldBlocks[commonPrefix].hash === this.blocks[commonPrefix].hash
    ) {
      commonPrefix++;
    }
    let firstDirty = this.blocks.length;
    for (let i = 0; i < this.blocks.length; i++) {
      if (!this.blocks[i].galley || dirtySource.has(this.blocks[i].id)) {
        firstDirty = i;
        break;
      }
    }
    if (oldBlocks.length !== this.blocks.length || diff.removed.length) {
      firstDirty = Math.min(firstDirty, commonPrefix);
    }
    // kill checkpoints beyond the last valid boundary
    for (const [idx, peer] of [...this.checkpoints]) {
      if (idx > firstDirty) {
        peer.send('DIE\n');
        this.checkpoints.delete(idx);
      }
    }

    // ---- foreground typeset: resume from the nearest kept snapshot -----
    // Any failure in the typeset phase (dead checkpoint, TeX emergency
    // stop, protocol timeout) triggers ONE full rebuild retry; if that
    // also fails the error surfaces to the client while the last good
    // pages keep being served.
    try {
    const dirtyBlocks = [];
    const depDirty = [];
    const changedLabels = new Set();
    let typesetCount = 0;
    let forkMs = 0;
    const oldLabels = new Map(this.labelTable);

    let i = this.#nearestCheckpoint(Math.min(firstDirty, this.blocks.length));
    while (i < this.blocks.length) {
      const block = this.blocks[i];
      const before = { hash: block.galleyHash, state: block.stateVec, hadGalley: !!block.galley };
      const t0 = performance.now();
      const galley = await this.#typesetBlock(i);
      forkMs += performance.now() - t0;
      typesetCount++;
      const wasClean = before.hadGalley && !dirtySource.has(block.id);
      this.#adoptGalley(block, galley);
      // track label movements
      for (const l of galley.labels ?? []) {
        if (this.labelTable.get(l.k) !== l.v) {
          changedLabels.add(l.k);
          this.labelTable.set(l.k, l.v);
        }
        if (l.h != null) this.hrefTable.set(l.k, l.h);
      }
      const changed = block.galleyHash !== before.hash || block.stateVec !== before.state;
      if (changed || !wasClean) {
        dirtyBlocks.push(block.id);
        if (wasClean) {
          push2(depDirty, changedLabels.size ? 'label' : 'counter', 'chain', block.id);
        }
      }
      i++;
      if (wasClean && !changed && i > firstDirty) {
        // convergence: verify no known-affected blocks remain downstream
        const affectedAhead = this.blocks.slice(i).some(
          (b) => !b.galley || (b.galley.refs ?? []).some((k) => changedLabels.has(k))
        );
        if (!affectedAhead) break;
      }
    }
    const fgStop = i;

    // labels that vanished entirely
    for (const key of oldLabels.keys()) {
      let stillDefined = false;
      for (const b of this.blocks) {
        if ((b.galley?.labels ?? []).some((l) => l.k === key)) { stillDefined = true; break; }
      }
      if (!stillDefined) {
        this.labelTable.delete(key);
        changedLabels.add(key);
      }
    }

    // Backward references: a label defined LATER in the chain (new figure,
    // renamed equation...) can be referenced by EARLIER blocks, which the
    // forward pass never revisits. Retypeset those ref-users explicitly.
    if (changedLabels.size) {
      for (let c = 0; c < this.blocks.length; c++) {
        const block = this.blocks[c];
        const hit = (block.galley?.refs ?? []).some(
          (k) => changedLabels.has(k) && !resolvedInGalley(block, k, this.labelTable)
        );
        if (!hit) continue;
        const from = this.#nearestCheckpoint(c);
        await this.#retypesetChain(from, c, (j, changed) => {
          typesetCount++;
          if (j === c && changed) {
            dirtyBlocks.push(block.id);
            for (const k of block.galley.refs ?? []) {
              if (changedLabels.has(k)) push2(depDirty, 'label', k, block.id);
            }
          } else if (j > c && changed) {
            dirtyBlocks.push(this.blocks[j].id);
          }
        });
      }
    }
    t.lap('typeset');

    for (const key of changedLabels) {
      for (const b of this.blocks) {
        if ((b.galley?.refs ?? []).includes(key)) push2(depDirty, 'label', key, b.id);
      }
    }

    // ---- live table of contents -----------------------------------------
    // Provisional pagination gives page numbers; if the toc data moved,
    // retypeset the \tableofcontents blocks with the fresh toc file.
    // Fixed point: the toc block's own height shifts page numbers, which
    // shift the toc — iterate like latex reruns would, but per block.
    for (let pass = 0; pass < 3; pass++) {
      const prov = this.#paginateNow();
      const toc = this.#computeToc(prov);
      if (toc.hash === this.tocHash) break;
      this.tocHash = toc.hash;
      for (const [ext, content] of Object.entries(toc.contents)) {
        writeFileSync(path.join(this.workDir, `driver.${ext}`), content);
      }
      let anyConsumer = false;
      for (let c = 0; c < this.blocks.length; c++) {
        const block = this.blocks[c];
        if (!block.consumesToc) continue;
        anyConsumer = true;
        const from = this.#nearestCheckpoint(c);
        await this.#retypesetChain(from, c, (j, changed) => {
          typesetCount++;
          if (changed && j >= c) {
            dirtyBlocks.push(this.blocks[j].id);
            if (j === c) push2(depDirty, 'toc', 'contents', block.id);
          }
        });
      }
      if (!anyConsumer) break;
    }
    t.lap('toc');

    // ---- page-context-sensitive rescues ---------------------------------
    // A rescued environment that reads \pagegoal-\pagetotal (mdframed,
    // breakable tcolorbox …) splits by its position ON the page. Feed each
    // rescued block its true entry offset from provisional pagination and
    // iterate to a fixed point — the split changes heights, which move
    // every later block's offset, exactly like TeX's own reruns would.
    for (let pass = 0; pass < 4; pass++) {
      const prov = this.#paginateNow();
      const entry = prov.blockEntry ?? new Map();
      let moved = false;
      for (let c = 0; c < this.blocks.length; c++) {
        const block = this.blocks[c];
        if (!block.rescued) continue;
        const want = Math.round((entry.get(block.id) ?? 0) * 100) / 100;
        const have = block.pageOffset ?? 0;
        if (Math.abs(want - have) <= 0.05) continue;
        // offset-independent cases skip the (expensive) re-rescue:
        // an env that OPENS with a page break (\clearpage in landscape/
        // longtable) never sees the entry offset, and an unbroken box that
        // fits at BOTH offsets renders identically
        const items = block.galley?.items ?? [];
        const th = this.geometry?.textheight ?? 0;
        const boxH = (block.galley?.h ?? 0) + (block.galley?.d ?? 0);
        if (
          items[0]?.k === 'eject' ||
          (!items.some((it) => it.k === 'eject') && boxH <= th - want && boxH <= th - have)
        ) {
          block.pageOffset = want;
          continue;
        }
        block.pageOffset = want;
        moved = true;
        const from = this.#nearestCheckpoint(c);
        await this.#retypesetChain(from, c, (j, changed) => {
          typesetCount++;
          if (changed && j >= c) dirtyBlocks.push(this.blocks[j].id);
        });
      }
      if (!moved) break;
    }
    t.lap('pagectx');
    this._typesetResult = { dirtyBlocks, depDirty, changedLabels, typesetCount, forkMs, fgStop };
    } catch (err) {
      if (!retry) {
        this.diagnostics.push('typeset phase failed (' + err.message + ') — full rebuild');
        this.preHash = null; // force a root reboot on the retry pass
        for (const peer of this.peers) peer.send('DIE\n');
        this.checkpoints.clear();
        return this.#update({ editLabel, retry: true });
      }
      throw err;
    }
    const { dirtyBlocks, depDirty, changedLabels, typesetCount, forkMs, fgStop } = this._typesetResult;

    // ---- pages, display lists, patches ---------------------------------
    const pagesRaw = this.#paginateNow();
    const { pages, reused, rebuilt } = reconcile(pagesRaw, this.pages);
    const prevHashes = new Map(this.pages.map((p) => [p.number, p.dl?.hash]));
    const prevCount = this.pages.length;
    const patches = [];
    const dirtyPages = [];
    for (const page of pages) {
      if (!page.dl || page.dl.hfSig !== this.hfSig) page.dl = this.#displayList(page);
      if (page.dl.hash !== prevHashes.get(page.number)) {
        dirtyPages.push(page.number);
        patches.push({ type: 'replace-page', page: page.number, displayList: page.dl });
      }
    }
    if (pages.length < prevCount) patches.push({ type: 'remove-pages', from: pages.length + 1 });
    this.pages = pages;
    this.#scheduleHeaders();
    t.lap('paginate');

    // ---- async work: rebuild remaining checkpoint chain + gfx renders --
    this.#scheduleBackground(fgStop, dirtyBlocks);
    t.lap('schedule');

    this.rev++;
    return {
      rev: this.rev,
      edit: editLabel,
      backend: this.backendName,
      dirtySourceNodes: [...dirtySource].map((id) => 'src-' + id),
      dirtySemanticNodes: dirtyBlocks.map((id) => 'blk-' + id),
      dirtyDependencies: depDirty,
      dirtyLayoutNodes: dirtyBlocks.map((id) => 'galley-' + id),
      dirtyPages,
      patches,
      stats: {
        ...t.done(),
        blocksTotal: this.blocks.length,
        blocksTypeset: typesetCount,
        blocksReparsed: typesetCount,
        semanticCacheHits: this.blocks.length - typesetCount,
        layoutCacheHits: this.blocks.length - typesetCount,
        layoutCacheMisses: typesetCount,
        typesetMs: Math.round(forkMs * 100) / 100,
        rebooted,
        checkpoints: this.checkpoints.size,
        pagesReused: reused,
        pagesRebuilt: rebuilt,
        pageCount: pages.length,
        macrosChanged: [],
        labelsChanged: [...changedLabels],
        diagnostics: [...diagnostics, ...this.diagnostics.splice(0)],
      },
    };
  }

  #scheduleBackground(fromIdx, dirtyBlocks) {
    // Chain restoration must finish before the next edit is applied (edits
    // await bgTask); graphics renders are fire-and-forget — an edit never
    // waits on pdftocairo.
    this.bgTask = (async () => {
      for (let j = fromIdx; j < this.blocks.length; j++) {
        if (this.bgAbort) return;
        if (this.checkpoints.has(j + 1)) continue;
        const block = this.blocks[j];
        const before = block.galleyHash;
        const galley = await this.#typesetBlock(j).catch(() => null);
        if (!galley) return;
        this.#adoptGalley(block, galley);
        if (block.galleyHash !== before) {
          // late-discovered change (rare): patch through the async channel
          this.#asyncRepaginate();
          if (block.needsRender) {
            this.renderTask = (this.renderTask ?? Promise.resolve()).then(() =>
              this.#renderBlock(block).catch((err) => {
                this.diagnostics.push(`render ${block.id}: ${err.message}`);
              })
            );
          }
        }
      }
    })();
    const renders = [];
    const fresh = (key, block) => {
      const c = this.chunks.get(key);
      return !!c && c.forGalley === block.galleyHash;
    };
    for (const block of this.blocks) {
      const missingChunk =
        (block.gfx && !fresh(block.id, block)) ||
        (block.galley?.floats ?? []).some((f) => f.gfx && !fresh(block.id + '#' + f.n, block));
      if (block.needsRender && (dirtyBlocks.includes(block.id) || missingChunk)) {
        renders.push(
          this.bgTask
            .then(() => this.#renderBlock(block))
            .catch((err) => {
              this.diagnostics.push(`render ${block.id}: ${err.message}`);
            })
        );
      }
    }
    // exposed so tools/tests can wait for the exact-render tier to settle
    this.renderTask = Promise.all(renders).then(() => {});
  }

  async #renderBlock(block) {
    const idx = this.blocks.indexOf(block);
    if (idx < 0) return;
    if (this.pdfOpenedAtRoot) return this.#renderIsolated(block, idx);
    const ck = this.checkpoints.get(idx);
    if (!ck) return;
    // one render per (block, content); stale results are discarded so a
    // fast typist never sees an outdated exact image over live glyphs
    const forGalley = block.galleyHash;
    const inflightKey = block.id + ':' + forGalley;
    this.rendering ??= new Set();
    if (this.rendering.has(inflightKey)) return;
    this.rendering.add(inflightKey);
    try {
    const jobdir = path.join(this.workDir, `render-${block.id}-${forGalley}`);
    mkdirSync(jobdir, { recursive: true });
    rmSync(path.join(jobdir, 'driver.pdf'), { force: true });
    const guard = '}'.repeat(Math.max(0, braceImbalance(block.text)));
    const body = Buffer.from(block.text + guard, 'utf8');
    const done = this.#await('render:' + block.id, 60_000);
    ck.send(`RENDER ${block.id} ${jobdir} ${body.length}\n`);
    ck.sendRaw(body);
    await done;
    const pdf = path.join(jobdir, 'driver.pdf');
    // DONE fires from finish_pdffile, but the child's stdio buffers reach
    // the disk only on _exit — wait until the file is complete (%%EOF)
    await waitForPdf(pdf);
    // page 1 = the block galley; pages 2..N = its float boxes in order
    const targets = [];
    if (block.gfx) {
      targets.push({ key: block.id, page: 1, w: block.galley.w, h: block.galley.h + block.galley.d });
    }
    (block.galley.floats ?? []).forEach((f, i) => {
      if (f.gfx) {
        targets.push({ key: block.id + '#' + f.n, page: 2 + i, w: f.w, h: (f.h ?? 0) + (f.d ?? 0) });
      }
    });
    for (const tgt of targets) {
      const svgPath = path.join(jobdir, `chunk-${tgt.page}.svg`);
      await execFileP(
        'pdftocairo',
        ['-svg', '-f', String(tgt.page), '-l', String(tgt.page), pdf, svgPath],
        { timeout: 30_000 }
      );
      const svg = cropSvg(readFileSync(svgPath, 'utf8'), tgt.w, tgt.h);
      const prev = this.chunks.get(tgt.key);
      this.chunks.set(tgt.key, {
        svg,
        wBp: tgt.w,
        hBp: tgt.h,
        v: (prev?.v ?? 0) + 1,
        forGalley,
      });
    }
    if (block.galleyHash === forGalley) this.#asyncRepaginate();
    } finally {
      this.rendering.delete(inflightKey);
    }
  }

  /**
   * Exact render via a standalone lualatex run — used when the resident
   * tree cannot ship pages (hyperref opened the PDF at boot). Slower
   * (full preamble per render) but pixel-exact all the same.
   */
  async #renderIsolated(block, idx) {
    // isolated renders are FULL lualatex runs of the document preamble —
    // dozens in parallel overload the machine, hit the 90s timeout and
    // leave truncated PDFs ('Invalid XRef'). Serialize them; each result
    // is cached by galley hash so the queue drains once per content.
    this.isoRenderQueue = (this.isoRenderQueue ?? Promise.resolve()).then(() =>
      this.#renderIsolatedInner(block, idx).catch((err) => {
        this.diagnostics.push(`render ${block.id}: ${err.message}`);
      })
    );
    return this.isoRenderQueue;
  }

  async #renderIsolatedInner(block, idx) {
    const forGalley = block.galleyHash;
    const inflightKey = 'iso:' + block.id + ':' + forGalley;
    this.rendering ??= new Set();
    if (this.rendering.has(inflightKey)) return;
    this.rendering.add(inflightKey);
    try {
      // entry counters = the previous block's REAL exit vector (captured
      // from TeX by the galley report); zeros at the document start
      const entry = {};
      const prevVec = idx > 0 ? JSON.parse(this.blocks[idx - 1].stateVec ?? '[]') : [];
      this.counters.forEach((c, i) => {
        entry[c] = prevVec[i] ?? 0;
      });
      // cross-block layout state from the previous block's REAL exit vector:
      // [..counters.., tdom@pd, tdom@nobreak, tdom@ls] — prevdepth reproduces
      // the exact leading interline glue, @nobreak the post-heading \everypar
      const prevPd = idx > 0 && prevVec.length >= 3 ? prevVec[prevVec.length - 3] : -65536000;
      const prevNobreak = idx > 0 && prevVec.length >= 2 ? prevVec[prevVec.length - 2] === 1 : false;
      const text = this.store.get(this.file);
      const bounds = documentBounds(text);
      const L = [];
      L.push(text.slice(bounds.preamble.start, bounds.preamble.end).trimEnd());
      L.push('\\begin{document}');
      L.push('\\makeatletter\\pagestyle{empty}\\hoffset=-1in\\voffset=-1in');
      for (const [key, val] of this.labelTable) {
        if (key.startsWith('cite:')) L.push(`\\global\\@namedef{b@${key.slice(5)}}{${val}}`);
        else L.push(`\\global\\@namedef{r@${key}}${labelDefBody(key, val, this.geometry?.hyperref === 1, this.hrefTable?.get(key))}`);
      }
      for (const [name, val] of Object.entries(entry)) {
        L.push(`\\ifcsname c@${name}\\endcsname\\setcounter{${name}}{${val}}\\fi`);
      }
      // float capture, exactly like the resident driver: the environment
      // body is typeset into a box with \@xfloat's setup, and a Lua-side
      // copy is kept so each float ships as its own page (2..N) after the
      // galley — same protocol as the resident RENDER path
      // NB: inline Lua under LaTeX catcodes — no '%', '#' or backslash
      // characters (see #isoCompile); TeX tokens are built via string.char
      L.push('\\newbox\\TDOMisofbox');
      L.push('\\directlua{tdom_iso_fbox=\\number\\TDOMisofbox tdom_iso_floats={} tdom_iso_nf=0 ' +
        'function tdom_iso_float() local b = tex.box[tdom_iso_fbox] ' +
        'if b then tdom_iso_nf = tdom_iso_nf + 1 tdom_iso_floats[tdom_iso_nf] = node.copy_list(b) end end ' +
        'function tdom_iso_load_float(i) local b = tdom_iso_floats[i] ' +
        'if not b then return end tdom_iso_floats[i] = false ' +
        'tex.box[255] = b ' +
        'tex.pagewidth = math.max(b.width or 0, 65536) ' +
        'tex.pageheight = math.max((b.height or 0) + (b.depth or 0), 65536) end ' +
        'function tdom_iso_ship_floats() ' +
        'local BS = string.char(92) ' +
        'local lines = {} ' +
        'for i = 1, tdom_iso_nf do ' +
        "table.insert(lines, BS .. 'directlua{tdom_iso_load_float(' .. i .. ')}') " +
        "table.insert(lines, BS .. 'shipout' .. BS .. 'box255') end " +
        'if lines[1] then tex.print(lines) end end}');
      L.push('\\def\\TDOMHplacement{H}');
      for (const env of ['figure', 'table']) {
        // [H] (float.sty) is inline material, not a float — same dispatch
        // as the resident driver: hand it back to the original environment
        L.push(`\\expandafter\\let\\csname TDOMorig${env}\\expandafter\\endcsname\\csname ${env}\\endcsname`);
        L.push(
          `\\renewenvironment{${env}}[1][tbp]` +
            `{\\gdef\\TDOMfp{#1}\\ifx\\TDOMfp\\TDOMHplacement` +
            `\\csname TDOMorig${env}\\endcsname[H]` +
            `\\else\\def\\@captype{${env}}\\ifhmode\\@bsphack\\fi` +
            '\\global\\setbox\\TDOMisofbox\\vbox\\bgroup\\hsize\\columnwidth\\@parboxrestore\\@floatboxreset\\fi}' +
            '{\\par\\vskip\\z@skip\\egroup' +
            '\\directlua{tdom_iso_float()}' +
            '\\ifhmode\\@Esphack\\fi}'
        );
      }
      L.push('\\makeatother');
      // same dormant-page technique as the resident daemon: typeset on the
      // real MVL (state-faithful spacing), then harvest, vpack and ship
      L.push('\\vsize=\\maxdimen');
      L.push('\\holdinginserts=1');
      L.push('\\maxdeadcycles=200');
      L.push('\\hbox to0pt{}');
      L.push('\\special{tdom:isostart}');
      L.push(`\\directlua{tex.nest[0].prevdepth=${Math.round(prevPd)}}`);
      // see #isoCompile: vertical-env blocks keep the @nobreak flag instead
      // of \noindent, so their own before-skip glue survives
      if (prevNobreak) L.push(startsVertical(block.text) ? '\\makeatletter\\@nobreaktrue\\makeatother' : '\\noindent');
      L.push(block.text.trimEnd() + '}'.repeat(Math.max(0, braceImbalance(block.text))));
      L.push('\\par');
      L.push(
        '\\directlua{' +
          'tex.triggerbuildpage() ' +
          'local head = tex.lists.page_head ' +
          'tex.lists.page_head = nil tex.lists.contrib_head = nil ' +
          'local INS = node.id("ins") local WH = node.id("whatsit") ' +
          'local SP = node.subtype("special") ' +
          // everything up to and including the isostart marker is pre-body
          // machinery (begin-document whatsits, \topskip glue, the seed box)
          'while head do ' +
          'local ismark = head.id == WH and head.subtype == SP and head.data == "tdom:isostart" ' +
          'local nxt = head.next head.next = nil if nxt then nxt.prev = nil end node.free(head) head = nxt ' +
          'if ismark then break end end ' +
          'local out, tail = nil, nil local n = head ' +
          'while n do local nxt = n.next n.next = nil n.prev = nil ' +
          'if n.id == INS then node.free(n) else if tail then tail.next = n n.prev = tail else out = n end tail = n end n = nxt end ' +
          // page 1 must ALWAYS exist (floats follow at 2..N): an empty
          // galley (float-only block) would make \shipout void = no page
          // and shift every float's page index
          'local b = out and node.vpack(out) or node.new("hlist") ' +
          'tex.box[255] = b tex.pagewidth = math.max(b.width or 0, 65536) ' +
          'tex.pageheight = math.max((b.height or 0) + (b.depth or 0), 65536)}'
      );
      L.push('\\shipout\\box255');
      L.push('\\directlua{tdom_iso_ship_floats()}');
      L.push('\\csname @@end\\endcsname');
      const jobdir = path.join(this.workDir, `render-${block.id}-${forGalley}`);
      mkdirSync(jobdir, { recursive: true });
      rmSync(path.join(jobdir, 'iso.pdf'), { force: true });
      writeFileSync(path.join(jobdir, 'iso.tex'), L.join('\n') + '\n');
      await execFileP('lualatex', ['-interaction=nonstopmode', 'iso.tex'], {
        cwd: jobdir,
        timeout: 90_000,
      }).catch(() => {});
      const pdf = path.join(jobdir, 'iso.pdf');
      if (!existsSync(pdf)) throw new Error('isolated render produced no PDF');
      await waitForPdf(pdf); // %%EOF flushed before pdftocairo reads it
      // page 1 = the block galley; pages 2..N = its float boxes in order —
      // the same convention as the resident RENDER path
      const targets = [];
      if (block.gfx) {
        targets.push({
          key: block.id,
          page: 1,
          w: block.galley.w,
          h: block.galley.h + block.galley.d,
        });
      }
      (block.galley.floats ?? []).forEach((f, i) => {
        if (f.gfx) {
          targets.push({ key: block.id + '#' + f.n, page: 2 + i, w: f.w, h: (f.h ?? 0) + (f.d ?? 0) });
        }
      });
      for (const tgt of targets) {
        const svgPath = path.join(jobdir, `iso-${tgt.page}.svg`);
        await execFileP(
          'pdftocairo',
          ['-svg', '-f', String(tgt.page), '-l', String(tgt.page), pdf, svgPath],
          { timeout: 30_000 }
        );
        // the shipped page can come out paper-sized when a class hooks the
        // shipout (luatexja); the box sits at the origin (\hoffset=-1in), so
        // cropping the viewBox to the known extent is always exact
        const svg = cropSvg(readFileSync(svgPath, 'utf8'), tgt.w, tgt.h);
        const prev = this.chunks.get(tgt.key);
        this.chunks.set(tgt.key, {
          svg,
          wBp: tgt.w,
          hBp: tgt.h,
          v: (prev?.v ?? 0) + 1,
          forGalley,
        });
      }
      if (block.galleyHash === forGalley) this.#asyncRepaginate();
      rmSync(jobdir, { recursive: true, force: true });
    } finally {
      this.rendering.delete(inflightKey);
    }
  }

  #asyncRepaginate() {
    // rebuild display lists after async galley/chunk arrivals and push
    // patches through the async channel (SSE)
    const rawPages = this.#paginateNow();
    const { pages } = reconcile(rawPages, this.pages);
    const prevHashes = new Map(this.pages.map((p) => [p.number, p.dl?.hash]));
    const patches = [];
    for (const page of pages) {
      if (!page.dl || page.dl.hfSig !== this.hfSig) page.dl = this.#displayList(page);
      if (page.dl.hash !== prevHashes.get(page.number)) {
        patches.push({ type: 'replace-page', page: page.number, displayList: page.dl });
      }
    }
    if (pages.length < this.pages.length) {
      patches.push({ type: 'remove-pages', from: pages.length + 1 });
    }
    this.pages = pages;
    if (patches.length && this.onAsyncPatches) {
      this.rev++;
      this.onAsyncPatches({ rev: this.rev, patches });
    }
  }

  // --------------------------------------------------------------- units

  #paginateNow() {
    this.#rebuildUnits();
    const stream = [];
    for (const block of this.blocks) stream.push(...(block.units ?? []));
    return buildPages(stream, this.geometry);
  }

  #rebuildUnits() {
    for (const block of this.blocks) {
      const bc = this.chunks.get(block.id);
      const hasChunk = !!bc && bc.forGalley === block.galleyHash;
      const floatVs = (block.galley?.floats ?? [])
        .map((f) => {
          const fc = this.chunks.get(block.id + '#' + f.n);
          return fc && fc.forGalley === block.galleyHash ? fc.v : 0;
        })
        .join(',');
      const sig = `${block.galleyHash}|${hasChunk ? bc.v : 0}|${floatVs}`;
      if (!block.units || block.unitsSig !== sig) {
        block.units = buildStream(block, hasChunk, this.chunks);
        block.unitsSig = sig;
      }
    }
  }

  // ----------------------------------------------------- toc / includes

  /**
   * Regenerate the contents files (toc / lof / lot) from the toclines the
   * daemon captured off \addcontentsline — the entries are TeX's own,
   * already expanded with the class's real numbering; the orchestrator
   * substitutes only the page number, which it owns (it builds the pages).
   */
  #computeToc(pages) {
    // toc entries print the FOLIO (roman front matter, arabic body...), not
    // the physical page index — take it from the page specs, formatted with
    // the kernel's \@arabic/\@roman/... transcriptions
    const specs = this.#pageSpecs(pages);
    const folioText = new Map(specs.map((s) => [s.page, formatFolio(s.folio, s.fmt)]));
    const blockPage = new Map();
    for (const page of pages) {
      for (const d of page.draw ?? []) {
        const bid = d.u?.blockId;
        if (bid && !blockPage.has(bid)) blockPage.set(bid, page.number);
      }
      for (const f of page.floats ?? []) {
        const bid = f.blockId ?? f.id?.split('#')[0];
        if (bid && !blockPage.has(bid + '#float')) blockPage.set(bid + '#float', page.number);
      }
    }
    // toclines are stream-anchored (tdom:tl markers): the entry's page is
    // the page its marker landed on, exact even inside multi-page blocks
    const tlPage = new Map();
    for (const page of pages) {
      for (const r of page.tls ?? []) tlPage.set(`${r.bid}:${r.i}`, page.number);
    }
    const files = { toc: [], lof: [], lot: [] };
    for (const block of this.blocks) {
      (block.galley?.toclines ?? []).forEach((tl, idx) => {
        const ext = tl.e ?? 'toc';
        if (!files[ext]) files[ext] = [];
        if (tl.l === '@raw') {
          // \addtocontents material (inter-group \addvspace etc.): replayed
          // verbatim in document order between the entries
          files[ext].push(tl.t);
          return;
        }
        // float captions (lof/lot) sit on the page the float landed on when
        // known; everything else on the page its stream marker reached
        const page =
          (ext !== 'toc' ? blockPage.get(block.id + '#float') : undefined) ??
          tlPage.get(`${block.id}:${idx}`) ??
          blockPage.get(block.id) ??
          1;
        // 4th (destination) argument required by LaTeX 2020-10 and later
        files[ext].push(`\\contentsline {${tl.l}}{${tl.t}}{${folioText.get(page) ?? page}}{}%`);
      });
    }
    const contents = {};
    for (const [ext, lines] of Object.entries(files)) {
      contents[ext] = lines.join('\n') + '\n';
    }
    return { hash: fnv1a(JSON.stringify(contents)), contents };
  }

  // ------------------------------------------------- page-style layer
  //
  // Headers, footers and folios are TeX-typeset, never invented: the daemon
  // captures \pagestyle/\thispagestyle/\pagenumbering/\markboth/\markright
  // as block-anchored events; after pagination the orchestrator reconstructs
  // each page's exact state (folio value + format, style, marks) and a
  // header job typesets the real \@oddhead/\@oddfoot boxes for every page.

  #pageSpecs(pages) {
    // events ride the node stream as markers, so each page's event list
    // (page.evs) is exact even when one block spans several pages
    const blockById = new Map(this.blocks.map((b) => [b.id, b]));
    const specs = [];
    let style = this.initialStyle;
    let fmt = 'arabic';
    let folio = 1;
    let lmark = '';
    let rmark = '';
    for (const page of pages) {
      let thisstyle = null;
      // TeX mark semantics: \leftmark = botmark's left (LAST mark on the
      // page), \rightmark = firstmark's right (FIRST mark on the page, or
      // the carried value when the page has no marks)
      const rmarkAtStart = rmark;
      let firstRight = null;
      for (const ref of page.evs ?? []) {
        // synthetic events (blank verso pages) carry their payload inline
        const ev = ref.bid ? blockById.get(ref.bid)?.galley?.events?.[ref.i] : ref;
        if (!ev) continue;
        if (ev.k === 'style') style = ev.a;
        else if (ev.k === 'thisstyle') thisstyle = ev.a;
        else if (ev.k === 'pagenum') {
          fmt = ev.a;
          folio = 1; // \pagenumbering resets the page counter (kernel behavior)
        } else if (ev.k === 'mark') {
          lmark = ev.a;
          if (firstRight === null) firstRight = ev.b;
          rmark = ev.b;
        } else if (ev.k === 'markr') {
          if (firstRight === null) firstRight = ev.a;
          rmark = ev.a;
        }
      }
      specs.push({
        page: page.number,
        // the page builder owns folio assignment (it inserts blank versos
        // and applies \pagenumbering resets in stream order)
        folio: page.folio ?? folio,
        fmt,
        style: thisstyle ?? style,
        lmark,
        rmark: firstRight ?? rmarkAtStart,
      });
      folio = (page.folio ?? folio) + 1;
    }
    return specs;
  }

  #hfJobBody(specs) {
    const L = ['\\makeatletter'];
    // \pageref{LastPage} in headers/footers: the label lastpage would write
    // at \enddocument is the LAST page's folio — a value the page builder
    // owns outright (\pageref prints the second group of \r@LastPage)
    const last = specs[specs.length - 1];
    if (last) {
      const lp = formatFolio(last.folio, last.fmt);
      L.push(`\\global\\@namedef{r@LastPage}{{}{${lp}}}`);
    }
    for (const s of specs) {
      L.push(`\\global\\c@page=${s.folio}`);
      L.push(`\\gdef\\thepage{\\csname @${s.fmt}\\endcsname\\c@page}`);
      L.push(`\\def\\leftmark{${s.lmark}}`);
      L.push(`\\def\\rightmark{${s.rmark}}`);
      // reset then apply the page style (an unknown style leaves all empty)
      L.push('\\def\\@oddhead{}\\def\\@evenhead{}\\def\\@oddfoot{}\\def\\@evenfoot{}');
      L.push(`\\csname ps@${s.style}\\endcsname`);
      L.push('\\let\\TDOMhd\\@oddhead\\let\\TDOMft\\@oddfoot');
      L.push('\\if@twoside\\ifodd\\c@page\\else\\let\\TDOMhd\\@evenhead\\let\\TDOMft\\@evenfoot\\fi\\fi');
      L.push(
        `\\setbox\\z@\\vbox{\\hsize\\textwidth\\hb@xt@\\textwidth{\\normalcolor\\TDOMhd}}` +
          `\\directlua{tdom_hf_box(0, ${s.page}, 'h')}`
      );
      L.push(
        `\\setbox\\z@\\vbox{\\hsize\\textwidth\\hb@xt@\\textwidth{\\normalcolor\\TDOMft}}` +
          `\\directlua{tdom_hf_box(0, ${s.page}, 'f')}`
      );
    }
    L.push('\\directlua{tdom_hf_flush()}');
    return L.join('\n');
  }

  #scheduleHeaders() {
    const pages = this.pages;
    if (!pages?.length) return;
    const specs = this.#pageSpecs(pages);
    const sig = fnv1a(JSON.stringify(specs));
    if (sig === this.hfSig || sig === this.hfPending) return;
    const ck = this.checkpoints.get(0);
    if (!ck) return;
    this.hfPending = sig;
    this.hfTask = (async () => {
      const body = Buffer.from(this.#hfJobBody(specs), 'utf8');
      const done = this.#await('galley:__hf', 60_000);
      done.catch(() => {});
      ck.send(`RENDER __hf ${this.workDir} ${body.length}\n`);
      ck.sendRaw(body);
      const payload = await done;
      for (const [fid, meta] of Object.entries(payload.fonts ?? {})) {
        this.#registerFont(Number(fid), meta);
      }
      const map = new Map();
      for (const [pageStr, entry] of Object.entries(payload.hf ?? {})) {
        map.set(Number(pageStr.replace(/^p/, '')), entry);
      }
      // apply only between updates — never mid-#update (see this.updating)
      await new Promise((resolve) => {
        const apply = () => {
          if (this.updating) {
            setTimeout(apply, 10);
            return;
          }
          this.hf = map;
          this.hfSig = sig;
          this.#asyncRepaginate();
          resolve();
        };
        apply();
      });
    })()
      .catch((err) => {
        this.diagnostics.push('header job failed: ' + err.message);
      })
      .finally(() => {
        if (this.hfPending === sig) this.hfPending = null;
      });
  }

  #expandIncludes(segs, depth) {
    if (depth > 3) return segs;
    const out = [];
    for (const seg of segs) {
      const m = seg.text.match(/^\s*\\(input|include)\s*\{([^}]+)\}\s*$/);
      if (!m) {
        out.push(seg);
        continue;
      }
      let rel = m[2];
      if (!/\.tex$/i.test(rel)) rel += '.tex';
      const full = path.resolve(this.docDir ?? this.workDir, rel);
      let text = null;
      try {
        const st = statSync(full);
        const cached = this.includes.get(full);
        text = cached && cached.mtime === st.mtimeMs ? cached.text : readFileSync(full, 'utf8');
        this.includes.set(full, { mtime: st.mtimeMs, text });
        this.#watchInclude(full);
      } catch {
        this.diagnostics.push(`\\input file not found: ${rel} (typeset literally)`);
        out.push(seg);
        continue;
      }
      const subs = this.#expandIncludes(segmentBody(text, 0), depth + 1);
      for (const s of subs) out.push({ ...s, file: full, hash: fnv1a(full + '|' + s.text) });
    }
    return out;
  }

  #watchInclude(full) {
    if (this.watchers.has(full)) return;
    try {
      let timer = null;
      const w = watch(full, () => {
        clearTimeout(timer);
        timer = setTimeout(() => this.onExternalChange?.(full), 120);
      });
      this.watchers.set(full, w);
    } catch {
      /* watching is best-effort */
    }
  }

  async refresh() {
    return this.#update({ editLabel: 'external-include' });
  }

  #displayList(page) {
    const geo = this.geometry;
    const L = 72 + (geo.oddsidemargin ?? 0);
    const T = 72 + (geo.topmargin ?? 0) + (geo.headheight ?? 0) + (geo.headsep ?? 0);
    const commands = [];
    let gfxOpen = null;
    const flushGfx = () => {
      if (!gfxOpen) return;
      const meta = this.chunks.get(gfxOpen.blockId);
      commands.push({
        op: 'chunk',
        chunk: gfxOpen.blockId,
        x: r2(L),
        y: r2(gfxOpen.top + gfxOpen.clip0),
        w: r2(gfxOpen.w),
        h: r2(gfxOpen.clip1 - gfxOpen.clip0),
        sy: r2(gfxOpen.clip0),
        ch: r2(meta?.hBp ?? gfxOpen.clip1),
        cv: meta?.v ?? 0,
        src: gfxOpen.blockId,
      });
      gfxOpen = null;
    };

    for (const entry of page.draw ?? []) {
      const u = entry.u;
      const baseline = T + entry.y;
      if (u.ln.gfxChunk) {
        const c = u.ln.gfxChunk;
        const unitTop = baseline - u.ln.boxH;
        const chunkTop = unitTop - c.yOff;
        const clip0 = c.yOff;
        const clip1 = c.yOff + u.h + (u.d ?? 0);
        if (gfxOpen && gfxOpen.blockId === c.blockId && Math.abs(gfxOpen.top - chunkTop) < 0.05) {
          gfxOpen.clip1 = Math.max(gfxOpen.clip1, clip1);
        } else {
          flushGfx();
          gfxOpen = { blockId: c.blockId, top: chunkTop, clip0, clip1, w: c.w };
        }
        continue;
      }
      flushGfx();
      this.#runCommands(commands, u.ln.runs, L, baseline, u.blockId);
    }
    flushGfx();
    // Header / footer: TeX-typeset boxes from the page-style job (the exact
    // \@oddhead/\@oddfoot with the page's real folio format, style and
    // marks). \@outputpage geometry: head box bottom at topmargin+headheight,
    // foot baseline \footskip below the text area.
    const hfEntry = this.hf?.get(page.number);
    if (hfEntry) {
      this.#paintHfItems(commands, hfEntry.h, L, 72 + (geo.topmargin ?? 0) + (geo.headheight ?? 0));
      this.#paintHfItems(commands, hfEntry.f, L, T + geo.textheight + (geo.footskip ?? 30));
    } else {
      // header job hasn't landed yet: provisional plain folio (replaced by
      // the TeX-typeset footer as soon as the async job reports)
      commands.push({
        op: 'folio',
        x: r2(L + geo.textwidth / 2),
        y: r2(T + geo.textheight + (geo.footskip ?? 30)),
        text: String(page.number),
      });
    }
    const dl = { page: page.number, commands };
    dl.hash = fnv1a(JSON.stringify(commands));
    dl.hfSig = this.hfSig; // display lists built pre-header-job get rebuilt
    return dl;
  }

  /** Paint one run list (glyphs + rules) at a baseline — shared by body
   * units and the TeX-typeset header/footer boxes. */
  #runCommands(commands, runs, X, baseline, src) {
    for (const r of runs ?? []) {
      if (r.rule) {
        commands.push({
          op: 'rule',
          x: r2(X + r.x),
          y: r2(baseline + r.dy),
          w: r2(r.w),
          h: r2(r.h),
          color: r.c && r.c !== '#000000' ? r.c : undefined,
          src,
        });
      } else if (r.t) {
        const fmeta = this.fonts.get(r.f);
        const text = fmeta?.remap ? remapText(r.t, fmeta.remap) : r.t;
        // cmex (OMX) glyphs hang below their reference point in TeX's
        // metrics; the unicode twins sit on a normal baseline. Align the
        // ink tops exactly: TeX extents travel with the run, twin extents
        // were measured by the daemon from the actual twin font.
        let dy = r.dy;
        if (fmeta?.omx) {
          const gh = r.gh ?? 0;
          const gd = r.gd ?? 0;
          const cp = text.codePointAt(0);
          const tm = this.twinMetrics?.[cp];
          if (tm) {
            dy = r.dy - gh + tm[0] * (r.s / 10);
          } else {
            dy = r.dy - gh + 0.78 * (gh + gd);
          }
        }
        commands.push({
          op: 'glyphs',
          fam: fmeta?.family ?? 'f-unknown',
          size: r.s,
          x: r2(X + r.x),
          y: r2(baseline + dy),
          text,
          color: r.c && r.c !== '#000000' ? r.c : undefined,
          src,
        });
      }
    }
  }

  /** Paint a harvested header/footer box (vbox-wrapped hbox items) with its
   * first line's baseline at anchorY. */
  #paintHfItems(commands, items, X, anchorY) {
    let y = anchorY;
    let first = true;
    for (const it of items ?? []) {
      if (it.k === 'glue' || it.k === 'kern') {
        y += it.a ?? 0;
      } else if (it.k === 'box') {
        if (!first) y += it.h ?? 0;
        this.#runCommands(commands, it.runs, X, y, '_hf');
        y += it.d ?? 0;
        first = false;
      }
    }
  }
}

// ------------------------------------------------------------------ Peer

class Peer {
  constructor(sock, engine) {
    this.sock = sock;
    this.engine = engine;
    this.role = '?';
    this.pid = 0;
    this.buf = Buffer.alloc(0);
    this.pendingHeader = null; // { kind, id, len }
    sock.on('data', (d) => {
      this.buf = Buffer.concat([this.buf, d]);
      this.#drain();
    });
    sock.on('error', () => {});
  }

  send(line) {
    try { this.sock.write(line); } catch { /* peer gone */ }
  }

  sendRaw(buf) {
    try { this.sock.write(buf); } catch { /* peer gone */ }
  }

  #drain() {
    while (true) {
      if (this.pendingHeader) {
        const { kind, id, len } = this.pendingHeader;
        if (this.buf.length < len) return;
        const payload = this.buf.subarray(0, len).toString('utf8');
        this.buf = this.buf.subarray(len);
        this.pendingHeader = null;
        let json = null;
        try {
          json = JSON.parse(payload);
        } catch (err) {
          this.engine.diagnostics.push(`bad ${kind} payload from pid ${this.pid}: ${err.message}`);
        }
        if (json) this.engine._onMessage(this, { kind, id, json });
        continue;
      }
      const nl = this.buf.indexOf(0x0a);
      if (nl < 0) return;
      const line = this.buf.subarray(0, nl).toString('utf8').trim();
      this.buf = this.buf.subarray(nl + 1);
      if (!line) continue;
      const parts = line.split(/\s+/);
      switch (parts[0]) {
        case 'HELLO':
          this.engine._onMessage(this, {
            kind: 'HELLO',
            role: parts[1],
            idx: Number(parts[2]),
            pid: Number(parts[3]),
          });
          break;
        case 'GEO':
          this.pendingHeader = { kind: 'GEO', id: null, len: Number(parts[1]) };
          break;
        case 'TWIN':
          this.pendingHeader = { kind: 'TWIN', id: null, len: Number(parts[1]) };
          break;
        case 'GALLEY':
          this.pendingHeader = { kind: 'GALLEY', id: parts[1], len: Number(parts[2]) };
          break;
        case 'CKPT':
          this.engine._onMessage(this, { kind: 'CKPT', idx: Number(parts[1]), pid: Number(parts[2]) });
          break;
        case 'DONE':
          this.engine._onMessage(this, { kind: 'DONE', id: parts[1] });
          break;
        case 'FORKED':
          this.engine._onMessage(this, { kind: 'FORKED', id: parts[1], pid: Number(parts[2]) });
          break;
        case 'PONG':
          break;
        default:
          break;
      }
    }
  }
}

// ------------------------------------------------------------- helpers

/**
 * galley items -> the page builder's input stream. The items ARE the real
 * main vertical list (boxes, glue with full specs, penalties, inserts,
 * float anchors, eject markers) — this function only reshapes them into
 * stream entries and attaches drawing/chunk metadata. Entry objects are
 * cached per block (unitsSig), so page identity survives unrelated edits.
 */
function buildStream(block, hasChunk, chunks) {
  const items = block.galley?.items ?? [];
  const floats = block.galley?.floats ?? [];
  const stream = [];
  let li = 0;
  let yOff = 0;

  const makeFloat = (n) => {
    const f = floats.find((x) => x.n === n);
    if (!f) return null;
    const chunkKey = block.id + '#' + f.n;
    const fc = chunks.get(chunkKey);
    const chunkRef =
      f.gfx && fc && fc.forGalley === block.galleyHash ? { key: chunkKey, w: f.w } : null;
    return {
      id: chunkKey,
      n: f.n,
      place: parsePlacement(f.placement),
      type: f.type,
      w: f.w,
      h: f.h ?? 0,
      d: f.d ?? 0,
      gfx: f.gfx,
      blockId: block.id,
      units: miniUnits(f.items, block.id, chunkRef),
    };
  };

  for (const it of items) {
    if (it.k === 'glue') {
      stream.push({ t: 'glue', a: it.a ?? 0, st: it.st ?? 0, sto: it.sto ?? 0, sh: it.sh ?? 0, sho: it.sho ?? 0, sub: it.sub ?? 0 });
      yOff += it.a ?? 0;
    } else if (it.k === 'kern') {
      stream.push({ t: 'kern', a: it.a ?? 0 });
      yOff += it.a ?? 0;
    } else if (it.k === 'pen') {
      stream.push({ t: 'pen', v: it.v ?? 0 });
    } else if (it.k === 'ins') {
      stream.push({
        t: 'ins',
        h: it.h ?? it.hc ?? 0,
        d: it.d ?? 0,
        hc: it.hc ?? it.h ?? 0,
        units: miniUnits(it.items, block.id, null),
      });
    } else if (it.k === 'fm') {
      const f = makeFloat(it.n);
      if (f) stream.push({ t: 'fm', f, vmode: true });
    } else if (it.k === 'eject') {
      stream.push({ t: 'eject', v: it.v ?? -10000 });
    } else if (it.k === 'ev') {
      // page-style event marker: invisible, but its page decides when the
      // event (pagenumbering/style/marks) takes effect. The payload kind
      // rides along so the page builder can act on folio-coupled events
      // (\pagenumbering resets, \cleardoublepage blank pages).
      const ev = block.galley?.events?.[it.n ?? 0];
      stream.push({ t: 'ev', bid: block.id, i: it.n ?? 0, k: ev?.k, a: ev?.a });
    } else if (it.k === 'tl') {
      // tocline marker: page-anchors the contents entry it points at
      stream.push({ t: 'tl', bid: block.id, i: it.n ?? 0 });
    } else if (it.k === 'box') {
      const unit = {
        blockId: block.id,
        li: li++,
        h: it.h ?? 0,
        d: it.d ?? 0,
        ln: {
          descent: it.d ?? 0,
          boxH: it.h ?? 0,
          runs: it.runs ?? [],
          // rescued blocks carry per-item chunk refs (multi-page isolated
          // renders); ordinary gfx blocks map every unit into one chunk
          gfxChunk: it.chunk
            ? { blockId: it.chunk, yOff: it.coff ?? 0, w: chunks.get(it.chunk)?.wBp ?? block.galley.w }
            : block.gfx && hasChunk
              ? { blockId: block.id, yOff, w: block.galley.w }
              : null,
        },
      };
      stream.push({ t: 'box', u: unit });
      yOff += (it.h ?? 0) + (it.d ?? 0);
      if (it.fm) {
        for (const n of it.fm) {
          const f = makeFloat(n);
          if (f) stream.push({ t: 'fm', f, vmode: false });
        }
      }
    }
  }
  // tag the block's first stream node: the page builder records \pagetotal
  // at block entry there (page-context-sensitive rescues need it)
  if (stream[0]) {
    stream[0].first = true;
    stream[0].bid = block.id;
  }
  return stream;
}

/** Convert a captured mini-galley (float body, footnote text) to draw units. */
function miniUnits(items, blockId, chunkRef) {
  const units = [];
  let y = 0;
  for (const it of items ?? []) {
    if (it.k === 'glue' || it.k === 'kern') {
      y += it.a ?? 0;
      continue;
    }
    if (it.k !== 'box') continue;
    units.push({
      blockId,
      h: it.h ?? 0,
      d: it.d ?? 0,
      yRel: y + (it.h ?? 0), // baseline relative to the mini-galley top
      ln: {
        descent: it.d ?? 0,
        boxH: it.h ?? 0,
        runs: it.runs ?? [],
        gfxChunk: chunkRef ? { blockId: chunkRef.key, yOff: y, w: chunkRef.w } : null,
      },
    });
    y += (it.h ?? 0) + (it.d ?? 0);
  }
  return units;
}

/**
 * The \r@<key> macro body for a live label definition. Plain labels carry a
 * bare page number; cleveref's @cref labels carry the bracketed page field
 * its parser expects ([1][1][]1 — pages are substituted by the orchestrator,
 * never read from here). Under hyperref the plain body must be the FIVE
 * group form {label}{page}{name}{anchor}{ext} — hyperref's \@setref and
 * \hyperref parse exactly five and typeset garbage otherwise.
 */
/**
 * True when a block opens with a vertical-mode environment (its content
 * begins in vertical mode, not by continuing a paragraph). Such blocks must
 * not be forced into horizontal mode with \noindent in the isolated rescue.
 */
function startsVertical(text) {
  return /^\s*(\\begin\s*\{|\\(chapter|section|subsection|subsubsection|vspace|vskip|clearpage|newpage|noindent)\b)/.test(text);
}

/**
 * True when a block opens with a construct that emits leading vertical space
 * via LaTeX's \addvspace (sectioning commands, list/box environments, the
 * \…skip family) — i.e. it MERGES (maxes) against \lastskip rather than
 * summing. Only such blocks want the \lastskip primer; a plain paragraph
 * keeps \lastskip and would just accrue the primer as extra height.
 */
function startsAddvspace(text) {
  return /^\s*(\\begin\s*\{|\\(chapter|section|subsection|subsubsection|paragraph|subparagraph)\b|\\(addvspace|vspace|smallskip|medskip|bigskip)\b)/.test(text);
}

function labelDefBody(key, val, hy, href) {
  if (key.endsWith('@cref')) return `{{${val}}{[1][1][]1}}`;
  if (hy) return `{{${val}}{1}{}{${href ?? ''}}{}}`;
  return `{{${val}}{1}}`;
}

/** Extract a balanced {...} group's contents starting at an opening brace. */
/** Kernel \@arabic/\@roman/\@Roman/\@alph/\@Alph transcriptions. */
function formatFolio(n, fmt) {
  if (fmt === 'roman' || fmt === 'Roman') {
    const table = [
      [1000, 'm'], [900, 'cm'], [500, 'd'], [400, 'cd'], [100, 'c'], [90, 'xc'],
      [50, 'l'], [40, 'xl'], [10, 'x'], [9, 'ix'], [5, 'v'], [4, 'iv'], [1, 'i'],
    ];
    let v = n;
    let out = '';
    for (const [val, sym] of table) {
      while (v >= val) {
        out += sym;
        v -= val;
      }
    }
    return fmt === 'Roman' ? out.toUpperCase() : out;
  }
  if (fmt === 'alph') return String.fromCharCode(96 + n);
  if (fmt === 'Alph') return String.fromCharCode(64 + n);
  return String(n);
}

function extractBraced(text, open) {
  if (open < 0 || text[open] !== '{') return '';
  let depth = 1;
  let i = open + 1;
  while (i < text.length && depth > 0) {
    const c = text[i];
    if (c === '{' && text[i - 1] !== '\\') depth++;
    else if (c === '}' && text[i - 1] !== '\\') depth--;
    if (depth === 0) break;
    i++;
  }
  return text.slice(open + 1, i);
}

/**
 * True when the block's galley plausibly already reflects the label's
 * current value (cheap check: the rendered text contains the value and no
 * unresolved ?? marker for it).
 */
function resolvedInGalley(block, key, labelTable) {
  const val = labelTable.get(key);
  if (val === undefined) return false;
  if (block.__galleyText === undefined || block.__galleyTextHash !== block.galleyHash) {
    const parts = [];
    const visit = (items) => {
      for (const it of items ?? []) {
        for (const r of it.runs ?? []) if (r.t) parts.push(r.t);
        if (it.items) visit(it.items);
      }
    };
    visit(block.galley?.items);
    for (const f of block.galley?.floats ?? []) visit(f.items);
    block.__galleyText = parts.join(' ');
    block.__galleyTextHash = block.galleyHash;
  }
  if (block.__galleyText.includes('??') || block.__galleyText.includes('[?]')) return false;
  let needle = String(val);
  if (key.endsWith('@cref')) {
    // @cref values are "[type][i][j]<printed label>" — only the printed
    // label part ever appears in the galley text
    const m = needle.lastIndexOf(']');
    if (m >= 0) needle = needle.slice(m + 1);
  }
  return block.__galleyText.includes(needle);
}

/** Pull the first TeX error lines out of a lualatex log/stdout capture. */
function texErrorFrom(log) {
  const lines = String(log || '').split('\n');
  const idx = lines.findIndex((l) => l.startsWith('! '));
  if (idx < 0) return '';
  return lines.slice(idx, idx + 2).join(' ').trim();
}

function scanCounterDefs(preamble) {
  const out = [];
  const re = /\\newtheorem\*?\{([^}]+)\}|\\newcounter\{([^}]+)\}/g;
  let m;
  while ((m = re.exec(preamble))) out.push(m[1] ?? m[2]);
  return out;
}

function resolveFont(name) {
  try {
    return execFileSync('kpsewhich', [name], { encoding: 'utf8' }).trim();
  } catch {
    return '';
  }
}

/**
 * Normalize a pdftocairo page SVG to the exact box extent (bp): content is
 * anchored at the origin by the driver's \hoffset/\voffset, so setting the
 * viewBox crops precisely regardless of the page size the ship went out at.
 */
function cropSvg(svg, wBp, hBp) {
  return svg.replace(
    /<svg([^>]*?)width="[^"]*" height="[^"]*" viewBox="[^"]*"/,
    `<svg$1width="${wBp}pt" height="${hBp}pt" viewBox="0 0 ${wBp} ${hBp}"`
  );
}

/** cropSvg with an origin offset — for real \@outputpage ships, whose content
 * sits at (oddsidemargin, topmargin+headheight+headsep) under \hoffset=-1in. */
function cropSvgAt(svg, xBp, yBp, wBp, hBp) {
  return svg.replace(
    /<svg([^>]*?)width="[^"]*" height="[^"]*" viewBox="[^"]*"/,
    `<svg$1width="${wBp}pt" height="${hBp}pt" viewBox="${xBp} ${yBp} ${wBp} ${hBp}"`
  );
}

/** Wait until a PDF file exists and ends with %%EOF (flushed completely). */
async function waitForPdf(p, timeoutMs = 5000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try {
      const buf = readFileSync(p);
      if (buf.length > 8 && buf.subarray(-32).toString('latin1').includes('%%EOF')) return;
    } catch {
      /* not there yet */
    }
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error('render child produced no complete PDF');
}

function luaStr(s) {
  return s.replace(/\\/g, '/').replace(/'/g, "\\'");
}

/** Net {…} depth of a block (comments stripped, \{ \} ignored). */
function braceImbalance(text) {
  let d = 0;
  for (const line of text.split('\n')) {
    let s = line;
    const ci = s.search(/(?<!\\)%/);
    if (ci >= 0) s = s.slice(0, ci);
    for (let i = 0; i < s.length; i++) {
      if (s[i] === '\\') { i++; continue; }
      if (s[i] === '{') d++;
      else if (s[i] === '}') d--;
    }
  }
  return d;
}

function push2(list, kind, key, blockId) {
  let entry = list.find((e) => e.kind === kind && e.key === key);
  if (!entry) {
    entry = { kind, key, affected: [] };
    list.push(entry);
  }
  if (!entry.affected.includes('blk-' + blockId)) entry.affected.push('blk-' + blockId);
}

function r2(v) {
  return Math.round(v * 100) / 100;
}

class Timer {
  constructor() {
    this.t0 = performance.now();
    this.last = this.t0;
    this.laps = {};
  }
  lap(name) {
    const now = performance.now();
    this.laps[name + 'Us'] = Math.round((now - this.last) * 1000);
    this.last = now;
  }
  done() {
    this.laps.totalUs = Math.round((performance.now() - this.t0) * 1000);
    return this.laps;
  }
}
