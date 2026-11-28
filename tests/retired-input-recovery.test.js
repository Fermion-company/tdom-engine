// tdom-engine #18 (and tex64-internal #121): typing a new box character by
// character makes the block broken TeX for a while. Its fallback continues
// the chain with an @state JOB forked from the block's input checkpoint; when
// that boundary had been retired after the walk passed it (retirement outside
// the chain lock does not know where the walk stands), the JOB threw "no
// checkpoint", the update took its full-rebuild retry, and the whole document
// was reset in the viewer. The input must be rebuilt from the nearest live
// checkpoint instead, the way a walk reaches any boundary.
//
// The retirement is forced deterministically at the two moments it can bite:
//  - right after the boundary was minted, before the block's own JOB
//    (the in-chain path, then a stale-first fallback in the observed stack)
//  - while the block's own JOB runs, before its fallback continuation.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CheckpointEngine } from '../engine/checkpoint/engine-v3.js';
import { drain, signature } from '../tools/harness.mjs';

const texReady = spawnSync('lualatex', ['--version']).status === 0;
const opts = texReady ? { timeout: 180_000 } : { skip: 'lualatex not installed' };

const SOURCE = String.raw`\documentclass{article}
\begin{document}
` + Array.from({ length: 16 }, (_, i) => String.raw`
PARA${i} is a plain paragraph with enough words to fill a line or two of the page, so that the
chain has ordinary blocks before and after the one that is typed into.

`).join('') + '\\end{document}\n';

let runs = 0;
const withEngine = async (fn, { source = SOURCE, ceiling = 4, plainWalk = true, canonical = false } = {}) => {
  // inside the repository like the other engine tests (the fork shim cached there)
  const root = fileURLToPath(new URL(`../.tdom-v3-test-retired-input-${++runs}`, import.meta.url));
  rmSync(root, { recursive: true, force: true });
  const cached = fileURLToPath(new URL('../.tdom-v3-test/', import.meta.url));
  if (existsSync(path.join(cached, 'tdomfork.so'))) {
    mkdirSync(root, { recursive: true });
    for (const f of ['tdomfork.so', 'tdomfork.so.sha256']) copyFileSync(path.join(cached, f), path.join(root, f));
  }
  const engine = new CheckpointEngine({ workDir: root });
  if (!canonical) engine.canonical.schedule = () => {};
  // a tiny budget: most boundaries are off the grid, as in a long document
  engine.checkpointCeiling = engine.maxCheckpoints = ceiling;
  if (plainWalk) {
    // the walk replays straight through to the block (no cold stop / preview)
    engine.coldPrefixBudgetMs = 0;
    engine.coldPreviewEnabled = false;
  }
  const resets = [];
  try {
    await engine.open(source);
    await drain(engine);
    assert.equal(engine.mode, 'structured');
    // (the open's own root boot is announced too: count from here)
    engine.onDocumentResetPending = (event) => resets.push(event);
    await fn(engine, resets);
  } finally {
    await engine.close().catch(() => {});
    rmSync(root, { recursive: true, force: true });
  }
};

// retire one checkpoint the way the cap does: out of the map, told to DIE
// (later, for the parent of a JOB in flight: its exit would fail that JOB)
const retire = (engine, idx, die = true) => {
  const peer = engine.checkpoints.get(idx);
  if (!peer) return null;
  for (const [k, p] of [...engine.checkpoints]) if (p === peer) engine.checkpoints.delete(k);
  if (die) {
    peer.send('DIE\n');
    if (peer.pid) engine.dyingPids.add(peer.pid);
  }
  return peer;
};

const signatures = (engine) => {
  const sigs = signature(engine);
  return new Map(engine.blocks.map((b, i) => [b.id, sigs[i]]));
};
// every other block (or only those before the typed one) keeps its galley
// and exit state
const othersUnchanged = (engine, before, block, prefixOnly = false) => {
  const after = signatures(engine);
  const at = engine.blocks.findIndex((b) => b.id === block.id);
  engine.blocks.forEach((b, i) => {
    if (b.id === block.id || (prefixOnly && i > at)) return;
    assert.equal(after.get(b.id), before.get(b.id), `block ${b.id} keeps its galley and exit state`);
  });
};

const breakAndHeal = async (engine, resets, target, arm) => {
  const block = engine.blocks.find((b) => b.text.includes(target));
  assert.ok(block, 'target paragraph');
  const before = signatures(engine);
  const pages = engine.pages.length;
  const fired = arm(block);

  // mid-typing: lexically closed, rejected by LuaLaTeX
  const bad = String.raw`\UndefinedWhileTyping{x}`;
  const at = engine.getSource().indexOf(target);
  const report = await engine.edit(at, at + target.length, bad);
  assert.ok(fired(), 'the boundary was retired at the forced moment');
  const diagnostics = report.stats?.diagnostics ?? [];
  assert.equal(resets.length, 0, `no document reset (${JSON.stringify(resets)}; ${JSON.stringify(diagnostics.filter((d) => /input|rebuild|diverge|recovery|fail/.test(d)))})`);
  assert.equal(report.stats?.rebooted, false, 'no full-rebuild retry');
  assert.equal(diagnostics.some((d) => d.includes('typeset phase failed')), false, JSON.stringify(diagnostics));
  assert.ok(diagnostics.some((d) => d.includes(`input checkpoint`) && d.includes('replaying it from checkpoint')),
    `the missing input was rebuilt (${JSON.stringify(diagnostics)})`);
  assert.equal(engine.mode, 'structured');
  const held = engine.blocks.find((b) => b.id === block.id);
  assert.equal(held.closure?.reason, 'native-error');
  assert.equal(held.galley?.tdomDeferred, true, 'the broken block holds its last good output');
  assert.equal(engine.pages.length, pages);
  othersUnchanged(engine, before, block);

  // the source is valid again: the block heals in place
  const fixAt = engine.getSource().indexOf(bad);
  const healedReport = await engine.edit(fixAt, fixAt + bad.length, `${target} again`);
  assert.equal(resets.length, 0);
  assert.equal(healedReport.stats?.rebooted, false);
  const healed = engine.blocks.find((b) => b.id === block.id);
  assert.equal(healed.closure?.native, true, 'healed through real LuaLaTeX');
  assert.equal(healed.galley?.tdomDeferred, undefined);
  assert.equal(engine.mode, 'structured');
  await drain(engine);
  assert.equal(resets.length, 0, 'nor while the background settles');
  othersUnchanged(engine, before, block, true);
};

test('a boundary retired right after it was minted is rebuilt for the block typed into', opts, async () => {
  await withEngine(async (engine, resets) => {
    await breakAndHeal(engine, resets, 'PARA9 is', (block) => {
      const idx = engine.blocks.indexOf(block);
      // the walk must mint this boundary itself: start it from the root
      for (const k of [...engine.checkpoints.keys()]) if (k > 0 && k <= idx) retire(engine, k);
      let done = false;
      const onMessage = engine._onMessage.bind(engine);
      engine._onMessage = (peer, msg) => {
        const out = onMessage(peer, msg);
        // retired before the JOB that would fork from it is sent
        if (!done && msg.kind === 'CKPT' && msg.idx === engine.blocks.findIndex((b) => b.id === block.id)) {
          done = !!retire(engine, msg.idx);
        }
        return out;
      };
      return () => done;
    });
  });
});

test('a boundary retired while the block\'s own JOB runs is rebuilt for its fallback', opts, async () => {
  await withEngine(async (engine, resets) => {
    await breakAndHeal(engine, resets, 'PARA6 is', (block) => {
      let retired = null;
      const onMessage = engine._onMessage.bind(engine);
      engine._onMessage = (peer, msg) => {
        // the in-chain galley (rejected by LuaLaTeX) is in: its input goes
        // before the @state continuation forks from it
        if (!retired && msg.kind === 'GALLEY' && msg.id === block.id) {
          retired = retire(engine, engine.blocks.findIndex((b) => b.id === block.id), false);
        }
        return onMessage(peer, msg);
      };
      return () => {
        retired?.send('DIE\n');
        return !!retired;
      };
    });
  });
});

// The replay starts only from a checkpoint whose lineage is the current
// source's: a suffix peer re-keyed across an edit (vstale) can carry a stale
// definition the replayed prefix never shows.
test('a retired boundary is replayed from a trusted checkpoint, not a re-keyed suffix peer', opts, async () => {
  await withEngine(async (engine, resets) => {
    const block = engine.blocks.find((b) => b.text.includes('PARA11 is'));
    const idx = engine.blocks.indexOf(block);
    // the walk starts from the root and mints every boundary up to the block
    for (const k of [...engine.checkpoints.keys()]) if (k > 0 && k <= idx) retire(engine, k);
    let trusted = null;
    const onMessage = engine._onMessage.bind(engine);
    engine._onMessage = (peer, msg) => {
      const out = onMessage(peer, msg);
      if (trusted === null && msg.kind === 'CKPT' && msg.idx === engine.blocks.findIndex((b) => b.id === block.id)) {
        // the block's input goes, and every boundary between it and the
        // root but one is taken for a suffix peer of an earlier edit
        retire(engine, msg.idx);
        const below = [...engine.checkpoints.keys()].filter((k) => k < msg.idx).sort((a, b) => a - b);
        trusted = below.length > 1 ? below.at(-2) : 0;
        for (const k of below) if (k > trusted) engine.checkpoints.get(k).vstale = true;
      }
      return out;
    };
    const at = engine.getSource().indexOf('PARA11 is');
    const report = await engine.edit(at, at, 'Z');
    assert.ok(trusted !== null, 'the boundary was retired');
    const diagnostics = report.stats?.diagnostics ?? [];
    assert.ok(diagnostics.some((d) => d.includes(`input checkpoint ${idx} retired`) && d.endsWith(`replaying it from checkpoint ${trusted}`)),
      `replayed from the trusted checkpoint ${trusted}: ${JSON.stringify(diagnostics)}`);
    assert.equal(resets.length, 0);
    assert.equal(report.stats?.rebooted, false);
    await drain(engine);
    assert.match(engine.blocks[idx].text, /ZPARA11/);
  });
});

// A recovery that fails outside an update (here a caret warm's walk) is not
// an early stop of that walk: it owes the full rebuild, which runs at once.
test('a recovery that fails in a background walk rebuilds the document', opts, async () => {
  await withEngine(async (engine, resets) => {
    const before = signature(engine);
    // nothing left to replay from: the root included
    for (const k of [...engine.checkpoints.keys()]) retire(engine, k);
    const at = engine.getSource().indexOf('PARA12 is');
    const warmed = await engine.warmEditOffset(at).then(() => null, (err) => err);
    assert.ok(warmed?.tdomInputRecovery, `the warm walk failed with the recovery (${warmed?.message})`);
    for (let i = 0; i < 200 && !resets.length; i++) await new Promise((r) => setTimeout(r, 50));
    assert.deepEqual(resets.map((r) => r.reason), ['engine-retry-reboot'], 'the owed rebuild ran');
    await drain(engine);
    for (let i = 0; i < 100 && engine.recoveryRebuildOwed; i++) await new Promise((r) => setTimeout(r, 50));
    assert.equal(engine.recoveryRebuildOwed, null);
    assert.equal(engine.mode, 'structured');
    assert.deepEqual(signature(engine), before, 'the rebuilt document is the same');
  });
});

// A decorated block typed key by key (the TeXConf booklet's new lesson): a
// TikZ picture and a box, under a four-checkpoint budget with the render
// pump, cold previews and the cold budget all live. No key resets the
// document, input recoveries stay rare, and the result is the document a
// fresh engine typesets.
const DECORATED = String.raw`\documentclass{article}
\usepackage{tikz}
\usepackage{tcolorbox}
\begin{document}
` + Array.from({ length: 12 }, (_, i) => (i === 4
  ? String.raw`\begin{tcolorbox}[title=Box]Inline $x^2$ and \tikz \draw (0,0) -- (1,.5);\end{tcolorbox}` + '\n\n'
  : i === 8
    ? String.raw`\begin{center}\begin{tikzpicture}\draw[->] (0,0) -- (3,0);\draw plot[domain=0:3] (\x,{(\x-1.5)^2});\end{tikzpicture}\end{center}` + '\n\n'
    : `PARA${i} is a plain paragraph with enough words to fill a line or two of the page, and $a_${i}$ in it.\n\n`)).join('') +
  '\\end{document}\n';

test('typing a new decorated block under retirement pressure: no reset, bounded recovery, scratch-equal', { ...opts, timeout: 300_000 }, async (t) => {
  let typed;
  await withEngine(async (engine, resets) => {
    const replaysBefore = engine.inputReplays ?? 0;
    const typingFrom = Date.now();
    const seen = [];
    const anchor = engine.getSource().indexOf('PARA10 is');
    let at = anchor;
    const put = async (text) => {
      const report = await engine.edit(at, at, text);
      for (const d of report.stats?.diagnostics ?? []) if (/rescue|failed|retired|replay|timed out|freez/.test(d)) seen.push(`${JSON.stringify(text)} ${d}`.slice(0, 200));
      at += text.length;
      await new Promise((r) => setTimeout(r, 15));
    };
    await put(String.raw`\begin{tcolorbox}[title=Example 1]` + '\n\n' + String.raw`\end{tcolorbox}` + '\n\n');
    at = anchor + String.raw`\begin{tcolorbox}[title=Example 1]`.length + 1;
    for (const ch of String.raw`Solve $x^2-4x+3<0$ and sketch \tikz \draw (0,0) -- (1,1); here.`) await put(ch);
    assert.equal(resets.length, 0, `no key reset the document (${JSON.stringify(resets)})`);
    assert.equal(engine.mode, 'structured');
    await drain(engine);
    assert.equal(resets.length, 0, 'nor the background after it');
    const replays = (engine.inputReplays ?? 0) - replaysBefore;
    assert.ok(replays <= 2, `input recoveries stay rare under retirement pressure: ${replays} for ~60 keys`);
    // (the pressure is real: the budget retired boundaries while the block was typed)
    const pressure = [...engine.retiredInputs.values()].filter((r) => r.why === 'cap' && r.at >= typingFrom).length;
    assert.ok(pressure > 0, 'the checkpoint budget retired inputs during the typing');
    t.diagnostic(`input recoveries while typing: ${replays} (${pressure} boundaries retired by the budget)`);
    typed = {
      source: engine.getSource(), signature: signature(engine),
      seen,
      flags: engine.blocks.map((b) => [b.id, b.closure?.native, !!b.galley?.tdomColdPreview, !!b.galley?.tdomDeferred,
        !!b.galley?.tdomFrozen, !!b.rescued, b.text.slice(0, 40)]),
    };
  }, { source: DECORATED, plainWalk: false });
  await withEngine(async (fresh) => {
    // A block the async rescue pump last adopted holds its isolated
    // (print-identical) galley until it is typed in again: its exit state is
    // compared, its galley identity is not (a mid-typing \t crashed the
    // in-chain child once in this sequence: tools/fuzz.mjs scopes it alike).
    const sigs = signature(fresh);
    const comparable = (sig, i) => (typed.flags[i][5] ? sig.slice(sig.indexOf('|')) : sig);
    const differ = sigs.map((sig, i) => comparable(sig, i) === comparable(typed.signature[i], i) ? null
      : { i, typed: typed.flags[i], fresh: [fresh.blocks[i].id, fresh.blocks[i].closure?.native] }).filter(Boolean);
    assert.deepEqual(differ, [], `the typed document is the one a fresh engine typesets ${JSON.stringify(typed.seen.slice(-12))}`);
    assert.equal(fresh.blocks.length, typed.flags.length);
  }, { source: typed.source, plainWalk: false });
});
