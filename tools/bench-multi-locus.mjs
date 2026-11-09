// Whole-buffer snapshots containing distant edits. Optional --caret=0.5 warms
// that locus; --caret=none (default) retains the original document-order run.
// Report fresh-block publication separately from whole-page paintability.
// Neither includes browser raster/paint time.
import { readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { CheckpointEngine } from '../engine/checkpoint/engine-v3.js';
import { observePublication, observeCanonicalPublication } from './publication.mjs';
import { drain, percentile } from './harness.mjs';

const args = process.argv.slice(2);
const file = path.resolve(args.find(arg => !arg.startsWith('--')) ?? '/tmp/long12.tex');
const keys = Number(args.find(arg => arg.startsWith('--keys='))?.split('=')[1] ?? 20);
const caretArg = args.find(arg => arg.startsWith('--caret='))?.split('=')[1] ?? 'none';
const caret = caretArg === 'none' ? null : Number(caretArg);
const timeoutMs = Number(args.find(arg => arg.startsWith('--timeout='))?.split('=')[1] ?? 3000);
if (!Number.isInteger(keys) || keys < 1 || !(timeoutMs > 0) ||
    (caret !== null && !(caret > 0 && caret < 1))) throw new Error('Use --keys=N --caret=none|0..1 --timeout=ms');
process.env.TDOM_MAX_CHECKPOINTS ||= '8';
if (!(Number(process.env.TDOM_MAX_CHECKPOINTS) > 0 && Number(process.env.TDOM_MAX_CHECKPOINTS) <= 8)) {
  throw new Error('Use TDOM_MAX_CHECKPOINTS=8 (one engine at a time).');
}
const source = readFileSync(file, 'utf8');
const work = path.join(os.tmpdir(), `tdom-ml-${process.pid}`);
const eng = new CheckpointEngine({ workDir: work, docDir: path.dirname(file) });
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const summary = values => {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  return sorted.length ? Object.fromEntries([50, 90, 100].map(p =>
    [p === 100 ? 'max' : `p${p}`, Math.round(percentile(sorted, p))])) : null;
};
const at = (text, fraction) => {
  const body = text.indexOf('\\begin{document}');
  const offset = text.indexOf('。', body + Math.floor((text.length - body) * fraction));
  if (body < 0 || offset < 0 || offset >= text.indexOf('\\end{document}')) {
    throw new Error(`No body sentence at ${fraction}; use tools/gen-long-doc.mjs.`);
  }
  return offset + 1;
};
let sample = null;
let jobs = 0;
const onMessage = eng._onMessage.bind(eng);
eng._onMessage = (peer, message) => {
  // All resident galley jobs, including deferred/header/state work; full
  // canonical compiles and RENDER/CAPTURE do not produce GALLEY messages.
  if (message.kind === 'GALLEY') jobs++;
  return onMessage(peer, message);
};
function published(report) {
  observePublication(eng, sample, report, performance.now());
}
eng.onCanonical = info => observeCanonicalPublication(sample, info, performance.now());
eng.onDeferredUpdate = published;
eng.onAsyncPatches = published;
try {
  await eng.open(source);
  await drain(eng);
  if (eng.mode !== 'structured' || !eng.pages.length) throw new Error(`Resident boot failed: ${eng.diagnostics.join('; ')}`);
  console.log(JSON.stringify({ file, blocks: eng.blocks.length, pages: eng.pages.length, keys, caret,
    publish: 'caretPublishMs/lastPublishMs: fresh edited blocks in actual patches; *PagePublishMs: paintable whole pages or canonical events; excludes browser paint', timeoutMs }));
  for (const fractions of [[0.5], [0.2, 0.5], [0.2, 0.5, 0.8], [0.8, 0.5, 0.2]]) {
    const walls = [], caretTimes = [], lastTimes = [], typed = [], rebuilt = [], typesetMs = [];
    let missed = 0, pageMissed = 0, priority = 0;
    const caretPageTimes = [], lastPageTimes = [];
    const channels = { resident: 0, canonical: 0 };
    const pageChannels = { resident: 0, canonical: 0 };
    if (caret !== null) {
      await eng.warmEditOffset(at(eng.getSource(), caret));
      await drain(eng);
    }
    const jobsBefore = jobs;
    for (let key = 0; key < keys; key++) {
      const text = eng.getSource();
      const positions = fractions.map(fraction => at(text, fraction)).sort((a, b) => a - b);
      if (new Set(positions).size !== fractions.length) throw new Error('Loci must be distinct.');
      const focusOffset = at(text, caret ?? 0.5);
      const targets = positions.map(offset => {
        const block = eng.blocks.find(candidate => !candidate.file && candidate.start <= offset && candidate.end >= offset);
        if (!block) throw new Error(`No root block at ${offset}`);
        return { id: block.id, oldHash: block.hash, offset, publishedMs: null };
      });
      const focus = targets.reduce((best, target) => Math.abs(target.offset - focusOffset) <
        Math.abs(best.offset - focusOffset) ? target : best);
      let next = text;
      for (const offset of [...positions].reverse()) next = next.slice(0, offset) + 'あ' + next.slice(offset);
      sample = { targets, srcRev: eng.srcRev + 1, started: performance.now() };
      const report = await eng.edit(positions[0], positions.at(-1),
        next.slice(positions[0], positions.at(-1) + positions.length));
      const finished = performance.now();
      walls.push(finished - sample.started);
      typed.push(report.stats.blocksTypeset);
      rebuilt.push(report.stats.pagesRebuilt);
      typesetMs.push(report.stats.typesetMs);
      if (report.stats.multiLocus) priority++;
      published(report);
      // Like stageProvisionalPage, request the fallback when the resident
      // transaction cannot paint. Merely watching patches misses this lane.
      const demandId = `bench-${sample.srcRev}`;
      if (targets.some(target => target.pagePublishedMs == null)) {
        eng.canonical.requestDisplay(sample.srcRev, 0, { demandId });
      }
      while (targets.some(target => target.publishedMs === null) && performance.now() - sample.started < timeoutMs) {
        await sleep(5);
      }
      await sleep(Math.max(0, 120 - (performance.now() - finished)));
      if (focus.publishedMs !== null) caretTimes.push(focus.publishedMs);
      if (targets.every(target => target.publishedMs !== null)) lastTimes.push(Math.max(...targets.map(t => t.publishedMs)));
      else missed++;
      for (const target of targets) if (target.channel) channels[target.channel]++;
      if (focus.pagePublishedMs != null) caretPageTimes.push(focus.pagePublishedMs);
      if (targets.every(target => target.pagePublishedMs != null)) {
        lastPageTimes.push(Math.max(...targets.map(t => t.pagePublishedMs)));
        eng.canonical.fulfillDisplay(sample.srcRev, 0, demandId);
      } else pageMissed++;
      for (const target of targets) if (target.pageChannel) pageChannels[target.pageChannel]++;
      sample = null;
    }
    await drain(eng);
    console.log(JSON.stringify({ places: fractions.length, fractions, caret, observedFocusFraction: caret ?? 0.5, priority, samples: keys,
      wallMs: summary(walls), caretPublishMs: summary(caretTimes), lastPublishMs: summary(lastTimes),
      caretPagePublishMs: summary(caretPageTimes), lastPagePublishMs: summary(lastPageTimes),
      pageUnpublishedAtNextEdit: pageMissed, pagePublicationChannels: pageChannels,
      unpublishedWithinTimeout: missed, publicationChannels: channels, caretSamples: caretTimes.length, lastSamples: lastTimes.length,
      blocksTypesetP50: summary(typed)?.p50, pagesRebuiltP50: summary(rebuilt)?.p50,
      typesetMsP50: summary(typesetMs)?.p50, totalNativeJobs: jobs - jobsBefore,
      nativeJobsPerEdit: (jobs - jobsBefore) / keys }));
    if (missed) process.exitCode = 1;
  }
} finally {
  sample = null;
  await eng.close();
  rmSync(work, { recursive: true, force: true });
}
