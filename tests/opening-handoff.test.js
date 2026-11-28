// The opening phase and the furniture work after it (final engine release
// review of v0.1.33):
//  - A1: the opening belongs to the opened revision. It ends once that
//    revision's baseline canonical has landed, failed or been superseded by an
//    edit, and the body is idle; a later revision's canonical never extends it.
//  - A2/B3: the furniture witness replay is owned apart from body work: a
//    keystroke during it is classified as on c53846b, it resumes from its own
//    frontier, and a genuine body rebuild renders what c53846b renders.
//  - B2: a replay whose fork fails is retried or settled; hfPending ends.
//  - B1: an edit that changes what a sheet's head prints stamps that sheet's
//    display list with the revision (web/app.js furnitureHolds).
// The round-19 rule stays: an unedited opening publishes no furniture.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { CheckpointEngine } from '../engine/checkpoint/engine-v3.js';
import { runChainPass, runWitnessPass } from '../engine/checkpoint/chain-pass.js';
import { drain } from '../tools/harness.mjs';

const texReady = spawnSync('lualatex', ['--version']).status === 0;
const skip = !texReady && 'lualatex not installed';

let runs = 0;
async function withEngine(fn, setup = () => {}) {
  const root = fileURLToPath(new URL(`../.tdom-v3-test-opening-${process.pid}-${++runs}`, import.meta.url));
  rmSync(root, { recursive: true, force: true });
  const cached = fileURLToPath(new URL('../.tdom-v3-test/', import.meta.url));
  if (existsSync(path.join(cached, 'tdomfork.so'))) {
    mkdirSync(root, { recursive: true });
    for (const f of ['tdomfork.so', 'tdomfork.so.sha256']) copyFileSync(path.join(cached, f), path.join(root, f));
  }
  const engine = new CheckpointEngine({ workDir: root });
  setup(engine);
  try {
    return await fn(engine);
  } finally {
    await engine.close().catch(() => {});
    rmSync(root, { recursive: true, force: true });
  }
}

async function until(check, what, ms = 60_000, step = 20) {
  const end = performance.now() + ms;
  for (;;) {
    const value = check();
    if (value) return value;
    if (performance.now() > end) throw new Error(`timed out: ${what}`);
    await delay(step);
  }
}

const furnitureOf = (list) => list.commands.filter((c) => c.src === '_hf' || c.op === 'folio' ||
  /^__hfr?-/.test(String(c.chunk ?? '')));

const twoside = String.raw`\documentclass[twoside]{article}
\begin{document}
` + Array.from({ length: 14 }, (_, i) => (i === 0 ? 'First paragraph.' : `Short sentence ${i}.`)).join('\n\n') + String.raw`
\end{document}
`;

const fancy = (pages = 3) => String.raw`\documentclass{article}
\usepackage{fancyhdr}
\newcommand{\HeadText}{Instructor copy}
\pagestyle{fancy}
\fancyhf{}
\fancyhead[L]{\HeadText}
\fancyfoot[C]{\thepage}
\begin{document}
` + Array.from({ length: pages }, (_, i) => `Paragraph ${i + 1} of the typing fixture.\n\nAnother paragraph on sheet ${i + 1}.`)
  .join('\n\n\\clearpage\n\n') + String.raw`
\end{document}
`;

// The owed replay, caught while it is under way (it runs between JOBs).
async function midReplay(engine) {
  for (let i = 0; i < 200_000; i++) {
    const w = engine.hfWitness;
    if (w && !w.settled && w.from > 0 && engine.witnessActive) return w;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error('the witness replay was never seen under way');
}

test('a keystroke during the furniture witness replay typesets one block, and the replay completes after it', { skip, timeout: 120_000 }, async () => {
  await withEngine(async (engine) => {
    await engine.open(twoside, undefined, { canonicalBaseline: false });
    const witness = await midReplay(engine);
    assert.equal(engine.pendingChain, null, 'the replay is not body work');
    const at = engine.getSource().indexOf('First paragraph') + 'First'.length;
    const report = await engine.edit(at, at, 's');
    // c53846b on the same fixture and edit: 1 block, verdict verify
    assert.equal(report.stats.blocksTypeset, 1, 'one foreground block');
    assert.equal(report.stats.chainVerdict, 'verify');
    assert.equal(witness.settled, null, 'the replay yielded, still owed');
    assert.equal(engine.hfPending, true, 'the owed replay is furniture work');
    await until(() => witness.settled, 'the replay settles without another edit');
    assert.equal(witness.settled, 'done');
    assert.equal(witness.from, engine.blocks.length, 'it reached the end of the document');
    await until(() => !engine.hfPending, 'furniture done');
    assert.equal(engine.hfFolioRoot, engine.checkpoints.get(0));
  }, (engine) => { engine.canonical.schedule = () => {}; });
});

test('a witness replay completes across a genuine body rebuild queued ahead of it', { skip, timeout: 120_000 }, async () => {
  await withEngine(async (engine) => {
    await engine.open(twoside, undefined, { canonicalBaseline: false });
    const witness = await midReplay(engine);
    // a definition in the body: the suffix is rebuilt as body work
    const at = engine.getSource().indexOf('Short sentence 3.');
    const report = await engine.edit(at, at, '\\newcommand{\\Unused}{x}');
    assert.equal(report.stats.chainVerdict, 'leak');
    assert.ok(engine.pendingChain && engine.pendingChain.kind === 'rebuild', 'body rebuild queued');
    assert.equal(engine.hfWitness, witness, 'the replay keeps its own owner');
    await until(() => witness.settled, 'replay settled');
    assert.equal(witness.settled, 'done');
    await drain(engine);
    await until(() => !engine.hfPending, 'furniture done');
  }, (engine) => { engine.canonical.schedule = () => {}; });
});

test('a witness replay completes across a cold keystroke and its resume', { skip, timeout: 180_000 }, async () => {
  const paragraphs = [];
  for (let i = 1; i <= 90; i++) {
    paragraphs.push(`Paragraph ${i} keeps the resident chain walking for a while.`, '');
    if (i % 6 === 0) paragraphs.push('\\newpage', '');
  }
  const source = [String.raw`\documentclass[twoside]{article}`, String.raw`\begin{document}`, ...paragraphs,
    String.raw`\end{document}`, ''].join('\n');
  await withEngine(async (engine) => {
    await engine.open(source, undefined, { canonicalBaseline: false });
    const witness = await midReplay(engine);
    engine.coldPrefixBudgetMs = 1;
    engine.coldPreviewEnabled = false;
    const resumed = new Promise((resolve) => { engine.onDeferredUpdate = resolve; });
    const at = engine.getSource().indexOf('Paragraph 80 ') + 'Paragraph 80'.length;
    const cold = await engine.edit(at, at, 'x');
    assert.equal(cold.stats.chainVerdict, 'cold');
    assert.equal(engine.hfWitness, witness, 'the cold walk carries body work only');
    await resumed;
    await until(() => witness.settled, 'replay settled after the cold resume', 120_000);
    assert.equal(witness.settled, 'done');
    await until(() => !engine.hfPending, 'furniture done', 60_000);
  }, (engine) => {
    engine.canonical.schedule = () => {};
    engine.checkpointCeiling = 4;
  });
});

test('a witness replay whose fork fails recovers without an edit, and one that keeps failing is settled', { skip, timeout: 120_000 }, async () => {
  for (const failures of [1, 50]) {
    await withEngine(async (engine) => {
      let injected = false;
      engine.onOpeningSettled = () => {
        // the first witness JOB forks from the root checkpoint
        engine.checkpoints.get(0)?.send(`FAULT FORKFAIL ${failures}\n`);
        injected = true;
      };
      await engine.open(twoside, undefined, { canonicalBaseline: false });
      await until(() => injected, 'handoff');
      const witness = await until(() => engine.hfWitness, 'the replay is owed');
      await until(() => witness.settled, 'the replay settles without another edit', 30_000);
      await until(() => !engine.hfPending, 'hfPending ends', 30_000);
      assert.equal(engine.bgActive, false);
      if (failures === 1) {
        assert.equal(witness.settled, 'done', 'one failed fork is tried again');
        assert.equal(witness.failures, 1);
      } else {
        assert.equal(witness.settled, 'failed', 'a failure that persists is settled, not left owed');
        assert.ok(engine.diagnostics.some((line) => /witness replay failed .* settled without it/.test(line)));
      }
    }, (engine) => { engine.canonical.schedule = () => {}; });
  }
});

test('the witness pass renders only what the body owes; a body rebuild renders what c53846b does', async () => {
  // an unchanged galley: prose, then an untouched cold graphic with a capture
  const blocks = () => ['text', 'graphic'].map((id, i) => ({ id, galleyHash: id, stateVec: '[]',
    galley: { capture: i === 1 ? 'capture' : null }, needsRender: i === 1 }));
  const callbacks = (engine, renders) => ({
    nearestCheckpoint: () => 0, typesetBlock: async (i) => engine.blocks[i].galley, adoptGalley() {},
    queueRender: (id) => { renders.push(id); engine.renderWant.delete(id); }, asyncRepaginate() {}, chainAfterPass: async () => {},
    enforceCheckpointCap() {}, queueChainWork() {}, current: () => true,
  });
  const make = (pendingChain = null) => ({ blocks: blocks(), pendingChain, chunks: new Map(), renderWant: new Map(),
    labelTable: new Map(), hrefTable: new Map() });
  const body = make({ kind: 'rebuild', from: 0, phase: 'blocks', labels: new Set() });
  const bodyRenders = [];
  await runChainPass(body, callbacks(body, bodyRenders));
  assert.deepEqual(bodyRenders, ['graphic'], 'a genuine body rebuild renders the stale picture, as c53846b');
  const replay = make();
  const replayRenders = [];
  const witness = { from: 0 };
  assert.equal(await runWitnessPass(replay, witness, callbacks(replay, replayRenders)), 'done');
  assert.deepEqual(replayRenders, [], 'the replay leaves the untouched cold picture cold');
  assert.equal(witness.from, 2);
  // a picture the body already holds is the body's: the replay renders it again
  const held = make();
  held.chunks.set('graphic', { forGalley: 'old' });
  const heldRenders = [];
  await runWitnessPass(held, { from: 0 }, callbacks(held, heldRenders));
  assert.deepEqual(heldRenders, ['graphic']);
});

test('an opening ends with its own revision: an edit before the baseline starts, during it, or just after it lands', { skip, timeout: 240_000 }, async () => {
  const doc = String.raw`\documentclass{article}
\pagestyle{headings}
\begin{document}
\section{Alpha}

First paragraph.

\clearpage

Second paragraph.
\end{document}
`;
  for (const when of ['before', 'during', 'after']) {
    await withEngine(async (engine) => {
      let settled = null;
      engine.onOpeningSettled = () => { settled = { srcRev: engine.srcRev, canonical: engine.canonical.info(), ms: performance.now() }; };
      const opened = await engine.open(doc);
      const openedRev = engine.srcRev;
      assert.ok(engine.opening, 'still opening after the walk');
      assert.ok(engine.getDisplayLists().every((list) => furnitureOf(list).length === 0), 'no furniture while opening');
      const at = engine.getSource().indexOf('First paragraph') + 'First'.length;
      if (when === 'during') await until(() => engine.canonical.info().compiling, 'the baseline compiles');
      if (when === 'after') {
        // the edit arrives as the baseline's result does, before its body
        // verification and crops (onCanonicalResult)
        await new Promise((resolve, reject) => {
          engine.onCanonical = (info) => {
            if (info.rev !== openedRev || info.error) return;
            engine.onCanonical = null;
            assert.ok(engine.opening, 'after: still opening when the baseline lands');
            engine.edit(at, at, 's').then(resolve, reject);
          };
        });
      } else {
        assert.equal(settled, null, `${when}: still opening before the edit`);
        await engine.edit(at, at, 's');
      }
      // the edit's own canonical work stays queued: it is not the opening's
      assert.ok(engine.canonical.info().inFlight || engine.canonical.info().rev > openedRev);
      await until(() => settled, `${when}: the opening ends`, 60_000);
      if (when !== 'after') assert.ok(!(settled.canonical.rev > openedRev), `${when}: not waiting for the edited revision's PDF`);
      assert.equal(engine.openingAuthority, null, 'an edited opening hands off with no authority of its revision');
      await until(() => !engine.hfPending, `${when}: furniture done`, 60_000);
      assert.ok(furnitureOf(engine.getDisplayLists()[0]).length, `${when}: the provisional sheet gets its furniture`);
      assert.ok(opened.patches.length);
    }, (engine) => {
      // a short baseline debounce: the "before" edit lands before it starts
      engine.canonical.debounceMs = 1500;
    });
  }
});

test('an unedited opening shows no provisional furniture and hands off to the furniture work', { skip, timeout: 240_000 }, async () => {
  await withEngine(async (engine) => {
    const samples = [];
    let handoff = false;
    engine.onOpeningSettled = () => { handoff = true; };
    await engine.open(fancy(3));
    while (!handoff) {
      samples.push(engine.getDisplayLists().flatMap(furnitureOf).length);
      await delay(50);
    }
    assert.ok(samples.length > 3 && samples.every((n) => n === 0), 'no head, foot or folio while opening');
    assert.equal(engine.openingAuthority?.rev, engine.srcRev, 'the opened revision is the authority');
    await until(() => !engine.hfPending, 'furniture done', 120_000);
    assert.ok(engine.getDisplayLists().every((list) => furnitureOf(list).length), 'every sheet gets its furniture');
  });
});

test('continuous typing after an edited opening: heads and feet come within seconds of the handoff, and busy ends', { skip, timeout: 240_000 }, async () => {
  await withEngine(async (engine) => {
    let handoffAt = null;
    engine.onOpeningSettled = () => { handoffAt = performance.now(); };
    await engine.open(fancy(3));
    const at = engine.getSource().indexOf('Paragraph 2 of') + 'Paragraph 2'.length;
    const started = performance.now();
    let shownAt = null;
    let typed = 0;
    // one key every 300 ms for 30 s, from right after open
    while (performance.now() - started < 30_000) {
      await engine.edit(at + typed, at + typed, 'x');
      typed++;
      const lists = engine.getDisplayLists();
      if (handoffAt !== null && shownAt === null && lists.every((list) => furnitureOf(list).some((c) => c.src === '_hf' && c.hfSlot === 'h'))) {
        shownAt = performance.now();
      }
      await delay(300);
    }
    assert.ok(handoffAt !== null, 'the opening ended while the typing went on');
    assert.ok(handoffAt - started < 10_000, `the opening ended ${Math.round(handoffAt - started)} ms after the first key`);
    assert.ok(shownAt !== null, 'heads were shown while the typing went on');
    assert.ok(shownAt - handoffAt < 8_000, `heads came ${Math.round(shownAt - handoffAt)} ms after the handoff`);
    await until(() => !engine.hfPending, 'busy ends once the furniture is done', 60_000);
    // (the runs' glyphs, spaces apart)
    const text = engine.getDisplayLists().map((list) => furnitureOf(list).map((c) => c.text ?? '').join('').replace(/\s/g, ''));
    assert.deepEqual(text, ['Instructorcopy1', 'Instructorcopy2', 'Instructorcopy3']);
  });
});

test('an edit that changes what a sheet\'s head prints stamps that sheet\'s list, also while opening', { skip, timeout: 120_000 }, async () => {
  await withEngine(async (engine) => {
    await engine.open(String.raw`\documentclass{article}
\pagestyle{headings}
\begin{document}
\section{Alpha}

First paragraph.

\clearpage

Second paragraph.

\clearpage

Third paragraph.
\end{document}
`);
    const lists = () => engine.getDisplayLists();
    assert.ok(engine.opening, 'the baseline is still owed: opening');
    assert.ok(lists().every((list) => list.hfSince === undefined && list.hfUnknown === 'hf'), 'an unedited opening: no stamp');
    // every sheet's head prints the section mark (\rightmark): sheet 1 its own, the others the carried one
    const at = engine.getSource().indexOf('Alpha');
    const report = await engine.edit(at, at + 5, 'Bravo');
    const stamped = engine.srcRev;
    const patched = new Map(report.patches.filter((p) => p.type === 'replace-page').map((p) => [p.page, p.displayList]));
    for (const n of [1, 2, 3]) {
      const list = patched.get(n);
      assert.equal(list?.hfSince, stamped, `sheet ${n}'s list is sent stamped with the edit`);
      assert.equal(list.hfUnknown, 'hf', 'and says it describes neither slot yet');
    }
    await until(() => !engine.opening && !engine.hfPending, 'the edited opening hands off and its furniture lands', 90_000);
    assert.ok(lists().every((list) => list.hfSince === stamped && !list.hfUnknown), 'the furniture is known now');
    // prose leaves every head as it was
    const prose = engine.getSource().indexOf('Third paragraph') + 'Third'.length;
    await engine.edit(prose, prose, 's');
    assert.ok(lists().every((list) => list.hfSince === stamped), 'the stamp stays the revision that changed the heads');
  }, (engine) => { engine.canonical.debounceMs = 60_000; });
});
