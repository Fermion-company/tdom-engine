// ShippingChain — the incremental canonical (phase 1 of the standing goal).
// Slice 1: a boot ships every page as a real single-page LuaLaTeX PDF whose
//          text equals a cold 2-pass compile.
// Slice 2: an edit resumes from the page-boundary checkpoint; the re-shipped
//          wave equals a cold compile of the NEW source while prefix pages
//          keep their generation-0 PDFs untouched.
// These fork real lualatex processes; skipped without a TeX installation.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { ShippingChain } from '../engine/checkpoint/shipping.js';
import { CheckpointEngine } from '../engine/checkpoint/engine-v3.js';

const execFileP = promisify(execFile);
const WORK = fileURLToPath(new URL('../.tdom-ship-test', import.meta.url));
const DOC = fileURLToPath(new URL('../samples/demo-lua.tex', import.meta.url));

const available = await promisify(execFile)('lualatex', ['--version'], { timeout: 15_000 }).then(
  () => true,
  () => false
);
const opts = available ? {} : { skip: 'lualatex not installed' };

const source = readFileSync(DOC, 'utf8');
const privatePdf = process.env.TDOM_SHIP_PRIVATE_PDF !== '0';

async function coldCompile(src, dir) {
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'main.tex'), src);
  for (let p = 0; p < 2; p++) {
    await execFileP('lualatex', ['-interaction=nonstopmode', 'main.tex'], {
      cwd: dir,
      timeout: 300_000,
    }).catch(() => {});
  }
  return path.join(dir, 'main.pdf');
}

const pageText = async (pdf, p) =>
  (await execFileP('pdftotext', ['-f', String(p), '-l', String(p), pdf, '-'])).stdout
    .replace(/\s+/g, ' ')
    .trim();

function seedsFrom(dir) {
  const aux = readFileSync(path.join(dir, 'main.aux'), 'utf8');
  const labelSeed = [];
  for (const m of aux.matchAll(/\\newlabel\{([^}]+)\}\{\{([^{}]*)\}/g)) {
    labelSeed.push([m[1], m[2]]);
  }
  for (const m of aux.matchAll(/\\bibcite\{([^}]+)\}\{([^{}]*)\}/g)) {
    labelSeed.push(['cite:' + m[1], m[2]]);
  }
  const contents = {};
  for (const ext of ['toc', 'lof', 'lot']) {
    const f = path.join(dir, 'main.' + ext);
    if (existsSync(f)) contents[ext] = readFileSync(f, 'utf8');
  }
  return { labelSeed, contents };
}

async function waitDone(chain, timeoutMs = 120_000) {
  const t0 = Date.now();
  while ((!chain.done || chain.info().waveReady !== true) && !chain.err) {
    if (Date.now() - t0 > timeoutMs) throw new Error('shipping chain timeout');
    await new Promise((r) => setTimeout(r, 25));
  }
  if (chain.err) throw chain.err;
}

let chain;
let truth0;
let baselineOutcomes = [];
before(async () => {
  if (!available) return;
  rmSync(WORK, { recursive: true, force: true });
  mkdirSync(WORK, { recursive: true });
  truth0 = await coldCompile(source, path.join(WORK, 'truth0'));
  chain = new ShippingChain({ workDir: WORK, docDir: path.dirname(DOC) });
  chain.onBaselineOutcome = (outcome) => baselineOutcomes.push(outcome);
  await chain.open(source, seedsFrom(path.join(WORK, 'truth0')));
  await waitDone(chain);
});
after(async () => {
  if (chain) await chain.close();
});

test('slice 1: every page ships as a real PDF identical to a cold compile', opts, async () => {
  assert.equal(baselineOutcomes.length, 1, 'baseline outcome is one-shot');
  assert.equal(baselineOutcomes[0].outcome, 'CERTIFIED');
  assert.equal(baselineOutcomes[0].baselineGeneration, 0);
  assert.ok(baselineOutcomes[0].pdfCertificateId);
  const { stdout } = await execFileP('pdfinfo', [truth0]);
  const coldPages = Number(stdout.match(/Pages:\s+(\d+)/)?.[1]);
  const shipped = chain.info().shipped;
  assert.equal(shipped.length, coldPages, 'page count');
  for (const p of shipped) {
    assert.equal(
      await pageText(chain.publishedPdf, p),
      await pageText(truth0, p),
      `page ${p} text`
    );
  }
  const [svg1, svg2] = await Promise.all([chain.pageSVG(1), chain.pageSVG(2)]);
  assert.ok(svg1.includes('<svg') && svg2.includes('<svg'));
  assert.notEqual(svg1, svg2, 'concurrent visible pages use independent SVG artifacts');
});

test('slice 2: a tail edit resumes from the page checkpoint, wave == cold truth', opts, async () => {
  const marker = 'renumbers these citations';
  assert.ok(source.includes(marker));
  const edited = source.replace(marker, 'renumbers these very citations');
  const page1Before = await pageText(chain.publishedPdf, 1);

  // A previous server process can leave this generation name behind.  It is
  // a viewer cache, not a TeX output, and must neither poison the manifest
  // nor block an otherwise exact resume.
  for (const page of chain.info().shipped) {
    const staleDir = path.join(WORK, `ship-g1-root-from-${page}`);
    mkdirSync(staleDir, { recursive: true });
    writeFileSync(path.join(staleDir, 'driver-ship.svg'), '<svg>stale viewer cache</svg>');
  }

  const t0 = Date.now();
  const r = chain.resume(edited);
  assert.equal(r.mode, 'resumed', JSON.stringify(r));
  assert.ok(r.fromPage >= 2, 'prefix pages survive');
  await waitDone(chain);
  const waveMs = Date.now() - t0;

  const truth1 = await coldCompile(edited, path.join(WORK, 'truth1'));
  const { stdout } = await execFileP('pdfinfo', [truth1]);
  const coldPages = Number(stdout.match(/Pages:\s+(\d+)/)?.[1]);
  const shipped = chain.info().shipped;
  assert.equal(shipped.length, coldPages, 'page count after resume');
  for (const p of shipped) {
    assert.equal(
      await pageText(chain.publishedPdf, p),
      await pageText(truth1, p),
      `page ${p} text after resume`
    );
  }
  assert.equal(await pageText(chain.publishedPdf, 1), page1Before, 'prefix page remains exact');
  // the whole point: the authority wave is fast (goal: viewed page ≤ 300ms)
  assert.ok(waveMs < 5000, `resume wave took ${waveMs}ms`);
  console.log(`    resume wave: ${waveMs}ms for ${shipped.length - (r.fromPage - 1)} page(s)`);
});

test('R1→R2 preemption clones an immutable checkpoint and publishes only R2', opts, async () => {
  const waves = [];
  chain.onWave = (wave) => waves.push(wave);
  const current = chain.source;
  const marker = 'renumbers these very citations';
  assert.ok(current.includes(marker));
  const r1Source = current.replace(marker, 'renumbers these very rapid citations');
  const r1 = chain.resume(r1Source);
  assert.equal(r1.mode, 'resumed');
  const r1Gen = chain.gen;
  const r2Source = r1Source.replace('very rapid citations', 'very rapid live citations');
  const r2 = chain.resume(r2Source);
  assert.equal(r2.mode, 'resumed');
  const r2Gen = chain.gen;
  assert.ok(r2Gen > r1Gen);
  await waitDone(chain);

  assert.equal(waves.some((wave) => wave.gen === r1Gen), false, 'superseded R1 never published');
  assert.equal(waves.some((wave) => wave.gen === r2Gen), true, 'latest R2 published');
  const truth = await coldCompile(r2Source, path.join(WORK, 'truth-r2'));
  for (const page of chain.info().shipped) {
    assert.equal(
      await pageText(chain.publishedPdf, page),
      await pageText(truth, page),
      `R2 page ${page}`
    );
  }
});

test('unsafe syntax edits fail closed before a replay generation is forked', opts, () => {
  const current = chain.source;
  const gen = chain.gen;
  const at = current.indexOf('very rapid live citations');
  assert.ok(at > 0);
  const mathEdit = current.slice(0, at) + '$x$' + current.slice(at);
  assert.deepEqual(chain.resume(mathEdit), { mode: 'reboot-needed', reason: 'non-plain-edit' });
  assert.equal(chain.gen, gen, 'no speculative generation was created');
  assert.equal(chain.source, current, 'authority source was not changed');
});

test('12-keystroke burst publishes only the terminal complete-PDF generation', opts, async () => {
  const start = chain.source;
  const marker = 'very rapid live citations';
  assert.ok(start.includes(marker));
  const waves = [];
  chain.onWave = (wave) => waves.push(wave);
  let latest = start;
  for (let index = 1; index <= 12; index++) {
    latest = start.replace(marker, `very rapid live ${'x'.repeat(index)} citations`);
    assert.equal(chain.resume(latest).mode, 'resumed');
  }
  const terminalGen = chain.gen;
  await waitDone(chain);
  assert.deepEqual(waves.map((wave) => wave.gen), [terminalGen]);

  const truth = await coldCompile(latest, path.join(WORK, 'truth-burst'));
  for (const page of chain.info().shipped) {
    assert.equal(await pageText(chain.publishedPdf, page), await pageText(truth, page));
  }
});

test('a complete but late generation never reaches the renderer', opts, async () => {
  const previousCutoff = process.env.TDOM_SHIP_WAVE_CUTOFF;
  process.env.TDOM_SHIP_WAVE_CUTOFF = '1';
  const waves = [];
  chain.onWave = (wave) => waves.push(wave);
  try {
    const current = chain.source;
    const marker = 'citations';
    const at = current.lastIndexOf(marker);
    assert.ok(at > 0);
    assert.equal(chain.resume(current.slice(0, at) + 'z' + current.slice(at)).mode, 'resumed');
    const rejectedGen = chain.gen;
    await waitDone(chain);
    assert.equal(chain.info().rejectReason, 'deadline-exceeded');
    assert.equal(waves.length, 0);
    assert.equal(
      [...chain.pageGen.values()].includes(rejectedGen),
      false,
      'a timed-out wave contributes no page artifact to the authority map'
    );
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(
      [...chain.pageGen.values()].includes(rejectedGen),
      false,
      'late pager EXIT stays drain-only after the deadline'
    );
  } finally {
    if (previousCutoff === undefined) delete process.env.TDOM_SHIP_WAVE_CUTOFF;
    else process.env.TDOM_SHIP_WAVE_CUTOFF = previousCutoff;
  }
});

test('standard two-column output ships the same physical pages as cold LuaLaTeX', opts, async () => {
  const paragraphs = Array.from({ length: 90 }, (_, index) =>
    `Paragraph ${index + 1}. The quick brown fox follows the exact two column output routine.\n\n`
  ).join('');
  const twoColumn = `\\documentclass[twocolumn]{article}\n\\begin{document}\n${paragraphs}\\end{document}\n`;
  const dir = path.join(WORK, 'two-column');
  const truth = await coldCompile(twoColumn, path.join(dir, 'truth'));
  const local = new ShippingChain({ workDir: dir, docDir: dir });
  try {
    await local.open(twoColumn, seedsFrom(path.join(dir, 'truth')));
    await waitDone(local);
    const { stdout } = await execFileP('pdfinfo', [truth]);
    const pages = Number(stdout.match(/Pages:\s+(\d+)/)?.[1]);
    assert.ok(pages >= 2, 'fixture exercises multiple physical column pages');
    assert.equal(local.info().shipped.length, pages);
    for (const page of local.info().shipped) {
      assert.equal(
        await pageText(local.publishedPdf, page),
        await pageText(truth, page)
      );
    }

    // A lexically plain edit can still repaginate the whole tail. This is a
    // general layout closure test, not a two-column special case: the
    // provisional generation must never publish when physical page count
    // differs from the certified baseline.
    const waves = [];
    local.onWave = (wave) => waves.push(wave);
    const expanded = twoColumn.replace(
      'Paragraph 90.',
      `Paragraph 90.${' additional ordinary prose'.repeat(1200)}`
    );
    const result = local.resume(expanded);
    assert.equal(result.mode, 'resumed');
    await waitDone(local);
    const expandedTruth = await coldCompile(expanded, path.join(dir, 'expanded-truth'));
    const { stdout: expandedInfo } = await execFileP('pdfinfo', [expandedTruth]);
    const expandedPages = Number(expandedInfo.match(/Pages:\s+(\d+)/)?.[1]);
    console.log(`    repagination gate: ${pages}→${expandedPages} pages, ${waves.length} provisional commits`);
    assert.equal(local.info().rejectReason, 'page-count-changed');
    assert.equal(waves.length, 0, 'repaginated wave stayed invisible');
  } finally {
    await local.close();
  }
});

test('slice 3: engine integration — an edit lands a ship page event', opts, async () => {
  process.env.TDOM_SHIP = '1';
  const work = path.join(WORK, 'engine');
  rmSync(work, { recursive: true, force: true });
  const eng = new CheckpointEngine({ workDir: work, docDir: path.dirname(DOC) });
  try {
    const arrivals = [];
    eng.onShipWave = (info) => arrivals.push(info);
    await eng.open(source);
    // the ship boot is idle-gated (~800ms) and then ships every page
    const t0 = Date.now();
    while ((!eng.shipping?.done || eng.shipBooting) && Date.now() - t0 < 120_000) {
      await new Promise((r) => setTimeout(r, 100));
    }
    assert.ok(eng.shipping?.done, 'shipping chain booted and completed');
    // Generation 0 establishes the closure baseline but is not a live-edit
    // publication. Only a complete edited wave may reach the renderer.
    assert.equal(arrivals.length, 0);

    // edit tail material: the wave must re-land page 2 at the new srcRev
    const marker = 'renumbers these very citations';
    const src = eng.getSource();
    const at = src.includes(marker) ? src.indexOf(marker) : src.indexOf('renumbers these citations');
    assert.ok(at > 0);
    await eng.edit(at, at, 'X');
    const rev = eng.srcRev;
    const t1 = Date.now();
    while (
      !arrivals.some((a) => a.srcRev === rev && a.pages.includes(2)) &&
      Date.now() - t1 < 30_000
    ) {
      await new Promise((r) => setTimeout(r, 25));
    }
    const hit = arrivals.find((a) => a.srcRev === rev && a.pages.includes(2));
    assert.ok(hit, 'edited page set re-shipped at the new source revision');
    assert.ok(Number.isFinite(hit.acceptedAt), 'renderer receives wave acceptance time');
    assert.ok(Number.isFinite(hit.deadlineAt), 'renderer receives the hard display deadline');
    assert.ok(hit.deadlineAt > hit.acceptedAt);
    assert.equal(hit.deadlineAt - hit.acceptedAt, 1000, 'visible commit owns the full one-second SLA');
    assert.ok(Array.isArray(hit.changedPages) && hit.changedPages.length > 0);
    console.log(`    engine wave: pages ${hit.pages.join(',')} in ${Date.now() - t1}ms after edit`);
    const svg = await eng.shipping.pageSVG(2);
    assert.ok(svg && svg.includes('<svg'), 'shipped page serves as SVG');
    assert.equal(eng.shipStale, false, 'no label divergence on a plain edit');
  } finally {
    delete process.env.TDOM_SHIP;
    await eng.close();
  }
});

test('four healthy structural rebaselines do not exhaust shipping recovery', opts, async () => {
  process.env.TDOM_SHIP = '1';
  const previousCanonicalIdle = process.env.TDOM_CANON_IDLE;
  const previousCanonicalCooldown = process.env.TDOM_CANON_COOLDOWN;
  // Production intentionally waits for a real typing pause before its next
  // authority compile. This test exercises four completed idle cycles, so
  // collapse only that wall-clock policy while preserving the same compile
  // and canonical-seeded ShippingChain route.
  process.env.TDOM_CANON_IDLE = '10';
  process.env.TDOM_CANON_COOLDOWN = '0';
  const work = path.join(WORK, 'engine-rebaseline-recovery');
  rmSync(work, { recursive: true, force: true });
  const eng = new CheckpointEngine({ workDir: work, docDir: path.dirname(DOC) });
  const marker = 'renumbers these citations';
  try {
    const arrivals = [];
    eng.onShipWave = (info) => arrivals.push(info);
    await eng.open(source);

    const waitCurrentBaseline = async (revision, timeoutMs = 120_000) => {
      const t0 = Date.now();
      while (
        !(eng.shipRetry?.state === 'ready' &&
          eng.shipRetry.lastCertifiedSnapshot === eng.shipRetry.desiredSnapshot &&
          eng.srcRev === revision) &&
        Date.now() - t0 < timeoutMs
      ) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      assert.equal(eng.srcRev, revision);
      assert.equal(eng.shipRetry?.state, 'ready', `baseline revision ${revision} certified`);
      assert.equal(eng.shipRetry?.consecutiveFailures, 0);
      assert.equal(eng.shipBootTries, 0);
    };

    await waitCurrentBaseline(eng.srcRev);
    let lastAttemptId = eng.shipRetry.nextAttemptId;
    for (let index = 0; index < 4; index++) {
      const at = eng.getSource().indexOf(marker);
      assert.ok(at > 0);
      await eng.edit(at, at, '{}'); // valid TeX, deliberately outside plain-replay admission
      const revision = eng.srcRev;
      await waitCurrentBaseline(revision);
      assert.ok(eng.shipRetry.nextAttemptId > lastAttemptId, 'a fresh rebaseline attempt ran');
      lastAttemptId = eng.shipRetry.nextAttemptId;
    }

    const at = eng.getSource().indexOf(marker);
    await eng.edit(at, at, 'X');
    const plainRevision = eng.srcRev;
    const t0 = Date.now();
    while (!arrivals.some((wave) => wave.srcRev === plainRevision) && Date.now() - t0 < 5_000) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    const hit = arrivals.find((wave) => wave.srcRev === plainRevision);
    assert.ok(hit, 'plain prose still publishes after four structural rebaselines');
    assert.ok(hit.elapsedMs < 700, `native shipping wave stayed inside cutoff (${hit.elapsedMs}ms)`);
    assert.ok(hit.deadlineAt > hit.acceptedAt, 'complete deadline envelope survives manager fanout');
  } finally {
    delete process.env.TDOM_SHIP;
    if (previousCanonicalIdle === undefined) delete process.env.TDOM_CANON_IDLE;
    else process.env.TDOM_CANON_IDLE = previousCanonicalIdle;
    if (previousCanonicalCooldown === undefined) delete process.env.TDOM_CANON_COOLDOWN;
    else process.env.TDOM_CANON_COOLDOWN = previousCanonicalCooldown;
    await eng.close();
  }
});
