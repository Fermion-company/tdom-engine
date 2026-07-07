// CheckpointEngine — the structured/provisional layer plus its exact anchor.
//
// Two truths, strictly ranked:
//
//   1. CANONICAL (canonical.js): a real, plain lualatex compile of the
//      actual source — the ONLY authority on what the final display looks
//      like. It runs asynchronously off the edit path and the client
//      converges every page to it.
//   2. PROVISIONAL (this file + pagebuilder.js): the resident fork-
//      checkpointed lualatex chain that turns a keystroke into display-list
//      patches in milliseconds. It exists for latency, dependency tracking,
//      the inspector and source mapping — never for final correctness.
//
// A safety gate (safety.js) decides whether a document may use the
// structured layer at all; anything page-mechanism-hostile (shipout hooks,
// twocolumn, marginpar …), any boot/typeset failure, and any verification
// mismatch demotes to the opaque path: the display becomes the canonical
// LuaLaTeX pages themselves, still editable, still incremental at the
// source level. Unknown constructs are not failures — they are opaque
// nodes rendered from LuaLaTeX's own output.
//
// The provisional machinery: a single resident lualatex process tree holds
// the document. Every block
// boundary is a fork()ed checkpoint: a copy-on-write snapshot of the COMPLETE
// TeX state. An edit preserves exact prefix checkpoints, rekeys reusable
// suffix checkpoints as volatile-stale, and runs only a bounded foreground
// verification walk before deferring wider propagation, so the foreground
// cost of a keystroke is:
//
//   fork + typeset the changed block (+bounded verification blocks)
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
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, renameSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { SourceStore } from '../source-store.js';
import { fnv1a } from '../hash.js';
import { segmentBody, documentBounds, diffBlocks } from '../segmenter.js';
import { buildPages, reconcile, parsePlacement } from './pagebuilder.js';
import { mapLegacyFont, remapText } from './mathmap.js';
import { CanonicalRenderer } from './canonical.js';
import { ensureShim } from './forkshim.js';
import { ShippingChain } from './shipping.js';
import { classifyDocument, verifyTokens, tokenContainment } from './safety.js';
import { classifyGalley, demoteFidelity, SAFE_GLYPH } from './fidelity.js';
import { cropSvg, cropSvgAt, r2 } from './util/svg.js';
import {
  luaStr,
  braceImbalance,
  labelDefBody,
  extractBraced,
  startsVertical,
  startsAddvspace,
  scanCounterDefs,
  formatFolio,
  texErrorFrom,
} from './util/tex.js';
import { statSync, watch } from 'node:fs';

const execFileP = promisify(execFile);
const DIR = path.dirname(fileURLToPath(import.meta.url));

const BASE_COUNTERS = [
  'part', 'chapter', 'section', 'subsection', 'subsubsection', 'paragraph',
  'equation', 'figure', 'table', 'footnote',
];
const HEADING_RE = /^\s*\\(chapter|section|subsection|subsubsection|paragraph)\b/;
const JOB_TIMEOUT = Number(process.env.TDOM_JOB_TIMEOUT || 12_000);
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
  /\\begin\{(multicols\*?|paracol|longtable|landscape|mdframed|framed|shaded)\}|\\begin\{tcolorbox\}\[[^\]]*breakable|\\includepdf\b/;

// Margin placement: material lands OUTSIDE the galley box (page margin), so
// no per-block chunk can represent it — the block is typeset in-chain for
// its body text and demoted to CANONICAL_ONLY (#applyFidelity). \todo is
// todonotes (paper-draft review marks — marginpar underneath).
const MARGIN_RE = /\\(?:marginpar|marginnote|todo)\b/;

// Definition-bearing body edits: a macro/environment/length defined (or
// undefined) in a BODY block can change the meaning of every later block in
// ways the exit-state vector cannot see. Such edits forfeit checkpoint-suffix
// preservation and take the conservative path: serial re-typeset of the
// suffix, off the hot path.
const DEF_RE =
  /\\(def|edef|gdef|xdef|newcommand|renewcommand|providecommand|DeclareRobustCommand|DeclareMathOperator|let|futurelet|newenvironment|renewenvironment|newcounter|newtheorem|newlength|newsavebox|setlength|addtolength|makeatletter|catcode|pagestyle)\b/;

/** Stable, lineage-independent identity of one TeX font instance. */
function stableFontKey(meta) {
  return 'F' + fnv1a(`${meta.file || ''}|${meta.name || ''}|${meta.size || 0}`);
}

/** Visit every glyph run in a harvested item tree (boxes, floats, inserts). */
function walkItemRuns(items, fn) {
  if (!items) return;
  for (const it of items) {
    if (it.runs) {
      for (const r of it.runs) fn(r);
    }
    if (it.items) walkItemRuns(it.items, fn);
  }
}

function parseVec(json) {
  try {
    return JSON.parse(json ?? '[]');
  } catch {
    return [];
  }
}

// stateVec layout: [...counters, tdom@pd, tdom@nobreak, tdom@ls]
function vecCountersEqual(aJson, bJson) {
  const a = parseVec(aJson);
  const b = parseVec(bJson);
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length - 3; i++) if (a[i] !== b[i]) return false;
  return true;
}

function vecLocalsEqual(aJson, bJson) {
  const a = parseVec(aJson);
  const b = parseVec(bJson);
  if (a.length !== b.length) return false;
  for (let i = Math.max(0, a.length - 3); i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}
// cheap "will want an exact preview chunk" scan for blocks with no fidelity
// verdict yet (checkpoint render-hold heuristic — a miss only costs the
// slower isolated render path)
const MATHY_RE =
  /\$|\\\[|\\\(|\\begin\{(equation|align|gather|multline|eqnarray|math|displaymath|tikzpicture)/;
// how many off-grid checkpoints may stay alive awaiting their block's chunk
const RENDER_HOLD_MAX = Number(process.env.TDOM_RENDER_HOLD_MAX || 8);

export class CheckpointEngine {
  constructor({ workDir, docDir }) {
    this.workDir = path.resolve(workDir);
    this.docDir = docDir ? path.resolve(docDir) : this.workDir;
    mkdirSync(this.workDir, { recursive: true });
    this.store = new SourceStore();
    this.file = 'main.tex';
    this.blocks = [];
    this.idSeq = 1;
    this.rev = 0; // patch-stream ordering (advances on async repaints too)
    this.srcRev = 0; // SOURCE revisions only — what canonical compiles chase

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
    // incremental label/ref bookkeeping — the hot path must never scan
    // every block × every label (O(L×B) melts on long documents)
    this.blockLabelIdx = new Map(); // blockId -> [label keys its galley defines]
    this.blockRefIdx = new Map(); // blockId -> [label keys its galley references]
    this.labelCount = new Map(); // label key -> number of defining blocks
    this.refIndex = new Map(); // label key -> Set<blockId> of referencing blocks
    this.vanishedLabels = new Set(); // keys whose defining count dropped to 0
    this.fonts = new Map(); // fid -> {file,name,size,fmt, family, remap}
    this.fontFiles = new Map(); // familyKey -> absolute path
    this.pages = [];
    this.chunks = new Map(); // chunkKey -> {svg, wBp, hBp, v} exact renders
    this.isoCache = new Map(); // rescue key -> isolated compile result
    this.isoFailCache = new Map(); // rescue key -> error message (doomed compiles: same inputs fail the same way — don't pay the preamble again on every chain pass over a frozen block)
    this.isoForkBroken = new Set(); // block ids whose iso fork children die (tcolorbox-class fork/dormant incompatibility) — go straight to cold
    this.dyingPids = new Set(); // DIE'd checkpoint pids not yet exited — #reapDying backpressure
    this.poisoned = new Map(); // block.id -> fnv1a(text) that failed in-chain
    this.hf = new Map(); // page number -> {h: items, f: items} TeX-typeset header/footer
    this.hfSig = null; // page-spec signature the current hf map was built for
    this.hfPending = null; // spec signature of an in-flight header job
    this.initialStyle = 'plain'; // \pagestyle in effect at \begin{document}
    this.bgAbort = false;
    this.bgActive = false; // a background pass holds the chain lock right now
    this.bgTask = Promise.resolve();
    this.onAsyncPatches = null; // callback(report-ish) for gfx swaps
    this.onExternalChange = null; // callback when an \input file changes
    this.backendName = 'checkpoint';
    this.diagnostics = [];
    this.tocHash = null;
    this.includes = new Map(); // path -> {mtime, text}
    this.watchers = new Map(); // path -> FSWatcher
    // Resident-fork budget. Every checkpoint is a live lualatex process
    // (~100-300MB unique RSS on package-heavy preambles), so N engines on a
    // big document multiply into real RAM: 64 forks × 2 audit engines ×
    // stress preamble ≈ machine death by OOM kill wave (observed: macOS
    // took down the server AND the editor session). Audit tools run with a
    // reduced budget via this env; sparse grids only cost ~3ms replay per
    // skipped block on resume.
    this.maxCheckpoints = Math.max(4, Number(process.env.TDOM_MAX_CHECKPOINTS || 64));

    // canonical layer: the exact-output authority (see file header)
    this.canonical = new CanonicalRenderer({
      workDir: path.join(this.workDir, 'canonical'),
      docDir: this.docDir,
    });
    this.canonical.onResult = (info) => this.#onCanonicalResult(info);
    this.onCanonical = null; // callback(info) for the server's SSE fanout

    // shipping chain: the INCREMENTAL authority (goal "invisible canonical",
    // phase 1). Feature-flagged while the ja long-document numbers are
    // gathered; the cold canonical stays as the demand-paced final audit.
    this.onShipPage = null; // callback({page, gen, srcRev}) for SSE fanout
    this.shipGenRev = new Map(); // wave generation -> srcRev it converges to
    this.shipBootedFor = null; // preamble hash the chain booted with
    this.shipStale = false; // a label diverged from its seed: cold owns truth
    this.shipBooting = false;
    this.shipBootTimer = null;
    this.shipLabelOverrides = new Map(); // ship-observed truth for reseeding
    this.shipBootTries = 0; // bounded per preamble: a reboot loop burns CPU
    this.shipping = process.env.TDOM_SHIP === '1' ? this.#makeShipping() : null;
    this.mode = 'structured'; // 'structured' | 'opaque'
    this.modeReasons = [];
    this.opaqueStickyPre = null; // preamble hash a dynamic demotion sticks to
    this.verifyState = null; // last exactness-verification outcome

    // stale-first rescue machinery: exact isolated compiles are queued and
    // run OFF the editing hot path; the chain lock serializes everything
    // that touches the resident checkpoint chain (updates, background chain
    // rebuild, async rescue adoption)
    this.chainLock = Promise.resolve();
    this.rescueQueue = new Map(); // block.id -> cacheKey at queue time
    this.rescuePumping = false;
    this.isoChildren = new Set(); // in-flight isolated lualatex processes

    // visual fidelity gate state (fidelity.js): verification demotions are
    // sticky per (block, text) — a region caught diverging never uses the
    // glyph layer again until its source changes
    this.fidelityDemoted = new Map(); // block.id -> {hash, level:'exact'|'canonical'}
    this.demotedFamilies = new Set(); // font family keys the browser failed to load
    this.fidelityEpoch = 0; // bumped when font tiers change (busts unit sigs)
    // high-fidelity chunk queue: latest-wins per block, LIFO across blocks
    // (the block just edited gets its exact pixels first), small
    // concurrency so an edit burst never forks a render storm
    this.renderWant = new Map(); // block.id -> queue marker
    this.renderPumping = 0;
    this.renderTask = Promise.resolve();
    this.renderHold = new Map(); // ckpt idx kept alive for a pending render -> block.id
    // Edit-locus pinning: the checkpoints at (and right after) the block the
    // user is typing in are exempt from grid retirement, so a keystroke burst
    // is always "fork once + typeset one block", never a grid replay.
    this.editHold = []; // boundary indices (most recent loci, capped)
    // Deferred chain work (the ONLY background chain activity): 'rebuild'
    // re-typesets the suffix serially (definition edits, untracked-state
    // leaks). Idle-gated, preemptible, resumable — see #runChainPass.
    this.pendingChain = null; // {kind:'rebuild', from, phase:'blocks'|'after', labels:Set}
  }

  /** Serialize access to the resident chain (jobBlock/currentJob users). */
  #locked(fn) {
    const run = this.chainLock.then(fn);
    this.chainLock = run.then(
      () => {},
      () => {}
    );
    return run;
  }

  // ------------------------------------------------------------ lifecycle

  async open(text, file = 'main.tex') {
    this.file = file;
    this.store.open(file, text);
    this.blocks = [];
    this.labelTable = new Map();
    this.hrefTable = new Map();
    this.blockLabelIdx = new Map();
    this.blockRefIdx = new Map();
    this.labelCount = new Map();
    this.refIndex = new Map();
    this.vanishedLabels = new Set();
    this._pageRun = null;
    this.pages = [];
    // a fresh document gets a fresh chance at the structured layer
    this.mode = 'structured';
    this.modeReasons = [];
    this.opaqueStickyPre = null;
    this.verifyState = null;
    this.pendingChain = null;
    this.editHold = [];
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
    this.closed = true;
    this.bgAbort = true;
    this.canonical.dispose();
    clearTimeout(this.shipBootTimer);
    if (this.shipping) await this.shipping.close().catch(() => {});
    this.rescueQueue.clear();
    for (const child of this.isoChildren) {
      try { child.kill('SIGKILL'); } catch { /* gone */ }
    }
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
      mode: this.mode,
      modeReasons: this.modeReasons,
      canonical: this.canonical.info(),
      pageCount: this.pages.length,
      checkpoints: [...this.checkpoints.keys()].sort((a, b) => a - b),
      blocks: this.blocks.map((b, i) => {
        const chunkKeys = this.#chunkTargets(b).map((t) => t.key);
        return {
          id: b.id,
          index: i,
          type: b.kind ?? 'block',
          gfx: chunkKeys.length > 0,
          gfxChunks: chunkKeys,
          fidelity: b.fidelity?.level ?? null,
          exactLines: b.fidelity?.exactLines ?? 0,
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
    // The canonical layer IS the honest full path (plain lualatex to its
    // aux fixpoint); when its last compile already matches the current
    // source this returns the exact bytes the preview converged to.
    // NB: srcRev, not rev — canonical revisions live on the source axis
    // (async repaints advance this.rev without changing the source)
    const res = await this.canonical.ensure(this.getSource(), this.srcRev);
    return readFileSync(res.pdf);
  }

  // ---------------------------------------------------------- root/daemon

  async #ensureShim() {
    await ensureShim(this.workDir);
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
      if (peer.pid) this.dyingPids?.delete(peer.pid);
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
        // render children announce the same way — remember the pid so a
        // timed-out render (deep-lineage luahbtex spin) can be SIGKILLed
        // instead of burning a core forever
        if (this.renderPids?.has(msg.id)) this.renderPids.set(msg.id, msg.pid);
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

    // The aux family is a BYPRODUCT of the previous process tree, not state:
    // everything persistent lives in the orchestrator (labelTable, hrefTable,
    // #computeToc regenerates driver.toc after the first pagination). A tree
    // that died mid-write (SIGKILL, crash, power) leaves truncated/NUL-ridden
    // files behind, and \begin{document} reading them kills the boot ("Text
    // line contains an invalid character") — demoting a perfectly good
    // document to opaque. Boot from a clean slate, always.
    for (const ext of ['aux', 'toc', 'lof', 'lot', 'loa', 'lol', 'idx', 'out', 'nav', 'snm', 'vrb']) {
      rmSync(path.join(this.workDir, `driver.${ext}`), { force: true });
    }
    rmSync(path.join(this.workDir, 'driver.pdf'), { force: true });
    const ckptReady = this.#await('ckpt:0', BOOT_TIMEOUT);
    const geoReady = this.#await('geo', BOOT_TIMEOUT);
    this.root = spawn(
      'lualatex',
      ['--shell-escape', '-interaction=nonstopmode', 'driver.tex'],
      {
        cwd: this.workDir,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: {
          ...process.env,
          TEXINPUTS: `${this.docDir}:${process.env.TEXINPUTS || ''}`,
          LUAINPUTS: `${this.docDir}:${process.env.LUAINPUTS || ''}`,
        },
      }
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
    // \enlargethispage: record a stream marker for the JS page builder
    // (the dormant page ignores the real effect); the original still runs.
    L.push('\\let\\TDOMenlarge\\enlargethispage');
    L.push('\\renewcommand\\enlargethispage{\\@ifstar\\TDOMenlargeS\\TDOMenlargeN}');
    L.push(
      '\\newcommand\\TDOMenlargeS[1]{\\TDOMenlarge*{#1}' +
        '\\begingroup\\dimen@=\\dimexpr#1\\relax\\directlua{tdom_enlarge(\\number\\dimen@,1)}\\endgroup}'
    );
    L.push(
      '\\newcommand\\TDOMenlargeN[1]{\\TDOMenlarge{#1}' +
        '\\begingroup\\dimen@=\\dimexpr#1\\relax\\directlua{tdom_enlarge(\\number\\dimen@,0)}\\endgroup}'
    );
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
    // the REAL LaTeX output routine, saved before the dormant absorb takes
    // over: iso fork children restore it for splitting environments
    // (mdframed / breakable tcolorbox / longtable / multicols only break
    // pages inside \output — see #isoCompile splitMode)
    L.push('\\newtoks\\TDOMrealoutput');
    L.push('\\TDOMrealoutput=\\output');
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
    await this.#reapDying(); // bound the live-fork set before minting ckpt idx+1
    let body;
    let jobId;
    let refSnapshot = null;
    if (override) {
      // raw job (rescue continuation): caller supplies the exact body
      body = Buffer.from(override.body, 'utf8');
      jobId = override.id;
    } else {
      // Labels are defined in descendant lineages only; when resuming from an
      // ancestor snapshot, forward-referenced values must be injected so this
      // block sees the document-wide truth. A freshly EDITED block has no
      // galley yet (diffBlocks re-minted it), so its refs must come from the
      // new text itself — otherwise editing any \ref-bearing paragraph froze
      // its references at '??' until some label happened to move (found by
      // the Phase-0 fuzzer, corpus/06 seed 7).
      const refKeys = new Set(block.galley?.refs ?? []);
      const REF_USE_RE = /\\(?:ref|eqref|pageref|vref|vpageref|autoref|nameref|cref|Cref)\*?\s*\{([^}]+)\}/g;
      for (const m of block.text.matchAll(REF_USE_RE)) {
        for (const k of m[1].split(',')) refKeys.add(k.trim());
      }
      const CITE_USE_RE = /\\[cC]ite[a-zA-Z]*\*?\s*(?:\[[^\]]*\]\s*)*\{([^}]+)\}/g;
      for (const m of block.text.matchAll(CITE_USE_RE)) {
        for (const k of m[1].split(',')) refKeys.add('cite:' + k.trim());
      }
      // record the exact values injected below: resolvedInGalley compares
      // them against the live table instead of guessing from rendered text
      refSnapshot = {};
      for (const key of refKeys) refSnapshot[key] = this.labelTable.get(key);
      const defs = [];
      for (const key of refKeys) {
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
      const volatilePre = ck.vstale && idx > 0 ? this.#volatilePrelude(idx) : '';
      const prelude =
        volatilePre + (defs.length ? `\\makeatletter ${defs.join(' ')}\\makeatother\n` : '') + primer;
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
      if (refSnapshot) galley.tdomRefVals = refSnapshot;
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
    const TRACE = process.env.TDOM_TRACE_JOB
      ? (label, t0) => console.error(`[job] ${block.id} ${label} ${(performance.now() - t0).toFixed(0)}ms`)
      : null;
    const T0 = performance.now();
    // Block-granular last resort: a block that fails BOTH the chain and the
    // isolated rescue (mid-typing broken TeX — an unfinished \frac, a bare
    // trailing backslash …) must never take the whole document down. It
    // freezes at its last good galley (or renders empty when it never had
    // one), the chain continues with a consistent state, and the block
    // heals automatically on the next edit that changes its text. The
    // canonical layer keeps showing LuaLaTeX's own error-recovery output.
    const rescueSafely = async (why) => {
      try {
        return await this.#rescueBlock(idx, why);
      } catch (err) {
        if (this.bgAbort) throw err; // an edit is waiting — no freeze jobs now
        this.diagnostics.push(`${block.id}: rescue failed (${err.message}) — freezing the block`);
        return this.#brokenBlockGalley(idx);
      }
    };
    if (this.bgAbort) throw new Error('background pass aborted (edit waiting)');
    if (this.#needsRescue(block.text)) {
      const g = await rescueSafely('output-routine environment needs a real page');
      TRACE?.('rescue(env)', T0);
      return g;
    }
    if (this.poisoned.get(block.id) === sig) {
      return rescueSafely('previous in-chain failure');
    }
    // Established deep-lineage wall: don't even attempt the doomed in-chain
    // job (each attempt hangs to the timeout). A probe block every 25
    // still tries, so the chain recovers automatically if the wall lifts.
    if ((this.chainTimeouts ?? 0) >= 3 && !block.galley && idx % 25 !== 0) {
      this.poisoned.set(block.id, sig);
      this.rescueQueue.set(block.id, this.#rescueCacheKey(block, idx));
      this.#pumpRescues();
      return this.#brokenBlockGalley(idx);
    }
    try {
      const galley = await this.#jobBlock(idx);
      this.chainTimeouts = 0;
      TRACE?.('in-chain', T0);
      return galley;
    } catch (err) {
      // an edit is waiting on this background pass: fail the block WITHOUT
      // poisoning it (its job may have been killed mid-flight, not broken)
      // and without paying for rescue/state follow-up jobs — the next
      // rebuild retries from scratch
      if (this.bgAbort) throw err;
      this.poisoned.set(block.id, sig);
      const isTimeout = /timeout/.test(err.message);
      this.chainTimeouts = isTimeout ? (this.chainTimeouts ?? 0) + 1 : 0;
      this.diagnostics.push(
        `${block.id}: in-chain typeset failed (${err.message}) — isolated exact-render rescue`
      );
      // Deep-lineage wall (long luatexja documents): past ~25 pages of
      // cumulative CJK content in one fork lineage, every in-chain job
      // spins in luahbtex until the timeout. Once that pattern is
      // established, stop paying a timeout plus a synchronous isolated
      // compile PER BLOCK: freeze the block empty, queue its exact rescue
      // on the async pump (fresh processes typeset it at normal speed off
      // the hot path) and let the canonical layer own the pixels until the
      // provisional tail self-repairs in the background.
      if (isTimeout && this.chainTimeouts >= 3 && !block.galley) {
        this.diagnostics.push(
          `${block.id}: consecutive in-chain timeouts — deferring the tail to the async rescue pump`
        );
        this.rescueQueue.set(block.id, this.#rescueCacheKey(block, idx));
        this.#pumpRescues();
        return this.#brokenBlockGalley(idx);
      }
      return rescueSafely(err.message);
    }
  }

  /** Freeze a doubly-failed block: last good galley when one exists, an
   * empty galley carrying the previous block's exit state otherwise.
   *
   * Determinism scope (docs/10): a frozen block's exit state is HISTORY-
   * DEPENDENT by design — the pixel freeze keeps the pre-breakage exit so
   * downstream numbering stays stable (no churn while the user is mid-edit),
   * while a fresh boot on the same broken source has no history and passes
   * the entry state through. Real LuaLaTeX produces NO output for such a
   * source (emergency stop), so there is no ground truth to converge on;
   * the incremental==scratch equation only applies to compilable sources.
   * tdomFrozen marks both shapes so referees (fuzz) can scope the equation. */
  async #brokenBlockGalley(idx, frozen = true) {
    const block = this.blocks[idx];
    if (block.galley?.state) {
      await this.#jobBlock(idx, {
        id: block.id + '@state',
        body: this.#stateJobBody({ state: block.galley.state, labels: block.galley.labels ?? [] }),
      });
      return { ...block.galley, tdomStale: true, tdomFrozen: true };
    }
    const prevVec = idx > 0 ? JSON.parse(this.blocks[idx - 1].stateVec ?? '[]') : [];
    const state = {};
    this.counters.forEach((c, i) => {
      state[c] = prevVec[i] ?? 0;
    });
    state['tdom@pd'] = prevVec.length >= 3 ? prevVec[prevVec.length - 3] : -65536000;
    state['tdom@nobreak'] = prevVec.length >= 2 ? prevVec[prevVec.length - 2] : 0;
    state['tdom@ls'] = prevVec.length >= 1 ? prevVec[prevVec.length - 1] : 0;
    await this.#jobBlock(idx, {
      id: block.id + '@state',
      body: this.#stateJobBody({ state, labels: [] }),
    });
    // frozen=false: a PENDING placeholder (first-ever rescue queued on the
    // pump), not a freeze — frozenBlockIds derives real freezes from
    // isoFailCache if that compile then fails
    const g = { items: [], floats: [], w: 0, h: 0, d: 0, state, labels: [], toclines: [], refs: block.galley?.refs ?? [], fonts: {} };
    if (frozen) g.tdomFrozen = true;
    return g;
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
  /**
   * The rescue cache key carries every input the isolated compile depends
   * on: the block text, the previous block's exit state, the preamble, the
   * CURRENT values of every label the block referenced in its last compile
   * (when a referenced label moves, the key misses and the block re-rescues
   * with fresh seeds), and the block's on-page start offset (splitting
   * environments — mdframed, breakable tcolorbox — break by page position).
   */
  #rescueCacheKey(block, idx) {
    const refVals = (block.galley?.refs ?? []).map(
      (k) => k + '=' + (this.labelTable.get(k) ?? '')
    );
    // same 0.25bp quantum as the iso strut — see #isoCompile
    const pageOff = Math.round((block.pageOffset ?? 0) * 4) / 4;
    return fnv1a(
      JSON.stringify([block.text, this.blocks[idx - 1]?.stateVec ?? '', this.preHash, refVals, pageOff])
    );
  }

  /**
   * Blocks whose display cannot currently be exact-verified: hard freezes
   * (#brokenBlockGalley marked the galley) plus blocks whose last exact
   * compile failed FOR THEIR CURRENT INPUTS (isoFailCache hit on the live
   * rescue key). Derived, not sticky — a block that froze because a
   * transient input (mid-breakage page offset, a moved label) poisoned its
   * compile un-freezes by itself when the input reverts, because the key
   * reverts with it. Referees (tools/fuzz.mjs) use this to scope the
   * incremental==scratch equation to compilable states.
   */
  frozenBlockIds() {
    return this.frozenBlocks().map((f) => f.id);
  }

  /** Frozen blocks with their reasons — referees distinguish broken-TeX
   * freezes (no ground truth, equation must be skipped) from the known
   * structural discard class (splitting env needing the real output
   * routine; deterministic on both engines, so the equation still holds
   * and the comparison itself referees them). */
  frozenBlocks() {
    const out = [];
    for (let i = 0; i < this.blocks.length; i++) {
      const b = this.blocks[i];
      const failMsg = this.isoFailCache.get(this.#rescueCacheKey(b, i));
      if (b.galley?.tdomFrozen || failMsg) {
        out.push({ id: b.id, text: b.text, reason: failMsg ?? 'hard-frozen galley' });
      }
    }
    return out;
  }

  /** LRU-bounded iso result cache: each entry carries the block's chunk
   * SVGs (MBs on package-heavy docs), so an unbounded map grows into the
   * gigabytes across offset-keyed re-rescues — enough to OOM a 7GB CI
   * runner during a boot drain. Evictions only cost a re-fork (~2-5s). */
  #isoCacheGet(key) {
    const hit = this.isoCache.get(key);
    if (hit !== undefined) {
      this.isoCache.delete(key);
      this.isoCache.set(key, hit); // refresh recency
    }
    return hit;
  }

  #isoCacheSet(key, iso) {
    this.isoCache.set(key, iso);
    const cap = Math.max(8, Number(process.env.TDOM_ISO_CACHE || 48));
    while (this.isoCache.size > cap) {
      this.isoCache.delete(this.isoCache.keys().next().value);
    }
  }

  async #rescueBlock(idx, why) {
    const block = this.blocks[idx];
    const cacheKey = this.#rescueCacheKey(block, idx);
    let iso = this.#isoCacheGet(cacheKey);
    if (!iso) {
      if (block.galley?.state) {
        // STALE-FIRST: an isolated compile takes seconds and must never sit
        // on the editing hot path. Keep the previous galley on screen (the
        // provisional layer is allowed to be temporarily stale — canonical
        // guarantees the final pixels), seed the continuation checkpoint
        // from the stale exit state so the chain stays consistent, and let
        // the exact compile land asynchronously.
        await this.#jobBlock(idx, {
          id: block.id + '@state',
          body: this.#stateJobBody({ state: block.galley.state, labels: block.galley.labels ?? [] }),
        });
        this.rescueQueue.set(block.id, cacheKey);
        this.#pumpRescues();
        return { ...block.galley, tdomStale: true };
      }
      // first-ever rescue (nothing older to display): do NOT pay the
      // compile on the walk — hold an empty placeholder with
      // entry-passthrough state and land the exact galley through the
      // async pump, exactly like a stale-first landing. Fork isos arrive
      // in ~1-3s; the walk stays bounded, and a BOOT walk in particular
      // (which used to serialize EVERY rescue compile before first paint)
      // reaches the first page minutes earlier.
      this.rescueQueue.set(block.id, cacheKey);
      this.#pumpRescues();
      return this.#brokenBlockGalley(idx, false);
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
      tdomRefVals: iso.refVals ?? {},
      tdomPageOff: iso.compiledOff ?? 0,
      tdomIsoChunks: iso.chunks,
    };
  }

  /**
   * Volatile-state normalization for jobs forked from a vstale checkpoint
   * (a lineage that predates an upstream edit): re-seed counters,
   * \prevdepth and \if@nobreak from the orchestrator's authoritative exit
   * vector of the previous block. Identical machinery to the rescue
   * continuations (#stateJobBody); \lastskip is covered by the primer,
   * labels by the per-job defs. Natural fresh lineages never pass through
   * here — the hot path stays byte-identical to a continuous run.
   */
  #volatilePrelude(idx) {
    const prevVec = parseVec(this.blocks[idx - 1]?.stateVec);
    if (!prevVec.length) return '';
    const state = {};
    this.counters.forEach((c, i) => {
      state[c] = prevVec[i] ?? 0;
    });
    state['tdom@pd'] = prevVec[prevVec.length - 3] ?? -65536000;
    state['tdom@nobreak'] = prevVec[prevVec.length - 2] ?? 0;
    return this.#stateJobBody({ state, labels: [] }) + '\n';
  }

  #stateJobBody(iso) {
    const L = ['\\makeatletter'];
    for (const name of this.counters) {
      const v = iso.state[name];
      if (v !== undefined) L.push(`\\ifcsname c@${name}\\endcsname\\setcounter{${name}}{${v}}\\fi`);
    }
    for (const l of iso.labels ?? []) {
      // stale-first passes real galley labels through here, which can
      // include \bibitem captures (cite: keys) — those live under b@
      if (l.k.startsWith('cite:')) {
        L.push(`\\global\\@namedef{b@${l.k.slice(5)}}{${l.v}}`);
      } else {
        L.push(`\\global\\@namedef{r@${l.k}}${labelDefBody(l.k, l.v, this.geometry?.hyperref === 1, l.h)}`);
      }
    }
    L.push(iso.state['tdom@nobreak'] === 1 ? '\\global\\@nobreaktrue' : '\\global\\@nobreakfalse');
    L.push('\\makeatother');
    L.push(`\\directlua{tex.nest[0].prevdepth=${Math.round(iso.state['tdom@pd'] ?? -65536000)}}`);
    return L.join('\n');
  }

  async #isoCompile(block, idx, why, forceCold = false) {
    // doomed-compile memo: the rescue key carries every input the compile
    // depends on, so a failure repeats deterministically — rethrow instead
    // of paying the full preamble load per chain pass over a broken block
    const negKey = this.#rescueCacheKey(block, idx);
    const neg = this.isoFailCache.get(negKey);
    if (neg) throw new Error(neg);
    // Fork mode: rescue in a child forked from the pristine post-preamble
    // checkpoint (ckpt:0) — the preamble (the 10-15s / 300-500MB part of a
    // cold iso on package-heavy documents) is already loaded and COW-shared.
    // Cold mode remains the fallback when no resident root exists (opaque
    // mode, boot failure) or infra fails before the fork happens.
    // \includepdf keeps the REAL output routine (page-emitting) — that
    // cannot run in a fork child yet (inherited dormant page state breaks
    // it under luatexja), so it always compiles cold. Everything else
    // forks with the iso absorb; a fork run that DISCARDS (a split was
    // actually needed at this offset) retries cold with the real routine.
    const ck0 =
      !forceCold &&
      !process.env.TDOM_ISO_COLD &&
      !this.isoForkBroken.has(block.id) &&
      !/\\includepdf\b/.test(block.text)
        ? this.checkpoints.get(0)
        : null;
    // label values as injected into THIS run — recorded on the result so
    // resolvedInGalley can compare exactly (see #jobBlock's refSnapshot)
    const labelSnap = new Map(this.labelTable);
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
    const jobdir = path.join(this.workDir, `rescue-${block.id}-${fnv1a(block.text)}`);
    // absolute path injected into inline Lua (fork mode): single-quoted, so
    // escape the characters that would break the literal
    const jobdirForBody = jobdir.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
    const L = [];
    if (!ck0) {
      L.push(text.slice(bounds.preamble.start, bounds.preamble.end).trimEnd());
      L.push('\\begin{document}');
    } else {
      // the fork inherits the root's DORMANT regime (ckpt:0 is frozen right
      // after the dormant setup — \pagegoal=\maxdimen, seed material on the
      // page). Reset to the REAL height with TeX's own machinery: fire ONE
      // discarding output routine so the page truly EMPTIES (page_contents
      // flag included — unreachable from Lua), then the next contribution
      // re-derives \pagegoal from the restored \vsize. Without this, a
      // real-output child never fills a page and dies on "Output routine
      // didn't use all of \box255".
      L.push(`\\vsize=${Math.max(1, this.geometry?.textheight ?? 550).toFixed(4)}bp`);
    }
    L.push('\\makeatletter\\pagestyle{empty}\\hoffset=-1in\\voffset=-1in');
    if (ck0) {
      L.push('\\output={\\global\\setbox\\voidb@x\\box255}');
      L.push('\\hbox to0pt{}\\penalty-10000');
      // re-assert the job cwd right before the ship: package code in the
      // block body can wander the process cwd, and the PDF output file
      // opens wherever the FIRST \shipout finds it (observed: child PDFs
      // landing in the root's workDir instead of the jobdir)
      L.push(
        `\\AddToHook{shipout/before}{\\directlua{pcall(function() lfs.chdir('${jobdirForBody}') end)}}`
      );
    }
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
    // save-macro names must NOT collide with the resident daemon's own
    // shims (\TDOMlabel & co, boot driver): a fork-mode iso inherits those
    // wrappers, and \let\TDOMlabel\label would overwrite the root's saved
    // original with the wrapper itself — infinite recursion on first \label
    L.push('\\let\\TDOMisolabel\\label');
    L.push(
      "\\renewcommand\\label[1]{\\TDOMisolabel{#1}\\directlua{tdom_iso_label('\\luaescapestring{#1}','\\luaescapestring{\\@currentlabel}'," + isoHref + ')}' +
        isoCrefCapture + '}'
    );
    L.push('\\ifdefined\\ltx@label\\let\\TDOMisoltxlabel\\ltx@label');
    L.push(
      "\\def\\ltx@label#1{\\TDOMisoltxlabel{#1}\\directlua{tdom_iso_label('\\luaescapestring{#1}','\\luaescapestring{\\@currentlabel}'," + isoHref + ')}' +
        isoCrefCapture + '}\\fi'
    );
    // ref-use recording: a rescued block that references a label must be
    // re-rescued when that label's value changes (the cache key carries the
    // referenced values — see #rescueBlock)
    L.push('\\let\\TDOMisoref\\ref');
    L.push("\\renewcommand\\ref[1]{\\directlua{tdom_iso_ref('\\luaescapestring{#1}')}\\TDOMisoref{#1}}");
    L.push('\\let\\TDOMisopageref\\pageref');
    L.push("\\renewcommand\\pageref[1]{\\directlua{tdom_iso_ref('\\luaescapestring{#1}')}\\TDOMisopageref{#1}}");
    L.push('\\ifdefined\\eqref\\let\\TDOMisoeqref\\eqref');
    L.push("\\renewcommand\\eqref[1]{\\directlua{tdom_iso_ref('\\luaescapestring{#1}')}\\TDOMisoeqref{#1}}\\fi");
    L.push('\\ifdefined\\cref\\let\\TDOMisocref\\cref');
    L.push("\\renewcommand\\cref[1]{\\directlua{tdom_iso_ref_cref('\\luaescapestring{#1}')}\\TDOMisocref{#1}}\\fi");
    L.push('\\ifdefined\\Cref\\let\\TDOMisoCref\\Cref');
    L.push("\\renewcommand\\Cref[1]{\\directlua{tdom_iso_ref_cref('\\luaescapestring{#1}')}\\TDOMisoCref{#1}}\\fi");
    // toc/lof/lot entries born inside the rescued block (longtable captions,
    // sectioning inside output-hijack envs …) — captured exactly like the
    // resident driver captures them, or the contents pages miss the entry
    L.push('\\let\\TDOMisoacl\\addcontentsline');
    L.push(
      '\\renewcommand\\addcontentsline[3]{' +
        '\\directlua{tdom_iso_in_acl=true}\\TDOMisoacl{#1}{#2}{#3}\\directlua{tdom_iso_in_acl=false}' +
        '{\\let\\label\\@gobble\\let\\index\\@gobble\\let\\glossary\\@gobble' +
        '\\protected@edef\\TDOM@tocentry{#3}' +
        "\\directlua{tdom_iso_tocline('\\luaescapestring{#1}','\\luaescapestring{#2}'," +
        "'\\luaescapestring{\\detokenize\\expandafter{\\TDOM@tocentry}}')}}}"
    );
    L.push('\\let\\TDOMisoatc\\addtocontents');
    L.push(
      '\\renewcommand\\addtocontents[2]{\\TDOMisoatc{#1}{#2}' +
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
        // runaway page builder (splitting env making no progress — usually a
        // bogus page context): material is DISCARDED, so the harvest must
        // not be trusted — count it and let the node side fail the compile
        'if tdom_iso.fires > 50 then tdom_iso.discarded = (tdom_iso.discarded or 0) + 1 tex.box[255] = nil return end ' +
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
    // Page-EMITTING blocks (\includepdf: whole foreign pages) keep the REAL
    // output routine so every page ships and becomes a per-page chunk. The
    // dormant absorb would hand their zero-dimension page paintings back to
    // the galley as invisible material (pdfpages draws via a 0pt picture
    // box). Galley-material blocks keep the absorb as before.
    //
    // SPLITTING environments (mdframed / framed / breakable tcolorbox) also
    // keep the real routine: their page-splitting machinery only runs
    // inside \output, so under the dormant absorb a box that must break
    // simply never makes progress (runaway → discard → failed compile).
    // With the real routine the box splits exactly as in print: full pages
    // ship as per-page chunks (page 1 cropped below the entry strut), and
    // the final partial page stays on the galley for the normal remainder
    // harvest. A box that FITS never fires the routine, so its galley is
    // byte-identical to the absorb path.
    this.#needsRescue(block.text); // populate _breakableRe for this preamble
    const splitMode =
      !/\\includepdf\b/.test(block.text) &&
      (/\\begin\{(mdframed|framed|shaded|longtable|multicols\*?)\}|\\begin\{tcolorbox\}\[[^\]]*breakable/.test(
        block.text
      ) ||
        (this._breakableRe?.test(block.text) ?? false));
    // fork children always run the iso absorb: the real routine cannot run
    // against the inherited dormant page state yet (box255/unbox cascades
    // under luatexja). A fork run whose absorb DISCARDS (the env truly had
    // to split at this offset) is retried cold below, where the real
    // routine splits exactly as in print.
    const realOutput = !ck0 && (/\\includepdf\b/.test(block.text) || splitMode);
    if (!realOutput) L.push('\\output={\\directlua{tdom_iso_absorb()}}');
    // material taller than the page inside an output-hijack env (multicols'
    // own routine) ships REAL pages — count them so the harvest knows the
    // pre-body machinery (and the isostart marker) left with page 1
    L.push('\\AddToHook{shipout/before}{\\directlua{tdom_iso.ships = tdom_iso.ships + 1}}');
    L.push('\\hbox to0pt{}');
    // page-context strut: reproduce the block's true on-page start position
    // so splitting environments (mdframed & co.) measure the same
    // \pagegoal-\pagetotal as in print. The iso page's own \topskip already
    // contributed, so the strut is the entry \pagetotal minus that.
    // 0.25bp quantum (≈0.09mm — invisible): keys, struts and the
    // moved-offset comparison all use the same grid, so float-noise drifts
    // can never force a recompile, and both engines compile identical
    // galleys for offsets inside one quantum (condition D stays exact)
    const entryOff = Math.round((block.pageOffset ?? 0) * 4) / 4;
    const topskipW =
      typeof this.geometry?.topskip === 'object'
        ? this.geometry.topskip.w ?? 0
        : this.geometry?.topskip ?? 0;
    // clamp inside the page: an offset captured mid-breakage can exceed
    // \textheight, which would start the box below the page and spin the
    // dormant absorb (runaway → discard → failed compile)
    const maxStrut = Math.max(0, (this.geometry?.textheight ?? Infinity) - 1);
    const strut = Math.min(Math.max(0, entryOff - topskipW), maxStrut);
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
        '\',"discarded":\' .. (tdom_iso.discarded or 0) .. ' +
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
    mkdirSync(jobdir, { recursive: true });
    const pdf = path.join(jobdir, ck0 ? 'driver.pdf' : 'iso.pdf');
    const statePath = path.join(jobdir, 'state.json');
    rmSync(pdf, { force: true });
    rmSync(statePath, { force: true });
    writeFileSync(path.join(jobdir, 'iso.tex'), L.join('\n') + '\n');
    if (ck0) {
      // fork path: the ISO child chdir's to the jobdir, its lazily-opened
      // PDF (\jobname = driver) and state.json land there, and DONE fires
      // from finish_pdffile like the RENDER protocol
      const isoId = `iso@${fnv1a(jobdir + ':' + Date.now())}`;
      const body = Buffer.from(L.join('\n') + '\n', 'utf8');
      this.renderPids ??= new Map();
      this.renderPids.set(isoId, 0); // armed: FORKED fills the pid
      const done = this.#await('render:' + isoId, Number(process.env.TDOM_ISO_TIMEOUT || 120_000));
      // fail fast when the child dies without finishing (broken TeX
      // emergency-stops in the fork exactly like cold lualatex would):
      // poll the forked pid instead of running out the long timeout
      const poll = setInterval(() => {
        const pid = this.renderPids.get(isoId);
        if (pid) {
          try {
            process.kill(pid, 0);
          } catch {
            this._reject('render:' + isoId, new Error(`iso child exited for ${block.id}`));
          }
        }
      }, 200);
      let forked = false;
      try {
        ck0.send(`ISO ${isoId} ${jobdir} ${body.length}\n`);
        ck0.sendRaw(body);
        await done;
        if (!existsSync(pdf)) {
          // belt-and-braces: if the child's PDF still opened against the
          // root's workDir (cwd wandered before the re-chdir hook landed),
          // claim it — the pump is serial and nothing else ships there
          // (canonical is sandboxed in workDir/canonical)
          const stray = path.join(this.workDir, 'driver.pdf');
          await waitForPdf(stray).catch(() => {});
          if (existsSync(stray)) {
            try { renameSync(stray, pdf); } catch { /* raced away */ }
          }
        }
        await waitForPdf(pdf).catch(() => {});
        forked = true;
      } catch {
        // a child that actually forked and failed IS the verdict — the
        // missing-artifact check below classifies it exactly like a cold
        // failure. Only an infra miss (peer gone before FORKED) retries
        // cold with a full standalone compile.
        forked = (this.renderPids.get(isoId) ?? 0) !== 0;
        const pid = this.renderPids.get(isoId);
        if (pid) {
          try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
        }
      } finally {
        clearInterval(poll);
        this.renderPids.delete(isoId);
      }
      if (!forked) return this.#isoCompile(block, idx, why, true);
    } else {
      // cold path: no resident root — pay the full standalone compile.
      // Tracked so teardown/close can reap in-flight isolated compiles;
      // edits do NOT kill these — with stale-first rescues they already run
      // off the hot path, and a finished compile is a cache entry worth
      // keeping. nice(1): isolated compiles must lose CPU contests against
      // the resident fork jobs that answer keystrokes
      const run = execFileP('nice', ['-n', '15', 'lualatex', '-interaction=nonstopmode', 'iso.tex'], {
        cwd: jobdir,
        timeout: 120_000,
        // doc-relative assets (\includegraphics, \includepdf …) resolve the
        // same way the canonical compile resolves them
        env: {
          ...process.env,
          TEXINPUTS: `${this.docDir}:${process.env.TEXINPUTS || ''}`,
          LUAINPUTS: `${this.docDir}:${process.env.LUAINPUTS || ''}`,
        },
      });
      this.isoChildren.add(run.child);
      await run.catch(() => {});
      this.isoChildren.delete(run.child);
    }
    if (ck0 && (!existsSync(pdf) || !existsSync(statePath))) {
      // the FORK died without producing the artifacts. Some environments
      // (tcolorbox-class) are incompatible with the fork's inherited
      // dormant state in ways a cold compile is not — remember that for
      // this block and retry cold, whose verdict is final.
      this.isoForkBroken.add(block.id);
      return this.#isoCompile(block, idx, why, true);
    }
    if (!existsSync(pdf) || !existsSync(statePath)) {
      const msg = `isolated rescue failed for ${block.id} (${why})`;
      if (this.isoFailCache.size > 200) this.isoFailCache.clear();
      this.isoFailCache.set(negKey, msg);
      throw new Error(msg);
    }
    const st = JSON.parse(readFileSync(statePath, 'utf8'));
    if ((st.discarded ?? 0) > 0) {
      // the dormant absorb hit its runaway cap and THREW MATERIAL AWAY —
      // the galley would be silently empty/partial (found via stress
      // seed-21 burst 2: boxedtheorem/mdframed blocks stranded empty after
      // a broken window). In FORK mode this is the expected signal that
      // the env truly has to SPLIT at this offset: retry cold, where the
      // real output routine splits exactly as in print. In cold mode it is
      // final — fail; stale-first keeps the last good pixels, and once the
      // inputs return to sane values the rescue key changes back and the
      // cached good result re-adopts.
      if (!process.env.TDOM_ISO_KEEP) rmSync(jobdir, { recursive: true, force: true });
      if (ck0) return this.#isoCompile(block, idx, why, true);
      const msg = `isolated rescue discarded runaway material for ${block.id} (${why})`;
      if (this.isoFailCache.size > 200) this.isoFailCache.clear();
      this.isoFailCache.set(negKey, msg);
      throw new Error(msg);
    }
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
      const svg = readFileSync(svgPath, 'utf8');
      // A BLANK shipped page is a break, not content: with the real output
      // routine in place (\includepdf), the leading \clearpage ships the
      // near-empty current page — in the full document that position is
      // occupied by the PRECEDING blocks' material, so representing it as a
      // chunk would mint a phantom page. Keep the break, drop the box.
      const blank = !/<(path|image|text)\b/.test(svg);
      if (blank) {
        items.push({ k: 'eject', v: -10000 });
        continue;
      }
      const x0 = geo.oddsidemargin ?? 0;
      const y0 = (geo.topmargin ?? 0) + (geo.headheight ?? 0) + (geo.headsep ?? 0);
      const w = geo.textwidth ?? st.w;
      const key = `${block.id}@p${k}`;
      if (splitMode) {
        // a split box's shipped page is a REGULAR document page: page 1
        // carries the entry strut (the block starts mid-page — crop below
        // it and let the pagebuilder place the partial box at the block's
        // offset), later pages span the full text height. No full flag —
        // the preview stamps its normal page furniture.
        const cut = k === 1 ? strut : 0;
        const h = (geo.textheight ?? st.h) - cut;
        chunks.push({ key, svg: cropSvgAt(svg, x0, y0 + cut, w, h), wBp: w, hBp: h });
        items.push({ k: 'box', h, d: 0, chunk: key, coff: 0 });
        items.push({ k: 'eject', v: -10000 });
        continue;
      }
      const h = geo.textheight ?? st.h;
      chunks.push({ key, svg: cropSvgAt(svg, x0, y0, w, h), wBp: w, hBp: h });
      // full: a REAL shipped page — it owns its page style (pdfpages sets
      // \thispagestyle{empty}), so the preview must not stamp a folio on it
      items.push({ k: 'box', h, d: 0, chunk: key, coff: 0, full: 1 });
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
    // a success supersedes any earlier failure recorded for the same inputs
    // (retry ladders, transient infra) — stale entries would keep
    // frozenBlockIds reporting a healed block forever
    this.isoFailCache.delete(negKey);
    // trailing skip for the NEXT block's \addvspace merge: last glue item, sp
    const compiledOff = entryOff;
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
      refVals: Object.fromEntries((st.refs ?? []).map((k) => [k, labelSnap.get(k)])),
      compiledOff,
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

  /**
   * Hard cap on live checkpoints. `#retireOffGrid` only retires the single
   * index a JOB just processed, so passes that resume mid-document
   * (rescue pump, settle, chain, backward-ref) leave an orphan checkpoint
   * at every STOP point that no later JOB retires — the live set creeps far
   * past maxCheckpoints (observed: 25 live at budget 8, monotonic climb as
   * the boot rescue pump churns 55 blocks). Each checkpoint is a resident
   * lualatex holding its accumulated dormant page, so this is real memory.
   *
   * Collapse to the grid: keep checkpoint 0, every grid-aligned boundary,
   * and the edit-locus / render pins; DIE the rest. Idempotent — safe to
   * call after any checkpoint-creating pass.
   */
  #enforceCheckpointCap() {
    const grid = this.#ckptGrid();
    if (grid <= 1) return; // small doc: all boundaries fit under the budget
    for (const [idx, peer] of [...this.checkpoints]) {
      if (idx === 0 || idx % grid === 0) continue; // grid skeleton
      if (this.editHold.includes(idx)) continue; // block being typed in
      if (this.renderHold.has(idx)) continue; // awaiting an exact chunk
      peer.send('DIE\n');
      if (peer.pid) this.dyingPids?.add(peer.pid);
      this.checkpoints.delete(idx);
    }
  }

  #retireOffGrid(idx) {
    const grid = this.#ckptGrid();
    if (grid <= 1 || idx === 0 || idx % grid === 0) return;
    if (!this.checkpoints.has(idx + 1)) return; // successor must exist first
    // edit-locus pin: keep the boundaries around the block being typed in,
    // so a keystroke burst never pays a grid replay
    if (this.editHold.includes(idx)) return;
    // Render hold: the resident RENDER path needs the state AT the block,
    // so a block that will want a high-fidelity chunk (math/gfx — typically
    // the one being edited) keeps its checkpoint alive until the chunk
    // lands. Small budget: a boot-time flood must not hold half the
    // document's process tree — beyond it the isolated render path covers.
    const block = this.blocks[idx];
    if (
      block &&
      !this.renderHold.has(idx) &&
      this.renderHold.size < RENDER_HOLD_MAX &&
      this.#mayNeedRender(block)
    ) {
      this.renderHold.set(idx, block.id);
      return;
    }
    const peer = this.checkpoints.get(idx);
    if (peer) {
      peer.send('DIE\n');
      if (peer.pid) this.dyingPids?.add(peer.pid);
      this.checkpoints.delete(idx);
    }
  }

  /**
   * Live-fork backpressure: a boot/rebuild walk mints one checkpoint per
   * block and retires off-grid ones with DIE — but a DIE'd child exits
   * asynchronously, and on a slow box creation outruns the exits (observed:
   * 100+ live lualatex during a boot; on Linux each holds the FULL dirtied
   * preamble heap, ~470MB, which OOM-kills a 16GB CI runner). Before
   * forking the next job, wait for the dying set to shrink; stragglers get
   * SIGKILL after a grace period (they are retired snapshots — no state is
   * lost).
   */
  async #reapDying(maxDying = 8) {
    this.dyingPids ??= new Set();
    const sweep = () => {
      for (const pid of [...this.dyingPids]) {
        try {
          process.kill(pid, 0);
        } catch {
          this.dyingPids.delete(pid);
        }
      }
    };
    sweep();
    const t0 = Date.now();
    while (this.dyingPids.size > maxDying) {
      if (Date.now() - t0 > 2000) {
        for (const pid of [...this.dyingPids]) {
          try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
          this.dyingPids.delete(pid);
        }
        break;
      }
      await new Promise((r) => setTimeout(r, 25));
      sweep();
    }
  }

  /** Will this block plausibly want an exact preview chunk? Known from its
   * last fidelity verdict; brand-new blocks get a cheap math/gfx scan. */
  #mayNeedRender(block) {
    if (block.fidelity) return !!block.needsRender;
    return MATHY_RE.test(block.text);
  }

  /** A held checkpoint has served its render (or the hold went stale):
   * resume normal grid retirement. */
  #releaseRenderHold(idx) {
    if (!this.renderHold.delete(idx)) return;
    this.#retireOffGrid(idx);
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
   * `shouldAbort` lets background callers yield to an incoming edit.
   */
  async #retypesetChain(from, target, onBlock, shouldAbort = null) {
    let n = 0;
    for (let j = from; j < this.blocks.length; j++) {
      if (shouldAbort?.()) return -(n + 1); // strictly negative: aborted
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

  /** Keep the label/ref indexes in sync with one block's galley change. */
  #indexBlock(blockId, labels, refs) {
    const oldLabels = this.blockLabelIdx.get(blockId) ?? EMPTY_UNITS;
    for (const k of oldLabels) {
      const n = (this.labelCount.get(k) ?? 1) - 1;
      if (n <= 0) {
        this.labelCount.delete(k);
        this.vanishedLabels.add(k);
      } else {
        this.labelCount.set(k, n);
      }
    }
    for (const k of labels) {
      this.labelCount.set(k, (this.labelCount.get(k) ?? 0) + 1);
      this.vanishedLabels.delete(k);
    }
    if (labels.length) this.blockLabelIdx.set(blockId, labels);
    else this.blockLabelIdx.delete(blockId);

    const oldRefs = this.blockRefIdx.get(blockId) ?? EMPTY_UNITS;
    for (const k of oldRefs) {
      const set = this.refIndex.get(k);
      if (set) {
        set.delete(blockId);
        if (!set.size) this.refIndex.delete(k);
      }
    }
    for (const k of refs) {
      let set = this.refIndex.get(k);
      if (!set) this.refIndex.set(k, (set = new Set()));
      set.add(blockId);
    }
    if (refs.length) this.blockRefIdx.set(blockId, refs);
    else this.blockRefIdx.delete(blockId);
  }

  #unindexBlock(blockId) {
    this.#indexBlock(blockId, EMPTY_UNITS, EMPTY_UNITS);
  }

  /**
   * Rewrite the galley's numeric daemon font ids to stable keys BEFORE
   * anything hashes or stores it. Daemon ids are allocation-order artifacts
   * of one fork lineage: replaying the same block in a different lineage
   * (chain preservation, background rebuild, engine restart) yields
   * different ids for identical output — which used to make galleyHash /
   * page identity churn, mark untouched pages dirty and peel their
   * canonical overlays. After this pass, galley identity is a pure function
   * of TeX's output.
   */
  #normalizeGalleyFonts(galley) {
    const map = new Map();
    for (const [fid, meta] of Object.entries(galley.fonts ?? {})) {
      const key = stableFontKey(meta);
      map.set(Number(fid), key);
      this.#registerFont(key, meta);
    }
    if (galley.fontsNormalized) return; // stale-first reuse re-adopts objects
    const rewrite = (r) => {
      if (r.rule || r.f == null) return;
      const key = map.get(r.f);
      if (key) r.f = key;
      else if (typeof r.f === 'number' && map.size) {
        // a PARTIALLY mapped galley is a real bug (the daemon reports every
        // id its runs use); rescued iso galleys legitimately carry no font
        // table at all — their pixels come from chunks, runs only size them
        this.diagnostics.push(`font id ${r.f} missing from galley font table`);
      }
    };
    walkItemRuns(galley.items, rewrite);
    for (const f of galley.floats ?? []) walkItemRuns(f.items, rewrite);
    galley.fontsNormalized = true;
  }

  #adoptGalley(block, galley) {
    this.#normalizeGalleyFonts(galley);
    this.#indexBlock(
      block.id,
      (galley.labels ?? []).map((l) => l.k),
      galley.refs ?? []
    );
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
    } else if (galley.tdomStale) {
      // stale-first rescue: the previous (rescued) galley is being reused
      // verbatim — its chunks are already registered under the same hash
      delete galley.tdomStale;
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
    // fonts were registered by #normalizeGalleyFonts BEFORE the fidelity
    // gate reads their tiers
    this.#applyFidelity(block, galley);
    block.consumesToc = /\\(tableofcontents|listoffigures|listoftables)\b/.test(block.text);
    block.kind = HEADING_RE.test(block.text)
      ? 'heading'
      : block.gfx
        ? 'graphics'
        : 'paragraph';
    block.units = null;
  }

  /**
   * Visual fidelity gate, applied per adopted galley: classify every line
   * (safe-glyph vs exact-preview-required), merge any sticky verification
   * demotion, and derive whether the block needs a high-fidelity chunk.
   * Rescued blocks already carry print-identical chunks — the resident
   * RENDER path (dormant-page reship) must not overwrite them.
   */
  #applyFidelity(block, galley) {
    let fid = classifyGalley(galley, this.fonts);
    const dem = this.fidelityDemoted.get(block.id);
    if (dem && dem.hash === fnv1a(block.text)) {
      fid = demoteFidelity(fid, dem.level);
    }
    // Margin placement (\marginpar / \marginnote / todonotes' \todo) writes
    // OUTSIDE the galley box — no per-block chunk can show it. The block
    // still typesets in-chain for its BODY text (layout stays exact), but
    // its pixels are canonical-only: the provisional layer never patches
    // this band, so the canonical page (margin note included) shows
    // through. This is what keeps \todo-bearing paper drafts structured
    // instead of demoting the whole document.
    if (MARGIN_RE.test(block.text)) {
      fid = demoteFidelity(fid, 'canonical');
    }
    block.fidelity = fid;
    block.needsRender = !block.rescued && !fid.canonicalOnly && fid.exact;
    block.units = null;
  }

  #registerFont(key, meta) {
    if (this.fonts.has(key)) return;
    const base = path.basename(meta.file || meta.name || '');
    const browserLoadable = /\.(otf|ttf)$/i.test(base);
    const legacy = !browserLoadable ? mapLegacyFont(meta.name) : null;
    // delivery tier (fidelity gate input): only the ACTUAL TeX font file,
    // present on disk and browser-loadable, is 'native'. Legacy fonts with
    // a Latin Modern twin are 'twin' (a substitution — never exact); every
    // other case (pfb without a twin, missing file) is 'none': the glyph
    // layer must not fake those at all.
    let familyKey;
    let tier;
    if (legacy) {
      familyKey = 'twin-' + legacy.twin;
      if (!this.fontFiles.has(familyKey)) {
        this.fontFiles.set(familyKey, resolveFont(legacy.twin));
      }
      const twinPath = this.fontFiles.get(familyKey);
      tier = twinPath && existsSync(twinPath) ? 'twin' : 'none';
    } else if (browserLoadable && meta.file && existsSync(meta.file)) {
      familyKey = 'f-' + fnv1a(meta.file);
      if (!this.fontFiles.has(familyKey)) this.fontFiles.set(familyKey, meta.file);
      tier = 'native';
    } else {
      familyKey = 'f-' + fnv1a(meta.file || meta.name || String(key));
      tier = 'none';
    }
    if (this.demotedFamilies.has(familyKey)) tier = 'none';
    this.fonts.set(key, {
      ...meta,
      family: familyKey,
      remap: legacy?.map ?? null,
      omx: !!legacy?.omx,
      tier,
    });
  }

  /**
   * The browser reported it cannot load a served font family (@font-face
   * failure). Everything drawn with it would silently fall back to a
   * default browser font — exactly the display this engine exists to
   * prevent. Demote the family to tier 'none': lines using it become
   * exact-preview-required with no glyph bridge.
   */
  demoteFontFamily(familyKey) {
    if (!familyKey || this.demotedFamilies.has(familyKey)) return false;
    this.demotedFamilies.add(familyKey);
    let touched = false;
    for (const meta of this.fonts.values()) {
      if (meta.family === familyKey && meta.tier !== 'none') {
        meta.tier = 'none';
        touched = true;
      }
    }
    if (!touched) return false;
    this.diagnostics.push(`fidelity gate: font ${familyKey} failed in the browser — demoted to exact preview`);
    this.fidelityEpoch++;
    for (const block of this.blocks) {
      if (block.galley) this.#applyFidelity(block, block.galley);
    }
    this.#asyncRepaginate();
    return true;
  }

  // ------------------------------------------------------------- update

  async #update(args) {
    this.lastEditAt = Date.now(); // pauses the idle-gated isolated renders
    // Stop the in-flight background chain rebuild BEFORE taking the chain
    // lock (it holds the lock while running; aborting it first avoids a
    // lock-order deadlock). With stale-first rescues the background task
    // never blocks on an isolated compile, so this wait is milliseconds —
    // EXCEPT in a deep-lineage luatexja wall, where the current in-chain
    // job can spin to its 12s timeout (and its rescue's state jobs after
    // it: up to ~36s before the loop re-checks the flag). The flag alone
    // is not an abort there: kill the in-flight background job outright
    // (#typesetBlock sees bgAbort and neither poisons the block nor runs
    // its follow-up jobs — the next rebuild simply retries it).
    this.bgAbort = true;
    if (this.bgActive) {
      const pid = this.currentJob?.pid;
      if (pid) {
        try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
      }
    }
    await this.bgTask.catch(() => {});
    return this.#locked(async () => {
      // serialize async header-job arrivals against updates: an hf apply
      // between an update's prevHashes capture and its patch computation
      // would mark unrelated pages dirty
      this.updating = true;
      this.bgAbort = false;
      try {
        return await this.#updateInner(args);
      } finally {
        this.updating = false;
        this.progress = null; // /status liveness marker
      }
    });
  }

  async #updateInner({ editLabel, retry = false }) {
    const t = new Timer();
    const text = this.store.get(this.file);
    const diagnostics = [];

    const bounds = documentBounds(text);
    const preamble = text.slice(bounds.preamble.start, bounds.preamble.end);
    const preHash = fnv1a(preamble);

    // ---- safety gate -----------------------------------------------------
    // Structured is a privilege, not a default: page-mechanism-hostile
    // constructs and previously-failed preambles take the opaque path,
    // where the display is the canonical LuaLaTeX output itself.
    const gate = classifyDocument(preamble, text.slice(bounds.body.start, bounds.body.end));
    if (!gate.safe) {
      return this.#opaqueUpdate(editLabel, t, gate.reasons.map((r) => `safety gate: ${r}`));
    }
    if (this.opaqueStickyPre === preHash) {
      // dynamically demoted on this exact preamble — don't pay a doomed
      // boot per keystroke; a preamble edit (or reopen) retries structured
      return this.#opaqueUpdate(editLabel, t, this.modeReasons);
    }
    if (this.mode === 'opaque') {
      this.mode = 'structured';
      this.modeReasons = [];
      this.preHash = null; // the resident tree was torn down — force a boot
      this.canonical.pressure = 'authority'; // provisional carries the display again
      this.diagnostics.push('safety gate: structured layer re-enabled');
    }

    let rebooted = false;
    if (preHash !== this.preHash) {
      if (process.env.TDOM_DEBUG_BOOT) {
        console.error(
          `[tdom-debug] preHash mismatch: have=${this.preHash} want=${preHash} ` +
            `preambleLen=${preamble.length} bodyStart=${bounds.body.start} edit=${editLabel}`
        );
      }
      // Structure-changing edit: the honest full-rebuild path. A preamble
      // the daemon cannot boot (unknown packages breaking the driver shims,
      // TeX errors before \begin{document} …) is not an error state: the
      // document demotes to opaque and the canonical layer keeps rendering.
      this.progress = { phase: 'boot' }; // /status: preamble reload running
      try {
        await this.#bootRoot();
      } catch (err) {
        this.opaqueStickyPre = preHash;
        this.#scheduleStructuredReprobe(preHash);
        return this.#opaqueUpdate(editLabel, t, [`structured boot failed: ${err.message}`]);
      }
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
    for (const id of diff.removed) this.#unindexBlock(id);
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
    // Checkpoint-suffix preservation (docs/10 §I2): boundaries outside the
    // edited window survive the edit. Prefix boundaries are exact; suffix
    // boundaries move by the window's index delta and are marked
    // volatile-stale — a job forked from one re-seeds counters/\prevdepth/
    // \if@nobreak from the orchestrator's stateVec (#volatilePrelude). Only
    // boundaries INSIDE the window die. Whether the suffix may be TRUSTED
    // is decided after the foreground walk (verdict): definition edits and
    // untracked-state leaks still kill and rebuild it, off the hot path.
    {
      const { prefixLen, oldSuffixStart, newSuffixStart } = diff.bounds;
      const delta = newSuffixStart - oldSuffixStart;
      const rekeyed = new Map();
      for (const [idx, peer] of this.checkpoints) {
        if (idx <= prefixLen) {
          rekeyed.set(idx, peer);
        } else if (idx >= oldSuffixStart) {
          peer.vstale = true;
          rekeyed.set(idx + delta, peer);
        } else {
          peer.send('DIE\n');
          if (peer.pid) this.dyingPids?.add(peer.pid);
        }
      }
      this.checkpoints = rekeyed;
      const holds = new Map();
      for (const [idx, id] of this.renderHold) {
        if (idx <= prefixLen) holds.set(idx, id);
        else if (idx >= oldSuffixStart) holds.set(idx + delta, id);
      }
      this.renderHold = holds;
      this.editHold = this.editHold
        .map((idx) => (idx <= prefixLen ? idx : idx >= oldSuffixStart ? idx + delta : -1))
        .filter((idx) => idx >= 0);
      if (this.pendingChain) {
        const f = this.pendingChain.from;
        this.pendingChain.from = f <= prefixLen ? f : f >= oldSuffixStart ? f + delta : prefixLen;
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

    // Definition-bearing edits (docs/10 §I2b) forfeit suffix trust: scan the
    // changed window's old AND new text before deciding anything.
    let defEdit = false;
    {
      const { prefixLen, oldSuffixStart, newSuffixStart } = diff.bounds;
      for (let k = prefixLen; k < oldSuffixStart && !defEdit; k++) {
        defEdit = DEF_RE.test(oldBlocks[k]?.text ?? '');
      }
      for (let k = prefixLen; k < newSuffixStart && !defEdit; k++) {
        defEdit = DEF_RE.test(this.blocks[k]?.text ?? '');
      }
    }

    // Bounded foreground walk (docs/10 §I1): typeset the edited region plus
    // its verification blocks, then STOP with a verdict — never walk the
    // document on the hot path. 'clean' keeps the preserved suffix as-is;
    // 'counters' hands the moving exit state to the async settle pass;
    // 'leak' (galley divergence past the budget, or a definition edit)
    // distrusts the suffix and hands it to the async rebuild pass.
    let verdict = null;
    let verifyGalleyBudget = 8; // layout-coupled clean blocks absorbed inline
    let verifyLocalBudget = 4; // \prevdepth/\lastskip ripple blocks absorbed inline
    let i = this.#nearestCheckpoint(Math.min(firstDirty, this.blocks.length));
    while (i < this.blocks.length) {
      // /status liveness marker: which block the foreground pass is on —
      // a long boot walk shows movement instead of silence
      this.progress = { phase: 'typeset', at: i + 1, total: this.blocks.length };
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
      if (i <= firstDirty) continue; // replay ramp up to the edited region
      if (!wasClean) {
        // an EDITED block that reproduced its galley AND exit state exactly
        // (stale-first rescue reuse, comment-only change) moved nothing:
        // converge without paying a verification job
        if (!changed && before.hadGalley && !this.blocks.slice(i).some((b) => !b.galley)) {
          verdict = 'clean';
          break;
        }
        continue; // still consuming the edited/new region
      }
      if (!changed) {
        // convergence: exit state and galley reproduced exactly. Galley-less
        // blocks ahead (boot/reboot fill) still need a walk; moved-label
        // dependents are handled by the backward-reference pass below.
        const holes = this.blocks.slice(i).some((b) => !b.galley);
        if (!holes) {
          verdict = 'clean';
          break;
        }
        continue;
      }
      if (block.galleyHash !== before.hash) {
        // real layout coupling (\addvspace max-merge, @nobreak …) extends
        // the edited region — within a budget. A long cascade means an
        // untracked state (font switch, macro) is flowing downstream.
        if (verifyGalleyBudget-- > 0) continue;
        verdict = 'leak';
        break;
      }
      // galley identical, exit state moved: counters and/or the local tail
      if (vecLocalsEqual(before.state, block.stateVec)) {
        verdict = 'counters';
        break;
      }
      if (verifyLocalBudget-- > 0) continue; // let \prevdepth ripples settle
      verdict = 'counters';
      break;
    }
    if (defEdit && verdict) verdict = 'leak';
    const fgStop = i;

    // verdict dispatch: anything beyond the foreground bound is DEFERRED
    if (verdict === 'counters' || verdict === 'leak') {
      if (verdict === 'leak') {
        // the suffix lineage can no longer be trusted — kill it; the async
        // rebuild re-typesets serially from the stop point
        for (const [idx, peer] of [...this.checkpoints]) {
          if (idx > fgStop) {
            peer.send('DIE\n');
            if (peer.pid) this.dyingPids?.add(peer.pid);
            this.checkpoints.delete(idx);
          }
        }
        for (const idx of [...this.renderHold.keys()]) {
          if (idx > fgStop) this.renderHold.delete(idx);
        }
      }
      this.#queueChainWork(verdict === 'leak' ? 'rebuild' : 'settle', fgStop, changedLabels);
    }

    // labels whose defining blocks all disappeared — index-driven, no
    // labels × blocks scan on the hot path
    for (const key of [...this.vanishedLabels]) {
      this.vanishedLabels.delete(key);
      if (this.labelCount.has(key)) continue; // redefined meanwhile
      if (this.labelTable.has(key)) {
        this.labelTable.delete(key);
        changedLabels.add(key);
      }
    }

    // Backward references: a label defined LATER in the chain (new figure,
    // renamed equation...) can be referenced by EARLIER blocks, which the
    // forward pass never revisits. Retypeset those ref-users explicitly —
    // candidates come from the ref index, not a full block scan. With chain
    // work pending, labels are still moving: the async pass runs this after
    // the suffix settles (#chainAfterPass) instead.
    if (changedLabels.size && !this.pendingChain) {
      const candidates = new Set();
      for (const k of changedLabels) {
        for (const bid of this.refIndex.get(k) ?? []) candidates.add(bid);
      }
      for (let c = 0; c < this.blocks.length && candidates.size; c++) {
        const block = this.blocks[c];
        if (!candidates.has(block.id)) continue;
        candidates.delete(block.id);
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
      for (const bid of this.refIndex.get(key) ?? []) push2(depDirty, 'label', key, bid);
    }

    // ---- live table of contents -----------------------------------------
    // Provisional pagination gives page numbers; if the toc data moved,
    // retypeset the \tableofcontents blocks with the fresh toc file.
    // Fixed point: the toc block's own height shifts page numbers, which
    // shift the toc — iterate like latex reruns would, but per block.
    // Deferred to #chainAfterPass while chain work is pending (page numbers
    // are still moving until the suffix settles).
    for (let pass = 0; pass < 3 && !this.pendingChain; pass++) {
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
    // breakable tcolorbox …) splits by its position ON the page. An edit
    // near the top of the document moves EVERY later block's offset, so
    // walking re-rescue chains here would be O(document) on the hot path
    // (measured: 2 minutes for a one-character edit). Instead: update the
    // offsets, queue the affected rescues, and let the async exact
    // pipeline iterate to the fixed point — the stale galleys stay on
    // screen meanwhile, and canonical guarantees the final pixels.
    this.#queueMovedOffsets();
    t.lap('pagectx');
    this._typesetResult = { dirtyBlocks, depDirty, changedLabels, typesetCount, forkMs, fgStop, verdict };
    } catch (err) {
      if (!retry) {
        this.diagnostics.push('typeset phase failed (' + err.message + ') — full rebuild');
        this.preHash = null; // force a root reboot on the retry pass
        for (const peer of this.peers) peer.send('DIE\n');
        this.checkpoints.clear();
        this.pendingChain = null; // the reboot walk re-typesets everything
        this.editHold = [];
        // direct inner call: we already hold the chain lock (re-entering
        // #update would deadlock on it)
        return this.#updateInner({ editLabel, retry: true });
      }
      // even the full rebuild failed: demote to opaque instead of erroring —
      // the canonical layer keeps the document visible and editable
      this.opaqueStickyPre = this.preHash;
      return this.#opaqueUpdate(editLabel, t, [`structured typeset failed: ${err.message}`]);
    }
    const { dirtyBlocks, depDirty, changedLabels, typesetCount, forkMs, fgStop, verdict } =
      this._typesetResult;
    // pin the edit locus so the next keystroke is fork-once, typeset-once
    const locusPins = [fgStop];
    for (const id of dirtyBlocks) {
      const idx = this.blocks.findIndex((b) => b.id === id);
      if (idx >= 0) locusPins.push(idx, idx + 1);
    }
    this.editHold = [...new Set([...locusPins, ...this.editHold])].slice(0, 8);

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
    // the boot/edit walk left a checkpoint at every block it typeset —
    // collapse to the grid before scheduling background work (a full boot
    // walk of a large document is the worst offender)
    this.#enforceCheckpointCap();
    this.#scheduleBackground(fgStop, dirtyBlocks);
    t.lap('schedule');

    this.rev++;
    this.srcRev++;
    // converge to exact: the canonical compile of THIS source is scheduled
    // off the hot path; when it lands the client swaps every clean page to
    // LuaLaTeX's own pixels
    this.canonical.schedule(text, this.srcRev);
    this.#shipUpdate(text);
    return {
      rev: this.rev,
      srcRev: this.srcRev,
      edit: editLabel,
      backend: this.backendName,
      mode: this.mode,
      modeReasons: this.modeReasons,
      canonical: this.canonical.info(),
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
        chainVerdict: verdict ?? 'walked',
        chainPending: this.pendingChain
          ? { kind: this.pendingChain.kind, from: this.pendingChain.from }
          : null,
        pagesReused: reused,
        pagesRebuilt: rebuilt,
        pageCount: pages.length,
        macrosChanged: [],
        labelsChanged: [...changedLabels],
        verify: this.verifyState,
        fidelity: this.#fidelitySummary(),
        diagnostics: [...diagnostics, ...this.diagnostics.splice(0)],
      },
    };
  }

  /** Inspector counters for the visual fidelity gate. */
  #fidelitySummary() {
    let safe = 0;
    let exact = 0;
    let canonicalOnly = 0;
    let exactLines = 0;
    for (const b of this.blocks) {
      const f = b.fidelity;
      if (!f || f.level === SAFE_GLYPH) safe++;
      else if (f.canonicalOnly) canonicalOnly++;
      else exact++;
      exactLines += f?.exactLines ?? 0;
    }
    return {
      safeBlocks: safe,
      exactBlocks: exact,
      canonicalOnlyBlocks: canonicalOnly,
      exactLines,
      demoted: this.fidelityDemoted.size,
      demotedFonts: [...this.demotedFamilies],
      pendingRenders: this.renderWant.size,
    };
  }

  // ------------------------------------------------- opaque document mode
  //
  // The document-granularity exact fallback: no structured typesetting, no
  // JS page assembly — the display is the canonical LuaLaTeX pages, edits
  // keep applying to the source and each one schedules a fresh canonical
  // compile. Coarse-grained but unbreakable: anything lualatex compiles
  // renders, and anything it rejects reports its real TeX error while the
  // last good pages stay up.

  // ------------------------------------------- shipping chain (phase 1)

  #makeShipping() {
    const chain = new ShippingChain({
      workDir: path.join(this.workDir, 'ship'),
      docDir: this.docDir,
    });
    chain.onPaged = ({ page, gen }) => {
      if (this.shipStale || chain !== this.shipping) return;
      this.onShipPage?.({ page, gen, srcRev: this.shipGenRev.get(gen) ?? 0 });
    };
    chain.onLabel = ({ key, val }) => {
      const known = this.labelTable.get(key);
      const seeded = this.shipLabelOverrides.get(key) ?? known;
      if (seeded !== undefined && String(seeded) !== String(val) && !this.shipStale) {
        // backward effect: a label value the seeds promised has moved —
        // EARLIER pages may print stale numbers. Record the SHIP-observed
        // truth and reboot with corrected seeds (bounded: a divergence the
        // reseed cannot absorb must not loop). Until then the cold
        // canonical owns the display truth.
        this.shipStale = true;
        this.shipLabelOverrides.set(key, val);
        this.diagnostics.push(`shipping: label ${key} diverged (${seeded} -> ${val}) — reseeding`);
        this.#queueShipBoot();
      } else if (seeded === undefined) {
        this.shipLabelOverrides.set(key, val);
      }
    };
    return chain;
  }

  /**
   * Boot (or reboot) the incremental authority with the engine's own seeds:
   * label values + their provisional page numbers, and the computed
   * toc/lof/lot. Off the hot path; edits during the boot are caught by the
   * source comparison at the end.
   */
  async #bootShipping() {
    if (!this.shipping || this.mode !== 'structured' || this.shipBooting) return;
    this.shipBooting = true;
    try {
      const text = this.store.get(this.file);
      const preHash = this.preHash;
      if (this.shipBootedFor !== preHash) this.shipBootTries = 0;
      if (this.shipBootedFor !== null || this.shipping.rootPeer || this.shipping.disposed) {
        // a previous run exists: replace the whole instance (its net server
        // and process tree die with it)
        await this.shipping.close().catch(() => {});
        this.shipping = this.#makeShipping();
      }
      const prov = this.#paginateNow();
      const blockPage = new Map();
      for (const page of this.pages) {
        for (const d of page.draw ?? []) {
          const bid = d.u?.blockId;
          if (bid && !blockPage.has(bid)) blockPage.set(bid, page.number);
        }
      }
      const labelPage = new Map();
      for (const [bid, keys] of this.blockLabelIdx) {
        for (const k of keys) {
          if (!labelPage.has(k)) labelPage.set(k, blockPage.get(bid) ?? 1);
        }
      }
      const labelSeed = [...this.labelTable].map(([k, v]) => [
        k,
        [this.shipLabelOverrides.get(k) ?? v, labelPage.get(k) ?? 1],
      ]);
      for (const [k, v] of this.shipLabelOverrides) {
        if (!this.labelTable.has(k)) labelSeed.push([k, [v, labelPage.get(k) ?? 1]]);
      }
      const toc = this.#computeToc(prov);
      this.shipStale = false;
      this.shipGenRev.clear();
      this.shipGenRev.set(0, this.srcRev);
      this.shipBootTries = this.shipBootedFor === preHash ? this.shipBootTries + 1 : 1;
      await this.shipping.open(text, { labelSeed, contents: toc.contents });
      this.shipBootedFor = preHash;
      // an edit landed while booting: converge the wave to it now
      const now = this.store.get(this.file);
      if (now !== text) this.#shipUpdate(now);
    } catch (err) {
      this.diagnostics.push('shipping boot failed: ' + err.message);
      this.shipBootedFor = null;
    } finally {
      this.shipBooting = false;
    }
  }

  #queueShipBoot() {
    if (!this.shipping || this.shipBootTimer) return;
    if (this.shipBootTries >= 3) return; // stays cold-covered; a preamble
    // edit resets the budget (a genuinely divergent doc must not loop)
    const arm = () => {
      this.shipBootTimer = setTimeout(() => {
        this.shipBootTimer = null;
        // a stale-but-running run is a TRUTH HARVESTER: every divergent
        // label it reports lands in shipLabelOverrides, so ONE reboot with
        // the complete truth converges. Killing it at the first divergence
        // would relearn one label per boot and exhaust the budget.
        if (this.shipping && !this.shipping.done && this.shipping.rootPeer?.alive && !this.shipping.err) {
          arm();
          return;
        }
        this.#bootShipping().catch(() => {});
      }, 800);
      this.shipBootTimer.unref?.();
    };
    arm();
  }

  /** Hot-path hook: cheap (a unit diff + one socket line). */
  #shipUpdate(text) {
    if (!this.shipping || this.mode !== 'structured') return;
    if (this.shipBooting) return; // boot-end convergence will catch up
    if (
      this.shipping.err?.message?.startsWith('pdf-opened-at-root') &&
      this.shipBootedFor === this.preHash &&
      this.shipDisabledFor !== this.preHash
    ) {
      // hyperref-class document: the per-page lazy-open scheme cannot work;
      // the cold canonical owns the display. Disabled PER PREAMBLE — a
      // preamble edit (or another document) gets a fresh chance.
      this.shipDisabledFor = this.preHash;
      this.diagnostics.push('shipping disabled for this preamble: ' + this.shipping.err.message);
    }
    if (this.shipDisabledFor === this.preHash) return;
    if (this.shipBootedFor !== this.preHash || this.shipStale || this.shipping.err) {
      this.#queueShipBoot();
      return;
    }
    const r = this.shipping.resume(text);
    if (r.mode === 'resumed') {
      this.shipGenRev.set(this.shipping.gen, this.srcRev);
    } else if (r.mode === 'unchanged') {
      this.shipGenRev.set(this.shipping.gen, this.srcRev);
    } else if (r.mode === 'reboot-needed') {
      this.#queueShipBoot();
    }
  }

  #opaqueUpdate(editLabel, t, reasons) {
    const text = this.store.get(this.file);
    if (this.mode !== 'opaque') {
      this.mode = 'opaque';
      // the compile IS the display now: recompile promptly on every pause
      this.canonical.pressure = 'display';
      this.diagnostics.push(`structured layer demoted to opaque: ${reasons.join('; ')}`);
      this.#teardownTree();
    }
    this.modeReasons = reasons;
    t.lap('gate');
    this.rev++;
    this.srcRev++;
    this.canonical.schedule(text, this.srcRev);
    this.#shipUpdate(text);
    return {
      rev: this.rev,
      srcRev: this.srcRev,
      edit: editLabel,
      backend: this.backendName,
      mode: this.mode,
      modeReasons: this.modeReasons,
      canonical: this.canonical.info(),
      dirtySourceNodes: [],
      dirtySemanticNodes: [],
      dirtyDependencies: [],
      dirtyLayoutNodes: [],
      dirtyPages: [],
      patches: [],
      stats: {
        ...t.done(),
        blocksTotal: 0,
        blocksTypeset: 0,
        blocksReparsed: 0,
        semanticCacheHits: 0,
        layoutCacheHits: 0,
        layoutCacheMisses: 0,
        typesetMs: 0,
        rebooted: false,
        checkpoints: 0,
        pagesReused: 0,
        pagesRebuilt: 0,
        pageCount: this.canonical.info().pageCount,
        macrosChanged: [],
        labelsChanged: [],
        verify: null,
        diagnostics: this.diagnostics.splice(0),
      },
    };
  }

  /**
   * Transient boot failures (system pressure, teardown races, a workdir in a
   * bad moment) must not pin the document in opaque until the user happens
   * to edit the preamble. One automatic re-probe per failed preamble: after
   * a quiet delay, drop the sticky pin and re-run the update. Boot succeeds
   * → the structured layer comes back on its own; fails again → the pin
   * returns and stays (a genuinely unbootable preamble keeps its honest
   * opaque fallback without a retry storm).
   */
  #scheduleStructuredReprobe(preHash) {
    if (this.reprobedPre === preHash) return; // one shot per preamble
    this.reprobedPre = preHash;
    const t = setTimeout(() => {
      if (this.closed || this.mode !== 'opaque') return;
      if (this.opaqueStickyPre !== preHash) return; // preamble moved on
      this.diagnostics.push('opaque self-heal: re-probing the structured boot');
      this.opaqueStickyPre = null;
      this.#update({ editLabel: 'structured-reprobe' }).catch(() => {});
    }, Number(process.env.TDOM_REPROBE_MS || 20_000));
    t.unref?.(); // never keep the process alive for a reprobe
  }

  /** Free the resident process tree (opaque mode needs none of it). */
  #teardownTree() {
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
    this.rescueQueue.clear();
    this.renderWant.clear();
    this.renderHold.clear();
    this.pendingChain = null;
    this.editHold = [];
    clearTimeout(this.shipBootTimer);
    this.shipBootTimer = null;
    this.shipBootedFor = null;
    if (this.shipping) this.shipping.close().catch(() => {});
    for (const child of this.isoChildren) {
      try { child.kill('SIGKILL'); } catch { /* gone */ }
    }
    this.preHash = null; // a later promotion must reboot from scratch
    this.pages = [];
    this._pageRun = null;
  }

  // ------------------------------------- canonical arrival + verification

  #onCanonicalResult(info) {
    try {
      this.onCanonical?.(info);
    } catch { /* observer errors are not ours */ }
    if (info.error || process.env.TDOM_NO_VERIFY) return;
    // verify only at convergence: the compile must be of the CURRENT source
    if (this.mode !== 'structured' || info.rev !== this.srcRev) return;
    this.#verifyAgainstCanonical(info)
      .catch((err) => {
        this.diagnostics.push('verification failed to run: ' + err.message);
      })
      .then(() => this.#cropCanonicalChunks(info))
      .catch((err) => {
        this.diagnostics.push('canonical crop failed: ' + err.message);
      });
  }

  /**
   * Canonical-crop chunk source (the cheapest exact pixels in the system):
   * when a fresh canonical compile matches the current source, every block
   * whose exact preview chunk is missing/stale gets it cropped straight out
   * of the canonical page SVG. No compile at all: the pixels are the ones
   * the overlay already shows, but registering them as chunks means the
   * NEXT edit to that block holds a clean stale-exact band instead of
   * bridge glyphs. This is the ONLY bulk chunk source — the resident
   * RENDER pump serves just-edited blocks only (a whole-document RENDER
   * sweep spins on deep-lineage luatexja and starves the fork jobs), and
   * the isolated queue serves what drift keeps this pass from reaching.
   */
  async #cropCanonicalChunks(info) {
    if (this.mode !== 'structured' || this.srcRev !== info.rev) return;
    // pagination drift means provisional coordinates cannot address the
    // canonical pages — never crop pixels from the wrong page
    if (this.pages.length !== info.pageCount) return;
    const geo = this.geometry;
    if (!geo) return;
    const T = 72 + (geo.topmargin ?? 0) + (geo.headheight ?? 0) + (geo.headsep ?? 0);
    const L = 72 + (geo.oddsidemargin ?? 0);
    // block -> its vertical band, only when the block sits on ONE page
    // (page-spanning galleys cannot be one chunk box)
    const bands = new Map();
    for (const page of this.pages) {
      for (const d of page.draw ?? []) {
        const bid = d.u?.blockId;
        if (!bid) continue;
        const top = T + d.y - (d.u.ln?.boxH ?? d.u.h ?? 0);
        const cur = bands.get(bid);
        if (!cur) bands.set(bid, { page: page.number, top });
        else if (cur.page !== page.number) cur.split = true;
        else cur.top = Math.min(cur.top, top);
      }
    }
    let budget = Number(process.env.TDOM_CANON_CROP_MAX || 40);
    let changed = false;
    for (const block of this.blocks) {
      if (budget <= 0) break;
      if (!block.needsRender || !block.galley) continue;
      const bc = this.chunks.get(block.id);
      if (bc && bc.forGalley === block.galleyHash) continue; // fresh already
      if (this.renderWant.has(block.id)) continue; // a hot render is coming
      const band = bands.get(block.id);
      if (!band || band.split) continue;
      // chunk coordinates start at the galley TOP (leading glue included in
      // the shipped vpack) — rewind the first drawn box by the leading skips
      let lead = 0;
      for (const it of block.galley.items ?? []) {
        if (it.k === 'box') break;
        if (it.k === 'glue' || it.k === 'kern') lead += it.a ?? 0;
      }
      const h = block.galley.h + block.galley.d;
      const w = block.galley.w;
      if (!(h > 0) || !(w > 0)) continue;
      const pageSvg = await this.canonical.pageSVG(band.page, info.id).catch(() => null);
      if (!pageSvg) continue;
      if (this.srcRev !== info.rev) return; // superseded mid-pass
      const prev = this.chunks.get(block.id);
      this.chunks.set(block.id, {
        svg: cropSvgAt(pageSvg, L, band.top - lead, w, h),
        wBp: w,
        hBp: h,
        v: (prev?.v ?? 0) + 1,
        forGalley: block.galleyHash,
      });
      budget--;
      changed = true;
    }
    if (changed) this.#asyncRepaginate();
  }

  /**
   * Exactness verification (structured → opaque demotion): compare each
   * provisional page's glyph text against the canonical PDF's text via
   * token containment (latin words + CJK bigrams). A page whose provisional
   * tokens are largely missing from the canonical page means the JS page
   * assembly diverged from the real output routine there — its blocks are
   * demoted to the isolated exact-render path (print-identical pixels) and
   * stay demoted until their source changes. Conservative thresholds: this
   * must never demote healthy pages en masse.
   */
  async #verifyAgainstCanonical(info) {
    const texts = await this.canonical.pageTexts(info.id);
    if (!texts) return; // pdftotext unavailable — canonical overlay still wins visually
    if (this.srcRev !== info.rev || this.mode !== 'structured') return; // superseded meanwhile
    const mismatches = [];
    // Pagination drift (different page count, or content landing a page
    // early/late) is NOT block-level wrongness: the canonical overlay
    // already owns those pages visually, and demoting their blocks to the
    // rescue path cannot fix an offset — it would only poison the editing
    // hot path with full compiles. Demote only for genuine content
    // divergence: same page count AND the page's text matches neither its
    // own canonical page nor a ±1 neighbor.
    const countsMatch = this.pages.length === info.pageCount;
    if (!countsMatch) {
      mismatches.push(`page count: provisional ${this.pages.length} vs LuaLaTeX ${info.pageCount}`);
    }
    const demote = new Set();
    for (const page of this.pages) {
      const provTokens = [];
      for (const d of page.draw ?? []) {
        for (const r of d.u?.ln?.runs ?? []) {
          if (r.t) provTokens.push(...verifyTokens(r.t));
        }
      }
      if (provTokens.length < 20) continue; // chunk/gfx pages carry exact pixels already
      const n = page.number;
      const c = tokenContainment(provTokens, verifyTokens(texts[n - 1] ?? ''));
      if (c >= 0.8) continue;
      const window = Math.max(
        c,
        tokenContainment(provTokens, verifyTokens(texts[n - 2] ?? '')),
        tokenContainment(provTokens, verifyTokens(texts[n] ?? ''))
      );
      if (window >= 0.8) {
        mismatches.push(`page ${n}: drifted (content found on a neighboring page)`);
        continue;
      }
      mismatches.push(`page ${n}: ${Math.round(window * 100)}% of preview text found`);
      // demote only on CONFIDENT divergence — the canonical overlay already
      // guarantees the final pixels page-granularly, so a demotion buys
      // exact provisional rendering at real hot-path cost; borderline
      // scores (kerning artifacts, extraction quirks) are report-only
      if (!countsMatch || window >= 0.5) continue;
      for (const d of page.draw ?? []) {
        const bid = d.u?.blockId;
        if (bid) demote.add(bid);
      }
    }
    this.verifyState = {
      rev: info.rev,
      canonicalId: info.id,
      pagesChecked: Math.min(this.pages.length, info.pageCount),
      mismatches,
    };
    if (demote.size) {
      let demoted = 0;
      let refidelity = false;
      for (const bid of demote) {
        const block = this.blocks.find((b) => b.id === bid);
        if (!block) continue;
        const hash = fnv1a(block.text);
        // fidelity-gate demotion, sticky until the block's source changes:
        // glyph divergence costs the block its glyph privileges (exact
        // preview chunks only, no bridge); divergence while it ALREADY
        // showed exact pixels means the placement itself is wrong — stop
        // trusting the provisional layer there entirely (canonical-only)
        const level = block.rescued || block.fidelity?.blockExact ? 'canonical' : 'exact';
        const prev = this.fidelityDemoted.get(bid);
        if (!prev || prev.hash !== hash || (prev.level !== level && level === 'canonical')) {
          this.fidelityDemoted.set(bid, { hash, level });
          if (block.galley) this.#applyFidelity(block, block.galley);
          refidelity = true;
        }
        if (!block.rescued && this.poisoned.get(bid) !== hash) {
          this.poisoned.set(bid, hash);
          demoted++;
        }
      }
      if (refidelity) {
        this.fidelityEpoch++;
        this.#asyncRepaginate();
      }
      if (demoted) {
        this.diagnostics.push(
          `verification demoted ${demoted} block(s) to exact rendering: ${mismatches.join('; ')}`
        );
      }
    }
  }

  // ------------------------------------------ async exact-rescue pipeline
  //
  // Stale-first rescues land here: the isolated lualatex compile runs OFF
  // the chain lock (concurrently with edits), and only the cheap adoption
  // step — retypeset from the nearest checkpoint with the now-cached iso
  // result, repaginate, patch over SSE — takes the lock. Superseded work
  // (the block's inputs changed while compiling) is dropped; the newer
  // queue entry carries the fresh inputs.

  #pumpRescues() {
    if (this.rescuePumping) return;
    this.rescuePumping = true;
    (async () => {
      try {
        while (this.rescueQueue.size) {
          const [bid, key] = this.rescueQueue.entries().next().value;
          this.rescueQueue.delete(bid);
          try {
            await this.#asyncRescueOne(bid, key);
          } catch (err) {
            // the exact compile failed for the block's CURRENT inputs — the
            // stale pixels the foreground kept are a freeze for as long as
            // those inputs persist. No sticky mark here: frozenBlockIds()
            // derives the state from isoFailCache, so a block that was only
            // collateral (a sane text re-rescued at a mid-breakage page
            // offset) un-freezes by itself when its inputs revert.
            this.diagnostics.push(`async rescue ${bid}: ${err.message}`);
          }
        }
      } finally {
        this.rescuePumping = false;
      }
    })();
  }

  async #asyncRescueOne(bid, key) {
    if (this.mode !== 'structured') return;
    // typing-burst quiescence: a keystroke inside/near a rescue block
    // supersedes the previous compile anyway — wait for a short pause so
    // bursts cost ONE compile instead of one per keystroke, and the
    // resident fork jobs keep the CPU while the user is typing
    while (Date.now() - (this.lastEditAt ?? 0) < 800) {
      await new Promise((r) => setTimeout(r, 200));
    }
    let idx = this.blocks.findIndex((b) => b.id === bid);
    if (idx < 0) return;
    let block = this.blocks[idx];
    // Superseded = the key's inputs moved since queueing. An EDIT re-queues
    // the block itself (its fresh entry carries the fresh key), but inputs
    // also move without any edit — the first stale-first adoption of an
    // in-chain block flips it to rescued, which materializes pageOffset on
    // the next repagination. Dropping here would strand the block on its
    // stale pixels forever; re-queue with the current key instead.
    const nowKey = this.#rescueCacheKey(block, idx);
    if (nowKey !== key) {
      this.rescueQueue.set(bid, nowKey);
      return;
    }
    if (this.#isoCacheGet(key) === undefined) {
      const iso = await this.#isoCompile(block, idx, 'async exact rescue');
      this.#isoCacheSet(key, iso);
    }
    const outcome = await this.#locked(async () => {
      if (this.mode !== 'structured') return 'done';
      idx = this.blocks.findIndex((b) => b.id === bid);
      if (idx < 0) return 'done';
      block = this.blocks[idx];
      const lockedKey = this.#rescueCacheKey(block, idx);
      if (lockedKey !== key) {
        // same re-queue rationale as the pre-compile check above: inputs
        // moved without an edit — retry with the fresh key
        this.rescueQueue.set(bid, lockedKey);
        return 'done';
      }
      const before = block.galleyHash + '|' + block.stateVec;
      // cache hit inside → the exact galley adopts in milliseconds; the
      // chain continues to convergence exactly like a foreground edit,
      // but YIELDS to an incoming edit and re-queues so the propagation
      // resumes afterwards. bgActive lets the edit KILL the in-flight
      // job instead of waiting out a deep-lineage spin (#update).
      this.bgActive = true;
      let n;
      try {
        n = await this.#retypesetChain(
          this.#nearestCheckpoint(idx),
          idx,
          () => {},
          () => this.bgAbort
        );
      } catch (err) {
        if (this.bgAbort) return 'aborted';
        throw err;
      } finally {
        this.bgActive = false;
      }
      // retypesetChain swallows a killed job into an early break — treat
      // any abort-flagged pass as pre-empted so the queue entry retries
      if (n < 0 || this.bgAbort) return 'aborted';
      for (const l of block.galley?.labels ?? []) {
        if (l.v !== undefined) {
          this.labelTable.set(l.k, l.v);
          if (l.h != null) this.hrefTable.set(l.k, l.h);
        }
      }
      if (before !== block.galleyHash + '|' + block.stateVec) this.#asyncRepaginate();
      this.#queueMovedOffsets();
      // the resume walk left checkpoints at the blocks it re-typeset — collapse
      // back to the grid so the boot rescue storm can't creep the live set
      this.#enforceCheckpointCap();
      return 'done';
    });
    if (outcome === 'aborted') {
      // resume after the edit that pre-empted us (waiting OUTSIDE the lock
      // — the edit needs it); the queue entry revalidates on retry
      this.rescueQueue.set(bid, key);
      while (this.bgAbort) {
        await new Promise((r) => setTimeout(r, 25));
      }
    }
  }

  /**
   * Async page-context fixpoint: after an exact rescue lands (or a
   * foreground update repaginated with stale galleys), page offsets of
   * splitting environments may have moved — queue their re-rescues. The
   * same offset-independence shortcuts as the foreground pass apply.
   */
  #queueMovedOffsets() {
    if (this.mode !== 'structured') return;
    const prov = this.#paginateNow();
    const entry = prov.blockEntry ?? new Map();
    let queued = false;
    for (let c = 0; c < this.blocks.length; c++) {
      const block = this.blocks[c];
      if (!block.rescued) continue;
      // 0.25bp quantum shared with the rescue key and the iso strut: a
      // want/have pair inside one quantum compiles to the same galley by
      // construction, so only a real grid step queues work
      const want = Math.round((entry.get(block.id) ?? 0) * 4) / 4;
      // "have" is the galley's compile PROVENANCE, not block.pageOffset —
      // the latter is set optimistically when a re-rescue is queued, so a
      // compile that never lands (failed, superseded) would otherwise lock
      // the stale galley in forever (found via stress seed-21 burst 2)
      const have = block.galley?.tdomPageOff ?? block.pageOffset ?? 0;
      if (Math.abs(want - have) <= 0.001) {
        block.pageOffset = want;
        continue;
      }
      const items = block.galley?.items ?? [];
      const th = this.geometry?.textheight ?? 0;
      const boxH = (block.galley?.h ?? 0) + (block.galley?.d ?? 0);
      // offset-independence shortcuts: a leading eject counts only when the
      // galley was compiled at the page TOP — there the break is intrinsic
      // to the block (\clearpage & co). Compiled deep in the page, a leading
      // eject usually means "didn't fit at that offset" (split spill), which
      // is exactly the offset-DEPENDENT case.
      if (
        (items[0]?.k === 'eject' && have <= 0.26) ||
        (!items.some((it) => it.k === 'eject') && boxH <= th - want && boxH <= th - have)
      ) {
        block.pageOffset = want;
        continue;
      }
      block.pageOffset = want;
      this.rescueQueue.set(block.id, this.#rescueCacheKey(block, c));
      queued = true;
    }
    if (queued) this.#pumpRescues();
  }

  /**
   * Merge deferred chain work (docs/10). 'settle' re-typesets forward until
   * the moving exit state converges (trusting the same verification the
   * foreground uses); 'rebuild' distrusts the suffix entirely (definition
   * edits, untracked-state leaks) and never converges early. rebuild
   * subsumes settle; overlapping requests keep the earliest start.
   */
  #queueChainWork(kind, from, labels) {
    const cur = this.pendingChain;
    if (!cur) {
      this.pendingChain = { kind, from, phase: 'blocks', labels: new Set(labels) };
      return;
    }
    cur.kind = cur.kind === 'rebuild' || kind === 'rebuild' ? 'rebuild' : 'settle';
    cur.from = Math.min(cur.from, from);
    cur.phase = 'blocks';
    for (const k of labels ?? []) cur.labels.add(k);
  }

  #scheduleBackground(fromIdx, dirtyBlocks) {
    // Deferred chain work is the ONLY background chain activity (docs/10
    // §I3): nothing runs while the user is typing. The pass starts after a
    // short idle gate, aborts between blocks on the next edit (#update sets
    // bgAbort and SIGKILLs the in-flight job) and resumes where it left
    // off. With no pending work the engine is completely idle between
    // keystrokes. Graphics renders stay fire-and-forget — an edit never
    // waits on pdftocairo.
    this.bgTask = (async () => {
      if (!this.pendingChain) return;
      while (!this.bgAbort && Date.now() - (this.lastEditAt ?? 0) < 300) {
        await new Promise((r) => setTimeout(r, 25));
      }
      if (this.bgAbort || !this.pendingChain) return;
      await this.#locked(() => this.#runChainPass());
    })().catch((err) => {
      this.diagnostics.push('chain pass failed: ' + err.message);
    });
    // High-fidelity chunk renders go to the pump ONLY for the blocks this
    // edit touched: their checkpoint is warm (render hold). COLD blocks
    // (boot backlog, far-away staleness)
    // are deliberately NOT queued — on deep-lineage luatexja documents a
    // resident RENDER there spins to its timeout, and a whole-document
    // sweep would storm the CPU that the fork jobs need. Their exact
    // pixels arrive for free from the canonical-crop pass instead (and,
    // for drifting documents, from the idle-gated isolated queue). A boot
    // or huge paste of a LONG document dirties everything — that is the
    // cold case: cap it. Small documents render their whole set at boot
    // (a few seconds, and the referee tools rely on it).
    const hot = dirtyBlocks.length <= Number(process.env.TDOM_RENDER_HOT_MAX || 64) ? dirtyBlocks : [];
    for (const id of hot) {
      const block = this.blocks.find((b) => b.id === id);
      if (!block?.needsRender) continue;
      const stale = this.#chunkTargets(block).some(
        (t) => this.chunks.get(t.key)?.forGalley !== block.galleyHash
      );
      if (stale) this.#queueRender(id);
    }
    // stale render holds: the held block moved/changed under its index, or
    // its chunks are already fresh — resume normal grid retirement
    for (const [idx, id] of [...this.renderHold]) {
      const b = this.blocks[idx];
      const freshAll =
        b && !this.#chunkTargets(b).some((t) => this.chunks.get(t.key)?.forGalley !== b.galleyHash);
      if (!b || b.id !== id || freshAll) {
        this.renderHold.delete(idx);
        this.#retireOffGrid(idx);
      }
    }
  }

  /**
   * The deferred chain pass. 'settle': re-typeset forward from the stop
   * point until a clean block reproduces its galley AND exit state exactly
   * (the moving counters have been chased to convergence). 'rebuild': same
   * walk but to the end of the document — after a definition edit or an
   * untracked-state leak no early convergence can be trusted. Both are
   * resumable: bgAbort (set by the next edit) exits between blocks with
   * work.from advanced, and the pass re-runs after that edit's own
   * foreground. Changed galleys stream to the client through the async
   * patch channel; stale galleys stay on screen meanwhile (old-but-clean
   * beats fast-but-wrong, and canonical owns the final pixels regardless).
   */
  async #runChainPass() {
    const work = this.pendingChain;
    if (!work) return;
    this.bgActive = true;
    try {
      if (work.phase === 'blocks') {
        let sinceRepaint = 0;
        let j = this.#nearestCheckpoint(Math.min(work.from, this.blocks.length));
        while (j < this.blocks.length) {
          if (this.bgAbort) {
            work.from = Math.min(work.from, j);
            return;
          }
          this.progress = { phase: 'chain', at: j + 1, total: this.blocks.length };
          const block = this.blocks[j];
          const before = { hash: block.galleyHash, state: block.stateVec, hadGalley: !!block.galley };
          let galley;
          try {
            galley = await this.#typesetBlock(j);
          } catch {
            work.from = Math.min(work.from, j);
            return; // killed by an incoming edit — resume afterwards
          }
          this.#adoptGalley(block, galley);
          for (const l of galley.labels ?? []) {
            if (this.labelTable.get(l.k) !== l.v) {
              work.labels.add(l.k);
              this.labelTable.set(l.k, l.v);
            }
            if (l.h != null) this.hrefTable.set(l.k, l.h);
          }
          const changed = block.galleyHash !== before.hash || block.stateVec !== before.state;
          if (changed) {
            if (block.needsRender) this.#queueRender(block.id);
            if (++sinceRepaint >= 8) {
              this.#asyncRepaginate();
              sinceRepaint = 0;
            }
          }
          j++;
          work.from = Math.max(work.from, j);
          if (
            work.kind === 'settle' &&
            before.hadGalley &&
            !changed &&
            !this.blocks.slice(j).some((b) => !b.galley)
          ) {
            break; // exit state converged — the untouched suffix is exact
          }
        }
        if (sinceRepaint) this.#asyncRepaginate();
        work.phase = 'after';
      }
      if (this.bgAbort) return;
      await this.#chainAfterPass(work);
      if (this.bgAbort) return;
      if (this.pendingChain === work) this.pendingChain = null;
    } finally {
      this.bgActive = false;
      this.progress = null;
      // the settle/rebuild/after walks left checkpoints at every block they
      // re-typeset — collapse back to the grid
      this.#enforceCheckpointCap();
    }
  }

  /**
   * Post-settle dependency passes — the async twins of the foreground's
   * inline backward-reference and toc sections, run once the suffix state
   * has stopped moving. Abortable and re-entrant (work.phase = 'after').
   */
  async #chainAfterPass(work) {
    const changedLabels = work.labels;
    if (changedLabels.size) {
      const candidates = new Set();
      for (const k of changedLabels) {
        for (const bid of this.refIndex.get(k) ?? []) candidates.add(bid);
      }
      for (let c = 0; c < this.blocks.length && candidates.size; c++) {
        if (this.bgAbort) return;
        const block = this.blocks[c];
        if (!candidates.has(block.id)) continue;
        candidates.delete(block.id);
        const hit = (block.galley?.refs ?? []).some(
          (k) => changedLabels.has(k) && !resolvedInGalley(block, k, this.labelTable)
        );
        if (!hit) continue;
        const n = await this.#retypesetChain(
          this.#nearestCheckpoint(c),
          c,
          () => {},
          () => this.bgAbort
        );
        if (n < 0) return;
      }
    }
    for (let pass = 0; pass < 3; pass++) {
      if (this.bgAbort) return;
      const prov = this.#paginateNow();
      const toc = this.#computeToc(prov);
      if (toc.hash === this.tocHash) break;
      this.tocHash = toc.hash;
      for (const [ext, content] of Object.entries(toc.contents)) {
        writeFileSync(path.join(this.workDir, `driver.${ext}`), content);
      }
      let anyConsumer = false;
      for (let c = 0; c < this.blocks.length; c++) {
        if (this.bgAbort) return;
        const block = this.blocks[c];
        if (!block.consumesToc) continue;
        anyConsumer = true;
        const n = await this.#retypesetChain(
          this.#nearestCheckpoint(c),
          c,
          () => {},
          () => this.bgAbort
        );
        if (n < 0) return;
      }
      if (!anyConsumer) break;
    }
    this.#queueMovedOffsets();
    this.#asyncRepaginate();
  }

  /**
   * Chunk pages the RENDER protocol ships for one block: page 1 = the
   * galley (needed when ANY line requires exact pixels), 2..1+F = float
   * boxes in order, 2+F..1+F+N = footnote insert bodies in order — the
   * same page map the daemon's tdom_ship/tdom_ship_floats produce.
   * Rescued blocks carry their own print-identical chunks and never
   * appear here (needsRender is false).
   */
  #chunkTargets(block) {
    const galley = block.galley;
    if (!galley) return [];
    const fid = block.fidelity;
    const targets = [];
    if (block.gfx || fid?.blockExact || (fid?.exactLines ?? 0) > 0) {
      targets.push({ key: block.id, page: 1, w: galley.w, h: galley.h + galley.d });
    }
    const floats = galley.floats ?? [];
    floats.forEach((f, i) => {
      if (f.gfx || fid?.floats?.get(f.n)?.exact) {
        targets.push({ key: block.id + '#' + f.n, page: 2 + i, w: f.w, h: (f.h ?? 0) + (f.d ?? 0) });
      }
    });
    let k = 0;
    for (const it of galley.items ?? []) {
      if (it.k !== 'ins') continue;
      if (fid?.ins?.get(k)?.exact) {
        let w = 0;
        for (const sub of it.items ?? []) {
          if (sub.k === 'box' && (sub.w ?? 0) > w) w = sub.w;
        }
        targets.push({
          key: `${block.id}@fn${k}`,
          page: 2 + floats.length + k,
          w: w || galley.w || 1,
          h: it.hc ?? (it.h ?? 0) + (it.d ?? 0),
        });
      }
      k++;
    }
    return targets;
  }

  /**
   * High-fidelity chunk scheduler. Latest-wins per block (a superseded
   * galley is never rendered — #renderBlock reads the block's CURRENT
   * hash), newest-queued block first (the one being edited), bounded
   * concurrency (an edit burst or a math-heavy boot must not fork a
   * lualatex/pdftocairo storm — CPU saturation slows the resident fork
   * jobs by orders of magnitude), paused while a foreground update runs.
   */
  #queueRender(blockId) {
    // audits compare block identity (galleyHash + stateVec) — the exact
    // preview chunks the RENDER tier produces never enter the equation,
    // while its fork holds cost ~500MB each on Linux (the Lua GC dirties
    // every COW page, materializing the full heap per resident)
    if (process.env.TDOM_NO_RENDER === '1') return;
    this.renderWant.delete(blockId); // re-insertion moves it to the back = newest
    this.renderWant.set(blockId, true);
    this.#pumpRenders();
  }

  #pumpRenders() {
    const MAX = Number(process.env.TDOM_RENDER_CONCURRENCY || 2);
    if (this.renderPumping >= MAX) return;
    this.renderPumping++;
    const drain = (async () => {
      try {
        while (this.renderWant.size) {
          if (this.updating) {
            await new Promise((r) => setTimeout(r, 25));
            continue;
          }
          const id = [...this.renderWant.keys()].pop(); // newest first
          this.renderWant.delete(id);
          const block = this.blocks.find((b) => b.id === id);
          if (!block || !block.galley || !block.needsRender) continue;
          await this.#renderBlock(block).catch((err) => {
            this.diagnostics.push(`render ${id}: ${err.message}`);
          });
        }
      } finally {
        this.renderPumping--;
      }
    })();
    // exposed so tools/tests can wait for the exact-render tier to settle
    this.renderTask = Promise.all([this.renderTask.catch(() => {}), drain]).then(() => {});
  }

  #renderBlock(block) {
    // per-block serialization: the RENDER protocol's reply key is the block
    // id, so two in-flight renders of the same block (different galleys, two
    // pump lanes) would collide in the waiter table
    this.renderLocks ??= new Map();
    const prev = this.renderLocks.get(block.id) ?? Promise.resolve();
    const run = prev.then(() => this.#renderBlockInner(block));
    this.renderLocks.set(
      block.id,
      run.catch(() => {})
    );
    return run;
  }

  async #renderBlockInner(block) {
    const idx = this.blocks.indexOf(block);
    if (idx < 0 || !block.galley) return; // superseded (reboot nulls galleys)
    // one render per (block, content); stale results are discarded so a
    // fast typist never sees an outdated exact image over live glyphs
    const forGalley = block.galleyHash;
    // only the pages whose chunks are missing/stale — a fresh set is free
    const targets = this.#chunkTargets(block).filter(
      (t) => this.chunks.get(t.key)?.forGalley !== forGalley
    );
    if (!targets.length) {
      this.#releaseRenderHold(idx);
      return;
    }
    if (this.pdfOpenedAtRoot) {
      // resident children share hyperref's open PDF fd and cannot ship.
      // Fire-and-forget into the idle-gated isolated queue — it must NOT
      // occupy a pump lane (its gate can stay closed for minutes while
      // rescues/canonical churn, and each compile is minutes on
      // package-heavy documents). Meanwhile the canonical-crop pass
      // (#cropCanonicalChunks) supplies exact pixels for these blocks.
      this.#renderIsolated(block, idx);
      return;
    }
    const ck = this.checkpoints.get(idx);
    if (!ck) {
      // checkpoint retired off the grid (long documents keep ~64): the
      // resident RENDER path needs the state AT this block, so fall back to
      // the isolated render. Fire-and-forget — its queue is idle-gated and
      // self-serialized, and it must never occupy a pump lane (the lane has
      // to stay free for the fast resident renders of just-edited blocks).
      this.#renderIsolated(block, idx);
      return;
    }
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
    // renders are latency work, not correctness work (canonical always
    // wins): give up quickly on a spinning child rather than parking a
    // pump lane on it
    this.renderPids ??= new Map();
    this.renderPids.set(block.id, 0); // armed: FORKED will fill the pid
    const done = this.#await('render:' + block.id, Number(process.env.TDOM_RENDER_TIMEOUT || 20_000));
    ck.send(`RENDER ${block.id} ${jobdir} ${body.length}\n`);
    ck.sendRaw(body);
    try {
      await done;
    } catch (err) {
      if (/timeout/.test(String(err?.message))) {
        // deep-lineage luatexja wall: the forked render child spins in
        // luahbtex exactly like in-chain jobs do. Kill it (it never reads
        // its socket again) and let the canonical-crop pass supply the
        // exact pixels instead.
        const pid = this.renderPids.get(block.id);
        if (pid) {
          try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
        }
        // exact pixels still arrive two ways: the canonical-crop pass, or
        // (for drifting documents it cannot serve) the idle-gated isolated
        // queue — a fresh process typesets wall blocks at normal speed
        this.#renderIsolated(block, idx);
      }
      throw err;
    } finally {
      this.renderPids.delete(block.id);
    }
    const pdf = path.join(jobdir, 'driver.pdf');
    // DONE fires from finish_pdffile, but the child's stdio buffers reach
    // the disk only on _exit — wait until the file is complete (%%EOF)
    await waitForPdf(pdf);
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
      // fresh chunks (or a superseding edit) end the checkpoint's reprieve
      if (
        this.blocks[idx] !== block ||
        !this.#chunkTargets(block).some((t) => this.chunks.get(t.key)?.forGalley !== block.galleyHash)
      ) {
        this.#releaseRenderHold(idx);
      }
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

  /**
   * Isolated renders are the LOWEST-priority work in the system: a full
   * preamble compile (~minutes on package-heavy documents) per gfx block,
   * purely to upgrade the provisional preview's block chunks. The canonical
   * layer already guarantees exact final pixels, so these must never
   * compete with typing (rescue queue), the canonical compile, or an edit
   * burst — CPU saturation here slows the resident fork jobs by orders of
   * magnitude.
   */
  async #renderIdleGate() {
    for (;;) {
      const busy =
        this.rescueQueue.size > 0 ||
        this.canonical.info().inFlight ||
        Date.now() - (this.lastEditAt ?? 0) < 3000;
      if (!busy) return;
      await new Promise((r) => setTimeout(r, 500));
    }
  }

  async #renderIsolatedInner(block, idx) {
    await this.#renderIdleGate();
    if (!block.galley || !this.blocks.includes(block)) return; // superseded (reboot nulls galleys)
    const forGalley = block.galleyHash;
    // a full-preamble compile is minutes on package-heavy documents: never
    // pay it when every chunk is already fresh (idle-gate wait races)
    if (!this.#chunkTargets(block).some((t) => this.chunks.get(t.key)?.forGalley !== forGalley)) {
      return;
    }
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
        'tdom_iso_feet={} tdom_iso_nfeet=0 ' +
        'function tdom_iso_float() local b = tex.box[tdom_iso_fbox] ' +
        'if b then tdom_iso_nf = tdom_iso_nf + 1 tdom_iso_floats[tdom_iso_nf] = node.copy_list(b) end end ' +
        'function tdom_iso_load_box(b) ' +
        'tex.box[255] = b ' +
        'tex.pagewidth = math.max(b.width or 0, 65536) ' +
        'tex.pageheight = math.max((b.height or 0) + (b.depth or 0), 65536) end ' +
        'function tdom_iso_load_float(i) local b = tdom_iso_floats[i] ' +
        'if not b then return end tdom_iso_floats[i] = false tdom_iso_load_box(b) end ' +
        'function tdom_iso_load_foot(i) local b = tdom_iso_feet[i] ' +
        'if not b then return end tdom_iso_feet[i] = false tdom_iso_load_box(b) end ' +
        // page map matches the resident RENDER path: galley, floats,
        // then footnote insert bodies
        'function tdom_iso_ship_floats() ' +
        'local BS = string.char(92) ' +
        'local lines = {} ' +
        'for i = 1, tdom_iso_nf do ' +
        "table.insert(lines, BS .. 'directlua{tdom_iso_load_float(' .. i .. ')}') " +
        "table.insert(lines, BS .. 'shipout' .. BS .. 'box255') end " +
        'for i = 1, tdom_iso_nfeet do ' +
        "table.insert(lines, BS .. 'directlua{tdom_iso_load_foot(' .. i .. ')}') " +
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
          // footnote bodies ship as their own pages after the floats (kept
          // even when empty so page indices stay aligned with the galley's
          // ins items)
          'if n.id == INS then local c = n.head or n.list ' +
          'local b if c then b = node.vpack(node.copy_list(c)) else b = node.new("hlist") end ' +
          'tdom_iso_nfeet = tdom_iso_nfeet + 1 tdom_iso_feet[tdom_iso_nfeet] = b ' +
          'node.free(n) else if tail then tail.next = n n.prev = tail else out = n end tail = n end n = nxt end ' +
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
      // lowest-priority CPU: see #isoCompile
      await execFileP('nice', ['-n', '15', 'lualatex', '-interaction=nonstopmode', 'iso.tex'], {
        cwd: jobdir,
        timeout: 90_000,
      }).catch(() => {});
      const pdf = path.join(jobdir, 'iso.pdf');
      if (!existsSync(pdf)) throw new Error('isolated render produced no PDF');
      await waitForPdf(pdf); // %%EOF flushed before pdftocairo reads it
      // same page map as the resident RENDER path: galley, floats, feet
      const targets = this.#chunkTargets(block).filter(
        (t) => this.chunks.get(t.key)?.forGalley !== forGalley
      );
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
    // toc drift: an async landing (header job, rescue offsets, chunk
    // adoption) moved provisional page numbers AFTER the last toc pass —
    // the \tableofcontents blocks would keep printing the older numbers
    // (the one identity gap the farm's incremental-vs-scratch check kept
    // finding). Queue the settle pass; #chainAfterPass runs the toc
    // fixpoint once the stream is quiet.
    if (this.mode === 'structured' && !this.pendingChain) {
      const consumer = this.blocks.findIndex((b) => b.consumesToc);
      if (consumer >= 0 && this.#computeToc(pages).hash !== this.tocHash) {
        this.#queueChainWork('settle', consumer, []);
        this.#scheduleBackground(consumer, []);
      }
    }
  }

  // --------------------------------------------------------------- units

  #paginateNow() {
    this.#rebuildUnits();
    const prev = this._pageRun;
    const seq = this.blocks.map((b) => b.units ?? EMPTY_UNITS);
    // memo: repeated paginations inside one update (toc pass, offset
    // check, async repaints) are free when no block's units changed
    if (prev && prev.geoRef === this.geometry && sameUnitSeq(prev.seq, seq)) {
      return prev.pages;
    }
    const stream = [];
    const offsets = new Array(seq.length);
    for (let i = 0; i < seq.length; i++) {
      offsets[i] = stream.length;
      const u = seq[i];
      for (let j = 0; j < u.length; j++) stream.push(u[j]);
    }
    let incr = null;
    if (prev && prev.geoRef === this.geometry) {
      // common prefix/suffix of the per-block unit arrays: the builder
      // resumes before the first divergence and resyncs in the suffix
      const old = prev.seq;
      let p = 0;
      while (p < old.length && p < seq.length && old[p] === seq[p]) p++;
      let s = 0;
      while (s < old.length - p && s < seq.length - p && old[old.length - 1 - s] === seq[seq.length - 1 - s]) s++;
      const dirtyFromSi = p < offsets.length ? offsets[p] : stream.length;
      const suffixStartNew = seq.length - s < offsets.length ? offsets[seq.length - s] : stream.length;
      const suffixStartOld =
        old.length - s < prev.offsets.length ? prev.offsets[old.length - s] : prev.streamLen;
      incr = {
        prevRun: prev.run,
        dirtyFromSi,
        suffixStartNew,
        suffixShift: suffixStartNew - suffixStartOld,
      };
    }
    const pages = buildPages(stream, this.geometry, incr);
    this._pageRun = {
      geoRef: this.geometry,
      seq,
      offsets,
      streamLen: stream.length,
      run: pages.__run,
      pages,
    };
    return pages;
  }

  #rebuildUnits() {
    for (const block of this.blocks) {
      // the sig carries chunk VERSION and FRESHNESS (stale chunks are
      // displayed too — see buildStream — so a stale→fresh flip must
      // rebuild) plus the fidelity epoch (font-tier demotions)
      const chunkSig = (key) => {
        const c = this.chunks.get(key);
        return c ? `${c.v}${c.forGalley === block.galleyHash ? 'F' : 'S'}` : '0';
      };
      const floatVs = (block.galley?.floats ?? [])
        .map((f) => chunkSig(block.id + '#' + f.n))
        .join(',');
      const insVs = (block.galley?.items ?? [])
        .filter((it) => it.k === 'ins')
        .map((_, k) => chunkSig(`${block.id}@fn${k}`))
        .join(',');
      const sig = `${block.galleyHash}|${chunkSig(block.id)}|${floatVs}|${insVs}|${this.fidelityEpoch}`;
      if (!block.units || block.unitsSig !== sig) {
        block.units = buildStream(block, this.chunks);
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
      // same stable-key rewrite as galleys (lineage-independent identity)
      const fkeys = new Map();
      for (const [fid, meta] of Object.entries(payload.fonts ?? {})) {
        const key = stableFontKey(meta);
        fkeys.set(Number(fid), key);
        this.#registerFont(key, meta);
      }
      const rewrite = (r) => {
        if (r.rule || r.f == null) return;
        const key = fkeys.get(r.f);
        if (key) r.f = key;
      };
      const map = new Map();
      for (const [pageStr, entry] of Object.entries(payload.hf ?? {})) {
        walkItemRuns(entry.h, rewrite);
        walkItemRuns(entry.f, rewrite);
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
        st: gfxOpen.stale ? 1 : undefined, // stale-exact: previous pixels held
        src: gfxOpen.blockId,
      });
      gfxOpen = null;
    };

    let ownsPage = false; // a real shipped page (iso `full` chunk) carries
    // its own page style — no provisional folio/header on top of it
    for (const entry of page.draw ?? []) {
      const u = entry.u;
      const baseline = T + entry.y;
      if (u.ln.gfxChunk) {
        const c = u.ln.gfxChunk;
        if (c.full) ownsPage = true;
        const unitTop = baseline - u.ln.boxH;
        const chunkTop = unitTop - c.yOff;
        const clip0 = c.yOff;
        const clip1 = c.yOff + u.h + (u.d ?? 0);
        if (gfxOpen && gfxOpen.blockId === c.blockId && Math.abs(gfxOpen.top - chunkTop) < 0.05) {
          gfxOpen.clip1 = Math.max(gfxOpen.clip1, clip1);
          gfxOpen.stale ||= !!c.stale;
        } else {
          flushGfx();
          gfxOpen = { blockId: c.blockId, top: chunkTop, clip0, clip1, w: c.w, stale: !!c.stale };
        }
        continue;
      }
      flushGfx();
      if (u.cn) {
        // canonical-only band (margin-bearing blocks): blank in the
        // provisional layer, the canonical page supplies the pixels —
        // advertised so the referee counts real lines here as covered
        commands.push({
          op: 'canon',
          x: r2(L),
          y: r2(baseline - u.ln.boxH),
          w: r2(geo.textwidth),
          h: r2(u.ln.boxH + (u.d ?? 0)),
          src: u.blockId,
        });
        continue;
      }
      this.#runCommands(commands, u.ln.runs, L, baseline, u.blockId);
    }
    flushGfx();
    // Header / footer: TeX-typeset boxes from the page-style job (the exact
    // \@oddhead/\@oddfoot with the page's real folio format, style and
    // marks). \@outputpage geometry: head box bottom at topmargin+headheight,
    // foot baseline \footskip below the text area.
    const hfEntry = ownsPage ? null : this.hf?.get(page.number);
    if (hfEntry) {
      this.#paintHfItems(commands, hfEntry.h, L, 72 + (geo.topmargin ?? 0) + (geo.headheight ?? 0));
      this.#paintHfItems(commands, hfEntry.f, L, T + geo.textheight + (geo.footskip ?? 30));
    } else if (!ownsPage) {
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
function buildStream(block, chunks) {
  const galley = block.galley;
  const items = galley?.items ?? [];
  const floats = galley?.floats ?? [];
  const fid = block.fidelity;
  // Fidelity display policy (best available first):
  //   fresh chunk > STALE chunk (the previous edit's TeX pixels — old but
  //   clean) > glyph bridge (only where every glyph is at least mappable)
  //   > blank (no-bridge lines, canonical-only blocks).
  // A fast-but-wrong display is never an option; a ~100ms-old exact one is.
  const bc = chunks.get(block.id);
  const bcFresh = !!bc && bc.forGalley === block.galleyHash;
  const blockExact = !!(block.gfx || fid?.blockExact);
  const canonicalOnly = !!fid?.canonicalOnly;

  const stream = [];
  let li = 0;
  let yOff = 0;
  let insOrdinal = 0;

  const makeFloat = (n) => {
    const f = floats.find((x) => x.n === n);
    if (!f) return null;
    const chunkKey = block.id + '#' + f.n;
    const fc = chunks.get(chunkKey);
    const ffid = fid?.floats?.get(f.n);
    const wantExact = !canonicalOnly && !!(f.gfx || ffid?.exact);
    const chunkRef =
      wantExact && fc
        ? { key: chunkKey, w: f.w, stale: fc.forGalley === block.galleyHash ? undefined : 1 }
        : null;
    const suppress = canonicalOnly || (wantExact && !fc && !!ffid?.noBridge);
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
      units: miniUnits(f.items, block.id, chunkRef, suppress),
    };
  };

  for (let ii = 0; ii < items.length; ii++) {
    const it = items[ii];
    if (it.k === 'glue') {
      stream.push({ t: 'glue', a: it.a ?? 0, st: it.st ?? 0, sto: it.sto ?? 0, sh: it.sh ?? 0, sho: it.sho ?? 0, sub: it.sub ?? 0 });
      yOff += it.a ?? 0;
    } else if (it.k === 'kern') {
      stream.push({ t: 'kern', a: it.a ?? 0 });
      yOff += it.a ?? 0;
    } else if (it.k === 'pen') {
      stream.push({ t: 'pen', v: it.v ?? 0 });
    } else if (it.k === 'ins') {
      // footnote bodies get their own chunk pages (RENDER pages after the
      // floats) when the fidelity gate flags them
      const k = insOrdinal++;
      const ifid = fid?.ins?.get(k);
      const chunkKey = `${block.id}@fn${k}`;
      const ic = chunks.get(chunkKey);
      const wantExact = !canonicalOnly && !!ifid?.exact;
      const chunkRef =
        wantExact && ic
          ? { key: chunkKey, w: ic.wBp, stale: ic.forGalley === block.galleyHash ? undefined : 1 }
          : null;
      const suppress = canonicalOnly || (wantExact && !ic && !!ifid?.noBridge);
      stream.push({
        t: 'ins',
        h: it.h ?? it.hc ?? 0,
        d: it.d ?? 0,
        hc: it.hc ?? it.h ?? 0,
        units: miniUnits(it.items, block.id, chunkRef, suppress),
      });
    } else if (it.k === 'fm') {
      const f = makeFloat(it.n);
      if (f) stream.push({ t: 'fm', f, vmode: true });
    } else if (it.k === 'eject') {
      stream.push({ t: 'eject', v: it.v ?? -10000 });
    } else if (it.k === 'enlarge') {
      // \enlargethispage marker: grows the CURRENT page's goal in the page
      // builder at exactly this stream position
      stream.push({ t: 'enlarge', a: it.a ?? 0, star: it.star ?? 0 });
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
      // fidelity verdict for THIS line: exact-required lines map into the
      // block chunk (fresh, or stale until the new one lands ~100ms later);
      // safe lines stay pure glyphs. Rescued blocks carry per-item chunk
      // refs (multi-page isolated renders) which take precedence.
      const flags = fid?.itemFlags?.[ii] ?? 0;
      const wantExact = !canonicalOnly && (blockExact || (flags & 1) !== 0);
      let gfxChunk = null;
      if (it.chunk) {
        gfxChunk = { blockId: it.chunk, yOff: it.coff ?? 0, w: chunks.get(it.chunk)?.wBp ?? galley.w };
        if (it.full) gfxChunk.full = 1; // real shipped page: owns folio/hf
      } else if (wantExact && bc) {
        gfxChunk = { blockId: block.id, yOff, w: galley.w, stale: bcFresh ? undefined : 1 };
      }
      // no exact pixels yet: mappable glyphs may bridge the render latency;
      // unmappable ones (and verification-demoted blocks) show nothing
      // rather than something wrong
      const lineNoBridge =
        canonicalOnly || (flags & 2) !== 0 || (blockExact && !!fid?.noBridge);
      const suppress = !gfxChunk && (canonicalOnly || (wantExact && lineNoBridge));
      const unit = {
        blockId: block.id,
        li: li++,
        h: it.h ?? 0,
        d: it.d ?? 0,
        // canonical-only band: the blank keeps the layout, the canonical
        // page shows through — the display list advertises the band (op
        // 'canon') so referees count real-PDF lines there as covered
        cn: !gfxChunk && canonicalOnly ? 1 : undefined,
        ln: {
          descent: it.d ?? 0,
          boxH: it.h ?? 0,
          runs: suppress ? [] : (it.runs ?? []),
          gfxChunk,
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

/** Convert a captured mini-galley (float body, footnote text) to draw
 * units. `suppress` blanks the glyph runs when the fidelity gate forbids a
 * glyph bridge and no exact chunk has landed yet. */
function miniUnits(items, blockId, chunkRef, suppress = false) {
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
        runs: suppress && !chunkRef ? [] : (it.runs ?? []),
        gfxChunk: chunkRef
          ? { blockId: chunkRef.key, yOff: y, w: chunkRef.w, stale: chunkRef.stale }
          : null,
      },
    });
    y += (it.h ?? 0) + (it.d ?? 0);
  }
  return units;
}

/**
 * True when the block's galley plausibly already reflects the label's
 * current value (cheap check: the rendered text contains the value and no
 * unresolved ?? marker for it).
 */
function resolvedInGalley(block, key, labelTable) {
  // Exact bookkeeping, not text matching: every galley records the label
  // values that were injected when it was typeset (tdomRefVals, from
  // #jobBlock/#isoCompile). The ref is resolved iff the recorded value
  // equals the live one. The old substring-over-rendered-text heuristic
  // false-positived whenever the new value (almost always a small integer)
  // happened to appear ANYWHERE in the block — e.g. a block reading
  // "section 3 … equation (2)" was deemed resolved for an equation label
  // moving 2→3, and kept its stale (2) forever (corpus/06 fuzz seed 1).
  const rv = block.galley?.tdomRefVals;
  if (!rv || !Object.prototype.hasOwnProperty.call(rv, key)) return false;
  return rv[key] === labelTable.get(key);
}

function resolveFont(name) {
  try {
    return execFileSync('kpsewhich', [name], { encoding: 'utf8' }).trim();
  } catch {
    return '';
  }
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

const EMPTY_UNITS = [];

function sameUnitSeq(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function push2(list, kind, key, blockId) {
  let entry = list.find((e) => e.kind === kind && e.key === key);
  if (!entry) {
    entry = { kind, key, affected: [] };
    list.push(entry);
  }
  if (!entry.affected.includes('blk-' + blockId)) entry.affected.push('blk-' + blockId);
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
