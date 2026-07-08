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
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, renameSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { SourceStore } from '../source-store.js';
import { fnv1a } from '../hash.js';
import { segmentBody, documentBounds, diffBlocks } from '../segmenter.js';
import { reconcile } from './pagebuilder.js';
import { CanonicalRenderer } from './canonical.js';
import { ensureShim } from './forkshim.js';
import { acceptPeer } from './peer-accept.js';
import { handlePeerMessage } from './peer-message.js';
import { closeEngine } from './lifecycle.js';
import { Timer } from './timer.js';
import { buildDisplayList } from './display-list.js';
import { buildDomSnapshot, buildFidelitySummary } from './inspector.js';
import { computeToc, pageSpecs, hfJobBody } from './page-metadata.js';
import { chunkTargets } from './chunk-targets.js';
import { paginateNow, rebuildUnits } from './units.js';
import { expandIncludes, watchInclude } from './include-expander.js';
import { needsRescue } from './rescue-classifier.js';
import { scheduleHeaders as scheduleHeadersHelper } from './header-scheduler.js';
import {
  normalizeGalleyFonts,
  registerFont,
  demoteFontFamily as demoteRegisteredFontFamily,
} from './font-registry.js';
import { applyFidelity } from './fidelity-gate.js';
import { indexBlock, unindexBlock } from './block-index.js';
import { rescueCacheKey, isoCacheGet, isoCacheSet } from './rescue-cache.js';
import { mayNeedRender, releaseRenderHold } from './render-hold.js';
import { collectFrozenBlockIds, collectFrozenBlocks } from './frozen-blocks.js';
import { source, displayLists, geometry, fontFile, fontManifest, chunkSvg } from './public-accessors.js';
import { compareCanonicalText } from './canonical-verification.js';
import { canonicalCropMetrics, canonicalBlockBands, leadingGalleySkip } from './canonical-crop.js';
import { firstDirtyIndex, hasDefinitionEdit, nextEditHold } from './update-helpers.js';
import { buildPagePatches } from './page-patches.js';
import {
  flushVanishedLabels,
  labelReferenceCandidates,
  pushLabelDependencies,
} from './reference-deps.js';
import { preserveCheckpointSuffix } from './checkpoint-preservation.js';
import { adoptGalleyBlock } from './galley-adoption.js';
import { checkpointGrid, nearestCheckpoint } from './checkpoint-selection.js';
import { reapDyingPids } from './dying-pids.js';
import {
  enforceCheckpointCap as enforceCheckpointCapHelper,
  retireOffGrid as retireOffGridHelper,
} from './checkpoint-retirement.js';
import { shippingLabelSeed } from './shipping-seeds.js';
import {
  makeShippingChain,
  queueShipBoot as queueShipBootHelper,
  shipUpdate as shipUpdateHelper,
} from './shipping-manager.js';
import { buildUpdateResponse, buildOpaqueUpdateResponse } from './update-response.js';
import { scheduleStructuredReprobe as scheduleStructuredReprobeHelper } from './structured-reprobe.js';
import { teardownResidentTree } from './teardown-tree.js';
import {
  buildDriverSource,
  buildStateJobBody,
  buildVolatilePrelude,
  buildIsoCompileSource,
} from './tex-templates.js';
import { classifyDocument } from './safety.js';
import { cropSvg, cropSvgAt } from './util/svg.js';
import {
  luaStr,
  braceImbalance,
  labelDefBody,
  extractBraced,
  startsVertical,
  startsAddvspace,
  scanCounterDefs,
  texErrorFrom,
} from './util/tex.js';
import { parseVec, vecCountersEqual, vecLocalsEqual, push2, resolvedInGalley } from './util/galley.js';
import { waitForPdf } from './util/fs.js';

const execFileP = promisify(execFile);
const DIR = path.dirname(fileURLToPath(import.meta.url));

const BASE_COUNTERS = [
  'part', 'chapter', 'section', 'subsection', 'subsubsection', 'paragraph',
  'equation', 'figure', 'table', 'footnote',
];
const HEADING_RE = /^\s*\\(chapter|section|subsection|subsubsection|paragraph)\b/;
const JOB_TIMEOUT = Number(process.env.TDOM_JOB_TIMEOUT || 12_000);
const BOOT_TIMEOUT = 60_000;
// Definition-bearing body edits: a macro/environment/length defined (or
// undefined) in a BODY block can change the meaning of every later block in
// ways the exit-state vector cannot see. Such edits forfeit checkpoint-suffix
// preservation and take the conservative path: serial re-typeset of the
// suffix, off the hot path.
const DEF_RE =
  /\\(def|edef|gdef|xdef|newcommand|renewcommand|providecommand|DeclareRobustCommand|DeclareMathOperator|let|futurelet|newenvironment|renewenvironment|newcounter|newtheorem|newlength|newsavebox|setlength|addtolength|makeatletter|catcode|pagestyle)\b/;

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
    return closeEngine(this);
  }

  getSource() {
    return source(this.store, this.file);
  }

  getDisplayLists() {
    return displayLists(this.pages);
  }

  getGeometry() {
    return geometry(this.geometry);
  }

  getFontFile(key) {
    return fontFile(this.fontFiles, key);
  }

  getFontManifest() {
    return fontManifest(this.fontFiles);
  }

  getChunkSVG(id) {
    return chunkSvg(this.chunks, id);
  }

  getDOM() {
    return buildDomSnapshot({
      rev: this.rev,
      backendName: this.backendName,
      mode: this.mode,
      modeReasons: this.modeReasons,
      canonicalInfo: this.canonical.info(),
      pages: this.pages,
      checkpoints: this.checkpoints,
      blocks: this.blocks,
      chunkTargets: (b) => this.#chunkTargets(b),
      file: this.file,
      position: (file, offset) => this.store.position(file, offset),
      labelTable: this.labelTable,
    });
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
    acceptPeer(this, sock);
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
    handlePeerMessage(this, peer, msg);
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
    return buildDriverSource({
      preamble,
      daemonPath: path.join(DIR, 'daemon.lua'),
      port: this.port,
      workDir: this.workDir,
      counters: this.counters,
      labelTable: this.labelTable,
      hrefTable: this.hrefTable,
      geometry: this.geometry,
    });
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

  #needsRescue(text) {
    const result = needsRescue(text, {
      preHash: this.preHash,
      breakableFor: this._breakableFor,
      breakableRe: this._breakableRe,
      source: () => this.store.get(this.file) ?? '',
    });
    if (result.breakableFor !== this._breakableFor) this._breakableFor = result.breakableFor;
    if (result.breakableRe !== this._breakableRe) this._breakableRe = result.breakableRe;
    return result.needs;
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
  #rescueCacheKey(block, idx) {
    return rescueCacheKey(block, idx, {
      blocks: this.blocks,
      labelTable: this.labelTable,
      preHash: this.preHash,
    });
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
    return collectFrozenBlockIds(this.blocks, this.isoFailCache, (block, idx) => this.#rescueCacheKey(block, idx));
  }

  /** Frozen blocks with their reasons — referees distinguish broken-TeX
   * freezes (no ground truth, equation must be skipped) from the known
   * structural discard class (splitting env needing the real output
   * routine; deterministic on both engines, so the equation still holds
   * and the comparison itself referees them). */
  frozenBlocks() {
    return collectFrozenBlocks(this.blocks, this.isoFailCache, (block, idx) => this.#rescueCacheKey(block, idx));
  }

  #isoCacheGet(key) {
    return isoCacheGet(this.isoCache, key);
  }

  #isoCacheSet(key, iso) {
    isoCacheSet(this.isoCache, key, iso);
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
    return buildVolatilePrelude({
      stateVecJson: this.blocks[idx - 1]?.stateVec,
      counters: this.counters,
      hyperref: this.geometry?.hyperref === 1,
    });
  }

  #stateJobBody(iso) {
    return buildStateJobBody({
      iso,
      counters: this.counters,
      hyperref: this.geometry?.hyperref === 1,
    });
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
    this.#needsRescue(block.text); // populate _breakableRe for this preamble
    const splitMode =
      !/\\includepdf\b/.test(block.text) &&
      (/\\begin\{(mdframed|framed|shaded|longtable|multicols\*?)\}|\\begin\{tcolorbox\}\[[^\]]*breakable/.test(
        block.text
      ) ||
        (this._breakableRe?.test(block.text) ?? false));
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
    // fork children always run the iso absorb: the real routine cannot run
    // against the inherited dormant page state yet (box255/unbox cascades
    // under luatexja). A fork run whose absorb DISCARDS (the env truly had
    // to split at this offset) is retried cold below, where the real
    // routine splits exactly as in print.
    const realOutput = !ck0 && (/\\includepdf\b/.test(block.text) || splitMode);
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
    const prevLsSp = idx > 0 ? prevVec[prevVec.length - 1] ?? 0 : 0;
    const isoTex = buildIsoCompileSource({
      ck0,
      preamble: text.slice(bounds.preamble.start, bounds.preamble.end),
      jobdirForBody,
      labelTable: this.labelTable,
      entry,
      counters: this.counters,
      geometry: this.geometry,
      blockText: block.text,
      prevPd,
      prevNobreak,
      prevLsSp,
      realOutput,
      strut,
    });
    mkdirSync(jobdir, { recursive: true });
    const pdf = path.join(jobdir, ck0 ? 'driver.pdf' : 'iso.pdf');
    const statePath = path.join(jobdir, 'state.json');
    rmSync(pdf, { force: true });
    rmSync(statePath, { force: true });
    writeFileSync(path.join(jobdir, 'iso.tex'), isoTex);
    if (ck0) {
      // fork path: the ISO child chdir's to the jobdir, its lazily-opened
      // PDF (\jobname = driver) and state.json land there, and DONE fires
      // from finish_pdffile like the RENDER protocol
      const isoId = `iso@${fnv1a(jobdir + ':' + Date.now())}`;
      const body = Buffer.from(isoTex, 'utf8');
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
    return checkpointGrid(this.blocks.length, this.maxCheckpoints);
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
    enforceCheckpointCapHelper({
      checkpoints: this.checkpoints,
      grid: this.#ckptGrid(),
      editHold: this.editHold,
      renderHold: this.renderHold,
      dyingPids: this.dyingPids,
    });
  }

  #retireOffGrid(idx) {
    retireOffGridHelper({
      idx,
      grid: this.#ckptGrid(),
      checkpoints: this.checkpoints,
      editHold: this.editHold,
      renderHold: this.renderHold,
      block: this.blocks[idx],
      dyingPids: this.dyingPids,
    });
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
    await reapDyingPids(this.dyingPids, maxDying);
  }

  #mayNeedRender(block) {
    return mayNeedRender(block);
  }

  /** A held checkpoint has served its render (or the hold went stale):
   * resume normal grid retirement. */
  #releaseRenderHold(idx) {
    if (!releaseRenderHold(this.renderHold, idx)) return;
    this.#retireOffGrid(idx);
  }

  #nearestCheckpoint(idx) {
    return nearestCheckpoint(this.checkpoints, idx);
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
    indexBlock(blockId, labels, refs, {
      blockLabelIdx: this.blockLabelIdx,
      labelCount: this.labelCount,
      vanishedLabels: this.vanishedLabels,
      blockRefIdx: this.blockRefIdx,
      refIndex: this.refIndex,
    });
  }

  #unindexBlock(blockId) {
    unindexBlock(blockId, {
      blockLabelIdx: this.blockLabelIdx,
      labelCount: this.labelCount,
      vanishedLabels: this.vanishedLabels,
      blockRefIdx: this.blockRefIdx,
      refIndex: this.refIndex,
    });
  }

  #normalizeGalleyFonts(galley) {
    normalizeGalleyFonts(galley, {
      registerFont: (key, meta) => this.#registerFont(key, meta),
      diagnostics: this.diagnostics,
    });
  }

  #adoptGalley(block, galley) {
    this.#normalizeGalleyFonts(galley);
    this.#indexBlock(
      block.id,
      (galley.labels ?? []).map((l) => l.k),
      galley.refs ?? []
    );
    adoptGalleyBlock(block, galley, {
      counters: this.counters,
      chunks: this.chunks,
      headingRe: HEADING_RE,
      applyFidelity: (b, g) => this.#applyFidelity(b, g),
    });
  }

  #applyFidelity(block, galley) {
    applyFidelity(block, galley, {
      fonts: this.fonts,
      fidelityDemoted: this.fidelityDemoted,
    });
  }

  #registerFont(key, meta) {
    registerFont(key, meta, {
      fonts: this.fonts,
      fontFiles: this.fontFiles,
      demotedFamilies: this.demotedFamilies,
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
    const touched = demoteRegisteredFontFamily(familyKey, {
      demotedFamilies: this.demotedFamilies,
      fonts: this.fonts,
    });
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

    const firstDirty = firstDirtyIndex(oldBlocks, this.blocks, dirtySource, diff);
    // Checkpoint-suffix preservation (docs/10 §I2): boundaries outside the
    // edited window survive the edit. Prefix boundaries are exact; suffix
    // boundaries move by the window's index delta and are marked
    // volatile-stale — a job forked from one re-seeds counters/\prevdepth/
    // \if@nobreak from the orchestrator's stateVec (#volatilePrelude). Only
    // boundaries INSIDE the window die. Whether the suffix may be TRUSTED
    // is decided after the foreground walk (verdict): definition edits and
    // untracked-state leaks still kill and rebuild it, off the hot path.
    ({
      checkpoints: this.checkpoints,
      renderHold: this.renderHold,
      editHold: this.editHold,
    } = preserveCheckpointSuffix({
      checkpoints: this.checkpoints,
      renderHold: this.renderHold,
      editHold: this.editHold,
      pendingChain: this.pendingChain,
      bounds: diff.bounds,
      dyingPids: this.dyingPids,
    }));

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
    const defEdit = hasDefinitionEdit(oldBlocks, this.blocks, diff.bounds, DEF_RE);

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

    flushVanishedLabels(this.vanishedLabels, this.labelCount, this.labelTable, changedLabels);

    // Backward references: a label defined LATER in the chain (new figure,
    // renamed equation...) can be referenced by EARLIER blocks, which the
    // forward pass never revisits. Retypeset those ref-users explicitly —
    // candidates come from the ref index, not a full block scan. With chain
    // work pending, labels are still moving: the async pass runs this after
    // the suffix settles (#chainAfterPass) instead.
    if (changedLabels.size && !this.pendingChain) {
      const candidates = labelReferenceCandidates(changedLabels, this.refIndex);
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

    pushLabelDependencies(depDirty, changedLabels, this.refIndex);

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
    this.editHold = nextEditHold(fgStop, dirtyBlocks, this.blocks, this.editHold);

    // ---- pages, display lists, patches ---------------------------------
    const pagesRaw = this.#paginateNow();
    const { pages, reused, rebuilt } = reconcile(pagesRaw, this.pages);
    const { patches, dirtyPages } = buildPagePatches(pages, this.pages, this.hfSig, (page) =>
      this.#displayList(page)
    );
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
    return buildUpdateResponse({
      rev: this.rev,
      srcRev: this.srcRev,
      editLabel,
      backendName: this.backendName,
      mode: this.mode,
      modeReasons: this.modeReasons,
      canonical: this.canonical.info(),
      dirtySource,
      dirtyBlocks,
      depDirty,
      dirtyPages,
      patches,
      timerStats: t.done(),
      blocks: this.blocks,
      typesetCount,
      forkMs,
      rebooted,
      checkpoints: this.checkpoints,
      verdict,
      pendingChain: this.pendingChain,
      reused,
      rebuilt,
      pages,
      changedLabels,
      verifyState: this.verifyState,
      fidelity: this.#fidelitySummary(),
      diagnostics,
      engineDiagnostics: this.diagnostics,
    });
  }

  /** Inspector counters for the visual fidelity gate. */
  #fidelitySummary() {
    return buildFidelitySummary({
      blocks: this.blocks,
      fidelityDemoted: this.fidelityDemoted,
      demotedFamilies: this.demotedFamilies,
      renderWant: this.renderWant,
    });
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
    return makeShippingChain(this, () => this.#queueShipBoot());
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
      const labelSeed = shippingLabelSeed(this.pages, this.blockLabelIdx, this.labelTable, this.shipLabelOverrides);
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
    queueShipBootHelper(this, () => this.#bootShipping());
  }

  /** Hot-path hook: cheap (a unit diff + one socket line). */
  #shipUpdate(text) {
    shipUpdateHelper(this, text, () => this.#queueShipBoot());
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
    return buildOpaqueUpdateResponse({
      rev: this.rev,
      srcRev: this.srcRev,
      editLabel,
      backendName: this.backendName,
      mode: this.mode,
      modeReasons: this.modeReasons,
      canonical: this.canonical.info(),
      timerStats: t.done(),
      diagnostics: this.diagnostics,
    });
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
    scheduleStructuredReprobeHelper(this, preHash, (args) => this.#update(args));
  }

  /** Free the resident process tree (opaque mode needs none of it). */
  #teardownTree() {
    teardownResidentTree(this);
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
    const cropMetrics = canonicalCropMetrics(geo);
    const bands = canonicalBlockBands(this.pages, cropMetrics.top);
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
      const lead = leadingGalleySkip(block.galley);
      const h = block.galley.h + block.galley.d;
      const w = block.galley.w;
      if (!(h > 0) || !(w > 0)) continue;
      const pageSvg = await this.canonical.pageSVG(band.page, info.id).catch(() => null);
      if (!pageSvg) continue;
      if (this.srcRev !== info.rev) return; // superseded mid-pass
      const prev = this.chunks.get(block.id);
      this.chunks.set(block.id, {
        svg: cropSvgAt(pageSvg, cropMetrics.left, band.top - lead, w, h),
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
    const { mismatches, demote } = compareCanonicalText(this.pages, texts, info.pageCount);
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
    return chunkTargets(block);
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
    const { patches } = buildPagePatches(pages, this.pages, this.hfSig, (page) => this.#displayList(page));
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
    const { pages, pageRun } = paginateNow({
      blocks: this.blocks,
      geometry: this.geometry,
      chunks: this.chunks,
      fidelityEpoch: this.fidelityEpoch,
      pageRun: this._pageRun,
    });
    this._pageRun = pageRun;
    return pages;
  }

  #rebuildUnits() {
    rebuildUnits(this.blocks, this.chunks, this.fidelityEpoch);
  }

  // ----------------------------------------------------- toc / includes

  /**
   * Regenerate the contents files (toc / lof / lot) from the toclines the
   * daemon captured off \addcontentsline — the entries are TeX's own,
   * already expanded with the class's real numbering; the orchestrator
   * substitutes only the page number, which it owns (it builds the pages).
   */
  #computeToc(pages) {
    return computeToc(pages, this.blocks, this.initialStyle);
  }

  // ------------------------------------------------- page-style layer
  //
  // Headers, footers and folios are TeX-typeset, never invented: the daemon
  // captures \pagestyle/\thispagestyle/\pagenumbering/\markboth/\markright
  // as block-anchored events; after pagination the orchestrator reconstructs
  // each page's exact state (folio value + format, style, marks) and a
  // header job typesets the real \@oddhead/\@oddfoot boxes for every page.

  #pageSpecs(pages) {
    return pageSpecs(pages, this.blocks, this.initialStyle);
  }

  #hfJobBody(specs) {
    return hfJobBody(specs);
  }

  #scheduleHeaders() {
    scheduleHeadersHelper(this, {
      pageSpecs: (pages) => this.#pageSpecs(pages),
      hfJobBody: (specs) => this.#hfJobBody(specs),
      awaitGalley: (key, timeout) => this.#await(key, timeout),
      registerFont: (key, meta) => this.#registerFont(key, meta),
      asyncRepaginate: () => this.#asyncRepaginate(),
    });
  }

  #expandIncludes(segs, depth) {
    return expandIncludes(segs, depth, {
      docDir: this.docDir,
      workDir: this.workDir,
      includes: this.includes,
      diagnostics: this.diagnostics,
      watchInclude: (full) => this.#watchInclude(full),
    });
  }

  #watchInclude(full) {
    watchInclude(full, this.watchers, (changed) => this.onExternalChange?.(changed));
  }

  async refresh() {
    return this.#update({ editLabel: 'external-include' });
  }

  #displayList(page) {
    return buildDisplayList(page, {
      geometry: this.geometry,
      chunks: this.chunks,
      hf: this.hf,
      hfSig: this.hfSig,
      fonts: this.fonts,
      twinMetrics: this.twinMetrics,
    });
  }
}

// ------------------------------------------------------------- helpers
