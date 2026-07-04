// compare-breaks.mjs — the referee for "engine page builder == TeX page builder"
// at the NODE STREAM level (the handoff's cumulative-height comparison tool).
//
// Real side: compiles the .tex with vanilla 2-pass lualatex, injecting a
// pre_output_filter that dumps, for every output-routine invocation, the page
// body's node list with NATURAL glue values (width/stretch/shrink + orders,
// subtype), box heights/depths and glyph text, plus \outputpenalty, \pagegoal
// and \pagetotal at fire time. A shipout/before hook marks which invocations
// actually shipped (float pages ship with no invocation of their own).
//
// Engine side: runs the checkpoint engine headlessly with the pagebuilder's
// __TDOM_PAGE_DUMP__ hook installed; every #firePage records the same shape.
//
// Comparison is at NATURAL values, so page glue setting cancels exactly —
// the first node where the cumulative height differs is the root cause.
//
// Usage: node tools/compare-breaks.mjs <file.tex> [--page=N] [--all] [--tol=0.02]
//   --page=N   full node-by-node listing for page N (1-based ship order)
//   --all      report every diverged page, not just the first
//   --fresh    ignore the cached real-side dump
//
// The real-side dump is cached by source hash in .cache/ (a vanilla compile
// of a large document takes minutes; the dump is deterministic).

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, existsSync, rmSync, copyFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const execFileP = promisify(execFile);
const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

const args = process.argv.slice(2);
const texFile = args.find((a) => !a.startsWith('--'));
const TOL = Number((args.find((a) => a.startsWith('--tol=')) ?? '--tol=0.02').slice(6));
const PAGE = args.find((a) => a.startsWith('--page='));
const PAGE_N = PAGE ? Number(PAGE.slice(7)) : null;
const ALL = args.includes('--all');
const FRESH = args.includes('--fresh');
if (!texFile) {
  console.error('usage: node tools/compare-breaks.mjs <file.tex> [--page=N] [--all] [--fresh]');
  process.exit(2);
}

const texPath = path.resolve(texFile);
const texSource = readFileSync(texPath, 'utf8');
const name = path.basename(texPath, '.tex');
const scratch = path.join(os.tmpdir(), `tdom-breaks-${name}-${process.pid}`);
mkdirSync(scratch, { recursive: true });

// ------------------------------------------------------------- real side

const DUMP_LUA = String.raw`-- pre-output body-stream dump (written by compare-breaks.mjs)
local out = io.open('breakdump.jsonl', 'w')
local HLIST = node.id('hlist')
local VLIST = node.id('vlist')
local RULE = node.id('rule')
local GLUE = node.id('glue')
local KERN = node.id('kern')
local PENALTY = node.id('penalty')
local GLYPH = node.id('glyph')
local INS = node.id('ins')
local DISC = node.id('disc')
local function bp(sp) return (sp or 0) / 65781.76 end
local function esc(s)
  s = s:gsub('\\', '\\\\'):gsub('"', '\\"'):gsub('%c', ' ')
  return s
end
local function listtext(head, acc, budget)
  local n = head
  while n and budget > 0 do
    if n.id == GLYPH then
      local c = n.char or 63
      if c > 0 and c < 0x110000 then
        acc[#acc + 1] = utf8.char(c)
        budget = budget - 1
      end
    elseif n.id == HLIST or n.id == VLIST then
      budget = listtext(n.list or n.head, acc, budget)
    elseif n.id == DISC then
      -- post-linebreak, unbroken explicit hyphens/ligature discs keep their
      -- visible text in the REPLACE list (broken ones in pre/post)
      budget = listtext(n.replace, acc, budget)
    end
    n = n.next
  end
  return budget
end
local function boxtext(box, acc, budget)
  return listtext(box.list or box.head, acc, budget)
end
local function num(x)
  return string.format('%.4f', x)
end
luatexbase.add_to_callback('pre_output_filter', function(head)
  local parts = {}
  for n in node.traverse(head) do
    local id = n.id
    if id == HLIST or id == VLIST then
      local acc = {}
      boxtext(n, acc, 48)
      parts[#parts + 1] = string.format('{"k":"box","h":%s,"d":%s,"t":"%s"}',
        num(bp(n.height)), num(bp(n.depth)), esc(table.concat(acc)))
    elseif id == RULE then
      local h = n.height or 0
      local d = n.depth or 0
      if h < -1073741823 then h = 26214 end
      if d < -1073741823 then d = 0 end
      parts[#parts + 1] = string.format('{"k":"box","h":%s,"d":%s,"t":"<rule>"}',
        num(bp(h)), num(bp(d)))
    elseif id == GLUE then
      parts[#parts + 1] = string.format(
        '{"k":"glue","w":%s,"st":%s,"sto":%d,"sh":%s,"sho":%d,"sub":%d}',
        num(bp(n.width)), num(bp(n.stretch)), n.stretch_order or 0,
        num(bp(n.shrink)), n.shrink_order or 0, n.subtype or 0)
    elseif id == KERN then
      parts[#parts + 1] = string.format('{"k":"kern","w":%s}', num(bp(n.kern)))
    elseif id == PENALTY then
      parts[#parts + 1] = string.format('{"k":"pen","v":%d}', n.penalty or 0)
    elseif id == INS then
      parts[#parts + 1] = string.format('{"k":"ins","h":%s}', num(bp(n.height)))
    end
  end
  out:write(string.format('{"inv":true,"pen":%d,"goal":%s,"total":%s,"nodes":[%s]}\n',
    tex.outputpenalty or 0, num(bp(tex.pagegoal)), num(bp(tex.pagetotal)),
    table.concat(parts, ',')))
  out:flush()
  return true
end, 'tdom.breakdump')
function TDOMship()
  out:write(string.format('{"ship":true,"page":%d}\n', tex.count[0] or 0))
  out:flush()
end
`;

async function realDump() {
  const cacheDir = path.join(ROOT, '.cache');
  mkdirSync(cacheDir, { recursive: true });
  const hash = createHash('sha256').update(texSource).digest('hex').slice(0, 16);
  const cached = path.join(cacheDir, `breakdump-${name}-${hash}-fx.jsonl`);
  if (!FRESH && existsSync(cached)) {
    console.log(`real: using cached dump ${path.relative(ROOT, cached)}`);
    return parseJsonl(readFileSync(cached, 'utf8'));
  }
  const dir = path.join(scratch, 'truth');
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'main.tex'), texSource);
  writeFileSync(path.join(dir, 'dump.lua'), DUMP_LUA);
  const inject =
    '\\directlua{dofile("dump.lua")}' +
    '\\AddToHook{shipout/before}{\\directlua{TDOMship()}}' +
    '\\input{main.tex}';
  const run = () =>
    execFileP('lualatex', ['-interaction=nonstopmode', '--jobname=main', inject], {
      cwd: dir,
      timeout: 600_000,
      maxBuffer: 64 * 1024 * 1024,
    }).catch(() => {});
  // compile to FIXPOINT: a non-converged run prints stale toc/ref pages —
  // "the real PDF" the engine must match is the converged document
  const auxState = () => {
    let s = '';
    for (const f of ['main.aux', 'main.toc', 'main.lof', 'main.lot', 'main.out', 'main.idx']) {
      const p = path.join(dir, f);
      if (existsSync(p)) s += f + ':' + createHash('sha256').update(readFileSync(p)).digest('hex') + '\n';
    }
    return s;
  };
  let prev = null;
  for (let pass = 1; pass <= 6; pass++) {
    console.log(`real: pass ${pass} …`);
    await run();
    const cur = auxState();
    if (pass >= 2 && cur === prev) break;
    prev = cur;
  }
  const dumpPath = path.join(dir, 'breakdump.jsonl');
  if (!existsSync(dumpPath)) throw new Error('real lualatex produced no breakdump.jsonl');
  if (!existsSync(path.join(dir, 'main.pdf'))) throw new Error('real lualatex compile failed');
  copyFileSync(dumpPath, cached);
  console.log(`real: dump cached as ${path.relative(ROOT, cached)}`);
  return parseJsonl(readFileSync(dumpPath, 'utf8'));
}

function parseJsonl(s) {
  return s
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l));
}

/** ship-ordered real pages: each carries the invocation that fed it (or null
 * for float pages assembled inside the output routine). */
function realPages(events) {
  const pages = [];
  let pending = null;
  for (const ev of events) {
    if (ev.inv) pending = ev;
    else if (ev.ship) {
      pages.push({ folio: ev.page, inv: pending });
      pending = null;
    }
  }
  return pages;
}

// ------------------------------------------------------------ engine side

async function engineDump() {
  let last = null;
  globalThis.__TDOM_PAGE_DUMP__ = (recs) => {
    last = recs;
  };
  const { CheckpointEngine } = await import('../engine/checkpoint/engine-v3.js');
  const engine = new CheckpointEngine({
    workDir: path.join(scratch, 'engine'),
    docDir: path.dirname(texPath),
  });
  try {
    await engine.open(texSource);
    await engine.bgTask.catch(() => {});
    await (engine.renderTask ?? Promise.resolve()).catch(() => {});
    await (engine.hfTask ?? Promise.resolve()).catch(() => {});
    return { records: last, pageCount: engine.getDisplayLists().length };
  } finally {
    await engine.close();
  }
}

// -------------------------------------------------------------- comparison

const fmt = (x) => (Math.abs(x) < 1e-4 ? '0' : x.toFixed(3));

function nodeDesc(n) {
  if (!n) return '∅';
  if (n.k === 'box') return `box h=${fmt(n.h)} d=${fmt(n.d)} "${(n.t ?? '').slice(0, 28)}"`;
  if (n.k === 'glue') {
    let s = `glue w=${fmt(n.w)}`;
    if (n.st) s += ` st=${fmt(n.st)}@${n.sto}`;
    if (n.sh) s += ` sh=${fmt(n.sh)}@${n.sho}`;
    s += ` (sub ${n.sub})`;
    if (n.ts) s += ' [topskip]';
    return s;
  }
  if (n.k === 'kern') return `kern ${fmt(n.w)}`;
  if (n.k === 'pen') return `pen ${n.v}`;
  if (n.k === 'ins') return `ins h=${fmt(n.h)}`;
  return JSON.stringify(n);
}

function dimOf(n) {
  if (n.k === 'box') return n.h + n.d;
  if (n.k === 'glue' || n.k === 'kern') return n.w;
  return 0;
}

/** Only the height-bearing skeleton (boxes/glue/kern); pens ride as tags. */
function skeleton(nodes) {
  const seq = [];
  for (const n of nodes ?? []) {
    if (n.k === 'box' || n.k === 'glue' || n.k === 'kern') seq.push(n);
  }
  return seq;
}

/** LCS over the two pages' box lists (text key, height fallback). */
function alignBoxes(rs, es) {
  const rb = [];
  const eb = [];
  rs.forEach((n, i) => n.k === 'box' && rb.push({ n, i }));
  es.forEach((n, i) => n.k === 'box' && eb.push({ n, i }));
  const key = (x) =>
    x.n.t && x.n.t.length > 1 && x.n.t !== '<rule>' && x.n.t !== '<float>'
      ? 'T' + x.n.t.slice(0, 32)
      : 'H' + (x.n.h + x.n.d).toFixed(2);
  const m = rb.length;
  const nn = eb.length;
  const dp = Array.from({ length: m + 1 }, () => new Int32Array(nn + 1));
  for (let i = m - 1; i >= 0; i--) {
    for (let j = nn - 1; j >= 0; j--) {
      dp[i][j] = key(rb[i]) === key(eb[j]) ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const pairs = [];
  let i = 0;
  let j = 0;
  while (i < m && j < nn) {
    if (key(rb[i]) === key(eb[j])) {
      pairs.push({ r: rb[i], e: eb[j] });
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) i++;
    else j++;
  }
  return { pairs, rb, eb };
}

function comparePage(idx, real, eng) {
  // page kinds
  const rFloat = real && !real.inv;
  // a \cleardoublepage blank verso ships as a page whose only box is the
  // empty \hbox{} — same page the engine emits as a synthesized blank
  const rBlank =
    real?.inv &&
    !real.inv.nodes.some((n) => n.k === 'box' && ((n.t ?? '') !== '' || n.h + n.d > 0.01));
  const eFloat = eng && (eng.floatpage || eng.blank);
  if (rFloat || eFloat) {
    const ok = (rFloat && eng?.floatpage) || (rBlank && eng?.blank);
    return {
      ok,
      summary: `page ${idx + 1}: real=${rFloat ? 'floatpage' : rBlank ? 'blank' : 'text'} engine=${
        eng?.floatpage ? 'floatpage' : eng?.blank ? 'blank' : 'text'
      }${ok ? '' : '  << KIND MISMATCH'}`,
    };
  }
  if (!real || !eng) {
    return {
      ok: false,
      summary: `page ${idx + 1}: ${!real ? 'engine EXTRA page' : 'engine MISSING page'}`,
    };
  }
  const rs = skeleton(real.inv.nodes);
  const es = skeleton(eng.nodes);
  const rBoxes = rs.filter((n) => n.k === 'box');
  const eBoxes = es.filter((n) => n.k === 'box');
  const rH = rs.reduce((s, n) => s + dimOf(n), 0);
  const eH = es.reduce((s, n) => s + dimOf(n), 0);

  // box-anchored comparison: aligned boxes must agree in h/d, and the
  // glue+kern+unaligned-box sums BETWEEN consecutive anchors must agree
  const { pairs, rb, eb } = alignBoxes(rs, es);
  const faults = [];
  let prevR = -1;
  let prevE = -1;
  const gapSum = (seq, a, b) => {
    let s = 0;
    for (let i = a + 1; i < b; i++) s += dimOf(seq[i]);
    return s;
  };
  for (const p of pairs) {
    const gr = gapSum(rs, prevR, p.r.i);
    const ge = gapSum(es, prevE, p.e.i);
    if (Math.abs(gr - ge) > TOL * 2) {
      faults.push({
        kind: 'gap',
        before: p,
        gr,
        ge,
        rNodes: rs.slice(prevR + 1, p.r.i),
        eNodes: es.slice(prevE + 1, p.e.i),
      });
    }
    if (Math.abs(p.r.n.h - p.e.n.h) > TOL || Math.abs(p.r.n.d - p.e.n.d) > TOL) {
      faults.push({ kind: 'box', p });
    }
    prevR = p.r.i;
    prevE = p.e.i;
  }
  const tailR = gapSum(rs, prevR, rs.length);
  const tailE = gapSum(es, prevE, es.length);
  if (Math.abs(tailR - tailE) > TOL * 2) {
    faults.push({
      kind: 'gap',
      before: null,
      gr: tailR,
      ge: tailE,
      rNodes: rs.slice(prevR + 1),
      eNodes: es.slice(prevE + 1),
    });
  }
  const unalignedR = rb.filter((x) => !pairs.some((p) => p.r === x));
  const unalignedE = eb.filter((x) => !pairs.some((p) => p.e === x));

  const ok = faults.length === 0 && !unalignedR.length && !unalignedE.length;
  let summary =
    `page ${idx + 1} (folio ${real.folio}): nodes ${rs.length}/${es.length} ` +
    `boxes ${rBoxes.length}/${eBoxes.length} height ${fmt(rH)}/${fmt(eH)} ` +
    (ok ? 'OK' : `DIVERGED (${faults.length} faults, ${unalignedR.length}/${unalignedE.length} unmatched boxes)`);
  return { ok, summary, faults, unalignedR, unalignedE, rs, es, real, eng };
}

function printDetail(idx, r) {
  const { faults, unalignedR, unalignedE, real, eng } = r;
  console.log(
    `\n=== page ${idx + 1} detail (real pen=${real.inv.pen} goal=${fmt(real.inv.goal)} | engine pen=${eng.pen} goal=${fmt(eng.goal)})`
  );
  for (const f of faults.slice(0, 8)) {
    if (f.kind === 'box') {
      console.log(
        `  BOX DIM: real ${nodeDesc(f.p.r.n)}  vs  engine ${nodeDesc(f.p.e.n)}`
      );
    } else {
      const anchor = f.before ? `before "${(f.before.r.n.t ?? '').slice(0, 32)}"` : 'at page tail';
      console.log(`  GAP ${anchor}: real=${fmt(f.gr)} engine=${fmt(f.ge)} (Δ=${fmt(f.gr - f.ge)})`);
      console.log(`    real : ${f.rNodes.map(nodeDesc).join(' | ') || '(none)'}`);
      console.log(`    eng  : ${f.eNodes.map(nodeDesc).join(' | ') || '(none)'}`);
    }
  }
  if (faults.length > 8) console.log(`  ... +${faults.length - 8} more faults`);
  for (const x of unalignedR.slice(0, 6)) {
    console.log(`  REAL-ONLY box: ${nodeDesc(x.n)}`);
  }
  for (const x of unalignedE.slice(0, 6)) {
    console.log(`  ENGINE-ONLY box: ${nodeDesc(x.n)}`);
  }
}

// -------------------------------------------------------------------- main

const t0 = Date.now();
try {
  const [events, engRes] = await Promise.all([realDump(), engineDump()]);
  const rPages = realPages(events);
  const ePages = engRes.records ?? [];
  console.log(
    `pages: real=${rPages.length} engine=${ePages.length}` +
      (rPages.length !== ePages.length ? '  << PAGE COUNT MISMATCH' : '')
  );
  const n = Math.max(rPages.length, ePages.length);
  let firstShown = false;
  for (let i = 0; i < n; i++) {
    const r = comparePage(i, rPages[i] ?? null, ePages[i] ?? null);
    console.log(r.summary);
    const wantDetail =
      (PAGE_N != null && i + 1 === PAGE_N) ||
      (PAGE_N == null && !r.ok && (ALL || !firstShown));
    if (wantDetail && r.rs) {
      printDetail(i, r);
      firstShown = true;
      if (!ALL && PAGE_N == null) {
        console.log('\n(first diverged page shown; --all for every page, --page=N to drill)');
        break;
      }
    }
    if (!r.ok && !r.rs && !firstShown && PAGE_N == null && !ALL) {
      // kind mismatch / extra page with no drill-down — keep listing
    }
  }
  console.log(`done in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
} catch (err) {
  console.error('compare failed:', err);
  process.exitCode = 1;
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
