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
  constructor({ workDir, docDir, debounceMs = Number(process.env.TDOM_CANON_DEBOUNCE ?? 350) }) {
    this.workDir = path.resolve(workDir);
    this.docDir = docDir ? path.resolve(docDir) : this.workDir;
    mkdirSync(this.workDir, { recursive: true });
    this.debounceMs = debounceMs;
    this.timer = null;
    this.running = null; // in-flight compile promise
    this.pendingJob = null; // {source, rev} superseding the in-flight compile
    this.idSeq = 0;
    this.last = null; // last GOOD compile: {id, rev, srcHash, pdf, pageCount, paper, passes, ms}
    this.lastError = null; // {rev, message}
    this.svgCache = new Map(); // `${id}:${page}` -> svg string (LRU)
    this.textCache = null; // {id, pages: [string]} pdftotext page texts
    this.onResult = null; // callback({...info}) after every compile attempt
    this.disposed = false;
    this._texts = null;
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
    this.pendingJob = { source, rev };
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      this.#drain();
    }, this.debounceMs);
  }

  /**
   * Compile now (used by PDF export and tests): skips the debounce, reuses
   * the last good compile when the source is unchanged, and returns the
   * result record (throws when this exact source cannot be compiled).
   */
  async ensure(source, rev) {
    const srcHash = fnv1a(source);
    if (this.last && this.last.srcHash === srcHash) return this.last;
    this.pendingJob = { source, rev };
    await this.settle();
    // ours may have been consumed by an already-running drain loop — check
    // by source identity, not by who awaited
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
    this.running = this.#compile(job)
      .catch((err) => {
        this.lastError = { rev: job.rev, message: String(err?.message || err) };
      })
      .finally(() => {
        this.running = null;
      });
    await this.running;
    try {
      this.onResult?.(this.info());
    } catch {
      /* observer errors must not break the drain loop */
    }
    // an edit landed while we compiled: converge on the newest source
    if (this.pendingJob && !this.disposed) await this.#drain();
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
      paper: await paperSize(kept),
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
      const r = await execFileP(
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
    await execFileP('pdftocairo', ['-svg', '-f', String(n), '-l', String(n), cur.pdf, out], {
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
      const r = await execFileP('pdftotext', ['-enc', 'UTF-8', cur.pdf, '-'], {
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
  }
}

/** "Output written on …canon.pdf (N pages, …" — nonstopmode always logs it. */
function pageCountFrom(log) {
  const m = String(log).match(/Output written on [^\n]*?\((\d+) pages?/);
  return m ? Number(m[1]) : 0;
}

/** Paper size in bp via poppler's pdfinfo (the MediaBox usually lives in a
 * compressed object stream, invisible to a raw byte scan). */
async function paperSize(pdfPath) {
  try {
    const r = await execFileP('pdfinfo', [pdfPath], { timeout: 30_000 });
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
