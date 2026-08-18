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
import { promisify } from 'node:util';
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, copyFileSync } from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { fnv1a } from '../hash.js';

const execFileP = promisify(execFile);
const MAX_PASSES = 3;
const SVG_CACHE_MAX = 400; // pages kept as SVG strings (LRU)

export class CanonicalRenderer {
  constructor({
    workDir,
    docDir,
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
    this.workDir = path.resolve(workDir);
    this.docDir = docDir ? path.resolve(docDir) : this.workDir;
    mkdirSync(this.workDir, { recursive: true });
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
    this.svgCache = new Map(); // `${id}:${page}` -> svg string (LRU)
    this.textCache = null; // {id, pages: [string]} pdftotext page texts
    this.onResult = null; // callback({...info}) after every compile attempt
    this.disposed = false;
    this._texts = null;
    this.children = new Set(); // in-flight lualatex/pdftocairo/pdftotext/pdfinfo
  }

  /** execFile with child tracking, so dispose() can kill in-flight work —
   * an orphaned canonical lualatex otherwise burns a core for up to its
   * 5-minute timeout after the server exits. */
  #exec(cmd, args, opts) {
    const p = execFileP(cmd, args, opts);
    if (p.child) {
      const cleanup = () => this.children.delete(p.child);
      this.children.add(p.child);
      p.then(cleanup, cleanup);
    }
    return p;
  }

  /** Public snapshot for /doc payloads, reports and SSE events. */
  info() {
    return {
      rev: this.last?.rev ?? 0,
      id: this.last?.id ?? 0,
      pageCount: this.last?.pageCount ?? 0,
      paper: this.last?.paper ?? null,
      passes: this.last?.passes ?? 0,
      ms: this.last?.ms ?? 0,
      inFlight: !!(this.running || this.timer || this.pendingJob),
      error: this.lastError?.message ?? null,
      errorRev: this.lastError?.rev ?? 0,
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
    this.pendingJob = { source, rev };
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
    const srcHash = fnv1a(source);
    if (this.last && this.last.srcHash === srcHash) return this.last;
    while (this.running) await this.running;
    if (this.disposed) throw new Error('renderer disposed');
    if (this.last && this.last.srcHash === srcHash) return this.last;
    // No await between the check above and this assignment: #drain and
    // ensure both claim `running` synchronously, so two compiles can never
    // share the workdir.
    this.running = this.#compile({ source, rev })
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
    if (this.last && this.last.srcHash === fnv1a(job.source)) {
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
    this.running = this.#compile(job)
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

  async #compile({ source, rev }) {
    const t0 = performance.now();
    const srcHash = fnv1a(source);
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
      log = await this.#runLatex(tex);
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
    const prev = this.last;
    this.last = {
      id,
      rev,
      srcHash,
      pdf: kept,
      pageCount,
      paper: await paperSize(kept, (cmd, args, opts) => this.#exec(cmd, args, opts)),
      passes,
      ms: Math.round(performance.now() - t0),
    };
    this.lastError = null;
    if (prev) rmSync(prev.pdf, { force: true });
    // drop SVG/text caches of superseded compiles
    for (const key of this.svgCache.keys()) {
      if (!key.startsWith(`${id}:`)) this.svgCache.delete(key);
    }
    this.textCache = null;
    return this.last;
  }

  async #runLatex(tex) {
    let out = '';
    try {
      const r = await this.#exec(
        'lualatex',
        ['-interaction=nonstopmode', '-output-directory', this.workDir, tex],
        {
          cwd: this.docDir,
          timeout: Number(process.env.TDOM_CANON_TIMEOUT || 300_000),
          maxBuffer: 64 * 1024 * 1024,
          env: {
            ...process.env,
            TEXINPUTS: `${this.docDir}//:${process.env.TEXINPUTS || ''}`,
            LUAINPUTS: `${this.docDir}//:${process.env.LUAINPUTS || ''}`,
          },
        }
      );
      out = (r.stdout || '') + (r.stderr || '');
    } catch (err) {
      // nonstopmode exits non-zero on any error but often still ships a
      // usable PDF — the caller decides based on the artifacts
      out = (err.stdout || '') + (err.stderr || '') || String(err.message || err);
    }
    return out;
  }

  /**
   * Lazy per-page exact pixels: convert one PDF page to SVG on first
   * request. `id` (optional) pins the compile the client saw; a stale id
   * returns null so the client refetches against the current one.
   */
  async pageSVG(page, id = null) {
    const cur = this.last;
    if (!cur) return null;
    if (id != null && Number(id) !== cur.id) return null;
    const n = Number(page);
    if (!Number.isInteger(n) || n < 1 || n > cur.pageCount) return null;
    const key = `${cur.id}:${n}`;
    if (this.svgCache.has(key)) {
      const svg = this.svgCache.get(key);
      this.svgCache.delete(key); // LRU refresh
      this.svgCache.set(key, svg);
      return svg;
    }
    const out = path.join(this.workDir, `canon-${cur.id}-p${n}.svg`);
    await this.#exec('pdftocairo', ['-svg', '-f', String(n), '-l', String(n), cur.pdf, out], {
      timeout: 60_000,
    });
    const svg = readFileSync(out, 'utf8');
    rmSync(out, { force: true });
    this.svgCache.set(key, svg);
    while (this.svgCache.size > SVG_CACHE_MAX) {
      this.svgCache.delete(this.svgCache.keys().next().value);
    }
    return svg;
  }

  /**
   * Per-page plain text of the canonical PDF (for the exactness
   * verification pass). Returns null when pdftotext is unavailable.
   */
  async pageTexts(id = null) {
    const cur = this.last;
    if (!cur) return null;
    if (id != null && Number(id) !== cur.id) return null;
    if (this.textCache?.id === cur.id) return this.textCache.pages;
    try {
      const r = await this.#exec('pdftotext', ['-enc', 'UTF-8', cur.pdf, '-'], {
        timeout: 120_000,
        maxBuffer: 256 * 1024 * 1024,
      });
      const pages = r.stdout.split('\f');
      if (pages[pages.length - 1] === '' || pages[pages.length - 1] === '\n') pages.pop();
      this.textCache = { id: cur.id, pages };
      return pages;
    } catch {
      return null;
    }
  }

  /** The canonical PDF bytes (export path). */
  pdfBytes() {
    if (!this.last) return null;
    return readFileSync(this.last.pdf);
  }

  dispose() {
    this.disposed = true;
    clearTimeout(this.timer);
    this.timer = null;
    this.pendingJob = null;
    for (const child of this.children) {
      try {
        child.kill('SIGKILL');
      } catch {
        /* already gone */
      }
    }
    this.children.clear();
  }
}

/** "Output written on …canon.pdf (N pages, …" — nonstopmode always logs it. */
function pageCountFrom(log) {
  const m = String(log).match(/Output written on [^\n]*?\((\d+) pages?/);
  return m ? Number(m[1]) : 0;
}

/** Paper size in bp via poppler's pdfinfo (the MediaBox usually lives in a
 * compressed object stream, invisible to a raw byte scan). */
async function paperSize(pdfPath, exec = execFileP) {
  try {
    const r = await exec('pdfinfo', [pdfPath], { timeout: 30_000 });
    const m = r.stdout.match(/Page size:\s+([\d.]+) x ([\d.]+)/);
    if (!m) return null;
    return { w: Number(m[1]), h: Number(m[2]) };
  } catch {
    return null;
  }
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
