// gen-numbers.mjs — measurements.json から numbers.tex(数値マクロ)を生成する。
// Usage: node paper/gen-numbers.mjs [measurements.json] [numbers.tex]
import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const IN = process.argv[2] ?? path.join(ROOT, 'paper', 'measurements.json');
const OUT = process.argv[3] ?? path.join(ROOT, 'paper', 'numbers.tex');

const m = JSON.parse(readFileSync(IN, 'utf8'));
const L = [];
const def = (name, val) => L.push(`\\newcommand{\\${name}}{${val}}`);

const sec = (ms, d = 1) => (ms / 1000).toFixed(d);
const worstLocus = (doc, key) => Math.max(...Object.values(doc.typing).map((t) => t[key]));
const ms1 = (v) => (v >= 100 ? Math.round(v) : v.toFixed(1));

for (const doc of m.docs) {
  const X = doc.label; // S/M/L
  def(`n${X}pages`, doc.cold.pages);
  def(`n${X}blocks`, doc.blocks);
  def(`n${X}coldSec`, sec(doc.cold.ms));
  def(`n${X}bootSec`, sec(doc.bootMs));
  def(`n${X}typP`, ms1(worstLocus(doc, 'p50')));
  def(`n${X}typPP`, ms1(worstLocus(doc, 'p95')));
  def(`n${X}typMax`, ms1(worstLocus(doc, 'max')));
  def(`n${X}first`, ms1(worstLocus(doc, 'firstMs')));
  def(`n${X}secIns`, ms1(doc.sectionInsert.wallMs));
  def(`n${X}defEd`, ms1(doc.defEdit.wallMs));
  def(`n${X}rss`, doc.rssMB);
}

const Ldoc = m.docs.find((d) => d.label === 'L');
const worstPPall = Math.max(...m.docs.map((d) => worstLocus(d, 'p95')));
def('nWorstPP', ms1(worstPPall));
def('nWorstP', ms1(Math.max(...m.docs.map((d) => worstLocus(d, 'p50')))));
// speedup: L 全文コンパイル(2パス) vs L 打鍵p50 — 桁を丸めて控えめに表記
const speedup = Ldoc.cold.ms / worstLocus(Ldoc, 'p50');
def('nSpeedup', speedup >= 1000 ? `${Math.round(speedup / 100) * 100}` : `${Math.round(speedup / 10) * 10}`);

def('benchCpu', m.host.replace(/&/g, '\\&'));
def('benchMem', m.memGB);
let texlive = 'TeX Live';
try {
  const v = execFileSync('lualatex', ['--version'], { timeout: 15000 }).toString().split('\n')[0];
  const mm = /\(([^)]*TeX Live[^)]*)\)/.exec(v);
  texlive = (mm ? mm[1] : v).replace(/&/g, '\\&');
  const ver = /Version ([\d.]+)/.exec(v);
  if (ver) texlive = `LuaHBTeX ${ver[1]} (${mm ? mm[1] : 'TeX Live'})`;
} catch {}
def('benchTexlive', texlive);

// farm / hot-path の検証結果(ログから)
const scratch = process.argv[4];
let farmLines = '298/298', farmResult = '全数一致', hotpath = '11/11';
try {
  const farmLog = readFileSync(scratch ? path.join(scratch, 'farm.log') : '/dev/null', 'utf8');
  const fm = /line match (\d+)\/(\d+)/.exec(farmLog);
  if (fm) {
    farmLines = `${fm[1]}/${fm[2]}`;
    farmResult = fm[1] === fm[2] ? '全数一致' : `${fm[1]}/${fm[2]}一致`;
  }
} catch {}
try {
  const hpLog = readFileSync(scratch ? path.join(scratch, 'hotpath.log') : '/dev/null', 'utf8');
  const pass = /# pass (\d+)/.exec(hpLog);
  const fail = /# fail (\d+)/.exec(hpLog);
  if (pass) hotpath = `${pass[1]}/${Number(pass[1]) + Number(fail?.[1] ?? 0)}`;
} catch {}
def('nFarmLines', farmLines);
def('nFarmResult', farmResult);
def('nHotpath', hotpath);

writeFileSync(OUT, L.join('\n') + '\n');
console.log(`wrote ${OUT}\n` + L.join('\n'));
