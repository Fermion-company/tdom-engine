// CanonicalRenderer — the exact-output authority.
//
// This layer owns the ONLY definition of "correct display": a real, plain
// lualatex compile of the actual source, run to its aux fixpoint exactly the
// way a user would run it. Everything else in the engine (checkpoint chain,
// JS page builder, glyph display lists) is a provisional preview that this
// layer is allowed to override, never the other way around.
//
// Design constraints, matching the engine's two absolute requirements:
//   - it must NEVER sit on the edit hot path: compiles are debounced,
//     serialized, latest-wins, and run in a child process;
//   - it must converge: after the user stops typing, the newest source is
//     compiled (a compile that was in flight when an edit landed is followed
//     by one more compile of the newest source);
//   - page pixels are produced lazily: the compile makes one PDF, and pages
//     are converted to SVG only when the client actually asks for them
//     (viewport-aware — a 500-page document does not pay 500 pdftocairo
//     runs per keystroke pause);
//   - a failed compile (mid-typing syntax errors) keeps the last good
//     canonical result on screen and reports the TeX error.

import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { promisify } from 'node:util';
import {
  mkdirSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  existsSync,
  rmSync,
  copyFileSync,
  realpathSync,
} from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';
import { fnv1a } from '../hash.js';
import { withProjectInputs } from '../project-inputs.js';
import { buildPdfPaintPage, PDF_PAINT_INDEX_VERSION } from './canonical-paint-index.js';

const execFileP = promisify(execFile);
const MAX_PASSES = 3;
const SVG_CACHE_MAX = 400; // pages kept as SVG strings (LRU)
// Keep the latest result plus three predecessors. A browser may still be
// presenting generation N while generation N+1 is compiling/loading; those
// pixels must continue to resolve against generation N's PDF and SyncTeX.
// The fixed window prevents a long editing session from retaining files
// without bound.
const GENERATION_MAX = 4;

export class CanonicalRenderer {
  constructor({
    workDir,
    docDir,
    overlayDir = null,
    // Structured mode: canonical is the AUTHORITY, consumed when the user
    // is DONE writing for a while or asks for it (export) — never per
    // keystroke, never per short pause. Real writing does not recompile
    // the document every few seconds; the provisional layer owns the live
    // display and is already correct, so canonical is a background
    // confirmation pass. Cadence:
    //   - no compile yet: debounceMs (fast first baseline, one compile)
    //   - after that: idleMs of continuous quiet (a real writing pause,
    //     not a glance at the preview) AND the cost cooldown below.
    // Opaque mode uses displayDebounceMs (canonical IS the display there).
    debounceMs = Number(process.env.TDOM_CANON_DEBOUNCE ?? 2500),
    idleMs = Number(process.env.TDOM_CANON_IDLE ?? 30_000),
    displayDebounceMs = Number(process.env.TDOM_CANON_DISPLAY_DEBOUNCE ?? 350),
  }) {
    const resolvedWorkDir = path.resolve(workDir);
    mkdirSync(resolvedWorkDir, { recursive: true });
    // SyncTeX matches its Input records as strings even on a case-insensitive
    // filesystem.  macOS can expose the same directory as `TeX64` and
    // `tex64`; letting lualatex record one spelling while the server queries
    // the other yields zero anchors. Bind every canonical path to the native
    // realpath before the first compile.
    this.workDir = existingRealpath(resolvedWorkDir);
    this.docDir = docDir ? existingRealpath(docDir) : this.workDir;
    this.overlayDir = overlayDir ? existingRealpath(overlayDir) : null;
    this.debounceMs = debounceMs;
    this.idleMs = idleMs;
    this.displayDebounceMs = displayDebounceMs;
    this.timer = null;
    this.running = null; // in-flight compile promise
    this.pendingJob = null; // {source, rev} superseding the in-flight compile
    this.idSeq = 0;
    this.last = null; // last GOOD compile: {id, rev, srcHash, pdf, pageCount, paper, passes, ms}
    this.lastError = null; // {rev, message}
    // Demand-paced authority (docs/10 §I3): in structured mode the canonical
    // output is consumed when the user is DONE writing or exports — not per
    // edit. Recompiles are paced by their own cost (a cooldown of
    // cooldownFactor × last compile time), which bounds canonical's CPU duty
    // cycle at ~1/(1+factor). The cap exists only so a pathological compile
    // cannot postpone the refresh forever; it must stay far above any real
    // compile time or it silently breaks the duty bound (the old 30s cap put
    // a 60s-compile document at ~2/3 canonical CPU while typing).
    // In opaque mode the compile IS the display: pressure 'display' keeps the
    // short debounce but still paces by cost at half duty — an unpaced
    // display mode recompiled long documents nearly back-to-back.
    this.pressure = 'authority'; // 'authority' | 'display'
    this.lastEndAt = 0;
    this.cooldownFactor = Number(process.env.TDOM_CANON_COOLDOWN ?? 2);
    this.cooldownCapMs = Number(process.env.TDOM_CANON_COOLDOWN_CAP ?? 600_000);
    this.displayCooldownFactor = Number(process.env.TDOM_CANON_DISPLAY_COOLDOWN ?? 1);
    this.displayCooldownCapMs = Number(process.env.TDOM_CANON_DISPLAY_COOLDOWN_CAP ?? 60_000);
    this.generations = new Map(); // id -> retained canonical record, oldest first
    this.svgCache = new Map(); // `${id}:${page}` -> svg string (LRU)
    this.svgInFlight = new Map(); // `${id}:${page}` -> shared conversion promise
    this.textCache = new Map(); // id -> [string] (pdftotext page texts)
    this.textInFlight = new Map(); // id -> shared pdftotext promise
    this.textBoxCache = new Map(); // id -> [[{text,left,top,right,bottom}]]
    this.textBoxInFlight = new Map(); // id -> shared pdftotext -bbox promise
    // pdf.js is opened once per immutable generation and paint-safe pages are
    // extracted lazily. Canonical arrival prewarms the document parser; an
    // edit then pays only the candidate pages, not every page of a 500-page
    // paper. A requested page set is returned atomically or not at all.
    this.pdfJsPromise = null;
    this.pdfDocumentCache = new Map(); // id -> PDFDocumentProxy
    this.pdfDocumentInFlight = new Map(); // id -> shared open promise
    this.paintPageCache = new Map(); // `${id}:${page}` -> paint page
    this.paintPageInFlight = new Map(); // `${id}:${page}` -> shared extraction promise
    // SyncTeX records TeX's pre-PDF coordinates.  `/Rotate` and a page-wide
    // PDF content matrix (notably pdflscape's counter-rotation) are absent
    // from that file, while pdftocairo/pdftotext expose the final displayed
    // page.  Resolve that PDF content matrix lazily per retained page.
    this.syncTransformCache = new Map(); // `${id}:${page}` -> affine matrix | null (unsafe)
    this.syncTransformInFlight = new Map(); // `${id}:${page}` -> shared probe
    this.svgOutputSeq = 0;
    this.onResult = null; // callback({...info}) after every compile attempt
    this.disposed = false;
    this.resetting = false;
    this._texts = null;
    this.children = new Set(); // in-flight lualatex/pdftocairo/pdftotext/pdfinfo
    // Authority-only lualatex children run in private process groups. A live
    // edit can stop those independent groups for the shipping foreground
    // lease without killing a half-written aux workdir. Export and opaque
    // display compiles are never placed in this background set.
    this.authorityChildren = new Set();
    this.authorityPausedPids = new Map(); // pid -> true when signalled as a process group
    this.authorityPausedUntil = 0;
    this.authorityResumeTimer = null;
    // Source text is not the whole compilation input: images, \input files
    // and bibliographies can change without a byte changing in the main
    // buffer.  Capture this epoch in every queued job so those changes
    // invalidate the canonical cache without defeating normal source-hash
    // reuse.
    this.inputEpoch = 0;
  }

  #sourceHash(source, inputEpoch = this.inputEpoch) {
    return fnv1a(`${inputEpoch}\0${source}`);
  }

  #resolveGeneration(id = null) {
    if (this.disposed || this.resetting) return null;
    if (id == null) return this.last;
    const generationId = Number(id);
    if (!Number.isInteger(generationId)) return null;
    return this.generations.get(generationId) ?? null;
  }

  #acquireGeneration(id = null) {
    const generation = this.#resolveGeneration(id);
    if (!generation) return null;
    generation.readers = (generation.readers ?? 0) + 1;
    return generation;
  }

  #releaseGeneration(generation) {
    generation.readers = Math.max(0, (generation.readers ?? 1) - 1);
    if (generation.retired && generation.readers === 0) this.#deleteGenerationFiles(generation);
  }

  #deleteGenerationFiles(generation) {
    if (!generation || generation.filesDeleted) return;
    generation.filesDeleted = true;
    rmSync(generation.pdf, { force: true });
    if (generation.synctex) rmSync(generation.synctex, { force: true });
  }

  #retireGeneration(generation) {
    if (!generation || generation.retired) return;
    generation.retired = true;
    const prefix = `${generation.id}:`;
    for (const key of this.svgCache.keys()) {
      if (key.startsWith(prefix)) this.svgCache.delete(key);
    }
    this.textCache.delete(generation.id);
    this.textBoxCache.delete(generation.id);
    const pdfDocument = this.pdfDocumentCache.get(generation.id);
    this.pdfDocumentCache.delete(generation.id);
    Promise.resolve(pdfDocument?.destroy?.()).catch(() => {});
    for (const key of this.paintPageCache.keys()) {
      if (key.startsWith(prefix)) this.paintPageCache.delete(key);
    }
    for (const key of this.syncTransformCache.keys()) {
      if (key.startsWith(prefix)) this.syncTransformCache.delete(key);
    }
    if ((generation.readers ?? 0) === 0) this.#deleteGenerationFiles(generation);
  }

  #registerGeneration(generation) {
    this.generations.set(generation.id, generation);
    this.last = generation;
    while (this.generations.size > GENERATION_MAX) {
      const oldestId = this.generations.keys().next().value;
      const oldest = this.generations.get(oldestId);
      this.generations.delete(oldestId);
      this.#retireGeneration(oldest);
    }
  }

  #clearGenerations() {
    for (const generation of this.generations.values()) this.#retireGeneration(generation);
    this.generations.clear();
    this.last = null;
    this.svgCache.clear();
    this.svgInFlight.clear();
    this.textCache.clear();
    this.textInFlight.clear();
    this.textBoxCache.clear();
    this.textBoxInFlight.clear();
    for (const document of this.pdfDocumentCache.values()) {
      Promise.resolve(document?.destroy?.()).catch(() => {});
    }
    this.pdfDocumentCache.clear();
    this.pdfDocumentInFlight.clear();
    this.paintPageCache.clear();
    this.paintPageInFlight.clear();
    this.syncTransformCache.clear();
    this.syncTransformInFlight.clear();
  }

  #removeWorkArtifacts() {
    for (const name of readFileNames(this.workDir)) {
      if (/^canon(?:-\d+)?\.(?:aux|bbl|bcf|blg|log|lof|lot|out|pdf|run\.xml|svg|synctex\.gz|tex|toc)$/.test(name) ||
          /^canon-\d+-p\d+(?:-\d+)?\.svg$/.test(name)) {
        rmSync(path.join(this.workDir, name), { force: true });
      }
    }
  }

  async #settleReadJobs() {
    const jobs = new Set([
      ...this.svgInFlight.values(),
      ...this.textInFlight.values(),
      ...this.textBoxInFlight.values(),
      ...this.pdfDocumentInFlight.values(),
      ...this.paintPageInFlight.values(),
      ...this.syncTransformInFlight.values(),
    ]);
    if (jobs.size) await Promise.allSettled([...jobs]);
  }

  /** execFile with child tracking, so dispose() can kill in-flight work —
   * an orphaned canonical lualatex otherwise burns a core for up to its
   * 5-minute timeout after the server exits. */
  #exec(cmd, args, opts, { authority = false } = {}) {
    const p = execFileP(cmd, args, authority ? { ...opts, detached: true } : opts);
    if (p.child) {
      if (authority) {
        this.authorityChildren.add(p.child);
        if (Date.now() < this.authorityPausedUntil) this.#pauseAuthorityChild(p.child);
      }
      const cleanup = () => {
        this.children.delete(p.child);
        this.authorityChildren.delete(p.child);
        this.authorityPausedPids.delete(p.child.pid);
      };
      this.children.add(p.child);
      p.then(cleanup, cleanup);
    }
    return p;
  }

  #pauseAuthorityChild(child) {
    const pid = Number(child?.pid);
    if (!(pid > 0) || this.authorityPausedPids.has(pid)) return;
    try {
      process.kill(-pid, 'SIGSTOP');
      this.authorityPausedPids.set(pid, true);
    } catch {
      // Electron can keep a detached child in the app's inherited process
      // group on macOS. Never signal that shared group: stop the directly
      // tracked lualatex child instead. Canonical does not invoke latexmk,
      // biber or makeindex, and shell escape is disabled on this path.
      try {
        child.kill('SIGSTOP');
        this.authorityPausedPids.set(pid, false);
      } catch {
        /* the compile may have finished between spawn/tracking and the lease */
      }
    }
  }

  #resumeAuthority() {
    clearTimeout(this.authorityResumeTimer);
    this.authorityResumeTimer = null;
    this.authorityPausedUntil = 0;
    for (const [pid, asGroup] of [...this.authorityPausedPids]) {
      try { process.kill(asGroup ? -pid : pid, 'SIGCONT'); } catch { /* already gone */ }
      this.authorityPausedPids.delete(pid);
    }
  }

  /**
   * Give a live complete-PDF replay exclusive heavy-TeX time. Canonical
   * authority is independent and generation-checked, so stopping its process
   * group is safe; we resume the same compile instead of discarding partial
   * aux state or spawning a restart storm.
   */
  deferAuthority(delayMs) {
    if (this.disposed || this.pressure !== 'authority') return false;
    const delay = Math.max(0, Number(delayMs) || 0);
    if (!delay) return false;
    this.authorityPausedUntil = Math.max(this.authorityPausedUntil, Date.now() + delay);
    for (const child of this.authorityChildren) this.#pauseAuthorityChild(child);
    clearTimeout(this.authorityResumeTimer);
    const resumeWhenDue = () => {
      const remaining = this.authorityPausedUntil - Date.now();
      if (remaining > 0) {
        this.authorityResumeTimer = setTimeout(resumeWhenDue, remaining);
        this.authorityResumeTimer.unref?.();
        return;
      }
      this.#resumeAuthority();
    };
    this.authorityResumeTimer = setTimeout(resumeWhenDue, delay);
    this.authorityResumeTimer.unref?.();
    return true;
  }

  /** Public snapshot for /doc payloads, reports and SSE events. */
  info() {
    return {
      rev: this.last?.rev ?? 0,
      id: this.last?.id ?? 0,
      pageCount: this.last?.pageCount ?? 0,
      paper: this.last?.paper ?? null,
      papers: this.last?.papers ?? (this.last?.paper ? [this.last.paper] : []),
      passes: this.last?.passes ?? 0,
      ms: this.last?.ms ?? 0,
      inFlight: !!(this.running || this.timer || this.pendingJob),
      error: this.lastError?.message ?? null,
      errorRev: this.lastError?.rev ?? 0,
      syncWarnings: this.last?.syncWarnings ?? [],
      authorityPaused: this.authorityPausedPids.size > 0,
      authorityChildren: this.authorityChildren.size,
      authorityPauseRemainingMs: Math.max(0, this.authorityPausedUntil - Date.now()),
    };
  }

  /**
   * Debounced, latest-wins scheduling — the ONLY entry point the edit path
   * touches, and it does nothing but store the newest source and arm a
   * timer. The compile itself never blocks an edit.
   */
  schedule(source, rev) {
    if (this.disposed) return;
    // audit runs (fuzz on CI) compare provisional state only — a full
    // lualatex per engine would OOM a 7GB hosted runner for nothing
    if (process.env.TDOM_NO_CANONICAL === '1') return;
    this.pendingJob = { source, rev, inputEpoch: this.inputEpoch };
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      this.#drain();
    }, this.delayFor());
  }

  /**
   * Delay before the next compile may start, measured from the LAST edit
   * (schedule() re-arms the timer on every edit, so this is an idle gate).
   * Authority (structured) mode: one fast baseline compile per document,
   * then nothing until the user has been quiet for idleMs AND the
   * cost-proportional cooldown has passed — active writing never pays a
   * full compile. Display (opaque) mode: short debounce plus a half-duty
   * cost cooldown. Public for tests.
   */
  delayFor() {
    const since = Date.now() - this.lastEndAt;
    if (this.pressure !== 'authority') {
      // opaque mode: canonical IS the display — stay responsive on small
      // documents, but never let a long document compile back-to-back
      if (!this.last?.ms) return this.displayDebounceMs;
      const cool = Math.min(this.last.ms * this.displayCooldownFactor, this.displayCooldownCapMs);
      return Math.max(this.displayDebounceMs, cool - since);
    }
    if (!this.last?.ms) return this.debounceMs; // fast first baseline
    const cooldown = Math.min(this.last.ms * this.cooldownFactor, this.cooldownCapMs);
    return Math.max(this.idleMs, cooldown - since);
  }

  /**
   * Compile now (used by PDF export and tests): skips the debounce, reuses
   * the last good compile when the source is unchanged, and returns the
   * result record (throws when this exact source cannot be compiled).
   * Compiles exactly the snapshot it was handed — it never loop-chases
   * keystrokes that land during the compile (the old settle()-based path
   * ran full compiles back-to-back for as long as the user kept typing
   * during an export). Newer edits stay on the normal cadence timer.
   */
  async ensure(source, rev) {
    let inputEpoch = this.inputEpoch;
    let srcHash = this.#sourceHash(source, inputEpoch);
    if (this.last && this.last.srcHash === srcHash) return this.last;
    while (this.running) await this.running;
    if (this.disposed) throw new Error('renderer disposed');
    inputEpoch = this.inputEpoch;
    srcHash = this.#sourceHash(source, inputEpoch);
    if (this.last && this.last.srcHash === srcHash) return this.last;
    // No await between the check above and this assignment: #drain and
    // ensure both claim `running` synchronously, so two compiles can never
    // share the workdir.
    this.running = this.#compile({ source, rev, inputEpoch })
      .catch((err) => {
        this.lastError = { rev, message: String(err?.message || err) };
      })
      .finally(() => {
        this.running = null;
      });
    await this.running;
    this.lastEndAt = Date.now();
    try {
      this.onResult?.(this.info());
    } catch {
      /* observer errors must not break the export path */
    }
    if (this.last && this.last.srcHash === srcHash) return this.last;
    throw new Error(this.lastError?.message || 'canonical compile failed');
  }

  /** Wait until no compile is queued or running (tests / export). */
  async settle() {
    while (this.timer || this.running || this.pendingJob) {
      if (this.timer) {
        clearTimeout(this.timer);
        this.timer = null;
      }
      await (this.running ?? this.#drain());
    }
  }

  async #drain() {
    if (this.running) return this.running;
    if (!this.pendingJob) return;
    const job = this.pendingJob;
    this.pendingJob = null;
    if (this.last && this.last.srcHash === this.#sourceHash(job.source, job.inputEpoch)) {
      // the newest source is already compiled (an export ran it, or the
      // edits round-tripped back) — record the rev, skip the compile
      this.last.rev = job.rev;
      this.lastError = null;
      try {
        this.onResult?.(this.info());
      } catch {
        /* observer errors must not break the drain loop */
      }
      return;
    }
    this.running = this.#compile({
      ...job,
      // Scheduled authority confirmation is intentionally below the live
      // complete-PDF path. Export (`ensure`) and opaque display compiles stay
      // at normal priority because the user is directly waiting for them.
      background: this.pressure === 'authority',
    })
      .catch((err) => {
        this.lastError = { rev: job.rev, message: String(err?.message || err) };
      })
      .finally(() => {
        this.running = null;
      });
    await this.running;
    this.lastEndAt = Date.now();
    try {
      this.onResult?.(this.info());
    } catch {
      /* observer errors must not break the drain loop */
    }
    // An edit landed while we compiled: converge on the newest source — at
    // the authority cadence, NOT immediately. The old unconditional re-drain
    // ran full compiles back-to-back for as long as the user kept typing,
    // which was the single biggest CPU sink on long documents. settle()
    // still converges promptly for exports/tests (it clears the timer and
    // drains directly).
    if (this.pendingJob && !this.disposed && !this.timer) {
      this.timer = setTimeout(() => {
        this.timer = null;
        this.#drain();
      }, this.delayFor());
    }
  }

  async #compile({ source, rev, inputEpoch = this.inputEpoch, background = false }) {
    const t0 = performance.now();
    const srcHash = this.#sourceHash(source, inputEpoch);
    const tex = path.join(this.workDir, 'canon.tex');
    writeFileSync(tex, source.replace(/\r\n?/g, '\n'), 'utf8');
    const auxFiles = ['canon.aux', 'canon.toc', 'canon.lof', 'canon.lot', 'canon.out'];
    const auxState = () =>
      auxFiles
        .map((f) => {
          try {
            return fnv1a(readFileSync(path.join(this.workDir, f), 'utf8'));
          } catch {
            return 0;
          }
        })
        .join(',');
    let passes = 0;
    let log = '';
    let before = auxState();
    // aux fixpoint, the honest way latexmk does it: rerun while the aux
    // family keeps changing (toc page numbers, forward refs), capped
    while (passes < MAX_PASSES) {
      passes++;
      log = await this.#runLatex(tex, background);
      if (this.disposed) throw new Error('renderer disposed');
      const after = auxState();
      const changed = after !== before;
      before = after;
      if (!changed) break;
    }
    const pdf = path.join(this.workDir, 'canon.pdf');
    const pageCount = pageCountFrom(log);
    if (!existsSync(pdf) || !pageCount) {
      throw new Error(texErrorFrom(log) || 'lualatex produced no PDF');
    }
    // keep the PDF under a per-compile name: a page-SVG request racing the
    // NEXT compile must still read the pixels it was issued against
    const id = ++this.idSeq;
    const kept = path.join(this.workDir, `canon-${id}.pdf`);
    copyFileSync(pdf, kept);
    const synctexSource = path.join(this.workDir, 'canon.synctex.gz');
    const keptSynctex = path.join(this.workDir, `canon-${id}.synctex.gz`);
    const hasSynctex = existsSync(synctexSource);
    if (hasSynctex) copyFileSync(synctexSource, keptSynctex);
    const papers = await pageGeometries(
      kept,
      pageCount,
      (cmd, args, opts) => this.#exec(cmd, args, opts)
    );
    const firstPaper = papers[0] ?? null;
    const seedFiles = {};
    for (const name of auxFiles) {
      const file = path.join(this.workDir, name);
      if (existsSync(file)) seedFiles[path.extname(name).slice(1)] = readFileSync(file, 'utf8');
    }
    const generation = {
      id,
      rev,
      srcHash,
      inputEpoch,
      pdf: kept,
      synctex: hasSynctex ? keptSynctex : null,
      pdfHash: sha256File(kept),
      synctexHash: hasSynctex ? sha256File(keptSynctex) : null,
      pageCount,
      // `paper` remains the legacy first-page shape. `papers` is the exact
      // displayed geometry for every page, including /Rotate orientation.
      paper: firstPaper ? { w: firstPaper.w, h: firstPaper.h } : null,
      papers,
      passes,
      ms: Math.round(performance.now() - t0),
      readers: 0,
      retired: false,
      filesDeleted: false,
      syncWarnings: [],
      // Converged production inputs for a ShippingChain boot. Hyperref's
      // full five-field \newlabel records (including destination anchors)
      // cannot be reconstructed from the renderer's scalar label table.
      seedFiles,
    };
    if (this.disposed) {
      this.#deleteGenerationFiles(generation);
      throw new Error('renderer disposed');
    }
    this.#registerGeneration(generation);
    // Keep PDF import/open off the typing path. This intentionally does not
    // await: canonical pixels are already committed and the index is merely
    // an optional fast-proof accelerator.
    void this.prewarmPaintIndex(id);
    this.lastError = null;
    return generation;
  }

  async #runLatex(tex, background = false) {
    let out = '';
    try {
      const latexArgs = [
        '-synctex=1',
        '-interaction=nonstopmode',
        '-output-directory',
        this.workDir,
        tex,
      ];
      const command = background ? 'nice' : 'lualatex';
      const requestedNice = Number(process.env.TDOM_CANON_NICE ?? 10);
      const niceLevel = Number.isFinite(requestedNice) ? requestedNice : 10;
      const args = background
        ? ['-n', String(niceLevel), 'lualatex', ...latexArgs]
        : latexArgs;
      const r = await this.#exec(
        command,
        args,
        {
          cwd: this.docDir,
          timeout: Number(process.env.TDOM_CANON_TIMEOUT || 300_000),
          maxBuffer: 64 * 1024 * 1024,
          env: withProjectInputs(process.env, {
            docDir: this.docDir,
            overlayDir: this.overlayDir,
            recursive: true,
          }),
        },
        { authority: background }
      );
      out = (r.stdout || '') + (r.stderr || '');
    } catch (err) {
      // nonstopmode exits non-zero on any error but often still ships a
      // usable PDF — the caller decides based on the artifacts
      out = (err.stdout || '') + (err.stderr || '') || String(err.message || err);
    }
    return out;
  }

  /** Resolve the PDF content transform shared by all text on one page.
   *
   * SyncTeX itself knows neither the page dictionary's `/Rotate` nor PDF
   * graphics-state `cm` operators.  A bare `/Rotate 90` therefore needs the
   * page rotation only, while pdflscape needs its page-wide counter-rotation
   * as well. Poppler's PostScript preserves those `cm` operators, so inspect
   * a page only when synchronization first touches it and keep the result for
   * the retained generation. Normal pages never pay this probe. */
  async #syncContentTransform(generation, page) {
    const n = Math.floor(Number(page));
    const paper = generation?.papers?.[n - 1] ?? null;
    if (!paper || !Number(paper.rotation)) return IDENTITY_AFFINE;
    const key = `${generation.id}:${n}`;
    if (this.syncTransformCache.has(key)) return this.syncTransformCache.get(key);
    const pending = this.syncTransformInFlight.get(key);
    if (pending) return pending;

    let job;
    job = (async () => {
      let matrix = IDENTITY_AFFINE;
      let probeFailed = false;
      try {
        const result = await this.#exec('pdftops', [
          '-f', String(n),
          '-l', String(n),
          '-origpagesizes',
          '-level3',
          generation.pdf,
          '-',
        ], {
          timeout: 30_000,
          maxBuffer: 64 * 1024 * 1024,
        });
        matrix = parsePdfGlobalContentTransform(result.stdout || '');
      } catch {
        // `pdftops` ships with Poppler, but rotation-only synchronization is
        // still correct for ordinary `/Rotate` PDFs if it is unavailable.
        matrix = IDENTITY_AFFINE;
        probeFailed = true;
      }
      // On a quarter-turned page, predominantly horizontal Poppler word
      // boxes prove that PDF content counter-rotates the page (pdflscape is
      // the common case). If the matrix probe failed, silently applying only
      // `/Rotate` would open a different source line. Fail closed instead;
      // sparse/ambiguous pages retain the standard bare-/Rotate fallback.
      if ((probeFailed || sameAffine(matrix, IDENTITY_AFFINE)) &&
          (Number(paper.rotation) === 90 || Number(paper.rotation) === 270)) {
        const pages = await this.pageTextBoxes(generation.id).catch(() => null);
        if (pageTextBoxesShowCounterRotation(pages?.[n - 1], paper)) {
          matrix = null;
          generation.syncWarnings = [
            ...(generation.syncWarnings ?? []).filter((warning) => warning.page !== n),
            { page: n, code: 'unresolved-pdf-content-transform' },
          ];
        } else if (probeFailed) {
          generation.syncWarnings = [
            ...(generation.syncWarnings ?? []).filter((warning) => warning.page !== n),
            { page: n, code: 'rotation-only-synctex-fallback' },
          ];
        }
      }
      if (!generation.retired) this.syncTransformCache.set(key, matrix);
      return matrix;
    })().finally(() => {
      if (this.syncTransformInFlight.get(key) === job) this.syncTransformInFlight.delete(key);
    });
    this.syncTransformInFlight.set(key, job);
    return job;
  }

  /** Reverse-map a point in the latest canonical PDF. This is used only
   * when the structured SVG has no data-src target (opaque/canonical-only
   * pages), so SyncTeX adds no work to the typing path. Public x/y are always
   * canonical SVG (displayed, top-left) coordinates. */
  async reverseSync({ page, x, y, id = null } = {}) {
    if (![page, x, y].every(Number.isFinite) || page < 1) return null;
    const cur = this.#acquireGeneration(id);
    if (!cur) return null;
    try {
      if (!cur.synctex) return null;
      const pageNumber = Math.floor(page);
      const paper = cur.papers?.[pageNumber - 1] ?? null;
      const contentTransform = await this.#syncContentTransform(cur, pageNumber);
      if (contentTransform == null) return null;
      const syncPoint = displayedPointToSyncTeX({ x, y }, paper, contentTransform);
      const target = `${pageNumber}:${syncPoint.x}:${syncPoint.y}:${cur.pdf}`;
      const result = await this.#exec('synctex', ['edit', '-o', target], {
        cwd: this.docDir,
        timeout: 15_000,
        maxBuffer: 4 * 1024 * 1024,
        env: process.env,
      });
      return parseSynctexEditOutput(`${result.stdout || ''}\n${result.stderr || ''}`, this.docDir);
    } catch {
      return null;
    } finally {
      this.#releaseGeneration(cur);
    }
  }

  /** Map a source position into the latest canonical PDF.  Direct editing
   * in opaque mode uses the precise `x/y` anchor plus the containing TeX
   * line box; the visible pixels remain the canonical page itself. */
  async forwardSync({ file, line, column = 1, id = null, page = null, x = null, y = null } = {}) {
    const outputs = await this.forwardSyncAll({ file, line, column, id });
    if (![page, x, y].every(Number.isFinite)) return outputs[0] ?? null;
    return outputs
      .filter((item) => item.page === Math.floor(page))
      .sort((a, b) => pointBoxDistance(a.box, x, y) - pointBoxDistance(b.box, x, y))[0] ??
      outputs[0] ?? null;
  }

  async forwardSyncAll({ file, line, column = 1, id = null } = {}) {
    if (!file || !Number.isFinite(line) || line < 1) return [];
    const cur = this.#acquireGeneration(id);
    if (!cur) return [];
    try {
      if (!cur.synctex) return [];
      const input = `${Math.floor(line)}:${Math.max(1, Math.floor(Number(column) || 1))}:${path.resolve(file)}`;
      const result = await this.#exec('synctex', ['view', '-i', input, '-o', cur.pdf], {
        cwd: this.docDir,
        timeout: 15_000,
        maxBuffer: 4 * 1024 * 1024,
        env: process.env,
      });
      const raw = parseSynctexViewOutputs(`${result.stdout || ''}\n${result.stderr || ''}`);
      const transforms = new Map();
      await Promise.all([...new Set(raw.map((item) => item.page))].map(async (pageNumber) => {
        transforms.set(pageNumber, await this.#syncContentTransform(cur, pageNumber));
      }));
      return raw.flatMap((item) => {
        const contentTransform = transforms.get(item.page);
        return contentTransform == null ? [] : [syncTeXResultToDisplayed(
          item,
          cur.papers?.[item.page - 1] ?? null,
          contentTransform ?? IDENTITY_AFFINE
        )];
      });
    } catch {
      return [];
    } finally {
      this.#releaseGeneration(cur);
    }
  }

  /** True only when the supplied resident source is byte-identical to the
   * source/input epoch that produced one retained canonical generation. */
  sourceMatches(source, id = null) {
    const generation = this.#resolveGeneration(id);
    return Boolean(generation && generation.srcHash === this.#sourceHash(source, generation.inputEpoch));
  }

  /** Immutable identity used by anchor tickets and tests. */
  generationCertificate(id = null) {
    const generation = this.#resolveGeneration(id);
    if (!generation) return null;
    return {
      id: generation.id,
      rev: generation.rev,
      srcHash: generation.srcHash,
      inputEpoch: generation.inputEpoch,
      pdfHash: generation.pdfHash,
      synctexHash: generation.synctexHash,
      paintIndexVersion: PDF_PAINT_INDEX_VERSION,
    };
  }

  /** Start the expensive pdf.js import/document parse as soon as canonical
   * lands. Failure is an ordinary fail-closed condition for fast preview. */
  prewarmPaintIndex(id = null) {
    const generation = this.#resolveGeneration(id);
    if (!generation) return Promise.resolve(null);
    return this.#pdfDocument(generation.id).catch(() => null);
  }

  /** Paint-safe pdf.js pages for one immutable generation. The caller gets
   * the whole requested set or null; a partially extracted set is never used
   * as a proof for this request. */
  async pdfPaintPages(id, pageNumbers) {
    const generation = this.#resolveGeneration(id);
    const pages = [...new Set((pageNumbers ?? []).map(Number))];
    if (!generation || !pages.length || pages.some((page) =>
      !Number.isInteger(page) || page < 1 || page > generation.pageCount
    )) return null;
    const results = await Promise.all(pages.map((page) => this.#pdfPaintPage(generation.id, page)));
    if (results.some((page) => !page)) return null;
    if (!this.#resolveGeneration(generation.id)) return null;
    return results;
  }

  async #loadPdfJs() {
    if (this.pdfJsPromise) return this.pdfJsPromise;
    this.pdfJsPromise = (async () => {
      const configured = String(process.env.TDOM_PDFJS_PATH ?? '').trim();
      let module;
      if (configured) {
        const specifier = path.isAbsolute(configured) ? pathToFileURL(configured).href : configured;
        module = await import(specifier);
      } else {
        module = await import('pdfjs-dist/legacy/build/pdf.mjs');
      }
      if (typeof module?.getDocument !== 'function' || !module?.OPS || !module?.Util) {
        throw new Error('pdf.js paint index API unavailable');
      }
      return module;
    })();
    return this.pdfJsPromise;
  }

  #pdfDocument(id) {
    const generation = this.#resolveGeneration(id);
    if (!generation) return Promise.resolve(null);
    if (this.pdfDocumentCache.has(generation.id)) {
      return Promise.resolve(this.pdfDocumentCache.get(generation.id));
    }
    const pending = this.pdfDocumentInFlight.get(generation.id);
    if (pending) return pending;
    let job;
    job = (async () => {
      const pdfjs = await this.#loadPdfJs();
      if (!this.#resolveGeneration(generation.id)) return null;
      const bytes = new Uint8Array(readFileSync(generation.pdf));
      const task = pdfjs.getDocument({
        data: bytes,
        disableWorker: true,
        stopAtErrors: true,
        isEvalSupported: false,
      });
      const document = await task.promise;
      if (!this.#resolveGeneration(generation.id)) {
        await document.destroy().catch(() => {});
        return null;
      }
      this.pdfDocumentCache.set(generation.id, document);
      return document;
    })().catch(() => null).finally(() => {
      if (this.pdfDocumentInFlight.get(generation.id) === job) {
        this.pdfDocumentInFlight.delete(generation.id);
      }
    });
    this.pdfDocumentInFlight.set(generation.id, job);
    return job;
  }

  #pdfPaintPage(id, pageNumber) {
    const generation = this.#resolveGeneration(id);
    if (!generation) return Promise.resolve(null);
    const key = `${generation.id}:${pageNumber}`;
    if (this.paintPageCache.has(key)) return Promise.resolve(this.paintPageCache.get(key));
    const pending = this.paintPageInFlight.get(key);
    if (pending) return pending;
    let job;
    job = (async () => {
      const [pdfjs, document] = await Promise.all([this.#loadPdfJs(), this.#pdfDocument(generation.id)]);
      if (!document || !this.#resolveGeneration(generation.id)) return null;
      const page = await document.getPage(pageNumber);
      const [textContent, operatorList] = await Promise.all([
        page.getTextContent({ disableNormalization: true }),
        page.getOperatorList(),
      ]);
      const result = buildPdfPaintPage({
        pageNumber,
        textContent,
        operatorList,
        viewport: page.getViewport({ scale: 1 }),
        OPS: pdfjs.OPS,
        Util: pdfjs.Util,
      });
      if (result && this.#resolveGeneration(generation.id)) this.paintPageCache.set(key, result);
      page.cleanup?.();
      return result;
    })().catch(() => null).finally(() => {
      if (this.paintPageInFlight.get(key) === job) this.paintPageInFlight.delete(key);
    });
    this.paintPageInFlight.set(key, job);
    return job;
  }

  /**
   * Lazy per-page exact pixels: convert one PDF page to SVG on first
   * request. `id` (optional) pins the compile the client saw. Retained old
   * ids resolve against their own PDF; an unknown/pruned id returns null.
   * Concurrent requests for the same id/page share one conversion.
   */
  async pageSVG(page, id = null) {
    const cur = this.#resolveGeneration(id);
    if (!cur) return null;
    const n = Number(page);
    if (!Number.isInteger(n) || n < 1 || n > cur.pageCount) return null;
    const key = `${cur.id}:${n}`;
    if (this.svgCache.has(key)) {
      const svg = this.svgCache.get(key);
      this.svgCache.delete(key); // LRU refresh
      this.svgCache.set(key, svg);
      return svg;
    }
    const pending = this.svgInFlight.get(key);
    if (pending) return pending;

    const generation = this.#acquireGeneration(cur.id);
    if (!generation) return null;
    const out = path.join(this.workDir, `canon-${cur.id}-p${n}-${++this.svgOutputSeq}.svg`);
    let job;
    job = (async () => {
      try {
        await this.#exec('pdftocairo', ['-svg', '-f', String(n), '-l', String(n), generation.pdf, out], {
          timeout: 60_000,
        });
        const svg = readFileSync(out, 'utf8');
        if (!generation.retired) {
          this.svgCache.set(key, svg);
          while (this.svgCache.size > SVG_CACHE_MAX) {
            this.svgCache.delete(this.svgCache.keys().next().value);
          }
        }
        return svg;
      } finally {
        rmSync(out, { force: true });
        this.#releaseGeneration(generation);
      }
    })().finally(() => {
      if (this.svgInFlight.get(key) === job) this.svgInFlight.delete(key);
    });
    this.svgInFlight.set(key, job);
    return job;
  }

  async pageTextBoxes(id = null) {
    const cur = this.#resolveGeneration(id);
    if (!cur) return null;
    if (this.textBoxCache.has(cur.id)) return this.textBoxCache.get(cur.id);
    const pending = this.textBoxInFlight.get(cur.id);
    if (pending) return pending;

    const generation = this.#acquireGeneration(cur.id);
    if (!generation) return null;
    let job;
    job = (async () => {
      try {
        const result = await this.#exec('pdftotext', ['-bbox-layout', generation.pdf, '-'], {
          timeout: 60_000,
          maxBuffer: 64 * 1024 * 1024,
        });
        const pages = parsePdfTextBoxes(result.stdout || '');
        if (!generation.retired) this.textBoxCache.set(generation.id, pages);
        return pages;
      } catch {
        return null;
      } finally {
        this.#releaseGeneration(generation);
      }
    })().finally(() => {
      if (this.textBoxInFlight.get(cur.id) === job) this.textBoxInFlight.delete(cur.id);
    });
    this.textBoxInFlight.set(cur.id, job);
    return job;
  }

  /**
   * Per-page plain text of the canonical PDF (for the exactness
   * verification pass). Returns null when pdftotext is unavailable.
   */
  async pageTexts(id = null) {
    const cur = this.#resolveGeneration(id);
    if (!cur) return null;
    if (this.textCache.has(cur.id)) return this.textCache.get(cur.id);
    const pending = this.textInFlight.get(cur.id);
    if (pending) return pending;

    const generation = this.#acquireGeneration(cur.id);
    if (!generation) return null;
    let job;
    job = (async () => {
      try {
        const r = await this.#exec('pdftotext', ['-enc', 'UTF-8', generation.pdf, '-'], {
          timeout: 120_000,
          maxBuffer: 256 * 1024 * 1024,
        });
        const pages = r.stdout.split('\f');
        if (pages[pages.length - 1] === '' || pages[pages.length - 1] === '\n') pages.pop();
        if (!generation.retired) this.textCache.set(generation.id, pages);
        return pages;
      } catch {
        return null;
      } finally {
        this.#releaseGeneration(generation);
      }
    })().finally(() => {
      if (this.textInFlight.get(cur.id) === job) this.textInFlight.delete(cur.id);
    });
    this.textInFlight.set(cur.id, job);
    return job;
  }

  /** The canonical PDF bytes (export path). */
  pdfBytes() {
    if (!this.last) return null;
    return readFileSync(this.last.pdf);
  }

  /** Mark non-source inputs dirty. The next schedule/ensure compiles again. */
  invalidateInputs() {
    this.inputEpoch++;
  }

  /**
   * A fresh editor document must not inherit the previous project's exact
   * pages or aux files. Abort an in-flight compile, drop only this renderer's
   * canon artifacts, and retarget TeX's search root.
   */
  async resetDocument(docDir = this.docDir, overlayDir = this.overlayDir) {
    this.resetting = true;
    clearTimeout(this.authorityResumeTimer);
    this.authorityResumeTimer = null;
    this.authorityPausedUntil = 0;
    clearTimeout(this.timer);
    this.timer = null;
    this.pendingJob = null;
    for (const child of this.children) {
      try {
        if (this.authorityChildren.has(child) && child.pid) {
          try { process.kill(-child.pid, 'SIGKILL'); }
          catch { child.kill('SIGKILL'); }
        } else child.kill('SIGKILL');
      } catch { /* already gone */ }
    }
    try {
      if (this.running) await this.running.catch(() => {});
      await this.#settleReadJobs();
      this.children.clear();
      this.authorityChildren.clear();
      this.authorityPausedPids.clear();
      this.docDir = path.resolve(docDir);
      this.overlayDir = overlayDir ? path.resolve(overlayDir) : null;
      this.#clearGenerations();
      this.lastError = null;
      this.lastEndAt = 0;
      this.inputEpoch++;
      this.#removeWorkArtifacts();
    } finally {
      this.resetting = false;
    }
  }

  dispose() {
    this.disposed = true;
    clearTimeout(this.authorityResumeTimer);
    this.authorityResumeTimer = null;
    this.authorityPausedUntil = 0;
    clearTimeout(this.timer);
    this.timer = null;
    this.pendingJob = null;
    for (const child of this.children) {
      try {
        if (this.authorityChildren.has(child) && child.pid) {
          try { process.kill(-child.pid, 'SIGKILL'); }
          catch { child.kill('SIGKILL'); }
        } else child.kill('SIGKILL');
      } catch {
        /* already gone */
      }
    }
    this.children.clear();
    this.authorityChildren.clear();
    this.authorityPausedPids.clear();
    this.#clearGenerations();
    this.#removeWorkArtifacts();
  }
}

function existingRealpath(value) {
  const resolved = path.resolve(value);
  try {
    return realpathSync.native(resolved);
  } catch {
    return resolved;
  }
}

export function parseSynctexEditOutput(output, cwd = process.cwd()) {
  const results = [];
  let input = null;
  let line = null;
  let column = 1;
  const flush = () => {
    if (input && Number.isFinite(line) && line >= 1) {
      results.push({
        file: path.isAbsolute(input) ? path.resolve(input) : path.resolve(cwd, input),
        line,
        column: Number.isFinite(column) && column >= 1 ? column : 1,
      });
    }
    input = null;
    line = null;
    column = 1;
  };
  for (const raw of String(output || '').split(/\r?\n/)) {
    const value = raw.trim();
    if (value.startsWith('Input:')) {
      flush();
      input = value.slice('Input:'.length).trim();
    }
    else if (value.startsWith('Line:')) line = Number.parseInt(value.slice('Line:'.length).trim(), 10);
    else if (value.startsWith('Column:')) column = Number.parseInt(value.slice('Column:'.length).trim(), 10);
  }
  flush();
  return results[0] ?? null;
}

export function parseSynctexViewOutputs(output) {
  const results = [];
  let fields = {};
  const flush = () => {
    if (Number.isInteger(fields.Page) && fields.Page >= 1 &&
        [fields.x, fields.y, fields.h, fields.v, fields.W, fields.H].every(Number.isFinite)) {
      results.push({
        page: fields.Page,
        x: fields.x,
        y: fields.y,
        box: {
          left: fields.h,
          top: fields.v - fields.H,
          right: fields.h + Math.max(0, fields.W),
          bottom: fields.v + Math.max(1, fields.H * 0.25),
        },
      });
    }
    fields = {};
  };
  for (const raw of String(output || '').split(/\r?\n/)) {
    const match = /^([A-Za-z]+):\s*(-?(?:\d+(?:\.\d*)?|\.\d+))\s*$/.exec(raw.trim());
    if (!match) continue;
    if (match[1] === 'Page' && fields.Page != null) flush();
    fields[match[1]] = Number(match[2]);
  }
  flush();
  return results;
}

export function parseSynctexViewOutput(output) {
  return parseSynctexViewOutputs(output)[0] ?? null;
}

export function parsePdfTextBoxes(output) {
  const pages = [];
  const pagePattern = /<page\b[^>]*>([\s\S]*?)<\/page>/gi;
  let pageMatch;
  while ((pageMatch = pagePattern.exec(String(output || '')))) {
    const words = [];
    const wordPattern = /<word\b([^>]*)>([\s\S]*?)<\/word>/gi;
    let wordMatch;
    while ((wordMatch = wordPattern.exec(pageMatch[1]))) {
      const attrs = wordMatch[1];
      const number = (name) => {
        const match = new RegExp(`${name}="([^"]+)"`).exec(attrs);
        return match ? Number(match[1]) : NaN;
      };
      const box = {
        text: decodeXmlText(wordMatch[2]),
        left: number('xMin'),
        top: number('yMin'),
        right: number('xMax'),
        bottom: number('yMax'),
      };
      if (box.text && [box.left, box.top, box.right, box.bottom].every(Number.isFinite)) words.push(box);
    }
    pages.push(words);
  }
  return pages;
}

function decodeXmlText(value) {
  return String(value || '')
    .replace(/&#(x[0-9a-f]+|\d+);/gi, (_, raw) =>
      String.fromCodePoint(raw[0].toLowerCase() === 'x' ? Number.parseInt(raw.slice(1), 16) : Number(raw)))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

function pointBoxDistance(box, x, y) {
  const dx = x < box.left ? box.left - x : x > box.right ? x - box.right : 0;
  const dy = y < box.top ? box.top - y : y > box.bottom ? y - box.bottom : 0;
  return dx * dx + dy * dy;
}

function readFileNames(dir) {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

/** "Output written on …canon.pdf (N pages, …" — nonstopmode always logs it. */
function pageCountFrom(log) {
  const m = String(log).match(/Output written on [^\n]*?\((\d+) pages?/);
  return m ? Number(m[1]) : 0;
}

const IDENTITY_AFFINE = Object.freeze([1, 0, 0, 1, 0, 0]);

function normalizedRotation(value) {
  const rotation = ((Math.round(Number(value) || 0) % 360) + 360) % 360;
  return rotation === 90 || rotation === 180 || rotation === 270 ? rotation : 0;
}

function displayedPaperGeometry(paper) {
  const width = Number(paper?.w ?? paper?.width);
  const height = Number(paper?.h ?? paper?.height);
  if (!(width > 0 && height > 0)) return null;
  const rotation = normalizedRotation(paper?.rotation);
  return {
    width,
    height,
    rotation,
    nativeWidth: rotation === 90 || rotation === 270 ? height : width,
    nativeHeight: rotation === 90 || rotation === 270 ? width : height,
  };
}

function applyAffine(matrix, point) {
  const [a, b, c, d, e, f] = validAffine(matrix) ? matrix : IDENTITY_AFFINE;
  return {
    x: a * point.x + c * point.y + e,
    y: b * point.x + d * point.y + f,
  };
}

function multiplyAffine(left, right) {
  const [a, b, c, d, e, f] = left;
  const [g, h, i, j, k, l] = right;
  return [
    a * g + c * h,
    b * g + d * h,
    a * i + c * j,
    b * i + d * j,
    a * k + c * l + e,
    b * k + d * l + f,
  ];
}

function inverseAffine(matrix) {
  if (!validAffine(matrix)) return IDENTITY_AFFINE;
  const [a, b, c, d, e, f] = matrix;
  const determinant = a * d - b * c;
  if (Math.abs(determinant) < 1e-12) return IDENTITY_AFFINE;
  return [
    d / determinant,
    -b / determinant,
    -c / determinant,
    a / determinant,
    (c * f - d * e) / determinant,
    (b * e - a * f) / determinant,
  ];
}

function validAffine(matrix) {
  return Array.isArray(matrix) && matrix.length === 6 && matrix.every(Number.isFinite);
}

function rotatePdfTopPointToDisplayed(point, geometry) {
  switch (geometry.rotation) {
    case 90: return { x: geometry.width - point.y, y: point.x };
    case 180: return { x: geometry.width - point.x, y: geometry.height - point.y };
    case 270: return { x: point.y, y: geometry.height - point.x };
    default: return { x: point.x, y: point.y };
  }
}

function unrotateDisplayedPointToPdfTop(point, geometry) {
  switch (geometry.rotation) {
    case 90: return { x: point.y, y: geometry.width - point.x };
    case 180: return { x: geometry.width - point.x, y: geometry.height - point.y };
    case 270: return { x: geometry.height - point.y, y: point.x };
    default: return { x: point.x, y: point.y };
  }
}

/** Convert a raw SyncTeX top-left point into the exact coordinate system
 * exposed by pdftocairo's canonical SVG and pdftotext's word rectangles. */
export function syncTeXPointToDisplayed(point, paper, contentTransform = IDENTITY_AFFINE) {
  const geometry = displayedPaperGeometry(paper);
  if (!geometry || ![point?.x, point?.y].every(Number.isFinite)) return point ?? null;
  const pdfBottom = { x: point.x, y: geometry.nativeHeight - point.y };
  const paintedBottom = applyAffine(contentTransform, pdfBottom);
  const paintedTop = { x: paintedBottom.x, y: geometry.nativeHeight - paintedBottom.y };
  return rotatePdfTopPointToDisplayed(paintedTop, geometry);
}

/** Inverse of syncTeXPointToDisplayed(), used before `synctex edit`. */
export function displayedPointToSyncTeX(point, paper, contentTransform = IDENTITY_AFFINE) {
  const geometry = displayedPaperGeometry(paper);
  if (!geometry || ![point?.x, point?.y].every(Number.isFinite)) return point ?? null;
  const paintedTop = unrotateDisplayedPointToPdfTop(point, geometry);
  const paintedBottom = { x: paintedTop.x, y: geometry.nativeHeight - paintedTop.y };
  const syncBottom = applyAffine(inverseAffine(contentTransform), paintedBottom);
  return { x: syncBottom.x, y: geometry.nativeHeight - syncBottom.y };
}

export function syncTeXBoxToDisplayed(box, paper, contentTransform = IDENTITY_AFFINE) {
  if (!box || ![box.left, box.top, box.right, box.bottom].every(Number.isFinite)) return box ?? null;
  const corners = [
    { x: box.left, y: box.top },
    { x: box.right, y: box.top },
    { x: box.left, y: box.bottom },
    { x: box.right, y: box.bottom },
  ].map((point) => syncTeXPointToDisplayed(point, paper, contentTransform));
  return {
    left: Math.min(...corners.map((point) => point.x)),
    top: Math.min(...corners.map((point) => point.y)),
    right: Math.max(...corners.map((point) => point.x)),
    bottom: Math.max(...corners.map((point) => point.y)),
  };
}

export function syncTeXResultToDisplayed(result, paper, contentTransform = IDENTITY_AFFINE) {
  const point = syncTeXPointToDisplayed(result, paper, contentTransform);
  return {
    ...result,
    x: point.x,
    y: point.y,
    box: syncTeXBoxToDisplayed(result.box, paper, contentTransform),
  };
}

/** Conservative fail-closed diagnostic for the rare case where the Poppler
 * content-matrix probe is unavailable. pdftotext rotates word rectangles
 * into displayed space: bare quarter-turn text is predominantly vertical,
 * whereas pdflscape counter-rotates it back to horizontal. Require several
 * decisive words so a sparse one-glyph page still gets the standard
 * rotation-only fallback. */
export function pageTextBoxesShowCounterRotation(words, paper) {
  const rotation = normalizedRotation(paper?.rotation);
  if (rotation !== 90 && rotation !== 270 || !Array.isArray(words)) return false;
  const boxes = words.filter((word) => {
    const width = Number(word?.right) - Number(word?.left);
    const height = Number(word?.bottom) - Number(word?.top);
    return width > 0.25 && height > 0.25;
  });
  if (boxes.length < 3) return false;
  let totalWidth = 0;
  let totalHeight = 0;
  let horizontal = 0;
  for (const box of boxes) {
    const width = box.right - box.left;
    const height = box.bottom - box.top;
    totalWidth += width;
    totalHeight += height;
    if (width > height * 1.25) horizontal++;
  }
  return horizontal / boxes.length >= 0.75 && totalWidth > totalHeight * 1.5;
}

function sameAffine(left, right, epsilon = 1e-7) {
  return validAffine(left) && validAffine(right) &&
    left.every((value, index) => Math.abs(value - right[index]) <= epsilon);
}

/** Extract the deepest PDF graphics-state transform shared by the dominant
 * text paints on a Poppler `pdftops` page. This deliberately ignores local
 * image and glyph matrices. For pdflscape it recovers the outer
 * counter-rotation; for an ordinary page (including a bare `/Rotate`) it is
 * the identity. Headers/folios may be painted after pdflscape restores the
 * graphics state, so requiring literally every Tj to share the matrix would
 * discard the correct body transform. A sparse/non-majority transform stays
 * unresolved and is handled by the existing fail-closed word-box check. */
export function parsePdfGlobalContentTransform(output) {
  const text = String(output || '');
  const pageStart = text.search(/^%%Page:\s/m);
  if (pageStart < 0) return IDENTITY_AFFINE;
  const setupEnd = text.indexOf('%%EndPageSetup', pageStart);
  const bodyStart = setupEnd >= 0 ? setupEnd + '%%EndPageSetup'.length : pageStart;
  const showPage = text.indexOf('\nshowpage', bodyStart);
  const body = text.slice(bodyStart, showPage >= 0 ? showPage : undefined);
  const numeric = '[+-]?(?:\\d+(?:\\.\\d*)?|\\.\\d+)(?:[eE][+-]?\\d+)?';
  const matrixPattern = new RegExp(
    `^\\s*\\[(${numeric})\\s+(${numeric})\\s+(${numeric})\\s+(${numeric})\\s+(${numeric})\\s+(${numeric})\\]\\s+cm\\s*$`
  );
  let current = [...IDENTITY_AFFINE];
  const stack = [];
  const paintPaths = [];

  for (const rawLine of body.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === 'q') {
      stack.push([...current]);
      continue;
    }
    if (line === 'Q') {
      current = stack.pop() ?? [...IDENTITY_AFFINE];
      continue;
    }
    const matrix = matrixPattern.exec(rawLine);
    if (matrix) {
      current = multiplyAffine(current, matrix.slice(1).map(Number));
      continue;
    }
    if (!/\bTj\s*$/.test(line)) continue;
    paintPaths.push([...stack.map((item) => [...item]), [...current]]);
  }

  const candidates = [];
  for (const path of paintPaths) {
    const seen = [];
    for (let depth = 0; depth < path.length; depth++) {
      const matrix = path[depth];
      if (sameAffine(matrix, IDENTITY_AFFINE) || seen.some((item) => sameAffine(item, matrix))) continue;
      seen.push(matrix);
      let candidate = candidates.find((item) => sameAffine(item.matrix, matrix));
      if (!candidate) {
        candidate = { matrix, paints: 0, depth: 0 };
        candidates.push(candidate);
      }
      candidate.paints++;
      candidate.depth = Math.max(candidate.depth, depth);
    }
  }
  const requiredPaints = Math.max(2, Math.ceil(paintPaths.length * 0.6));
  const winner = candidates
    .filter((candidate) => candidate.paints >= requiredPaints)
    .sort((left, right) => right.paints - left.paints || right.depth - left.depth)[0];
  const matrix = winner?.matrix ?? IDENTITY_AFFINE;
  return validAffine(matrix) && Math.abs(matrix[0] * matrix[3] - matrix[1] * matrix[2]) > 1e-12
    ? matrix
    : IDENTITY_AFFINE;
}

/** Parse `pdfinfo -f 1 -l N` geometry. PDF page size is the unrotated box,
 * while pdftocairo (and therefore the browser's canonical SVG) exposes the
 * rotated viewport. Store w/h in that displayed coordinate system and keep
 * rotation so consumers can reason about the transform explicitly. */
export function parsePdfPageGeometries(output, pageCount = 0) {
  const rawPages = new Map();
  const getPage = (number) => {
    if (!rawPages.has(number)) rawPages.set(number, {});
    return rawPages.get(number);
  };
  const numeric = '([+-]?(?:\\d+(?:\\.\\d*)?|\\.\\d+))';
  const indexedSize = new RegExp(`^Page\\s+(\\d+)\\s+size:\\s*${numeric}\\s+x\\s+${numeric}\\s+pts\\b`, 'i');
  const indexedRotation = /^Page\s+(\d+)\s+rot:\s*([+-]?\d+)\s*$/i;
  const plainSize = new RegExp(`^Page\\s+size:\\s*${numeric}\\s+x\\s+${numeric}\\s+pts\\b`, 'i');
  const plainRotation = /^Page\s+rot:\s*([+-]?\d+)\s*$/i;

  for (const rawLine of String(output || '').split(/\r?\n/)) {
    const line = rawLine.trim();
    let match = indexedSize.exec(line);
    if (match) {
      Object.assign(getPage(Number(match[1])), { w: Number(match[2]), h: Number(match[3]) });
      continue;
    }
    match = indexedRotation.exec(line);
    if (match) {
      getPage(Number(match[1])).rotation = Number(match[2]);
      continue;
    }
    match = plainSize.exec(line);
    if (match) {
      Object.assign(getPage(1), { w: Number(match[1]), h: Number(match[2]) });
      continue;
    }
    match = plainRotation.exec(line);
    if (match) getPage(1).rotation = Number(match[1]);
  }

  const count = Math.max(0, Math.floor(Number(pageCount) || 0), ...rawPages.keys());
  return Array.from({ length: count }, (_, index) => {
    const raw = rawPages.get(index + 1);
    if (!raw || ![raw.w, raw.h].every(Number.isFinite)) return null;
    const rotation = ((Math.round(Number(raw.rotation) || 0) % 360) + 360) % 360;
    const quarterTurn = rotation === 90 || rotation === 270;
    return {
      w: quarterTurn ? raw.h : raw.w,
      h: quarterTurn ? raw.w : raw.h,
      rotation,
    };
  });
}

/** Per-page display size in bp via Poppler. MediaBoxes usually live in a
 * compressed object stream and cannot be recovered safely by scanning raw
 * PDF bytes. */
async function pageGeometries(pdfPath, pageCount, exec = execFileP) {
  try {
    const r = await exec('pdfinfo', ['-f', '1', '-l', String(pageCount), pdfPath], { timeout: 30_000 });
    return parsePdfPageGeometries(r.stdout || '', pageCount);
  } catch {
    return [];
  }
}

function sha256File(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

function texErrorFrom(log) {
  const lines = String(log || '').split('\n');
  const idx = lines.findIndex((l) => l.startsWith('! '));
  if (idx < 0) return '';
  return lines
    .slice(idx, idx + 3)
    .join(' ')
    .trim();
}
