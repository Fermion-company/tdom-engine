import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { SourceStore } from '../source-store.js';
import { CanonicalRenderer } from './canonical.js';

export function initializeEngineState(
  engine,
  { workDir, docDir, baseCounters, makeShipping, onCanonicalResult }
) {
  engine.workDir = path.resolve(workDir);
  engine.docDir = docDir ? path.resolve(docDir) : engine.workDir;
  mkdirSync(engine.workDir, { recursive: true });
  engine.store = new SourceStore();
  engine.file = 'main.tex';
  engine.blocks = [];
  engine.idSeq = 1;
  engine.rev = 0; // patch-stream ordering (advances on async repaints too)
  engine.srcRev = 0; // SOURCE revisions only — what canonical compiles chase

  engine.server = null;
  engine.port = 0;
  engine.root = null; // ChildProcess of the root lualatex
  engine.checkpoints = new Map(); // idx -> Peer (state after blocks[0..idx-1])
  engine.peers = new Set();
  engine.waiters = new Map(); // key -> {resolve, reject, timer}

  engine.geometry = null;
  engine.counters = [...baseCounters];
  engine.preHash = null;
  engine.labelTable = new Map(); // key -> value (for reboot injection)
  engine.hrefTable = new Map(); // key -> hyperref anchor (\@currentHref at \label)
  // incremental label/ref bookkeeping — the hot path must never scan
  // every block × every label (O(L×B) melts on long documents)
  engine.blockLabelIdx = new Map(); // blockId -> [label keys its galley defines]
  engine.blockRefIdx = new Map(); // blockId -> [label keys its galley references]
  engine.labelCount = new Map(); // label key -> number of defining blocks
  engine.refIndex = new Map(); // label key -> Set<blockId> of referencing blocks
  engine.vanishedLabels = new Set(); // keys whose defining count dropped to 0
  engine.fonts = new Map(); // fid -> {file,name,size,fmt, family, remap}
  engine.fontFiles = new Map(); // familyKey -> absolute path
  engine.pages = [];
  engine.chunks = new Map(); // chunkKey -> {svg, wBp, hBp, v} exact renders
  engine.isoCache = new Map(); // rescue key -> isolated compile result
  engine.isoFailCache = new Map(); // rescue key -> error message (doomed compiles: same inputs fail the same way — don't pay the preamble again on every chain pass over a frozen block)
  engine.isoForkBroken = new Set(); // block ids whose iso fork children die (tcolorbox-class fork/dormant incompatibility) — go straight to cold
  engine.dyingPids = new Set(); // DIE'd checkpoint pids not yet exited — #reapDying backpressure
  engine.poisoned = new Map(); // block.id -> fnv1a(text) that failed in-chain
  engine.hf = new Map(); // page number -> {h: items, f: items} TeX-typeset header/footer
  engine.hfSig = null; // page-spec signature the current hf map was built for
  engine.hfPending = null; // spec signature of an in-flight header job
  engine.initialStyle = 'plain'; // \pagestyle in effect at \begin{document}
  engine.bgAbort = false;
  engine.bgActive = false; // a background pass holds the chain lock right now
  engine.bgTask = Promise.resolve();
  engine.onAsyncPatches = null; // callback(report-ish) for gfx swaps
  engine.onExternalChange = null; // callback when an \input file changes
  engine.backendName = 'checkpoint';
  engine.diagnostics = [];
  engine.tocHash = null;
  engine.includes = new Map(); // path -> {mtime, text}
  engine.watchers = new Map(); // path -> FSWatcher
  // Resident-fork budget. Every checkpoint is a live lualatex process
  // (~100-300MB unique RSS on package-heavy preambles), so N engines on a
  // big document multiply into real RAM: 64 forks × 2 audit engines ×
  // stress preamble ≈ machine death by OOM kill wave (observed: macOS
  // took down the server AND the editor session). Audit tools run with a
  // reduced budget via this env; sparse grids only cost ~3ms replay per
  // skipped block on resume.
  engine.maxCheckpoints = Math.max(4, Number(process.env.TDOM_MAX_CHECKPOINTS || 64));

  // canonical layer: the exact-output authority (see file header)
  engine.canonical = new CanonicalRenderer({
    workDir: path.join(engine.workDir, 'canonical'),
    docDir: engine.docDir,
  });
  engine.canonical.onResult = onCanonicalResult;
  engine.onCanonical = null; // callback(info) for the server's SSE fanout

  // shipping chain: the INCREMENTAL authority (goal "invisible canonical",
  // phase 1). Feature-flagged while the ja long-document numbers are
  // gathered; the cold canonical stays as the demand-paced final audit.
  engine.onShipPage = null; // callback({page, gen, srcRev}) for SSE fanout
  engine.shipGenRev = new Map(); // wave generation -> srcRev it converges to
  engine.shipBootedFor = null; // preamble hash the chain booted with
  engine.shipStale = false; // a label diverged from its seed: cold owns truth
  engine.shipBooting = false;
  engine.shipBootTimer = null;
  engine.shipLabelOverrides = new Map(); // ship-observed truth for reseeding
  engine.shipBootTries = 0; // bounded per preamble: a reboot loop burns CPU
  engine.shipping = process.env.TDOM_SHIP === '1' ? makeShipping() : null;
  engine.mode = 'structured'; // 'structured' | 'opaque'
  engine.modeReasons = [];
  engine.opaqueStickyPre = null; // preamble hash a dynamic demotion sticks to
  engine.verifyState = null; // last exactness-verification outcome

  // stale-first rescue machinery: exact isolated compiles are queued and
  // run OFF the editing hot path; the chain lock serializes everything
  // that touches the resident checkpoint chain (updates, background chain
  // rebuild, async rescue adoption)
  engine.chainLock = Promise.resolve();
  engine.rescueQueue = new Map(); // block.id -> cacheKey at queue time
  engine.rescuePumping = false;
  engine.isoChildren = new Set(); // in-flight isolated lualatex processes

  // visual fidelity gate state (fidelity.js): verification demotions are
  // sticky per (block, text) — a region caught diverging never uses the
  // glyph layer again until its source changes
  engine.fidelityDemoted = new Map(); // block.id -> {hash, level:'exact'|'canonical'}
  engine.demotedFamilies = new Set(); // font family keys the browser failed to load
  engine.fidelityEpoch = 0; // bumped when font tiers change (busts unit sigs)
  // high-fidelity chunk queue: latest-wins per block, LIFO across blocks
  // (the block just edited gets its exact pixels first), small
  // concurrency so an edit burst never forks a render storm
  engine.renderWant = new Map(); // block.id -> queue marker
  engine.renderPumping = 0;
  engine.renderTask = Promise.resolve();
  engine.renderHold = new Map(); // ckpt idx kept alive for a pending render -> block.id
  // Edit-locus pinning: the checkpoints at (and right after) the block the
  // user is typing in are exempt from grid retirement, so a keystroke burst
  // is always "fork once + typeset one block", never a grid replay.
  engine.editHold = []; // boundary indices (most recent loci, capped)
  // Deferred chain work (the ONLY background chain activity): 'rebuild'
  // re-typesets the suffix serially (definition edits, untracked-state
  // leaks). Idle-gated, preemptible, resumable — see #runChainPass.
  engine.pendingChain = null; // {kind:'rebuild', from, phase:'blocks'|'after', labels:Set}
}
