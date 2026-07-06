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
  while (!chain.done && !chain.err) {
    if (Date.now() - t0 > timeoutMs) throw new Error('shipping chain timeout');
    await new Promise((r) => setTimeout(r, 25));
  }
  if (chain.err) throw chain.err;
  await new Promise((r) => setTimeout(r, 800)); // let final SPAGEDs land
}

let chain;
let truth0;
before(async () => {
  if (!available) return;
  rmSync(WORK, { recursive: true, force: true });
  mkdirSync(WORK, { recursive: true });
  truth0 = await coldCompile(source, path.join(WORK, 'truth0'));
  chain = new ShippingChain({ workDir: WORK, docDir: path.dirname(DOC) });
  await chain.open(source, seedsFrom(path.join(WORK, 'truth0')));
  await waitDone(chain);
});
after(async () => {
  if (chain) await chain.close();
});

test('slice 1: every page ships as a real PDF identical to a cold compile', opts, async () => {
  const { stdout } = await execFileP('pdfinfo', [truth0]);
  const coldPages = Number(stdout.match(/Pages:\s+(\d+)/)?.[1]);
  const shipped = chain.info().shipped;
  assert.equal(shipped.length, coldPages, 'page count');
  for (const p of shipped) {
    assert.equal(
      await pageText(chain.pagePdf.get(p), 1),
      await pageText(truth0, p),
      `page ${p} text`
    );
  }
});

test('slice 2: a tail edit resumes from the page checkpoint, wave == cold truth', opts, async () => {
  const marker = 'renumbers these citations';
  assert.ok(source.includes(marker));
  const edited = source.replace(marker, 'renumbers these very citations');
  const page1Before = chain.pagePdf.get(1);

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
      await pageText(chain.pagePdf.get(p), 1),
      await pageText(truth1, p),
      `page ${p} text after resume`
    );
  }
  assert.equal(chain.pagePdf.get(1), page1Before, 'prefix page untouched (gen 0)');
  // the whole point: the authority wave is fast (goal: viewed page ≤ 300ms)
  assert.ok(waveMs < 5000, `resume wave took ${waveMs}ms`);
  console.log(`    resume wave: ${waveMs}ms for ${shipped.length - (r.fromPage - 1)} page(s)`);
});

test('slice 3: engine integration — an edit lands a ship page event', opts, async () => {
  process.env.TDOM_SHIP = '1';
  const work = path.join(WORK, 'engine');
  rmSync(work, { recursive: true, force: true });
  const eng = new CheckpointEngine({ workDir: work, docDir: path.dirname(DOC) });
  try {
    const arrivals = [];
    eng.onShipPage = (info) => arrivals.push(info);
    await eng.open(source);
    // the ship boot is idle-gated (~800ms) and then ships every page
    const t0 = Date.now();
    while ((!eng.shipping?.done || eng.shipBooting) && Date.now() - t0 < 120_000) {
      await new Promise((r) => setTimeout(r, 100));
    }
    assert.ok(eng.shipping?.done, 'shipping chain booted and completed');
    // pager PDFs finalize at pager EXIT, which trails the feeder's end
    const t0b = Date.now();
    while (arrivals.length < 2 && Date.now() - t0b < 15_000) {
      await new Promise((r) => setTimeout(r, 50));
    }
    assert.ok(arrivals.length >= 2, `boot shipped pages (${arrivals.length})`);

    // edit tail material: the wave must re-land page 2 at the new srcRev
    const marker = 'renumbers these very citations';
    const src = eng.getSource();
    const at = src.includes(marker) ? src.indexOf(marker) : src.indexOf('renumbers these citations');
    assert.ok(at > 0);
    await eng.edit(at, at, 'X');
    const rev = eng.srcRev;
    const t1 = Date.now();
    while (
      !arrivals.some((a) => a.srcRev === rev && a.page >= 2) &&
      Date.now() - t1 < 30_000
    ) {
      await new Promise((r) => setTimeout(r, 25));
    }
    const hit = arrivals.find((a) => a.srcRev === rev && a.page >= 2);
    assert.ok(hit, 'edited page re-shipped at the new source revision');
    console.log(`    engine wave: page ${hit.page} in ${Date.now() - t1}ms after edit`);
    const svg = await eng.shipping.pageSVG(hit.page);
    assert.ok(svg && svg.includes('<svg'), 'shipped page serves as SVG');
    assert.equal(eng.shipStale, false, 'no label divergence on a plain edit');
  } finally {
    delete process.env.TDOM_SHIP;
    await eng.close();
  }
});
