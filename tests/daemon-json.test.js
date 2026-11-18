// The daemon encodes every galley to JSON inside TeX. Its encoder is tuned
// for speed; the bytes it writes must stay those of the reference encoder,
// because galley hashes (and with them page identity) are built on them.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const texlua = spawnSync('texlua', ['-v']).status === 0;

test('the daemon\'s JSON encoder writes the reference encoder\'s bytes', { skip: !texlua && 'texlua not installed' }, () => {
  const daemon = readFileSync(path.join(ROOT, 'engine/checkpoint/daemon.lua'), 'utf8');
  const from = daemon.indexOf('local function jstr(s)');
  const to = daemon.indexOf('-- ---------------------------------------------------------------- boot');
  assert.ok(from > 0 && to > from, 'the json section of daemon.lua');
  const dir = mkdtempSync(path.join(tmpdir(), 'tdom-json-'));
  try {
    const section = path.join(dir, 'section.lua');
    writeFileSync(section, daemon.slice(from, to));
    const out = execFileSync('texlua', [path.join(ROOT, 'tests/fixtures/daemon-json-reference.lua'), section], { encoding: 'utf8' });
    assert.match(out, /^diffs 0 of 20000 /);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// A galley goes to the engine with its repeated rules written short
// (daemon.lua jenc_wire); what the engine reads must be what jenc writes.
test('a galley written for the wire unpacks to what the reference bytes say', { skip: !texlua && 'texlua not installed' }, async () => {
  const { holdsPackedRules, unpackRuleRuns } = await import('../engine/checkpoint/rule-pack.js');
  const daemon = readFileSync(path.join(ROOT, 'engine/checkpoint/daemon.lua'), 'utf8');
  const from = daemon.indexOf('local function jstr(s)');
  const to = daemon.indexOf('-- ---------------------------------------------------------------- boot');
  const dir = mkdtempSync(path.join(tmpdir(), 'tdom-json-wire-'));
  try {
    const section = path.join(dir, 'section.lua');
    writeFileSync(section, daemon.slice(from, to));
    const run = (off) => {
      const env = { ...process.env };
      delete env.TDOM_NO_RULE_PACK;
      if (off) env.TDOM_NO_RULE_PACK = '1';
      return execFileSync('texlua', [path.join(ROOT, 'tests/fixtures/daemon-json-wire.lua'), section],
        { encoding: 'utf8', maxBuffer: 64 << 20, env }).trimEnd().split('\n');
    };
    const lines = run(false);
    assert.equal(lines.length % 2, 0);
    let shorter = 0;
    for (let i = 0; i < lines.length; i += 2) {
      const [whole, wire] = [lines[i], lines[i + 1]];
      const read = JSON.parse(wire);
      if (holdsPackedRules(wire)) unpackRuleRuns(read);
      assert.equal(JSON.stringify(read), JSON.stringify(JSON.parse(whole)), `case ${i / 2}: the same runs, fields in the same order`);
      assert.ok(wire.length <= whole.length);
      if (wire.length < whole.length) shorter++;
    }
    assert.ok(shorter >= 5, 'the cases with repeated rules travel shorter');
    // the last case: 2000 runs, about half of them rules of six kinds
    assert.ok(lines.at(-1).length < lines.at(-2).length * 0.45, `${lines.at(-1).length} of ${lines.at(-2).length} bytes`);
    // the first rule after more kinds than are looked back over comes whole again, the next one short
    const many = JSON.parse(lines[7]).items[0].runs;
    assert.equal(many[12].rule, true);
    assert.deepEqual(many[13].rq, [12, 14]);
    // a rule of another shape counts among the whole ones: the short forms after it name the right rule
    const odd = JSON.parse(lines[3]).items[0].runs;
    assert.equal(odd[2].ri, undefined);
    assert.deepEqual(odd[3].rq, [0, 3]);
    assert.deepEqual(odd[5].rq, [0, 5]);
    assert.deepEqual(odd[6].rq, [2, 6]);
    // switched off, every rule travels whole
    const off = run(true);
    for (let i = 0; i < off.length; i += 2) assert.equal(off[i + 1], off[i]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a short form that names no whole rule is left as it came', async () => {
  const { unpackRuleRuns } = await import('../engine/checkpoint/rule-pack.js');
  const whole = { c: '#000000', dy: -7, h: 8, ra: '0:0', rd: 1, rdir: 'TLT', rh: 2, ri: 0, rl: 0, rr: 0, rs: 3, rule: true, rv: 2, rw: 0, w: 0, x: 1 };
  const galley = { items: [{ k: 'box', runs: [{ rq: [0, 5] }, { ...whole }, { rq: [0, 9] }, { rq: [3, 9] }, { rq: [0, 'x'] }, { t: 'a', x: 2 }] }] };
  unpackRuleRuns(galley);
  const runs = galley.items[0].runs;
  assert.deepEqual(runs[0], { rq: [0, 5] }, 'before any whole rule');
  assert.deepEqual(runs[2], { ...whole, x: 9 });
  assert.deepEqual(Object.keys(runs[2]), Object.keys(whole), 'fields in the order they came in');
  assert.deepEqual(runs[3], { rq: [3, 9] }, 'no such whole rule');
  assert.deepEqual(runs[4], { rq: [0, 'x'] });
  assert.deepEqual(runs[5], { t: 'a', x: 2 });
});

const lualatex = spawnSync('lualatex', ['--version']).status === 0;

test('the engine holds the same galleys whether the rules travelled short or whole', { skip: !lualatex && 'lualatex not installed' }, async () => {
  const { mkdirSync } = await import('node:fs');
  const { CheckpointEngine } = await import('../engine/checkpoint/engine-v3.js');
  const { drain } = await import('../tools/harness.mjs');
  const source = String.raw`\documentclass{ltjsarticle}
\begin{document}
\section{はじめに}\label{sec:a}
最初の段落です。日本語の文章が続きます。和文と English が混じり、数式 $x^2+y$ と\textbf{太字}も入ります。

二つ目の段落は長めに書いて、二行から三行になるようにします。日本語の文章が続きます。日本語の文章が続きます。脚注\footnote{脚注の文です。}と節~\ref{sec:a}への参照も含みます。

\begin{itemize}
\item 箇条書きの一つ目です。
\item 箇条書きの二つ目です。
\end{itemize}
\end{document}
`;
  const root = mkdtempSync(path.join(tmpdir(), 'tdom-rule-pack-'));
  const open = async (name, whole) => {
    const docDir = path.join(root, name);
    mkdirSync(docDir, { recursive: true });
    writeFileSync(path.join(docDir, 'main.tex'), source);
    const before = process.env.TDOM_NO_RULE_PACK;
    if (whole) process.env.TDOM_NO_RULE_PACK = '1'; else delete process.env.TDOM_NO_RULE_PACK;
    const engine = new CheckpointEngine({ workDir: path.join(root, `${name}-work`), docDir, overlayDir: path.join(root, `${name}-overlay`) });
    engine.canonical.schedule = () => {};
    try { await engine.open(source, 'main.tex'); } finally {
      if (before === undefined) delete process.env.TDOM_NO_RULE_PACK; else process.env.TDOM_NO_RULE_PACK = before;
    }
    await drain(engine, 120_000);
    return engine;
  };
  const packed = await open('packed', false);
  const whole = await open('whole', true);
  try {
    assert.equal(packed.blocks.length, whole.blocks.length);
    let rules = 0;
    for (let i = 0; i < packed.blocks.length; i++) {
      const a = packed.blocks[i], b = whole.blocks[i];
      assert.equal(a.galleyHash, b.galleyHash, `block ${i}: galley hash`);
      assert.equal(a.stateVec, b.stateVec, `block ${i}: exit state`);
      assert.equal(JSON.stringify(a.galley?.items ?? null), JSON.stringify(b.galley?.items ?? null), `block ${i}: items`);
      assert.equal(JSON.stringify(a.galley?.floats ?? null), JSON.stringify(b.galley?.floats ?? null), `block ${i}: floats`);
      for (const item of a.galley?.items ?? []) {
        for (const run of item.runs ?? []) {
          assert.equal(run.rq, undefined, 'no short form is left in a galley');
          if (run.rule) rules++;
        }
      }
    }
    assert.ok(rules > 50, `the document has the empty rules this is about (${rules})`);
    assert.equal(JSON.stringify(packed.getDisplayLists().map((dl) => dl.hash)), JSON.stringify(whole.getDisplayLists().map((dl) => dl.hash)), 'the same pages');
    // and a keystroke: the edited paragraph's galley is the same too
    const at = source.indexOf('長めに書いて');
    await Promise.all([packed.edit(at, at, 'あ'), whole.edit(at, at, 'あ')]);
    const edited = (engine) => engine.blocks.find((block) => block.text.includes('あ長めに書いて'));
    assert.equal(edited(packed).galleyHash, edited(whole).galleyHash);
    assert.equal(JSON.stringify(edited(packed).galley.items), JSON.stringify(edited(whole).galley.items));
  } finally {
    await packed.close();
    await whole.close();
    rmSync(root, { recursive: true, force: true });
  }
});

