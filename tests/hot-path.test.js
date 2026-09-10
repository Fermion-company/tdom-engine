// Edit hot-path invariants (docs/10): bounded foreground, checkpoint-suffix
// preservation, deferred chain work, and the defining equation of the whole
// incremental design — "any edit sequence converges to exactly what a fresh
// engine computes from the final source". These fork real lualatex processes;
// skipped without a TeX installation.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { CheckpointEngine } from '../engine/checkpoint/engine-v3.js';
import { buildDisplayList } from '../engine/checkpoint/display-list.js';
import { buildStream } from '../engine/checkpoint/stream.js';
import { handlePeerMessage } from '../engine/checkpoint/peer-message.js';
import { mayCaptureDisplayMath } from '../engine/checkpoint/render-hold.js';
import { preemptResidentRenders } from '../engine/checkpoint/render-pump.js';
import { abortBackgroundJob } from '../engine/checkpoint/abort-background-job.js';
import { classifyDocument } from '../engine/checkpoint/safety.js';
import { sourceClosure } from '../engine/checkpoint/closure.js';
import { classifyStructuralAliases } from '../engine/checkpoint/structural-aliases.js';
import { ShippingChain } from '../engine/checkpoint/shipping.js';
import { makeShippingChain, shippingInputState } from '../engine/checkpoint/shipping-manager.js';
import { renderIsolatedBlock } from '../engine/checkpoint/isolated-render.js';
import { isoCompile } from '../engine/checkpoint/iso-compile.js';
import { segmentBody } from '../engine/segmenter.js';
import { finalizeShippingExactUpdate } from '../engine/checkpoint/update-finalize.js';
import { classifyResidentEdit } from '../engine/checkpoint/resident-edit-admission.js';
import { plainPreviewWitness, canDeferPlainVerification } from '../engine/checkpoint/plain-preview.js';
import {
  dirtyWithoutPatchFallback,
  planTerminalCanonicalAnchor,
} from '../engine/checkpoint/canonical-anchor.js';

const TEST_WORK_ROOT = process.env.TDOM_TEST_WORK_ROOT;
const workDir = (name) => TEST_WORK_ROOT
  ? path.join(TEST_WORK_ROOT, name)
  : fileURLToPath(new URL(`../${name}`, import.meta.url));
const WORK = workDir('.tdom-hotpath-test');
const WORK2 = workDir('.tdom-hotpath-test-scratch');
const WORK3 = workDir('.tdom-hotpath-test-mixed-shipping');

const available = await promisify(execFile)('lualatex', ['--version'], { timeout: 15_000 }).then(
  () => true,
  () => false
);
const opts = available ? {} : { skip: 'lualatex not installed' };

test('shipping checkpoints stay bounded across long documents and resident budget changes', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'tdom-shipping-cap-'));
  let budget = 8;
  const chain = new ShippingChain({ workDir: root, checkpointBudget: () => budget });
  const retired = [];
  const peer = page => ({ alive: true, pid: 0, send: message => {
    assert.equal(message, 'DIE\n');
    retired.push(page);
  } });
  try {
    for (let page = 0; page <= 316; page++) {
      chain.checkpoints.set(page, peer(page));
      chain.trimCheckpoints();
      assert.ok(chain.checkpoints.size <= 8);
      assert.ok(chain.checkpoints.has(0), 'the root remains a replay frontier');
      assert.ok(chain.checkpoints.has(page), 'recent page stays warm');
    }
    assert.ok(retired.length >= 309);
    assert.ok([...chain.checkpoints.keys()].some(page => page > 0 && page < 160), 'sparse earlier coverage survives');
    budget = 2;
    chain.trimCheckpoints();
    assert.deepEqual([...chain.checkpoints.keys()], [0, 316]);
    budget = 1;
    chain.trimCheckpoints();
    assert.deepEqual([...chain.checkpoints.keys()], [0]);
    assert.equal(chain.info().checkpointLimit, 1);
    assert.equal(chain.info().checkpointCount, 1);
  } finally {
    await chain.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('shipping treats one known literal child edit as a real immutable replay unit', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'tdom-shipping-child-input-'));
  const docDir = path.join(root, 'project');
  const overlayDir = path.join(root, 'overlay');
  const workDir = path.join(root, 'ship');
  const child = path.join(docDir, 'content', 'child.tex');
  const overlayChild = path.join(overlayDir, 'content', 'child.tex');
  mkdirSync(path.dirname(child), { recursive: true });
  mkdirSync(path.dirname(overlayChild), { recursive: true });
  mkdirSync(workDir, { recursive: true });
  writeFileSync(child, 'disk fallback\n');
  const source = String.raw`\documentclass{article}
\begin{document}
prefix\newpage

\input{content/child.tex}

tail
\end{document}
`;
  const unitsOf = (text) => {
    const begin = text.indexOf('\\begin{document}') + '\\begin{document}'.length;
    const end = text.indexOf('\\end{document}', begin);
    const body = text.slice(begin, end);
    const segments = segmentBody(body, 0);
    const units = segments.map((segment, index) =>
      body.slice(index === 0 ? 0 : segment.start, segments[index + 1]?.start ?? body.length));
    units.push('\\end{document}');
    return units;
  };
  const targetUnit = unitsOf(source).findIndex((unit) => unit.includes('\\input{content/child.tex}')) + 1;
  assert.ok(targetUnit > 1);
  let revision = 1;
  let currentChild = '観測値はAです。\n';
  const engine = {
    workDir,
    docDir,
    overlayDir,
    file: 'main.tex',
    preHash: 'pre',
    srcRev: revision,
    shipSessionId: 'child-session',
    shipDocumentEpoch: 1,
    shipDesiredCanonicalId: 1,
    shipDesiredCanonicalHash: 'canon',
    includes: new Map(),
    shippingIncludeTrace: [],
    store: { get: () => source },
  };
  const state = (value, changes = null, { command = 'input', sourceText = source } = {}) => {
    currentChild = value;
    writeFileSync(overlayChild, value);
    engine.srcRev = revision++;
    engine.store = { get: () => sourceText };
    engine.includes.set(child, { mtime: engine.srcRev, readPath: overlayChild, text: value });
    const rootUnit = unitsOf(sourceText).findIndex((unit) =>
      unit.includes(`\\${command}{content/child.tex}`)) + 1;
    engine.shippingIncludeTrace = [{
      actualPath: child,
      readPath: overlayChild,
      command,
      raw: 'content/child.tex',
      depth: 0,
      parentFile: path.join(docDir, 'main.tex'),
      rootUnit,
    }];
    return shippingInputState(engine, changes);
  };
  const unreachable = path.join(docDir, 'content', 'no-longer-read.tex');
  writeFileSync(unreachable, 'current disk bytes\n');
  engine.includes.set(unreachable, {
    mtime: 1,
    readPath: unreachable,
    text: 'stale cached bytes\n',
  });
  const stateA = state(currentChild);
  assert.equal(stateA.dependencies.some((entry) => entry.actualPath === unreachable), false,
    'a no-longer-reached include cache entry is outside the input snapshot');
  assert.equal(stateA.mirrorEntries.some((entry) => entry.projectPath === 'content/no-longer-read.tex'), false,
    'stale cached bytes cannot shadow the current disk fallback');
  const chain = new ShippingChain({ workDir, docDir, overlayDir });
  const sent = new Map();
  const peer = (page) => ({ alive: true, pid: 0, gen: 0, send: (message) => {
    if (!sent.has(page)) sent.set(page, []);
    sent.get(page).push(message);
  } });
  chain.source = source;
  chain.lines = unitsOf(source);
  chain.inputState = stateA;
  chain.acceptedSnapshotId = stateA.identity.snapshotId;
  chain.baselinePages = 8;
  chain.baselineManifest = {};
  chain.checkpoints.set(0, peer(0));
  chain.checkpoints.set(4, peer(4));
  chain.checkpoints.set(5, peer(5));
  chain.ships = [
    { page: 4, nline: targetUnit - 1, gen: 0 },
    { page: 5, nline: targetUnit, gen: 0 },
  ];
  try {
    const stateB = state('観測値はBです。\n', { changed: [child], removed: [] });
    const b = chain.resume(source, stateB);
    assert.deepEqual(b, { mode: 'resumed', fromPage: 5, firstChanged: targetUnit });
    assert.deepEqual(sent.get(5), ['DIE\n'], 'checkpoint inside the old child input is retired');
    assert.match(readFileSync(path.join(chain.inputMirrorDir, 'content', 'child.tex'), 'utf8'), /B/);
    assert.equal(chain.acceptedSnapshotId, stateB.identity.snapshotId);

    const bGeneration = chain.gen;
    const stateC = state('観測値はCです。\n', { changed: [child], removed: [] });
    const c = chain.resume(source, stateC);
    assert.equal(c.mode, 'resumed');
    assert.ok(chain.gen > bGeneration, 'a rapid child edit supersedes the B lineage');
    assert.match(readFileSync(path.join(chain.inputMirrorDir, 'content', 'child.tex'), 'utf8'), /C/);
    assert.equal(chain.acceptedSnapshotId, stateC.identity.snapshotId);

    const acceptedGeneration = chain.gen;
    const acceptedSnapshot = chain.acceptedSnapshotId;
    const unknown = state('観測値はCです。\n', { changed: [], removed: [], unknown: true });
    assert.deepEqual(chain.resume(source, unknown), {
      mode: 'reboot-needed', reason: 'dependency-change-unobserved',
    });
    assert.equal(chain.gen, acceptedGeneration);
    assert.equal(chain.acceptedSnapshotId, acceptedSnapshot, 'unknown refresh cannot retag old pixels');

    const mixedSource = source.replace('tail', 'tail changed');
    const mixed = state('観測値はCです。\n', { changed: [], removed: [], unknown: true }, {
      sourceText: mixedSource,
    });
    assert.deepEqual(chain.resume(mixedSource, mixed), {
      mode: 'reboot-needed', reason: 'mixed-source-dependency-edit',
    });

    const dynamicSource = source.replace('prefix\\newpage', String.raw`\def\p{content/}
\input{\p child.tex}
prefix\newpage`);
    const dynamicOld = state('観測値はCです。\n', null, { sourceText: dynamicSource });
    const dynamicNew = state('観測値はDです。\n', { changed: [child], removed: [] }, {
      sourceText: dynamicSource,
    });
    chain.source = dynamicSource;
    chain.lines = unitsOf(dynamicSource);
    chain.inputState = dynamicOld;
    chain.acceptedSnapshotId = dynamicOld.identity.snapshotId;
    chain.ships = [{ page: 4, nline: dynamicNew.dependencies[0].reads[0].rootUnit - 1, gen: chain.gen }];
    chain.checkpoints.set(4, peer(4));
    assert.deepEqual(chain.resume(dynamicSource, dynamicNew), {
      mode: 'reboot-needed', reason: 'dependency-reboot-required',
    }, 'an unresolved earlier reader prevents child-local replay');

    const unsafeRoot = source.replace('prefix\\newpage', String.raw`\directlua{texio.write('stateful')}
prefix\newpage`);
    const unsafeOld = state('観測値はCです。\n', null, { sourceText: unsafeRoot });
    const unsafeNew = state('観測値はDです。\n', { changed: [child], removed: [] }, {
      sourceText: unsafeRoot,
    });
    chain.source = unsafeRoot;
    chain.lines = unitsOf(unsafeRoot);
    chain.inputState = unsafeOld;
    chain.acceptedSnapshotId = unsafeOld.identity.snapshotId;
    assert.deepEqual(chain.resume(unsafeRoot, unsafeNew), {
      mode: 'reboot-needed', reason: 'dependency-reboot-required',
    }, 'child replay keeps the root document-effect safety profile');

    const includeSource = source.replace('\\input{content/child.tex}', '\\include{content/child.tex}');
    const includeOld = state('観測値はCです。\n', null, { command: 'include', sourceText: includeSource });
    const includeNew = state('観測値はDです。\n', { changed: [child], removed: [] }, {
      command: 'include', sourceText: includeSource,
    });
    chain.source = includeSource;
    chain.lines = unitsOf(includeSource);
    chain.inputState = includeOld;
    chain.acceptedSnapshotId = includeOld.identity.snapshotId;
    assert.deepEqual(chain.resume(includeSource, includeNew), {
      mode: 'reboot-needed', reason: 'dependency-reboot-required',
    }, '\\include keeps its conservative aux/clearpage path');

    const delayed = [];
    const guardEngine = {
      ...engine,
      maxCheckpoints: 8,
      checkpoints: new Map(),
      shipStale: false,
      shipGenRev: new Map([[7, 2]]),
      shipGenSnapshot: new Map([[7, stateB.identity.snapshotId]]),
      shipDesiredInputSnapshot: stateC.identity.snapshotId,
      srcRev: 3,
      onShipWave: (wave) => delayed.push(wave),
    };
    const guardedChain = makeShippingChain(guardEngine, () => {});
    guardEngine.shipping = guardedChain;
    guardedChain.onWave({ gen: 7, snapshotId: stateB.identity.snapshotId });
    assert.deepEqual(delayed, [], 'an unsupported C revision blocks a delayed B wave');
    await guardedChain.close();
  } finally {
    await chain.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('document switches bind replacement shipping to the new project and overlay', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'tdom-document-context-'));
  const first = path.join(root, 'first');
  const second = path.join(root, 'second');
  const overlay = path.join(root, 'overlay');
  for (const dir of [first, second, overlay]) mkdirSync(dir);
  const previousShip = process.env.TDOM_SHIP;
  process.env.TDOM_SHIP = '1';
  const engine = new CheckpointEngine({ workDir: path.join(root, 'work'), docDir: first });
  if (previousShip === undefined) delete process.env.TDOM_SHIP;
  else process.env.TDOM_SHIP = previousShip;
  try {
    const initial = engine.shipping;
    const checkpoints = engine.checkpoints;
    engine.checkpoints = new Map(Array.from({ length: engine.maxCheckpoints * 2 - 2 }, (_, i) => [i, {}]));
    assert.equal(initial.checkpointLimit(), 2, 'the resident tree reduces the actual shipping chain budget');
    engine.checkpoints = checkpoints;
    await engine.setDocumentContext({ docDir: second, overlayDir: overlay });
    assert.notEqual(engine.shipping, initial);
    assert.equal(engine.shipping.docDir, second);
    assert.equal(engine.shipping.overlayDir, overlay);
    assert.equal(engine.canonical.docDir, second);
    assert.equal(engine.canonical.overlayDir, overlay);
    await engine.setDocumentContext({ docDir: first });
    assert.equal(engine.shipping.docDir, first);
    assert.equal(engine.shipping.overlayDir, null, 'previous unsaved inputs must not leak');
  } finally {
    await engine.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('isolated exact chunks resolve project classes and prefer unsaved inputs', opts, async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'tdom-isolated-inputs-'));
  const docDir = path.join(root, 'project');
  const overlayDir = path.join(root, 'overlay');
  for (const dir of [docDir, overlayDir]) mkdirSync(dir);
  writeFileSync(path.join(docDir, 'tdomlocal.cls'), String.raw`\LoadClass{article}`);
  writeFileSync(path.join(docDir, 'content.tex'), String.raw`\errmessage{Stale disk input}`);
  writeFileSync(path.join(overlayDir, 'content.tex'), 'OverlayInputWitness');
  const block = { id: 'local', text: String.raw`\input{content.tex}`, galley: {}, galleyHash: 'local-inputs' };
  const engine = {
    workDir: path.join(root, 'work'), docDir, overlayDir,
    blocks: [block], counters: [], chunks: new Map(), isoChildren: new Set(),
    rescueQueue: new Map(), canonical: { info: () => ({ inFlight: false }) },
    labelTable: new Map(), hrefTable: new Map(), geometry: {}, file: 'main.tex',
    store: { get: () => String.raw`\documentclass{tdomlocal}\begin{document}\input{content.tex}\end{document}` },
  };
  let repaginated = false;
  try {
    await renderIsolatedBlock(engine, {
      block, idx: 0,
      chunkTargets: () => [{ key: block.id, page: 1, w: 400, h: 30 }],
      asyncRepaginate: () => { repaginated = true; },
    });
    const chunk = engine.chunks.get(block.id);
    assert.ok(chunk?.editPdf, 'local class must produce an exact PDF');
    assert.equal(repaginated, true);
    const pdf = path.join(root, 'result.pdf');
    writeFileSync(pdf, chunk.editPdf);
    const result = await promisify(execFile)('pdftotext', [pdf, '-']);
    assert.match(result.stdout, /OverlayInputWitness/, 'unsaved input must shadow disk');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a malformed fork PDF retries cold without adopting partial chunks', opts, async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'tdom-corrupt-fork-'));
  let finished;
  const peer = {
    send(command) {
      const jobdir = decodeURIComponent(command.trim().split(' ')[2]);
      writeFileSync(path.join(jobdir, 'driver.pdf'), '%PDF-1.7\ninvalid objects\n%%EOF\n');
      writeFileSync(path.join(jobdir, 'state.json'), JSON.stringify({ w: 100, h: 10, d: 0, items: [] }));
      finished();
    },
    sendRaw() {},
  };
  const block = { id: 'corrupt', text: 'Text' };
  const engine = {
    file: 'main.tex', workDir: root, blocks: [block], counters: [],
    checkpoints: new Map([[0, peer]]), isoForkBroken: new Set(), isoFailCache: new Map(),
    labelTable: new Map(), geometry: {}, chunks: new Map(),
    store: { get: () => String.raw`\documentclass{article}\begin{document}Text\end{document}` },
  };
  const coldResult = { chunks: ['verified cold result'] };
  let retries = 0;
  try {
    const result = await isoCompile(engine, {
      block, idx: 0, why: 'conversion regression', forceCold: false,
      rescueCacheKey: () => 'corrupt-key', needsRescue: () => false,
      awaitRender: () => new Promise(resolve => { finished = resolve; }),
      isoCompileCold: async () => { retries++; return coldResult; },
    });
    assert.equal(result, coldResult);
    assert.equal(retries, 1);
    assert.equal(engine.isoForkBroken.has(block.id), true);
    assert.equal(engine.chunks.size, 0);
    assert.equal(engine.isoFailCache.size, 0, 'corrupt fork must not poison the cold retry');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('exact page-building aliases segment as one block and ambiguous aliases fail closed', () => {
  const direct = String.raw`\newcommand\OpenLedgerColumns{\begin{multicols}{2}}
\newcommand\CloseLedgerColumns{\end{multicols}}`;
  assert.equal(classifyDocument(direct, 'plain prose').safe, true, 'unused wrappers stay structured');
  const directBody = String.raw`\OpenLedgerColumns

first paragraph

second paragraph

\CloseLedgerColumns`;
  const directGate = classifyStructuralAliases(direct, directBody);
  assert.equal(directGate.safe, true, 'exact paired wrappers stay incremental');
  assert.equal(
    directGate.requiresShippingExact,
    true,
    'segmentable output-routine aliases still require TeX-exact page promotion'
  );
  assert.equal(
    classifyDocument(direct, directBody).previewPolicy,
    'shipping-exact',
    'JS pagination stays presentation-ineligible for the certified region'
  );
  assert.equal(
    segmentBody(directBody, 0, { structuralEvents: directGate.segmentEvents }).length,
    1,
    'hidden environment boundaries keep every inner paragraph in one block'
  );

  const transitive = String.raw`\newcommand\C{\begin{longtable}{c}}
\newcommand\B{\C}
\let\A\B`;
  const transitiveBody = String.raw`\A body \end{longtable}`;
  assert.equal(
    classifyStructuralAliases(transitive, transitiveBody).safe,
    false,
    'mixed alias/literal boundaries remain conservative'
  );

  const xparse = String.raw`\NewDocumentCommand{\OpenParallel}{m}{\begin{paracol}{#1}}`;
  assert.equal(classifyDocument(xparse, String.raw`\OpenParallel{2}`).safe, false, 'xparse aliases demote');

  const customEnvironment = String.raw`\newenvironment{ledgerSpread}
    {\begin{multicols}{2}}{\end{multicols}}`;
  assert.equal(
    classifyDocument(customEnvironment, String.raw`\begin{ledgerSpread}x\end{ledgerSpread}`).safe,
    true,
    'literal custom-environment boundaries stay incremental'
  );

  assert.equal(
    classifyDocument(direct, "% \\OpenLedgerColumns\n\\verb|\\OpenLedgerColumns|").safe,
    true,
    'comments and literal payloads do not count as uses'
  );
  assert.equal(
    classifyDocument('', String.raw`\newcommand\LateOpen{\begin{multicols}{2}} text \LateOpen`).safe,
    false,
    'unpaired body-local definitions fail closed'
  );

  const nativeColumns = String.raw`\newcommand\SwitchLedgerLayout{\twocolumn}`;
  assert.equal(
    classifyDocument(nativeColumns, String.raw`\SwitchLedgerLayout`).safe,
    false,
    'native column-layout commands hidden by wrappers demote'
  );

  const ambiguous = String.raw`\newcommand\SpreadMode{\begin{multicols}{2}}
\renewcommand\SpreadMode{\begin{paracol}{2}}`;
  assert.equal(
    classifyStructuralAliases(ambiguous, String.raw`\SpreadMode`).safe,
    false,
    'multiply-defined structural effects fail closed'
  );
});

test('shipping-exact edits publish source immediately without resident page patches', () => {
  const order = [];
  const engine = {
    rev: 7,
    srcRev: 11,
    backendName: 'checkpoint',
    mode: 'structured',
    modeReasons: [],
    previewPolicy: 'shipping-exact',
    previewReasons: ['certified structural alias: \\Open -> multicols'],
    blocks: [{ id: 'b1' }, { id: 'b2' }],
    pages: [{ number: 1 }],
    checkpoints: new Map([[0, {}]]),
    pendingChain: null,
    verifyState: null,
    diagnostics: [],
    canonical: {
      schedule(source, rev) { order.push(['canonical', source, rev]); },
      info() { return { id: 3, rev: 11, pageCount: 42 }; },
    },
    getFontManifest() { return []; },
  };
  const timer = {
    laps: [],
    lap(name) { this.laps.push(name); },
    done() { return { totalUs: 120 }; },
  };
  const report = finalizeShippingExactUpdate(engine, {
    text: 'snapshot-12',
    editLabel: 'main.tex:8517:1-8517:1',
    dirtySource: new Set(['b2']),
    firstDirty: 1,
    rebooted: false,
    diagnostics: [],
    timer,
    callbacks: {
      queueChainWork(kind, from, labels) {
        engine.pendingChain = { kind, from, labels: new Set(labels) };
      },
      shipUpdate(source) { order.push(['ship', source, engine.srcRev]); },
      scheduleBackground(from) { order.push(['background', from, engine.srcRev]); },
      fidelitySummary() { return {}; },
    },
  });
  assert.equal(report.srcRev, 12);
  assert.equal(report.stats.blocksTypeset, 0);
  assert.equal(report.stats.chainVerdict, 'shipping-deferred');
  assert.deepEqual(report.patches, []);
  assert.deepEqual(report.dirtyPages, []);
  assert.equal(report.stats.pageCount, 42, 'last exact page tree remains the presentation authority');
  assert.deepEqual(order, [
    ['ship', 'snapshot-12', 12],
    ['canonical', 'snapshot-12', 12],
    ['background', 1, 12],
  ]);
});

test('shipping-exact foreground admission is limited to independent plain paragraphs', () => {
  const oldBlock = {
    id: 'b1', start: 20, end: 55, text: 'ordinary prose here\ncontinued prose',
    galley: { items: [] }, fidelity: { level: 'safe-glyph' },
    structuralSinks: [],
  };
  const block = { ...oldBlock, end: 56, text: 'ordinary prose! here\ncontinued prose' };
  const before = `${'x'.repeat(20)}${oldBlock.text}`;
  const after = `${'x'.repeat(20)}${block.text}`;
  const context = {
    file: 'main.tex', start: 34, end: 34, replacement: '!',
    before, after, baseSrcRev: 7,
  };
  const engine = {
    file: 'main.tex', srcRev: 7, blocks: [block], pendingChain: null,
  };
  assert.deepEqual(classifyResidentEdit(engine, {
    text: after,
    editContext: context,
    oldBlocks: [oldBlock],
    dirtySource: new Set(['b1']),
    rebooted: false,
  }), { kind: 'probe', blockId: 'b1' });

  const atomicOld = {
    ...oldBlock,
    text: '\\begin{multicols}{2}\nordinary prose here\n\\end{multicols}',
    end: 20 + '\\begin{multicols}{2}\nordinary prose here\n\\end{multicols}'.length,
  };
  const atomicBlock = { ...atomicOld, text: atomicOld.text.replace('prose', 'prose!'), end: atomicOld.end + 1 };
  const atomicBefore = `${'x'.repeat(20)}${atomicOld.text}`;
  const atomicAfter = `${'x'.repeat(20)}${atomicBlock.text}`;
  assert.deepEqual(classifyResidentEdit({ ...engine, blocks: [atomicBlock] }, {
    text: atomicAfter,
    editContext: {
      ...context,
      start: atomicBefore.indexOf('prose') + 5,
      end: atomicBefore.indexOf('prose') + 5,
      before: atomicBefore,
      after: atomicAfter,
    },
    oldBlocks: [atomicOld],
    dirtySource: new Set(['b1']),
    rebooted: false,
  }), { kind: 'exact-only', reason: 'atomic-layout-region' });
});

test('mixed heavy document resumes exact waves from visible edits in rich TeX contexts', opts, async () => {
  const sourcePath = fileURLToPath(
    new URL('../corpus/14-mixed-heavy-columns.tex', import.meta.url)
  );
  const previousWaveCutoff = process.env.TDOM_SHIP_WAVE_CUTOFF;
  const waveCutoffMs = Number(
    process.env.TDOM_TEST_WAVE_CUTOFF ?? previousWaveCutoff ?? 700
  );
  process.env.TDOM_SHIP_WAVE_CUTOFF = String(waveCutoffMs);
  rmSync(WORK3, { recursive: true, force: true });
  const chain = new ShippingChain({ workDir: WORK3, docDir: fileURLToPath(new URL('../corpus', import.meta.url)) });
  const waves = [];
  chain.onWave = (wave) => waves.push(wave);
  try {
    let source = readFileSync(sourcePath, 'utf8');
    let publishedSource = source;
    await chain.open(source);
    const baselineStarted = Date.now();
    while ((!chain.info().baselineReady || !chain.info().done) && Date.now() - baselineStarted < 120_000) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.equal(chain.info().error, null, `shipping baseline failed: ${chain.info().error}`);
    assert.equal(chain.info().baselineReady, true, 'mixed exact baseline certified');
    assert.ok(chain.info().pages >= 6, `stress source spans real pages (${chain.info().pages})`);
    assert.ok(chain.checkpoints.get(0)?.alive, 'body-root checkpoint is ready before first user unit');

    const scenarios = [
      ['first-page prose', 'PROSEMARKA', 'PROSEMARKB', true],
      ['tcolorbox body', 'BOXMARKA', 'BOXMARKB', true],
      ['table cell', 'TABLEMARKA', 'TABLEMARKB', true],
      ['macro-wrapped multicols', 'COLMARKA', 'COLMARKB', true],
      ['TikZ node argument', 'NODEMARKA', 'NODEMARKB', true],
      ['ordinary prose', 'TAILPROSEA', 'TAILPROSEB', true],
      ['tail tcolorbox', 'TAILBOXA', 'TAILBOXB', true],
      ['tail footnote argument', 'TAILNOTEA', 'TAILNOTEB', true],
      ['captured multi-page argument', 'CAPTUREMARKA', 'CAPTUREMARKB', true],
      // Caption text is a moving argument and changes the .lof output.  The
      // tail may execute, but it must not replace the visible authority while
      // the retained prefix was built from the old auxiliary-file universe.
      ['float caption argument', 'CAPTIONMARKA', 'CAPTIONMARKB', false],
    ];
    for (const [label, before, after, expectWave] of scenarios) {
      assert.ok(source.includes(before), `${label}: source marker exists`);
      const next = source.replace(before, after);
      const capturedUnitPage = label === 'captured multi-page argument'
        ? Math.min(
            ...chain.ships
              .filter((ship) => chain.lines[ship.nline - 1]?.includes(before))
              .map((ship) => ship.page)
          )
        : null;
      const started = Date.now();
      const outcome = chain.resume(next);
      assert.equal(outcome.mode, 'resumed', `${label}: ${JSON.stringify(outcome)}`);
      if (label === 'captured multi-page argument') {
        assert.ok(Number.isFinite(capturedUnitPage), 'captured unit spans a shipped page');
        assert.ok(
          outcome.fromPage <= capturedUnitPage,
          `resume cut ${outcome.fromPage} precedes captured-token checkpoint ${capturedUnitPage}`
        );
      }
      const generation = chain.info().gen;
      while (
        !waves.some((wave) => wave.gen === generation) &&
        !chain.info().rejectReason &&
        Date.now() - started < 5_000
      ) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      const wave = waves.find((candidate) => candidate.gen === generation);
      if (!expectWave) {
        assert.equal(wave, undefined, `${label}: changed auxiliary output must not be promoted`);
        assert.equal(chain.info().rejectReason, 'output-manifest-changed');
        console.log(`    mixed shipping ${label}: fail-closed on changed output manifest`);
        source = next;
        continue;
      }
      assert.ok(wave, `${label}: exact wave missed the configured cutoff (${JSON.stringify(chain.info())})`);
      assert.ok(wave.elapsedMs < waveCutoffMs, `${label}: exact wave took ${wave.elapsedMs}ms`);
      const pdf = chain.info().completePdf;
      assert.ok(pdf, `${label}: complete PDF published`);
      const { stdout } = await promisify(execFile)('pdftotext', [pdf, '-'], { timeout: 30_000 });
      assert.match(stdout, new RegExp(after), `${label}: certified PDF contains the edit`);
      console.log(`    mixed shipping ${label}: page ${outcome.fromPage}, ${wave.elapsedMs}ms`);
      source = next;
      publishedSource = next;
    }

    const truthWork = `${WORK3}-truth`;
    const shipRaster = `${WORK3}-ship-raster`;
    const truthRaster = `${WORK3}-truth-raster`;
    for (const dir of [truthWork, shipRaster, truthRaster]) {
      rmSync(dir, { recursive: true, force: true });
      mkdirSync(dir, { recursive: true });
    }
    writeFileSync(`${truthWork}/main.tex`, publishedSource);
    await promisify(execFile)(
      'lualatex',
      ['--shell-escape', '-interaction=nonstopmode', '-halt-on-error', 'main.tex'],
      { cwd: truthWork, timeout: 120_000 }
    );
    await Promise.all([
      promisify(execFile)(
        'pdftocairo',
        ['-png', '-r', '96', chain.info().completePdf, `${shipRaster}/page`],
        { timeout: 120_000 }
      ),
      promisify(execFile)(
        'pdftocairo',
        ['-png', '-r', '96', `${truthWork}/main.pdf`, `${truthRaster}/page`],
        { timeout: 120_000 }
      ),
    ]);
    const rasterHashes = (dir) => readdirSync(dir)
      .filter((name) => name.endsWith('.png'))
      .sort()
      .map((name) => createHash('sha256').update(readFileSync(`${dir}/${name}`)).digest('hex'));
    assert.deepEqual(
      rasterHashes(shipRaster),
      rasterHashes(truthRaster),
      'resumed complete PDF raster-matches a fresh LuaLaTeX process on every page'
    );

    const rejectedGeneration = chain.info().gen;
    const unsafe = [
      ['math token', source.replace('n(n+1)', 'm(n+1)')],
      ['comment text', source.replace('COMMENTMARKA', 'COMMENTMARKB')],
      ['control-word splice', source.replace('\\section{Combined tail}', '\\sectiom{Combined tail}')],
      ['TeX special character', source.replace('TAILPROSEB', 'TAILPROS{B')],
      ['verbatim payload', source.replace('VERBATIMMARKA', 'VERBATIMMARKB')],
    ];
    for (const [label, next] of unsafe) {
      assert.notEqual(next, source, `${label}: fixture mutation exists`);
      assert.deepEqual(
        chain.resume(next),
        { mode: 'reboot-needed', reason: 'non-plain-edit' },
        `${label}: replay admission fails closed`
      );
      assert.equal(chain.info().gen, rejectedGeneration, `${label}: no generation forked`);
      assert.equal(chain.source, source, `${label}: certified source remains untouched`);
    }
  } finally {
    if (previousWaveCutoff === undefined) delete process.env.TDOM_SHIP_WAVE_CUTOFF;
    else process.env.TDOM_SHIP_WAVE_CUTOFF = previousWaveCutoff;
    await chain.close();
    for (const dir of [WORK3, `${WORK3}-truth`, `${WORK3}-ship-raster`, `${WORK3}-truth-raster`]) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

test('newif-created conditionals close without weakening package-macro conservatism', () => {
  assert.equal(sourceClosure(String.raw`\newif\ifLedgerWide
\ifLedgerWide wide\else narrow\fi`).closed, true);
  assert.equal(sourceClosure(String.raw`\ifthenelse{a}{b}{c}`).closed, true);
  assert.equal(sourceClosure(String.raw`\ifnum 1=1 unfinished`).closed, false);
});

test('loop repeat closes only its own pending conditional', () => {
  assert.equal(sourceClosure(String.raw`\newcommand{\lines}[1]{\loop\ifnum\count0<#1 x\repeat}`).closed, true);
  assert.equal(sourceClosure(String.raw`\iftrue\loop\ifnum1<2 {\loop\ifnum2<3 x\repeat}\repeat\fi`).closed, true);
  for (const text of [String.raw`\loop\ifnum1<2 x`, String.raw`\loop x\repeat`,
    String.raw`\iftrue\loop x\repeat`, String.raw`\loop\iftrue\iftrue x\repeat`]) {
    assert.equal(sourceClosure(text).closed, false, text);
  }
});

const para = (s) =>
  `${s} paragraph with enough plain words to make a couple of real lines ` +
  `of typeset material for the measurement to mean something at all.`;

function makeDoc() {
  const L = [];
  L.push('\\documentclass{article}');
  L.push('\\usepackage{amsmath}');
  L.push('\\begin{document}');
  L.push('');
  L.push('\\newcommand{\\foo}{alpha-value}');
  L.push('');
  L.push('\\section{Alpha}\\label{sec:alpha}');
  L.push('');
  L.push(para('Opening alpha'));
  L.push('');
  L.push(para('Second alpha crossref to Section~\\ref{sec:gamma} ahead in'));
  L.push('');
  L.push('\\begin{equation}\\label{eq:one}');
  L.push('  a^2 + b^2 = c^2');
  L.push('\\end{equation}');
  L.push('');
  L.push('A displayed odd-function explanation begins here.');
  L.push('\\[');
  L.push('  h(x)=x^3-2x');
  L.push('\\]');
  L.push('is paired with');
  L.push('\\[');
  L.push('  h(-x)=-h(x)');
  L.push('\\]');
  L.push('and ends here.');
  L.push('');
  L.push(para('Macro user says \\foo{} inline in a normal'));
  L.push('');
  L.push('\\section{Beta}\\label{sec:beta}');
  L.push('');
  L.push(para('MIDWORD beta one'));
  L.push('');
  L.push(para('Beta two'));
  L.push('');
  L.push(para('Beta three'));
  L.push('');
  L.push('\\section{Gamma}\\label{sec:gamma}');
  L.push('');
  L.push(para('Gamma one refers to~\\eqref{eq:one} inside'));
  L.push('');
  L.push(para('Gamma two'));
  L.push('');
  L.push('\\section{Delta}\\label{sec:delta}');
  L.push('');
  for (let k = 0; k < 6; k++) {
    L.push(para(`Delta filler ${k}`));
    L.push('');
  }
  L.push('\\begin{align*}');
  L.push('u &= v \\\\[2mm]');
  L.push('w &= z');
  L.push('\\end{align*}');
  L.push('');
  L.push('\\section{Epsilon}\\label{sec:eps}');
  L.push('');
  L.push(para('Epsilon one'));
  L.push('');
  L.push(para('TAILWORD epsilon final'));
  L.push('');
  L.push('\\end{document}');
  L.push('');
  return L.join('\n');
}

/** Wait until the engine has nothing left to do (chain work, rescues). */
async function drain(eng, timeoutMs = 120_000) {
  const t0 = Date.now();
  for (;;) {
    await eng.bgTask?.catch?.(() => {});
    // rescuePumping: an in-flight async rescue is invisible to
    // rescueQueue.size alone (the pump dequeues before compiling)
    const busy =
      eng.pendingChain || eng.bgActive || eng.rescuePumping || (eng.rescueQueue?.size ?? 0) > 0;
    if (!busy) {
      await new Promise((r) => setTimeout(r, 400));
      if (
        !eng.pendingChain &&
        !eng.bgActive &&
        !eng.rescuePumping &&
        (eng.rescueQueue?.size ?? 0) === 0
      )
        return;
    } else {
      await new Promise((r) => setTimeout(r, 100));
    }
    if (Date.now() - t0 > timeoutMs) {
      throw new Error(
        `drain timeout (pendingChain=${JSON.stringify(eng.pendingChain)} rescues=${eng.rescueQueue?.size})`
      );
    }
  }
}

/** Lineage-independent identity of the whole document state. */
const signature = (eng) => eng.blocks.map((b) => `${b.galleyHash}|${b.stateVec}`);

test('terminal prose without a frozen canonical line proof fails closed', () => {
  const block = {
    id: 'b-tail',
    text: 'plain terminal prose\n',
    fidelity: { level: 'safe-glyph' },
    needsRender: false,
  };
  const report = {
    mode: 'structured',
    srcRev: 8,
    canonical: { id: 4, rev: 7, pageCount: 43 },
    stats: { pageCount: 6 },
    dirtySourceNodes: ['src-b-tail'],
    patches: [{
      type: 'replace-page',
      page: 6,
      displayList: {
        page: 6,
        commands: [{
          op: 'glyphs', src: 'b-tail', x: 72, y: 700, w: 90,
          gh: 8, gd: 2, size: 10, text: 'plain terminal prose',
        }],
      },
    }],
  };
  const geometry = {
    oddsidemargin: 0,
    textwidth: 450,
    topmargin: 0,
    headheight: 12,
    headsep: 18,
    textheight: 680,
  };
  const plan = planTerminalCanonicalAnchor({
    blocks: [block],
    domBlocks: [{
      id: block.id,
      source: {
        file: 'main.tex',
        start: { line: 622, column: 1 },
        end: { line: 623, column: 1 },
      },
    }],
    report,
    geometry,
  });
  assert.equal(plan, null, 'page-number guesses cannot replace a frozen paint/line certificate');
});

test('canonical anchoring fails closed for wrapped or command-bearing prose', () => {
  const base = {
    mode: 'structured',
    srcRev: 3,
    canonical: { id: 2, rev: 2, pageCount: 20 },
    stats: { pageCount: 4 },
    dirtySourceNodes: ['src-b1'],
    patches: [{
      type: 'replace-page',
      page: 4,
      displayList: { commands: [
        { op: 'glyphs', src: 'b1', x: 72, y: 600, w: 20, gh: 8, gd: 2, text: 'a' },
        { op: 'glyphs', src: 'b1', x: 72, y: 612, w: 20, gh: 8, gd: 2, text: 'b' },
      ] },
    }],
  };
  const domBlocks = [{ id: 'b1', source: { file: 'main.tex', start: { line: 10, column: 1 } } }];
  const geometry = { textheight: 700 };
  assert.equal(planTerminalCanonicalAnchor({
    blocks: [{ id: 'b1', text: 'plain', fidelity: { level: 'safe-glyph' } }],
    domBlocks,
    report: base,
    geometry,
  }), null);
  assert.equal(planTerminalCanonicalAnchor({
    blocks: [{ id: 'b1', text: 'unsafe \\command', fidelity: { level: 'safe-glyph' } }],
    domBlocks,
    report: {
      ...base,
      patches: [{
        ...base.patches[0],
        displayList: { commands: [
          { op: 'glyphs', src: 'b1', x: 72, y: 600, w: 40, gh: 8, gd: 2, text: 'unsafe' },
        ] },
      }],
    },
    geometry,
  }), null);
  assert.deepEqual(dirtyWithoutPatchFallback({
    dirtySourceNodes: ['src-b1'],
    patches: [],
  }), {
    kind: 'canonical-fallback',
    reason: 'dirty-source-without-structured-patch',
  });
});

test('canonical-anchor policy still requires a frozen pre-edit line certificate', () => {
  const block = {
    id: 'b-middle',
    text: 'ordinary internal prose',
    fidelity: { level: 'safe-glyph' },
    needsRender: false,
    galley: { items: [], floats: [], events: [], labels: [], refs: [], toclines: [] },
  };
  const report = {
    mode: 'structured',
    previewPolicy: 'canonical-anchor',
    srcRev: 12,
    canonical: { id: 9, rev: 11, pageCount: 5 },
    stats: { pageCount: 5 },
    dirtySourceNodes: ['src-b-middle'],
    patches: [{
      type: 'replace-page',
      page: 1,
      displayList: {
        page: 1,
        commands: [{
          op: 'glyphs', src: 'b-middle', x: 72, y: 120, w: 92,
          gh: 8, gd: 2, size: 10, text: 'ordinary internal prose',
        }],
      },
    }],
  };
  const geometry = {
    oddsidemargin: 0,
    textwidth: 450,
    columnwidth: 215,
    columnsep: 20,
    twocolumn: 1,
    topmargin: 0,
    headheight: 12,
    headsep: 18,
    textheight: 680,
  };
  const plan = planTerminalCanonicalAnchor({
    blocks: [{ id: 'before' }, block, { id: 'after' }],
    domBlocks: [{
      id: block.id,
      source: {
        file: 'main.tex',
        start: { line: 40, column: 1 },
        end: { line: 40, column: 24 },
      },
    }],
    report,
    geometry,
  });
  assert.equal(plan, null, 'column geometry alone is not a physical-address proof');
});

test('a replacement checkpoint retires the preserved peer at that boundary', () => {
  const sent = [];
  const oldPeer = { pid: 41, send: (message) => sent.push(message) };
  const newPeer = { pid: 42, send() {} };
  const engine = {
    checkpoints: new Map([[3, oldPeer]]),
    dyingPids: new Set(),
    waiters: new Map([['ckpt:3', {}]]),
    _fulfill() {},
  };

  handlePeerMessage(engine, newPeer, { kind: 'CKPT', idx: 3 });

  assert.deepEqual(sent, ['DIE\n']);
  assert.equal(engine.checkpoints.get(3), newPeer);
  assert.deepEqual([...engine.dyingPids], [41]);
});

test('capture scope includes display math but excludes inline/commented math', () => {
  assert.equal(mayCaptureDisplayMath({ text: '\\[x^2\\]' }), true);
  assert.equal(mayCaptureDisplayMath({ text: '\\begin{align*}x&=1\\end{align*}' }), true);
  assert.equal(mayCaptureDisplayMath({ text: 'inline $x$ only' }), false);
  assert.equal(mayCaptureDisplayMath({ text: '% \\[commented display\\]\nplain' }), false);
  assert.equal(
    mayCaptureDisplayMath({ text: '\\begin{tcolorbox}\\[x\\]\\end{tcolorbox}' }),
    false,
    'page-context boxes stay on the established render/rescue paths'
  );
});

test('capture miss rejects only the render attempt with a fallback marker', () => {
  let rejected = null;
  const engine = {
    _reject(key, err) {
      rejected = { key, err };
    },
  };
  handlePeerMessage(engine, {}, { kind: 'CAPTUREMISS', id: 'b7' });
  assert.equal(rejected?.key, 'render:b7');
  assert.equal(rejected?.err?.tdomCaptureMiss, true);
});

test('a new edit preempts active resident renders but retains latest-wins backlog', () => {
  const rejected = [];
  const engine = {
    renderWant: new Map([['old-block', true]]),
    renderPids: new Map([['rr@1', 0], ['iso@cache', 0]]),
    cancelledRenderIds: new Set(),
    _reject(key, err) { rejected.push({ key, err }); },
  };
  preemptResidentRenders(engine);
  assert.deepEqual([...engine.renderWant.keys()], ['old-block']);
  assert.equal(engine.renderPids.has('rr@1'), false);
  assert.equal(engine.renderPids.has('iso@cache'), true);
  assert.equal(engine.cancelledRenderIds.has('rr@1'), true);
  assert.equal(rejected[0]?.key, 'render:rr@1');
  assert.equal(rejected[0]?.err?.tdomSuperseded, true);
});

test('preview display list drops zero-area markers and preserves exact chunk ink', () => {
  const page = {
    number: 1,
    draw: [
      {
        y: 10,
        u: {
          blockId: 'ja',
          li: 0,
          h: 8,
          d: 2,
          ln: {
            boxH: 8,
            runs: [
              { rule: true, x: 10, dy: -8, w: 0, h: 10 },
              { rule: true, x: 20, dy: -0.4, w: 5, h: 0.4 },
            ],
          },
        },
      },
      {
        y: 30,
        u: {
          blockId: 'math',
          li: 0,
          h: 8,
          d: 2,
          ln: {
            boxH: 8,
            runs: [],
            editRuns: [{ t: 'x', x: 10, w: 5, f: 1 }],
            gfxChunk: { blockId: 'math', yOff: 6, w: 100, stale: 1 },
          },
        },
      },
    ],
  };
  const dl = buildDisplayList(page, {
    geometry: {
      oddsidemargin: 0,
      topmargin: 0,
      headheight: 0,
      headsep: 0,
      textwidth: 100,
      textheight: 200,
      footskip: 30,
    },
    chunks: new Map([['math', { hBp: 20, v: 1 }]]),
    hf: new Map(),
    hfSig: '',
    fonts: new Map([[1, { mth: 1 }]]),
    twinMetrics: {},
  });

  const rules = dl.commands.filter((command) => command.op === 'rule');
  assert.deepEqual(rules.map(({ w, h }) => ({ w, h })), [{ w: 5, h: 0.4 }]);

  const chunk = dl.commands.find((command) => command.op === 'chunk');
  assert.deepEqual(
    { x: chunk.x, y: chunk.y, h: chunk.h, sy: chunk.sy, ch: chunk.ch, line: chunk.line },
    { x: 72, y: 92, h: 14, sy: 4, ch: 20, line: 0 },
    'the SVG owns paragraph indentation, while a bounded vertical bleed preserves math ink'
  );
  const mathHit = dl.commands.find((command) => command.op === 'sourcebox' && command.src === 'math');
  assert.equal(mathHit?.math, 1, 'stale exact display math exposes its live TeX geometry');
  assert.equal(mathHit?.stale, 1, 'the client can retain clean stale pixels while the mini-compile runs');
});

test('fresh partial-exact pixels replace only contiguous math lines', () => {
  const line = (text) => ({
    k: 'box',
    h: 10,
    d: 2,
    w: 100,
    runs: [{ f: 1, t: text, x: 0, dy: 0, s: 10 }],
  });
  const block = {
    id: 'mixed',
    galleyHash: 'fresh-galley',
    galley: {
      w: 100,
      items: [line('before'), line('\uE000S_1=S_2'), line('\uE000S_2=S_3'), line('after')],
      floats: [],
    },
    fidelity: {
      blockExact: false,
      canonicalOnly: false,
      exactLines: 2,
      itemFlags: [0, 3, 3, 0],
      floats: new Map(),
      ins: new Map(),
    },
  };
  const chunks = new Map([['mixed', {
    forGalley: 'fresh-galley',
    wBp: 100,
    hBp: 48,
    v: 1,
  }]]);
  const boxes = buildStream(block, chunks)
    .filter((entry) => entry.t === 'box')
    .map((entry) => entry.u);
  const dl = buildDisplayList({
    number: 1,
    draw: boxes.map((u, index) => ({ y: 10 + index * 12, u })),
  }, {
    geometry: {
      oddsidemargin: 0,
      topmargin: 0,
      headheight: 0,
      headsep: 0,
      textwidth: 100,
      textheight: 200,
      footskip: 30,
    },
    chunks,
    hf: new Map(),
    hfSig: '',
    fonts: new Map(),
    twinMetrics: {},
  });
  const exact = dl.commands.filter((command) => command.op === 'chunk');

  assert.equal(boxes[0].ln.gfxChunk, null, 'safe prose before math stays as live glyphs');
  assert.equal(boxes[0].ln.runs[0].t, 'before');
  assert.equal(boxes[1].ln.gfxChunk?.blockId, 'mixed');
  assert.equal(boxes[2].ln.gfxChunk?.blockId, 'mixed');
  assert.equal(boxes[3].ln.gfxChunk, null, 'safe prose after math stays as live glyphs');
  assert.equal(boxes[3].ln.runs[0].t, 'after');
  assert.deepEqual(
    exact.map(({ sy, h, ch }) => ({ sy, h, ch })),
    [{ sy: 10, h: 28, ch: 48 }],
    'adjacent exact lines merge into one mini-compile window with only outer bleed'
  );
});

let eng;
let openReport;
function sharedTest(name, options, body) {
  test(name, options, async (context) => {
    if (!eng) {
      rmSync(WORK, { recursive: true, force: true });
      rmSync(WORK2, { recursive: true, force: true });
      eng = new CheckpointEngine({ workDir: WORK });
      openReport = await eng.open(makeDoc());
      await drain(eng);
    }
    await body(context);
  });
}

sharedTest('edit reports atomically carry newly registered texttt and textit faces', opts, async () => {
  assert.deepEqual(new Set(openReport.fonts), new Set(eng.getFontManifest()));
  const anchor = 'Opening alpha';
  const insert = '\\texttt{aaaa}\\textit{BBBB}';
  const start = eng.getSource().indexOf(anchor) + anchor.length;
  const before = new Set(eng.getFontManifest());
  const report = await eng.edit(start, start, insert);
  const commands = report.patches.flatMap((patch) => patch.displayList?.commands ?? []);
  const mono = commands.find((command) => command.op === 'glyphs' && command.text.includes('aaaa'));
  const italic = commands.find((command) => command.op === 'glyphs' && command.text.includes('BBBB'));
  assert.ok(mono?.fam && italic?.fam, 'both style runs stay in the structured text layer');
  assert.notEqual(mono.fam, italic.fam, 'typewriter and italic use distinct TeX faces');
  assert.ok(report.fonts.includes(mono.fam));
  assert.ok(report.fonts.includes(italic.fam));
  assert.ok(report.fonts.some((family) => !before.has(family)), 'the same edit reports its new face');
  await eng.edit(start, start + insert.length, '');
});
after(async () => {
  if (eng) await eng.close();
});

sharedTest('display-math exact render reuses the foreground JOB node list', opts, async () => {
  await eng.renderTask.catch(() => {});
  const beforeHits = eng.renderStats.captureHits;
  const at = eng.getSource().indexOf('a^2');
  assert.ok(at >= 0, 'equation source found');
  await eng.edit(at + 3, at + 3, '+1');
  await eng.renderTask;

  const equation = eng.blocks.find((b) => b.text.includes('a^2+1'));
  assert.ok(equation?.needsRender, 'edited equation requires exact pixels');
  assert.ok(
    eng.renderStats.captureHits > beforeHits,
    `capture path served the edit (${JSON.stringify(eng.renderStats)})`
  );
  assert.equal(equation.galley?.capture, undefined, 'retained list released after shipout');
  assert.equal(
    eng.chunks.get(equation.id)?.forGalley,
    equation.galleyHash,
    'the capture produced the current galley chunk'
  );

  const undo = eng.getSource().indexOf('a^2+1');
  await eng.edit(undo + 3, undo + 5, '');
  await eng.renderTask;
  await drain(eng);
});

sharedTest('mixed prose and display math reaches fresh exact pixels without canonical compile', opts, async () => {
  await eng.renderTask.catch(() => {});
  const beforeHits = eng.renderStats.captureHits;
  const source = eng.getSource();
  const at = source.indexOf('h(x)=x^3-2x');
  assert.ok(at >= 0, 'mixed equation source found');
  const two = at + 'h(x)=x^3-'.length;
  const canonicalRev = eng.canonical.last?.rev ?? eng.canonical.current?.rev ?? null;
  await eng.edit(two, two + 1, '');
  await Promise.race([
    eng.renderTask,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error('mixed display exact render timeout')), 5_000)
    ),
  ]);

  const mixed = eng.blocks.find((b) => b.text.includes('h(x)=x^3-x'));
  assert.ok(mixed?.needsRender, 'mixed prose/math block requires exact pixels');
  assert.ok(
    eng.renderStats.captureHits > beforeHits,
    `capture path served the mixed edit (${JSON.stringify(eng.renderStats)})`
  );
  assert.equal(eng.chunks.get(mixed.id)?.forGalley, mixed.galleyHash);
  assert.equal(
    eng.canonical.last?.rev ?? eng.canonical.current?.rev ?? null,
    canonicalRev,
    'exact pixels landed without waiting for a new canonical result'
  );

  const undo = eng.getSource().indexOf('h(x)=x^3-x') + 'h(x)=x^3-'.length;
  await eng.edit(undo, undo, '2');
  await eng.renderTask;
  await drain(eng);
});

sharedTest('steady-state keystrokes stay fork-once (edit-locus pin)', opts, async () => {
  const src = () => eng.getSource();
  let worstBlocks = 0;
  let worstWall = 0;
  for (let k = 0; k < 6; k++) {
    const cur = k % 2 === 0 ? 'MIDWORD' : 'MIDWORX';
    const next = k % 2 === 0 ? 'MIDWORX' : 'MIDWORD';
    const p = src().indexOf(cur);
    assert.ok(p >= 0, `token ${cur} present`);
    const t0 = performance.now();
    const r = await eng.edit(p, p + cur.length, next);
    worstWall = Math.max(worstWall, performance.now() - t0);
    worstBlocks = Math.max(worstBlocks, r.stats.blocksTypeset);
    assert.equal(r.stats.chainVerdict, 'clean', 'a plain word edit must not queue chain work');
  }
  assert.ok(worstBlocks <= 4, `edited + verification only (got ${worstBlocks})`);
  assert.ok(worstWall < 1500, `steady-state keystroke took ${worstWall.toFixed(0)}ms`);
  await drain(eng);
});

sharedTest('a tail edit right after a mid edit is NOT charged the distance', opts, async () => {
  if (process.env.TDOM_EXPECT_MAX_CHECKPOINTS !== undefined) {
    assert.equal(
      eng.maxCheckpoints,
      Number(process.env.TDOM_EXPECT_MAX_CHECKPOINTS),
      'the bounded regression must exercise its declared checkpoint budget'
    );
  }
  const src = eng.getSource();
  const mid = src.indexOf('MIDWORD');
  assert.ok(mid >= 0);
  await eng.edit(mid, mid + 'MIDWORD'.length, 'MIDWORQ');
  // immediately — the old design would replay every block from mid to tail
  const tail = eng.getSource().indexOf('TAILWORD');
  assert.ok(tail >= 0);
  const tailBlock = eng.blocks.find((block) => block.text.includes('TAILWORD'));
  assert.equal(
    tailBlock?.fidelity?.level,
    'safe-glyph',
    'row spacing must not absorb tail prose into the align chunk'
  );
  const r = await eng.edit(tail, tail + 'TAILWORD'.length, 'TAILWORQ');
  assert.ok(
    r.stats.blocksTypeset <= 6,
    `tail edit must resume from its own checkpoint (typeset ${r.stats.blocksTypeset} blocks)`
  );
  // an edit in the LAST block hits end-of-document instead of a clean
  // verification block — that is convergence too, as long as nothing is
  // deferred
  assert.ok(
    r.stats.chainVerdict === 'clean' ||
      (r.stats.chainVerdict === 'walked' && !r.stats.chainPending),
    `no deferred work for a plain tail edit (got ${r.stats.chainVerdict})`
  );
  // revert both
  const t2 = eng.getSource().indexOf('TAILWORQ');
  await eng.edit(t2, t2 + 8, 'TAILWORD');
  const m2 = eng.getSource().indexOf('MIDWORQ');
  await eng.edit(m2, m2 + 7, 'MIDWORD');
  await drain(eng);
});

sharedTest('a null edit pair leaves the document identity untouched', opts, async () => {
  const before = signature(eng);
  const pos = eng.getSource().indexOf('Delta filler 3');
  await eng.edit(pos, pos, 'Z');
  await eng.edit(pos, pos + 1, '');
  await drain(eng);
  assert.deepEqual(signature(eng), before, 'insert+revert must be a no-op');
});

sharedTest('section insert: fast response, async renumbering to convergence', opts, async () => {
  const pos = eng.getSource().indexOf('\\section{Gamma}');
  const t0 = performance.now();
  const r = await eng.edit(pos, pos, '\\section{Inserted}\\label{sec:ins}\n\n' + para('Inserted body') + '\n\n');
  const wall = performance.now() - t0;
  assert.ok(r.stats.blocksTypeset <= 8, `bounded foreground (typeset ${r.stats.blocksTypeset})`);
  assert.ok(wall < 3000, `section insert response took ${wall.toFixed(0)}ms`);
  assert.ok(
    r.stats.chainVerdict === 'counters' || r.stats.chainVerdict === 'leak',
    `moving counters must defer chain work (got ${r.stats.chainVerdict})`
  );
  await drain(eng);
  const labels = eng.getDOM().labels;
  assert.equal(labels['sec:ins'], '3');
  assert.equal(labels['sec:gamma'], '4', 'later sections renumbered after convergence');
  assert.equal(labels['sec:eps'], '6');
});

sharedTest('definition edit: suffix rebuilt off the hot path', opts, async () => {
  const src = eng.getSource();
  const pos = src.indexOf('alpha-value');
  const t0 = performance.now();
  const r = await eng.edit(pos, pos + 'alpha-value'.length, 'beta-value');
  const wall = performance.now() - t0;
  assert.equal(r.stats.chainVerdict, 'leak', 'a \\newcommand edit forfeits the suffix');
  assert.ok(wall < 3000, `definition edit response took ${wall.toFixed(0)}ms`);
  await drain(eng);
  // the macro user block must now typeset the new expansion
  const user = eng.blocks.find((b) => /\\foo\{\}/.test(b.text));
  assert.ok(user?.galley, 'macro user block present');
  // join with '' — runs split at every kern, so words arrive in pieces
  let text = '';
  for (const it of user.galley.items ?? []) {
    for (const run of it.runs ?? []) text += run.t ?? '';
  }
  assert.match(text, /beta/, 'downstream block reflects the new definition');
});

sharedTest('idle engine holds no deferred work and a bounded process set', opts, async () => {
  await drain(eng);
  assert.equal(eng.pendingChain, null);
  assert.equal(eng.bgActive, false);
  assert.equal(eng.rescueQueue.size, 0);
  assert.ok(
    eng.checkpoints.size <= eng.maxCheckpoints + 16,
    `checkpoint processes bounded (${eng.checkpoints.size})`
  );
});

sharedTest('THE defining equation: incremental result equals a fresh engine', opts, async () => {
  await drain(eng);
  const finalSrc = eng.getSource();
  const incremental = { signature: signature(eng), pages: eng.pages.length,
    ids: eng.blocks.map(block => block.id) };
  await eng?.close();
  eng = null;
  const scratch = new CheckpointEngine({ workDir: WORK2 });
  try {
    await scratch.open(finalSrc);
    await drain(scratch);
    assert.equal(incremental.ids.length, scratch.blocks.length, 'same segmentation');
    const a = incremental.signature;
    const b = signature(scratch);
    const mismatches = [];
    for (let i = 0; i < a.length; i++) {
      if (a[i] !== b[i]) mismatches.push(`#${i} ${incremental.ids[i]}`);
    }
    assert.deepEqual(mismatches, [], 'every block identical to from-scratch');
    assert.equal(incremental.pages, scratch.pages.length, 'same page count');
  } finally {
    await scratch.close();
  }
});

// Broken-TeX freeze semantics (docs/10 §10.9). The breakage class that
// freezes is the one that KILLS the typesetting child (found by the fuzzer
// on seed 21: a broken color name inside a tikz node cascades into a pgf
// emergency stop — real LuaLaTeX produces no PDF at all for such a source).
// Milder breakage (an unclosed conditional…) recovers at the job boundary
// and never reaches this path.
const tikzDoc = (fill) =>
  [
    '\\documentclass{article}',
    '\\usepackage{tikz}',
    '\\definecolor{softgreen}{RGB}{200,240,200}',
    '\\begin{document}',
    '',
    '\\section{A}',
    '',
    para('Alpha one'),
    '',
    '\\begin{tikzpicture}',
    `\\node[draw,fill=${fill},minimum width=20mm] (a) {Node A};`,
    '\\end{tikzpicture}',
    '',
    para('Gamma three'),
    '',
    '\\end{document}',
    '',
  ].join('\n');

// The incremental path freezes the killed block at the last good galley AND
// the last good exit state, so pixels and downstream numbering stay exactly
// where they were — zero churn while the user is mid-edit — and the block
// heals on the next edit that fixes it.
test('broken block freezes at its last good galley, downstream untouched, heals on fix', opts, async () => {
  await eng?.close();
  eng = null;
  rmSync(WORK2, { recursive: true, force: true });
  const e = new CheckpointEngine({ workDir: WORK2 });
  try {
    await e.open(tikzDoc('softgreen'));
    await drain(e);
    const preSig = signature(e);
    const prePages = e.pages.length;
    const at = e.getSource().indexOf('fill=softgr') + 'fill=softgr'.length;
    await e.edit(at, at, 'XX'); // fill=softgrXXeen — undefined color, pgf dies
    await drain(e);
    const bi = e.blocks.findIndex((b) => b.text.includes('softgrXX'));
    assert.ok(bi > 0, 'broken block found');
    assert.ok(e.frozenBlockIds().includes(e.blocks[bi].id), 'block reported frozen');
    // the freeze is total stasis: same pixels, same exit state, no
    // downstream wave — the document identity is byte-identical
    assert.deepEqual(signature(e), preSig, 'signature unchanged under freeze');
    assert.equal(e.pages.length, prePages, 'pagination unchanged under freeze');
    // heal: fix the color — the engine reconverges to the exact
    // pre-breakage state and the frozen mark leaves with the new galley
    const cut = e.getSource().indexOf('softgrXX');
    await e.edit(cut + 'softgr'.length, cut + 'softgrXX'.length, '');
    await drain(e);
    assert.deepEqual(signature(e), preSig, 'healed back to the exact pre-edit state');
    assert.deepEqual(e.frozenBlockIds(), [], 'no frozen blocks after heal');
  } finally {
    await e.close();
  }
});

// The scratch side of the same coin: a fresh boot on a broken source has no
// last-good galley to freeze — the block renders empty and passes the entry
// state through. That exit is deliberately DIFFERENT from the incremental
// freeze above (which keeps pre-breakage counters): real LuaLaTeX produces
// no output at all for such a source, so there is no ground truth, and the
// incremental==scratch equation is scoped to compilable sources (the fuzzer
// skips and reverts when it sees tdomFrozen). This test pins the fresh-boot
// half: empty freeze, engine alive, state passthrough.
test('fresh boot on a broken source: empty freeze, engine alive', opts, async () => {
  await eng?.close();
  eng = null;
  rmSync(WORK2, { recursive: true, force: true });
  const scratch = new CheckpointEngine({ workDir: WORK2 });
  try {
    await scratch.open(tikzDoc('softgrXXeen'));
    await drain(scratch);
    const bi = scratch.blocks.findIndex((b) => b.text.includes('softgrXX'));
    assert.ok(bi > 0, 'broken block found');
    const b = scratch.blocks[bi];
    assert.ok(scratch.frozenBlockIds().includes(b.id), 'block reported frozen');
    assert.equal(b.galley?.items?.length ?? 0, 0, 'frozen empty (no history to show)');
    assert.equal(b.stateVec, scratch.blocks[bi - 1].stateVec, 'exit = entry passthrough');
    assert.ok(scratch.pages.length > 0, 'document still paginates');
    // every other block is fully typeset — the failure is local
    assert.equal(scratch.blocks.filter((k) => !k.galley).length, 0, 'no galley holes elsewhere');
  } finally {
    await scratch.close();
  }
});

// Margin-bearing blocks (\marginpar / todonotes' \todo — the paper-draft
// review-mark workflow) must NOT demote the document: the block typesets
// in-chain for its body text, its fidelity is CANONICAL_ONLY (the canonical
// page supplies the margin pixels through the 'canon' display band), and
// keystrokes inside it stay on the fast path.
test('margin marks stay structured as canonical-only blocks', opts, async () => {
  await eng?.close();
  eng = null;
  rmSync(WORK2, { recursive: true, force: true });
  const e = new CheckpointEngine({ workDir: WORK2 });
  try {
    const r = await e.open(
      [
        '\\documentclass{article}',
        '\\begin{document}',
        '',
        para('Plain opening'),
        '',
        para('Noted\\marginpar{margin!} middle'),
        '',
        para('Plain closing'),
        '',
        '\\end{document}',
        '',
      ].join('\n')
    );
    assert.equal(r.mode, 'structured', `stays structured (${r.modeReasons?.join('; ')})`);
    await drain(e);
    const bi = e.blocks.findIndex((b) => /marginpar/.test(b.text));
    assert.ok(bi >= 0, 'margin block found');
    assert.equal(e.blocks[bi].fidelity?.level, 'canonical-only', 'canonical-only tier');
    assert.ok((e.blocks[bi].galley?.items?.length ?? 0) > 0, 'body text typeset in-chain');
    // the display list advertises the band for referees/clients
    const dls = e.getDisplayLists();
    const hasBand = dls.some((dl) => dl.commands.some((c) => c.op === 'canon'));
    assert.ok(hasBand, "display list carries the 'canon' band");
    // keystroke inside the margin block stays on the fast path
    const at = e.getSource().indexOf('margin!') + 'margin!'.length;
    const r2 = await e.edit(at, at, '!');
    assert.ok((r2.stats?.typesetUs ?? 1e9) < 5_000_000, 'edit stays fast');
    await drain(e);
    assert.equal(
      e.blocks.find((b) => /marginpar/.test(b.text))?.fidelity?.level,
      'canonical-only',
      'tier survives the edit'
    );
  } finally {
    await e.close();
  }
});

// A backward reference whose label moves to a value that ALREADY appears in
// the referring block's rendered text ("section 3 … equation (2)" with the
// equation moving 2→3). The old resolved-check matched substrings of the
// rendered text and skipped the retypeset, freezing the stale "(2)" forever
// (found by the fuzzer: corpus/06 seed 1, burst 2). resolvedInGalley now
// compares the exact values injected at typeset time (galley.tdomRefVals).
test('backward ref updates when the label moves to a value already visible in the block', opts, async () => {
  await eng?.close();
  eng = null;
  const refsDoc = readFileSync(
    fileURLToPath(new URL('../corpus/06-refs-heavy.tex', import.meta.url)),
    'utf8'
  );
  rmSync(WORK2, { recursive: true, force: true });
  const e = new CheckpointEngine({ workDir: WORK2 });
  try {
    await e.open(refsDoc);
    await drain(e);
    // a new numbered equation ahead of e:y/e:z renumbers both; the Alpha
    // block (which renders \eqref{e:z} AND the digit 3 via \ref{s:c}) must
    // re-render with the new (3)
    const anchor = 'resolve only through the label table.';
    const at = e.getSource().indexOf(anchor) + anchor.length;
    await e.edit(at, at, '\n\n\\begin{equation}\n  q^2 = p\n\\end{equation}\n');
    await drain(e);
    const incremental = { signature: signature(e), ids: e.blocks.map(block => block.id) };
    const finalSrc = e.getSource();
    await e.close();
    const scratch = new CheckpointEngine({ workDir: WORK2 + '-scratch' });
    try {
      await scratch.open(finalSrc);
      await drain(scratch);
      assert.equal(incremental.ids.length, scratch.blocks.length, 'same segmentation');
      const a = incremental.signature;
      const b = signature(scratch);
      const mismatches = [];
      for (let i = 0; i < a.length; i++) {
        if (a[i] !== b[i]) mismatches.push(`#${i} ${incremental.ids[i]}`);
      }
      assert.deepEqual(mismatches, [], 'every block identical to from-scratch');
    } finally {
      await scratch.close();
      rmSync(WORK2 + '-scratch', { recursive: true, force: true });
    }
  } finally {
    await e.close();
  }
});

sharedTest('native forced breaks retain adjacent material without phantom pages or rescue work', opts, async () => {
  await eng.open(String.raw`\documentclass{article}
\begin{document}
Ordinary prose before the rescued material.

\begin{center}Rescued material with a forced break.\end{center}
\newpage

Ordinary prose after the rescued material.
\clearpage

Ordinary prose on the third page.
\end{document}`);
  await drain(eng);
  assert.equal(eng.blocks.some(block => block.rescued || block.galley?.tdomPendingPaint), false);
  assert.equal(eng.rescueQueue.size, 0);
  assert.equal(eng.pages.length, 3);
  const text = eng.getDisplayLists().map(page => page.commands
    .filter(command => command.op === 'glyphs').map(command => command.text).join('').replace(/\s/g, ''));
  assert.match(text[0], /Rescuedmaterialwithaforcedbreak/);
  assert.match(text[1], /Ordinaryproseafter/);
  assert.match(text[2], /Ordinaryproseonthethirdpage/);
  assert.doesNotMatch(eng.rootLogRef?.() ?? '', /Output routine didn't use all of/,
    'the native output routine must consume box255 through TeX');
  const at = eng.getSource().indexOf('Ordinary prose before') + 'Ordinary prose'.length;
  const report = await eng.edit(at, at, ' edited');
  assert.ok(report.stats.blocksTypeset <= 2, 'adjacent prose stays bounded');
  await drain(eng);
  assert.equal(eng.blocks.some(block => block.galley?.tdomPendingPaint), false);
});


sharedTest('resident forced output retains material before and after a page break', opts, async () => {
  await eng.open(String.raw`\documentclass{article}
\begin{document}
Before forced output.\par
\pagebreak
After forced output.\par
\end{document}`);
  await drain(eng);
  assert.equal(eng.mode, 'structured');
  const text = eng.getDisplayLists().flatMap(page => page.commands)
    .filter(command => command.op === 'glyphs').map(command => command.text).join('');
  assert.match(text.replace(/\s/g, ''), /Beforeforcedoutput/);
  assert.match(text.replace(/\s/g, ''), /Afterforcedoutput/);
  assert.doesNotMatch(eng.rootLogRef?.() ?? '', /Output routine didn't use all of/);
});

test('decorated boxes retain private PDF resources across capture, resize, and sibling edits', opts, async () => {
  await eng?.close();
  eng = null;
  const root = mkdtempSync(path.join(tmpdir(), 'tdom-private-pdf-'));
  const e = new CheckpointEngine({ workDir: path.join(root, 'work') });
  const source = String.raw`\documentclass{article}
\usepackage[textheight=110pt]{geometry}
\usepackage[most]{tcolorbox}
\usepackage{hyperref}
\begin{document}
Before.

\begin{tcolorbox}[enhanced,title=Notice,interior style={left color=white,right color=blue!30},underlay={\draw[red,line width=2pt] (frame.south west)--(frame.north east);}]
ResourceWitness alpha.
\end{tcolorbox}

After.

\begin{tcolorbox}[enhanced,interior style={left color=yellow,right color=red!50}]
SiblingResource.
\end{tcolorbox}
\end{document}`;
  const samples = [];
  const pageCounts = [];
  try {
    await e.open(source);
    await drain(e);
    await e.renderTask;
    const rootPdf = readFileSync(path.join(e.workDir, 'driver.pdf'));
    for (const [from, to] of [
      ['alpha.', 'alpha beta.'],
      ['alpha beta.', 'alpha ' + 'wrap words '.repeat(40) + 'beta.'],
      ['right color=blue!30', 'right color=green!30'],
      ['alpha ' + 'wrap words '.repeat(40) + 'beta.', 'alpha.'],
    ]) {
      const at = e.getSource().indexOf(from);
      assert.ok(at >= 0);
      const beforeHits = e.renderStats.captureHits;
      await e.edit(at, at + from.length, to);
      await e.renderTask;
      const block = e.blocks.find(b => b.text.includes('ResourceWitness'));
      const chunk = e.chunks.get(block.id);
      assert.equal(chunk?.forGalley, block.galleyHash, 'current graphics are available without canonical');
      assert.ok(e.renderStats.captureHits > beforeHits, 'ships the freshly typeset node list ' + JSON.stringify({gfx:block.galley.gfx, closure:block.galley.closure, rescued:block.rescued, stats:e.renderStats, items:block.galley.items.map(i=>i.k)}));
      assert.deepEqual(readFileSync(path.join(e.workDir, 'driver.pdf')), rootPdf, 'sibling output cannot mutate root resources');
      const chunks = new Map();
      await renderIsolatedBlock({ ...e, chunks, lastEditAt: 0,
        rescueQueue: new Map(), canonical: { info: () => ({ inFlight: false }) },
      }, { block, idx: e.blocks.indexOf(block),
        chunkTargets: () => [{ key: block.id, page: 1, w: chunk.wBp, h: chunk.hBp }],
        asyncRepaginate() {},
      });
      const cold = chunks.get(block.id);
      assert.ok(cold?.editPdf, 'independent cold PDF exists');
      const images = [];
      for (const [label, bytes] of [['resident', chunk.editPdf], ['cold', cold.editPdf]]) {
        const pdf = path.join(root, label + '.pdf');
        const raster = path.join(root, label);
        writeFileSync(pdf, bytes);
        await promisify(execFile)('pdftoppm', ['-f', '1', '-singlefile', '-r', '72', pdf, raster]);
        images.push(readFileSync(raster + '.ppm'));
      }
      assert.equal(createHash('sha256').update(images[0]).digest('hex'), createHash('sha256').update(images[1]).digest('hex'),
        'capture pixels equal independent cold typesetting, including changed decoration');
      samples.push(chunk.hBp);
      pageCounts.push(e.pages.length);
    }
    assert.ok(samples[1] > samples[0], 'wrapping grows the real frame');
    assert.equal(samples[3], samples[0], 'undo restores frame height');
    assert.ok(pageCounts[1] > pageCounts[0], 'growth crosses a physical page boundary');
    assert.equal(pageCounts[3], pageCounts[0], 'undo restores pagination');
    assert.deepEqual(e.diagnostics, []);
  } finally {
    await e.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('exact box pages exclude lastskip primer material from RENDER and CAPTURE', opts, async () => {
  await eng?.close();
  eng = null;
  const root = mkdtempSync(path.join(tmpdir(), 'tdom-primer-crop-'));
  const e = new CheckpointEngine({ workDir: path.join(root, 'work') });
  try {
    await e.open(String.raw`\documentclass{article}
\usepackage[most]{tcolorbox}
\begin{document}
Opening.\par\vskip12pt

\begin{tcolorbox}
PrimerWitness alpha.
\end{tcolorbox}

After.
\end{document}`);
    await drain(e);
    for (let editIndex = 0; editIndex < 3; editIndex++) {
      if (editIndex) {
        const at = e.getSource().indexOf('alpha') + 5;
        await e.edit(at, at, editIndex === 1 ? 'Z' : ' wrap words'.repeat(35));
      }
      await e.renderTask;
      const block = e.blocks.find(b => b.text.includes('PrimerWitness'));
      const idx = e.blocks.indexOf(block);
      assert.ok(JSON.parse(e.blocks[idx - 1].stateVec).at(-1) > 0, 'nonzero previous skip exercises the primer');
      const chunk = e.chunks.get(block.id);
      assert.equal(chunk?.forGalley, block.galleyHash);
      const pdf = path.join(root, 'chunk.pdf');
      writeFileSync(pdf, chunk.editPdf);
      const { stdout } = await promisify(execFile)('pdfinfo', [pdf]);
      const size = stdout.match(/Page size:\s+([\d.]+) x ([\d.]+) pts/);
      assert.ok(size, 'tight PDF dimensions available');
      assert.ok(Math.abs(Number(size[2]) - chunk.hBp) < 0.02,
        `PDF height ${size[2]} matches the display extent ${chunk.hBp}; no invisible primer is shipped`);
      if (editIndex) assert.ok(e.renderStats.captureHits > 0);
      const chunks = new Map();
      await renderIsolatedBlock({ ...e, chunks, lastEditAt: 0,
        rescueQueue: new Map(), canonical: { info: () => ({ inFlight: false }) },
      }, { block, idx,
        chunkTargets: () => [{ key: block.id, page: 1, w: chunk.wBp, h: chunk.hBp }],
        asyncRepaginate() {},
      });
      const images = [];
      for (const [label, bytes] of [['resident', chunk.editPdf], ['cold', chunks.get(block.id)?.editPdf]]) {
        const pdfPath = path.join(root, label + '.pdf');
        const raster = path.join(root, label);
        writeFileSync(pdfPath, bytes);
        await promisify(execFile)('pdftoppm', ['-f', '1', '-singlefile', '-r', '72', pdfPath, raster]);
        images.push(readFileSync(raster + '.ppm'));
      }
      assert.deepEqual(images[0], images[1], 'resident and cold preserve the same frame, including after wrapping');
    }
  } finally {
    await e.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('stable native prose paints before graphics verification and retains burst work', opts, async () => {
  await eng?.close();
  eng = null;
  const root = mkdtempSync(path.join(tmpdir(), 'tdom-plain-preview-'));
  const e = new CheckpointEngine({ workDir: path.join(root, 'work') });
  const source = String.raw`\documentclass{article}
\usepackage{fontspec}
\usepackage{tcolorbox}
\begin{document}
Lead.

PlainMarker abcd.

\begin{tcolorbox}
Next graphics witness.
\end{tcolorbox}

Tail.
\end{document}`;
  try {
    await e.open(source);
    await drain(e);
    const original = e.blocks.find(b => b.text.includes('PlainMarker'));
    const witness = plainPreviewWitness(original);
    assert.ok(witness, JSON.stringify({ closure: original.closure, galley: original.galley, fidelity: original.fidelity }));
    const admission = { blockId: original.id, witness };
    for (const mutate of [
      b => { b.galley.items.find(i => i.k === 'box').h += 1; },
      b => { b.galley.state.extra = 1; },
      b => { b.galley.items.push({ k: 'glue', a: 1 }); },
      b => { b.galley.tdomSourceCatcodesSafe = false; },
      b => { b.galley.events = [{ kind: 'write' }]; },
      b => { b.closure.native = false; },
    ]) {
      const changed = structuredClone(original);
      mutate(changed);
      assert.equal(canDeferPlainVerification(admission, witness, changed), false);
    }
    for (const char of ['a', 'b', 'c']) {
      const at = e.getSource().indexOf('abcd') + 4;
      const report = await e.edit(at, at, char);
      assert.equal(report.stats.blocksTypeset, 1, 'graphics neighbor is not on the response path: ' + JSON.stringify({ char,
        before: witness, after: plainPreviewWitness(e.blocks.find(b => b.id === original.id)),
        stats: report.stats }));
      assert.equal(report.stats.chainVerdict, 'verify', 'preview does not claim suffix convergence');
      assert.equal(e.pendingChain?.plainBlockId, original.id, 'every burst retains verification');
    }
    await drain(e);
    assert.equal(e.pendingChain, null, 'verification actually finishes');
    const at = e.getSource().indexOf('abcd') + 4;
    const wrap = await e.edit(at, at, ' wrap words'.repeat(45));
    assert.notEqual(wrap.stats.chainVerdict, 'verify', 'changed layout retains ordinary foreground verification');
    await drain(e);
    const finalSource = e.getSource();
    const incremental = signature(e);
    await e.close();
    const fresh = new CheckpointEngine({ workDir: path.join(root, 'fresh') });
    try {
      await fresh.open(finalSource);
      await drain(fresh);
      assert.deepEqual(signature(fresh), incremental, 'deferred result equals a fresh engine');
    } finally { await fresh.close(); }
  } finally {
    await e.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('active ordinary-looking source characters cannot grant a native plain preview', opts, async () => {
  await eng?.close();
  eng = null;
  const root = mkdtempSync(path.join(tmpdir(), 'tdom-active-source-'));
  const e = new CheckpointEngine({ workDir: path.join(root, 'work') });
  try {
    await e.open(String.raw`\documentclass{article}
\usepackage{fontspec}
\usepackage{tcolorbox}
${'\\catcode`\\!=13 \\def!{X}'}
\begin{document}
ActiveMarker !abcd.

\begin{tcolorbox}Next.\end{tcolorbox}
\end{document}`);
    await drain(e);
    const block = e.blocks.find(b => b.text.includes('ActiveMarker'));
    assert.equal(block.galley.tdomSourceCatcodesSafe, false);
    const at = e.getSource().indexOf('abcd') + 4;
    const report = await e.edit(at, at, 'e');
    assert.notEqual(report.stats.chainVerdict, 'verify');
  } finally {
    await e.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('warming a cold page supplies every exact neighbor before an included box edit', opts, async () => {
  await eng?.close();
  eng = null;
  const root = mkdtempSync(path.join(tmpdir(), 'tdom-warm-page-'));
  const child = path.join(root, 'child.tex');
  writeFileSync(child, String.raw`\begin{tcolorbox}[enhanced,title=Target]
TargetWitness $x^2$.
\end{tcolorbox}`);
  const e = new CheckpointEngine({ workDir: path.join(root, 'work'), docDir: root });
  const previousHot = process.env.TDOM_RENDER_HOT_MAX;
  process.env.TDOM_RENDER_HOT_MAX = '1';
  const missing = page => e.getDisplayLists().find(item => item.page === page)?.commands.filter(command =>
    command.op === 'pending-exact' || command.op === 'chunk' && command.st);
  try {
    await e.open(String.raw`\documentclass{article}
\usepackage[most]{tcolorbox}
\begin{document}
First page.
\newpage

\begin{tcolorbox}[enhanced,title=Neighbor]
NeighborWitness.
\end{tcolorbox}

\input{child.tex}
\end{document}`);
    assert.ok(missing(2).length > 0, 'cold page starts without exact graphics');
    if (previousHot === undefined) delete process.env.TDOM_RENDER_HOT_MAX;
    else process.env.TDOM_RENDER_HOT_MAX = previousHot;
    const warmed = await e.warmPage(2);
    assert.equal(warmed.status, 'ready');
    await e.renderTask;
    assert.deepEqual(missing(2), [], 'unchanged neighbor cannot block the next atomic page paint');
    writeFileSync(child, readFileSync(child, 'utf8').replace('x^2', 'x^3'));
    const report = await e.refresh();
    assert.ok(report.stats.blocksTypeset <= 2, 'child uses the warmed page checkpoint');
    await e.renderTask;
    assert.deepEqual(missing(2), []);
    assert.equal(e.pages.length, 2);
    assert.equal(e.rescueQueue.size, 0);
  } finally {
    if (previousHot === undefined) delete process.env.TDOM_RENDER_HOT_MAX;
    else process.env.TDOM_RENDER_HOT_MAX = previousHot;
    await e.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('input preserves attached paragraph geometry and child editing addresses', opts, async () => {
  await eng?.close();
  eng = null;
  const root = mkdtempSync(path.join(tmpdir(), 'tdom-input-paragraph-'));
  const child = path.join(root, 'child.tex');
  const childText = String.raw`\begin{tcolorbox}
AttachedWitness $x^2$.
\end{tcolorbox}`;
  writeFileSync(child, childText);
  const prefix = String.raw`\documentclass{article}
\usepackage{tcolorbox}
\begin{document}
\par\medskip\noindent\textbf{(1)}\quad
`;
  const suffix = '\n\\par\\medskip\nTailWitness.\n\\end{document}';
  const geometry = e => e.pages.map(page => page.draw.map(draw =>
    [draw.y, draw.u.h, draw.u.d]));
  const e = new CheckpointEngine({ workDir: path.join(root, 'mapped'), docDir: root });
  let expected;
  try {
    await e.open(prefix + '\\input{child.tex}' + suffix);
    await drain(e);
    expected = geometry(e);
    const block = e.blocks.find(b => b.text.includes('AttachedWitness'));
    assert.ok(block.text.includes('\\textbf{(1)}'), 'the open parent paragraph stays with its box');
    const regions = e.getDOM().blocks.flatMap(b => b.editRegions);
    const math = regions.find(region => region.value === 'x^2');
    assert.equal(math.source.file, child);
    assert.equal(math.source.start.line, 2);
    assert.equal(math.source.start.column, childText.split('\n')[1].indexOf('x^2') + 1);
    assert.equal((await e.warmEditOffset(childText.indexOf('x^2'), child)).status, 'ready');
  } finally { await e.close(); }
  const continuous = new CheckpointEngine({ workDir: path.join(root, 'continuous'), docDir: root });
  try {
    await continuous.open(prefix + childText + suffix);
    await drain(continuous);
    assert.deepEqual(geometry(continuous), expected, 'input adds no paragraph or box spacing');
  } finally {
    await continuous.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('deferred root and include edits converge, report errors, and recover exact page counts', opts, async () => {
  await eng?.close();
  eng = null;
  const root = mkdtempSync(path.join(tmpdir(), 'tdom-closure-convergence-'));
  const child = path.join(root, 'child.tex');
  writeFileSync(child, 'ChildWitnessA.\n');
  const e = new CheckpointEngine({ workDir: path.join(root, 'work'), docDir: root });
  e.canonical.displayDebounceMs = 10;
  e.canonical.displayCooldownFactor = 0;
  const replace = async (from, to) => {
    const at = e.getSource().indexOf(from);
    assert.ok(at >= 0, from);
    return e.edit(at, at + from.length, to);
  };
  const exact = async (marker, pages) => {
    await e.canonical.settle();
    const info = e.canonical.info();
    assert.equal(info.error, null);
    assert.equal(info.rev, e.srcRev);
    assert.equal(info.pageCount, pages);
    assert.match((await e.canonical.pageTexts(info.id)).join('\n'), new RegExp(marker));
  };
  try {
    await e.open(String.raw`\documentclass{article}
\newcount\linecount
\newcommand{\lines}[1]{\loop\ifnum\linecount<#1\advance\linecount by1 X\repeat}
\newif\ifanswers\answerstrue
\begin{document}
RootWitnessA.

\newpage
\input{child.tex}

\newpage AnswerWitness.
\end{document}`);
    await exact('RootWitnessA', 3);
    const childBlock = e.blocks.findIndex(block => block.file === child || block.sourceParts?.some(part => part.file === child));
    assert.ok(childBlock > 0);
    const childWarm = await e.warmEditOffset(3, child);
    assert.equal(childWarm.target, childBlock, 'child offsets must never warm a root block');
    assert.equal(childWarm.status, 'ready');
    const rootWarm = await e.warmEditOffset(e.getSource().indexOf('RootWitnessA'));
    assert.equal(e.blocks[rootWarm.target].file ?? e.file, e.file);
    assert.equal((await e.warmEditOffset(3, path.join(root, 'missing.tex'))).reason, 'unknown-source');
    const rootEdit = await replace('RootWitnessA', 'RootWitnessB');
    assert.notEqual(rootEdit.stats.chainVerdict, 'closure-deferred');
    await exact('RootWitnessB', 3);
    writeFileSync(child, 'ChildWitnessB.\n');
    const childEdit = await e.refresh();
    assert.notEqual(childEdit.stats.chainVerdict, 'closure-deferred');
    await exact('ChildWitnessB', 3);

    // An unused environment-opening macro is valid TeX but deliberately
    // beyond the lexical gate. Exact convergence cannot need its approval.
    const deferred = await replace('\\begin{document}', String.raw`\newcommand{\startquote}{\begin{quote}}
\begin{document}`);
    assert.equal(deferred.stats.chainVerdict, 'closure-deferred');
    assert.equal(deferred.canonical.scheduledRev, deferred.srcRev);
    assert.match(deferred.canonical.fallbackReason, /^closure-deferred:/);
    assert.ok(deferred.canonical.scheduledInMs < 1000, 'display cadence without a viewer request');
    await replace('RootWitnessB', 'RootWitnessC');
    writeFileSync(child, 'ChildWitnessC.\n');
    const newest = await e.refresh();
    assert.equal(newest.canonical.scheduledRev, e.srcRev, 'latest included input owns fallback');
    await exact('ChildWitnessC', 3);
    assert.match((await e.canonical.pageTexts()).join('\n'), /RootWitnessC/);

    const goodId = e.canonical.info().id;
    await replace('\\end{document}', '\\begin{quote}\n\\end{document}');
    await e.canonical.settle();
    assert.ok(e.canonical.info().error);
    assert.equal(e.canonical.info().errorRev, e.srcRev);
    assert.equal(e.canonical.info().id, goodId, 'syntax failure retains last-good PDF');
    await replace('\\begin{quote}\n\\end{document}', '\\end{document}');
    await exact('RootWitnessC', 3);
    await replace('\\newpage AnswerWitness.', '\\ifanswers\\newpage AnswerWitness.\\fi');
    await exact('AnswerWitness', 3);
    await replace('\\answerstrue', '\\answersfalse');
    await exact('RootWitnessC', 2);
    await replace('\\newpage\n\\input{child.tex}', '\\input{child.tex}');
    await exact('ChildWitnessC', 1);
  } finally {
    await e.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('an asynchronous title rescue regenerates downstream math and footnote chunks', opts, async () => {
  await eng?.close();
  eng = null;
  const root = mkdtempSync(path.join(tmpdir(), 'tdom-rescue-exact-successor-'));
  const e = new CheckpointEngine({ workDir: path.join(root, 'work') });
  let targetId, reports = 0, replayHeld = false, oldHash;
  let rendered;
  const oldRendered = new Promise(resolve => { rendered = resolve; });
  const fulfill = e._fulfill.bind(e);
  e._fulfill = (key, value) => {
    if (key.startsWith('galley:') && value?.items?.some(item => item.k === 'ins')) {
      targetId ??= key.slice('galley:'.length);
      if (key === 'galley:' + targetId && ++reports === 1) {
        const set = e.chunks.set.bind(e.chunks);
        e.chunks.set = (chunkKey, chunk) => {
          const result = set(chunkKey, chunk);
          if (chunkKey === targetId + '@fn0') {
            oldHash ??= chunk.forGalley;
            rendered();
          }
          return result;
        };
      } else if (key === 'galley:' + targetId && reports === 2) {
        // Make the old render win this race before the rescue adopts the
        // corrected paragraph. The successor must then get a new render.
        replayHeld = true;
        oldRendered.then(() => fulfill(key, value));
        return;
      }
    }
    fulfill(key, value);
  };
  try {
    await e.open(String.raw`\documentclass{article}
\usepackage{amsmath}
\title{A title}\author{Author}\date{}
\begin{document}
\maketitle

\section{Text}
A formula $x^2$ followed by a footnote.\footnote{FootnoteWitness.}

Tail.
\end{document}`);
    await drain(e);
    await e.renderTask;
    const block = e.blocks.find(item => item.id === targetId);
    assert.ok(replayHeld, 'the asynchronous rescue actually revisited the paragraph');
    assert.notEqual(block.galleyHash, oldHash, 'the test crosses a real galley generation change');
    for (const key of [targetId, targetId + '@fn0']) {
      assert.equal(e.chunks.get(key)?.forGalley, block.galleyHash, key + ' must describe the corrected paragraph');
    }
    assert.ok(e.getDisplayLists().some(page => page.commands.some(command =>
      command.op === 'chunk' && command.chunk === targetId + '@fn0' && !command.st)));
  } finally {
    rendered();
    await e.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('a cold page edit retains its native owners and prepares unchanged exact neighbors', opts, async () => {
  await eng?.close();
  eng = null;
  const root = mkdtempSync(path.join(tmpdir(), 'tdom-cold-edit-page-'));
  const e = new CheckpointEngine({ workDir: path.join(root, 'work') });
  e.maxCheckpoints = 4;
  const previousHot = process.env.TDOM_RENDER_HOT_MAX;
  process.env.TDOM_RENDER_HOT_MAX = '1';
  const missing = page => e.getDisplayLists().find(item => item.page === page)?.commands.filter(command =>
    command.op === 'pending-exact' || command.op === 'chunk' && command.st);
  const source = String.raw`\documentclass{article}
\usepackage[most]{tcolorbox}
\begin{document}
` + Array.from({ length: 12 }, (_, index) => String.raw`
\begin{tcolorbox}[enhanced,title=Neighbor]
Neighbor ${index}.
\end{tcolorbox}

\begin{tcolorbox}[enhanced,title=Target]
Target${index} $x^2$.
\end{tcolorbox}

\newpage

`).join('') + '\\end{document}';
  try {
    await e.open(source);
    assert.equal(e.renderHold.size, 0, 'unqueued cold work must not monopolize the render holds');
    const target = e.blocks.findIndex((block, index) => {
      const number = /Target(\d+) /.exec(block.text)?.[1];
      return number != null && Number(number) > 0 && Number(number) < 11 && !e.checkpoints.has(index);
    });
    assert.ok(target >= 0, 'a target starts outside the resident budget');
    const targetNumber = Number(/Target(\d+) /.exec(e.blocks[target].text)[1]);
    const targetPage = targetNumber + 1;
    assert.ok(missing(targetPage).length > 0);
    if (previousHot === undefined) delete process.env.TDOM_RENDER_HOT_MAX;
    else process.env.TDOM_RENDER_HOT_MAX = previousHot;
    const tailMarker = 'Target11 $x^';
    const tailAt = e.getSource().indexOf(tailMarker) + tailMarker.length;
    const tailReport = await e.edit(tailAt, tailAt + 1, '3');
    assert.ok(tailReport.stats.blocksTypeset <= 3,
      'a first edit on the final visible page starts with its unchanged neighbor');
    await e.renderTask;
    assert.deepEqual(missing(12), [], 'the final page has fresh exact neighbors before canonical');
    for (const exponent of ['3', '4']) {
      const marker = `Target${targetNumber} $x^`;
      const at = e.getSource().indexOf(marker) + marker.length;
      const report = await e.edit(at, at + 1, exponent);
      assert.ok(e.checkpoints.has(target), 'the edit input remains available before async rendering');
      assert.ok(e.checkpoints.has(target + 1), 'the current node capture remains available');
      if (exponent === '4') assert.ok(report.stats.blocksTypeset <= 2, 'typing twice must not repeat a cold prefix walk');
      await e.renderTask;
      assert.deepEqual(missing(targetPage), [], 'unchanged neighbor and changed box are both paintable without canonical');
      assert.equal(e.renderHold.size, 0, 'completed renders relinquish their temporary owners');
    }
  } finally {
    if (previousHot === undefined) delete process.env.TDOM_RENDER_HOT_MAX;
    else process.env.TDOM_RENDER_HOT_MAX = previousHot;
    await e.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('a word edit does not replay cold exact neighbors with retained native owners', opts, async () => {
  await eng?.close();
  eng = null;
  const root = mkdtempSync(path.join(tmpdir(), 'tdom-retained-page-'));
  const e = new CheckpointEngine({ workDir: path.join(root, 'work') });
  e.maxCheckpoints = 8;
  e.canonical.schedule = () => {};
  const previousHot = process.env.TDOM_RENDER_HOT_MAX;
  process.env.TDOM_RENDER_HOT_MAX = '1';
  try {
    await e.open(String.raw`\documentclass{article}
\begin{document}
Watch the paragraph.

Unchanged convergence paragraph.

\[x^2\]

\[y^2\]

\[z^2\]
\end{document}`);
    assert.ok(e.blocks.length + 1 <= e.maxCheckpoints);
    assert.ok(e.blocks.some(block => block.needsRender && e.chunks.get(block.id)?.forGalley !== block.galleyHash));
    if (previousHot === undefined) delete process.env.TDOM_RENDER_HOT_MAX;
    else process.env.TDOM_RENDER_HOT_MAX = previousHot;
    const at = e.getSource().indexOf('Watch');
    const result = await e.edit(at, at + 5, 'Check');
    assert.ok(result.stats.blocksTypeset <= 2, `edited + convergence probe only (got ${result.stats.blocksTypeset})`);
    await e.renderTask;
    assert.ok(e.getDisplayLists().every(page => page.commands.every(command =>
      command.op !== 'pending-exact' && !(command.op === 'chunk' && command.st))));
  } finally {
    if (previousHot === undefined) delete process.env.TDOM_RENDER_HOT_MAX;
    else process.env.TDOM_RENDER_HOT_MAX = previousHot;
    await e.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('a cold upper-page box edit prepares the exact material below its convergence point', opts, async () => {
  await eng?.close();
  eng = null;
  const root = mkdtempSync(path.join(tmpdir(), 'tdom-cold-upper-page-'));
  const e = new CheckpointEngine({ workDir: path.join(root, 'work') });
  e.maxCheckpoints = 4;
  e.canonical.schedule = () => {};
  const previousHot = process.env.TDOM_RENDER_HOT_MAX;
  process.env.TDOM_RENDER_HOT_MAX = '1';
  const missing = page => e.getDisplayLists().find(item => item.page === page)?.commands.filter(command =>
    command.op === 'pending-exact' || command.op === 'chunk' && command.st);
  const source = String.raw`\documentclass{article}
\usepackage[most]{tcolorbox}
\usepackage{amsmath}
\begin{document}
` + Array.from({ length: 12 }, (_, index) => String.raw`
\begin{tcolorbox}[title=Heading${index}]Unchanged heading.\end{tcolorbox}

\begin{tcolorbox}Upper${index} text is edited here.\end{tcolorbox}

\begin{tcolorbox}Lower${index} text stays unchanged.\end{tcolorbox}

\[\frac{x+1}{y+1}\]

\begin{tcolorbox}Another${index} box stays unchanged.\end{tcolorbox}

\[\sum_{k=1}^{n} k\]

\[\int_0^1 x^2\,dx\]

\newpage

`).join('') + '\\end{document}';
  try {
    await e.open(source);
    assert.equal(e.pages.length, 12);
    assert.ok(missing(7).length >= 5, 'the target starts with cold exact neighbors');
    if (previousHot === undefined) delete process.env.TDOM_RENDER_HOT_MAX;
    else process.env.TDOM_RENDER_HOT_MAX = previousHot;
    const at = e.getSource().indexOf('Upper6') + 'Upper6'.length;
    await e.edit(at, at, ' has more text which changes the height of this upper box. '.repeat(3));
    await e.renderTask;
    assert.deepEqual(missing(7), [], 'the lower equations must not wait for an isolated cold compile');
    assert.equal(e.pages.length, 12);
  } finally {
    if (previousHot === undefined) delete process.env.TDOM_RENDER_HOT_MAX;
    else process.env.TDOM_RENDER_HOT_MAX = previousHot;
    await e.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('native exact renders preserve decoration ink outside the logical box', opts, async () => {
  await eng?.close();
  eng = null;
  const root = mkdtempSync(path.join(tmpdir(), 'tdom-overhanging-ink-'));
  const e = new CheckpointEngine({ workDir: path.join(root, 'work') });
  const source = String.raw`\documentclass{article}
\usepackage[most]{tcolorbox}
\begin{document}
\begin{tcolorbox}[enhanced,before skip=0pt,after skip=0pt,
  overlay={\fill[black] ([xshift=-12bp]frame.north west)
    rectangle ([xshift=-4bp,yshift=-10bp]frame.north west);}]
Inside $x^2$.
\end{tcolorbox}
\end{document}`;
  try {
    await e.open(source);
    for (const exponent of ['2', '3']) {
      if (exponent !== '2') {
        const at = e.getSource().indexOf('x^2') + 2;
        await e.edit(at, at + 1, exponent);
      }
      await e.renderTask;
      const block = e.blocks.find(item => item.text.includes('Inside'));
      const chunk = e.chunks.get(block.id);
      assert.equal(chunk?.forGalley, block.galleyHash);
      const command = e.getDisplayLists().flatMap(page => page.commands)
        .find(item => item.op === 'chunk' && item.chunk === block.id);
      const textLeft = 72 + e.geometry.oddsidemargin;
      assert.ok(Math.abs(command.x - chunk.xBp - textLeft) < 0.02,
        'the padded image preserves the logical text origin');
      const pdf = path.join(root, `ink-${exponent}.pdf`);
      const raster = path.join(root, `ink-${exponent}`);
      writeFileSync(pdf, chunk.editPdf);
      await promisify(execFile)('pdftoppm', [
        '-f', '1', '-singlefile', '-gray', '-r', '72',
        '-x', String(Math.round(-chunk.xBp) - 10), '-y', '2',
        '-W', '4', '-H', '4', pdf, raster,
      ]);
      const pgm = readFileSync(raster + '.pgm');
      assert.match(pgm.subarray(0, 32).toString('latin1'), /^P5\s+4\s+4\s+255\s/);
      assert.ok(pgm.subarray(-16).every(value => value < 16),
        'the black decoration remains visible left of the TeX box in RENDER and CAPTURE');
    }
    assert.ok(e.renderStats.captureHits > 0);
  } finally {
    await e.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('cold native prefix replay advances only its fresh continuation and preserves TeX definitions', opts, async () => {
  await eng?.close();
  eng = null;
  const root = mkdtempSync(path.join(tmpdir(), 'tdom-prefix-continuation-'));
  const e = new CheckpointEngine({ workDir: path.join(root, 'work') });
  e.maxCheckpoints = Math.min(e.maxCheckpoints, 8);
  const source = String.raw`\documentclass{article}
\newcommand{\VisibleWord}{seed}
\begin{document}
` + Array.from({ length: 70 }, (_, index) => String.raw`
\gdef\VisibleWord{word${index}}

TARGET${index} uses \VisibleWord. Ordinary text continues with the inherited definition.

`).join('') + '\\end{document}';
  let finalSource, expected;
  let checkpointExcess = 0;
  const onMessage = e._onMessage.bind(e);
  e._onMessage = (peer, message) => {
    const result = onMessage(peer, message);
    checkpointExcess = Math.max(checkpointExcess,
      e.checkpoints.size - e.maxCheckpoints - e.editHold.length - e.renderHold.size - 2);
    return result;
  };
  try {
    await e.open(source);
    assert.equal(checkpointExcess, 0, 'checkpoint count stays bounded during every boot step');
    assert.equal(e.calibrateInitialHeap, false, 'initial body fonts have a completed heap calibration');
    const liveFloor = e.confirmedLiveHeapKb;
    assert.ok(liveFloor > 0, 'the native collector reported a live heap baseline');
    const coverage = [...e.checkpointKeepCache];
    const firstParagraph = e.getSource().indexOf('TARGET0');
    await e.warmEditOffset(firstParagraph);
    assert.deepEqual([...e.checkpointKeepCache], coverage,
      'warming unchanged text leaves the document coverage plan stable');
    const candidates = e.blocks.map((block, index) => {
      const marker = /TARGET\d+/.exec(block.text)?.[0];
      const prefix = Math.max(...[...e.checkpoints.keys()].filter(boundary => boundary <= index));
      return { index, marker, distance: index - prefix };
    }).filter(item => item.marker && item.distance >= 5).sort((a, b) => b.distance - a.distance);
    assert.ok(candidates.length > 0, 'a cold target spans multiple native definitions');
    const target = candidates[0];
    const rootPid = e.checkpoints.get(0).pid;
    const announcements = [];
    const recordMessage = e._onMessage.bind(e);
    e._onMessage = (peer, message) => {
      if (message.kind === 'FORKED') announcements.push({ pid: message.pid, parent: peer.pid });
      return recordMessage(peer, message);
    };
    const input = e.checkpoints.get(target.index - target.distance);
    const send = input.send.bind(input);
    const jobHeaders = [];
    input.send = message => {
      if (message.startsWith('JOB ')) jobHeaders.push(message.trim().split(/\s+/));
      return send(message);
    };
    const at = e.getSource().indexOf(target.marker) + target.marker.length;
    const report = await e.edit(at, at, 'x');
    assert.ok(report.stats.blocksTypeset >= 5);
    assert.ok(jobHeaders.some(header => header[5] === 'F' && Number(header[6]) >= liveFloor),
      'a cold prefix can reuse the confirmed heap of fonts loaded later in the document');
    assert.ok(announcements.some(item => item.pid === item.parent), 'the prefix reuses a transient process');
    assert.equal(e.checkpoints.get(0).pid, rootPid, 'the frozen root is never consumed');
    await drain(e);
    finalSource = e.getSource();
    expected = signature(e);
  } finally {
    await e.close();
  }
  const fresh = new CheckpointEngine({ workDir: path.join(root, 'fresh') });
  try {
    await fresh.open(finalSource);
    await drain(fresh);
    assert.deepEqual(signature(fresh), expected, 'every native galley and exit state matches a fresh run');
  } finally {
    await fresh.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('a failed prefix STEP restores its input and a known native hold is replayed by JOB', opts, async () => {
  await eng?.close();
  eng = null;
  const root = mkdtempSync(path.join(tmpdir(), 'tdom-prefix-step-recovery-'));
  const e = new CheckpointEngine({ workDir: path.join(root, 'work') });
  e.maxCheckpoints = Math.min(e.maxCheckpoints, 4);
  e.canonical.schedule = () => {};
  const source = String.raw`\documentclass{article}
\newcommand{\VisibleWord}{seed}
\begin{document}
` + Array.from({ length: 90 }, (_, index) => String.raw`
RECOVERY${index} uses \VisibleWord. Ordinary text keeps the inherited definition.

`).join('') + '\\end{document}';
  let injectedId = null;
  let injectedStepIndex = null;
  let injectedStepKeep = null;
  let pendingStep = null;
  let pendingStepIndex = null;
  let pendingStepKeep = null;
  let injectStepFailure = true;
  const commands = [];
  const wrapped = new WeakSet();
  const wrapPeer = (peer) => {
    if (wrapped.has(peer)) return;
    wrapped.add(peer);
    const send = peer.send.bind(peer);
    peer.send = message => {
      const header = /^(JOB|STEP)\s+(\S+)\s+(\d+)/.exec(message);
      if (header) {
        commands.push({ command: header[1], id: header[2] });
        if (injectStepFailure && header[1] === 'STEP') {
          pendingStep = header[2];
          pendingStepIndex = Number(header[3]) - 1;
          pendingStepKeep = new Set(e.checkpointKeepCache ?? []);
        }
      }
      return send(message);
    };
  };
  try {
    await e.open(source);
    await drain(e);
    for (const peer of e.peers) wrapPeer(peer);
    const onMessage = e._onMessage.bind(e);
    e._onMessage = (peer, message) => {
      wrapPeer(peer);
      if (injectStepFailure && message.kind === 'GALLEY' && message.id === pendingStep) {
        injectedId = message.id;
        injectedStepIndex = pendingStepIndex;
        injectedStepKeep = new Set(pendingStepKeep);
        injectStepFailure = false;
        pendingStep = null;
        pendingStepIndex = null;
        pendingStepKeep = null;
        message = {
          ...message,
          json: { ...message.json, closure: 'error', closure_error: 'injected STEP native error' },
        };
      }
      return onMessage(peer, message);
    };
    const candidates = e.blocks.map((block, index) => {
      const marker = /RECOVERY\d+/.exec(block.text)?.[0];
      const prefix = Math.max(...[...e.checkpoints.keys()].filter(boundary => boundary <= index));
      return { index, marker, distance: index - prefix };
    }).filter(item => item.marker && item.distance >= 8).sort((a, b) => b.distance - a.distance);
    assert.ok(candidates.length > 0, 'the edit has a consumptive prefix continuation');
    const target = candidates[0];
    const at = e.getSource().indexOf(target.marker) + target.marker.length;
    const first = await e.edit(at, at, 'x');
    assert.ok(injectedId, 'one previously certified STEP was made to fail');
    assert.equal(first.stats.rebooted, false, 'the consumed input is restored without a root reboot');
    assert.equal(first.stats.diagnostics.some(line => line.includes('typeset phase failed')), false);
    const held = e.blocks.find(block => block.id === injectedId);
    assert.equal(held.closure?.reason, 'native-error');
    assert.equal(held.galley?.tdomDeferred, true, 'the failed continuation itself was not adopted');

    const heldIndex = e.blocks.indexOf(held);
    assert.equal(injectedStepIndex, heldIndex);
    assert.ok(injectedStepKeep instanceof Set && !injectedStepKeep.has(heldIndex),
      'the injected input was outside the measured checkpoint skeleton when STEP consumed it');

    // Cost measurements and edit holds legitimately move the sparse
    // topology after the first recovery. Build the second, independent cold
    // gap explicitly: keep the live root, retire every successor through a
    // later target, and restore a COPY of the keep plan under which this
    // exact boundary was previously STEP-eligible.
    abortBackgroundJob(e, 'test prepares a deterministic known-hold replay gap');
    await e.bgTask.catch(() => {});
    e.bgAbort = false;
    e.checkpointKeepCache = new Set(injectedStepKeep);
    e.editHold = e.editHold.filter(index => index !== heldIndex);
    e.renderHold.delete(heldIndex);
    const previousId = e.blocks[heldIndex - 1]?.id;
    if (previousId) e.renderWant.delete(previousId);
    assert.equal(e.checkpointKeepCache.has(heldIndex), false);
    assert.equal(e.editHold.includes(heldIndex), false);
    assert.equal(e.renderHold.has(heldIndex), false);
    assert.equal(previousId ? e.renderWant.has(previousId) : false, false);
    assert.equal(previousId ? [...(e.rendering ?? [])].some(key => key.startsWith(previousId + ':')) : false, false,
      'the known native hold, not a grid/edit/render owner, must force JOB');

    const crossing = e.blocks.map((block, index) => ({
      index,
      marker: /RECOVERY\d+/.exec(block.text)?.[0],
    })).find(item => item.marker && item.index > heldIndex + 1);
    assert.ok(crossing, 'the fixture has a later block to warm across the held block');
    const rootCheckpoint = e.checkpoints.get(0);
    assert.ok(rootCheckpoint && !rootCheckpoint.sock.destroyed,
      'the root is a real live replay frontier');
    for (const [index, peer] of [...e.checkpoints]) {
      if (index === 0 || index > crossing.index) continue;
      peer.send('DIE\n');
      if (peer.pid) e.dyingPids.add(peer.pid);
      e.checkpoints.delete(index);
    }
    assert.equal(Math.max(...[...e.checkpoints.keys()].filter(index => index <= crossing.index)), 0,
      'the warm walk starts at root and must cross the known hold');
    commands.length = 0;
    await e.warmEditOffset(e.getSource().indexOf(crossing.marker));
    const heldCommands = commands.filter(item => item.id === injectedId).map(item => item.command);
    assert.ok(commands.some(item => item.command === 'STEP' && item.id !== injectedId),
      'the same warm walk still consumes ordinary STEP-eligible inputs');
    assert.ok(heldCommands.includes('JOB'), 'the known native hold retains its recovery input');
    assert.equal(heldCommands.includes('STEP'), false, 'the known native hold is never consumed in place');
    assert.equal(held.closure?.native, true, 'the valid block heals through real LuaLaTeX');
    assert.equal(held.galley?.tdomDeferred, undefined);

    const tailAt = e.getSource().indexOf(target.marker) + target.marker.length + 1;
    const second = await e.edit(tailAt, tailAt, 'y');
    assert.equal(second.stats.rebooted, false, 'normal editing continues after local recovery');
    assert.equal(second.stats.diagnostics.some(line => line.includes('typeset phase failed')), false);
  } finally {
    await e.close();
    rmSync(root, { recursive: true, force: true });
  }
});
