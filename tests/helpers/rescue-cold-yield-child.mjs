// Child process of tests/rescue-cold-yield.test.js (tex64-internal #121). A
// cold keystroke inside a rescued block whose exact result is already compiled,
// with the block's rescue queued and on the keystroke's page: the rescue pump
// must not hold the event loop. Run apart from the test runner, which kills it
// if it stops answering: a starved event loop also starves the runner's own
// timers. Progress goes out with synchronous writes for the same reason.
//
//   node tests/helpers/rescue-cold-yield-child.mjs [engine checkout]
import { rmSync, writeSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(process.argv[2] ?? fileURLToPath(new URL('../..', import.meta.url)));
const { CheckpointEngine } = await import(pathToFileURL(path.join(root, 'engine/checkpoint/engine-v3.js')).href);
const say = (event, data = {}) => writeSync(1, JSON.stringify({ event, ...data }) + '\n');

const LOREM = 'Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. ';
const paragraphs = [];
for (let i = 1; i <= 160; i += 1) {
  paragraphs.push(`Paragraph ${i} of the cold rescue fixture keeps the resident chain walking for a while.`);
  if (i % 4 === 0) paragraphs.push('\\newpage');
  paragraphs.push('');
  if (i === 150) paragraphs.push('\\begin{multicols}{2}', 'Columns start here. ' + LOREM.repeat(2), '\\end{multicols}', '');
}
const doc = ['\\documentclass{article}', '\\usepackage{multicol}', '\\begin{document}', ...paragraphs, '\\end{document}', ''].join('\n');

const work = path.join(root, '.tdom-v3-test-cold-yield');
rmSync(work, { recursive: true, force: true });
process.env.TDOM_GRID_FILL = '0';
process.env.TDOM_ISO_REAL_FORK = '1';
const e = new CheckpointEngine({ workDir: work });
delete process.env.TDOM_ISO_REAL_FORK;
e.checkpointCeiling = 4; // the columns are far from every boundary
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const busy = () => e.pendingChain || e.coldDirty.size || e.bgActive || e.updating || e.rescueQueue.size || e.rescuePumping;
const idle = async (ms) => {
  const until = Date.now() + ms;
  while (busy() && Date.now() < until) await sleep(50);
  return !busy();
};
const cols = () => e.blocks.find((b) => b.text.includes('\\begin{multicols}'));

let code = 1;
try {
  await e.open(doc);
  if (!(await idle(180_000))) throw new Error('the boot rescues did not drain');
  if (!cols()?.rescued) throw new Error('the columns are not a rescued block');
  say('opened');
  e.coldPrefixBudgetMs = 1; // stop after the first replayed clean block
  e.coldPreviewFromMs = 0; // preview every cold keystroke

  // 1. a cold keystroke inside the columns, and at once (inside the cold
  // resume's idle gate) 2. the keystroke back to the opened text, whose exact
  // result the boot compiled. In the app the block's rescue was still queued
  // from the paper a preamble edit had just rebuilt; here the second
  // keystroke's own update queues it, as an offset re-rescue (its galley
  // counts as compiled at the foot of the page).
  let at = e.getSource().indexOf('Columns start here.');
  const first = await e.edit(at, at + 'Columns'.length, 'Wide columns');
  if (first.stats.chainVerdict !== 'cold') throw new Error(`first keystroke was not cold: ${first.stats.chainVerdict}`);
  const id = cols().id;
  cols().galley.tdomPageOff = e.geometry.textheight;
  const abortedBefore = (e.rescueLog ?? []).filter((r) => r.id === id && r.outcome === 'aborted').length;
  at = e.getSource().indexOf('Wide columns');
  const second = await e.edit(at, at + 'Wide columns'.length, 'Columns');
  // the state of the stall, read before anything else can run
  const state = {
    verdict: second.stats.chainVerdict,
    coldDirty: [...e.coldDirty],
    chain: e.pendingChain?.kind ?? null,
    focus: e.rescueFocus.has(id),
    queued: e.rescueQueue.has(id) || !!e.rescuePumping,
    id,
  };
  say('second keystroke returned', state);
  // a heartbeat while it settles: the test runner kills this process when
  // the beats stop (the stall held the CPU and ran no timer again)
  let lastBeat = performance.now();
  let maxGapMs = 0;
  const heart = setInterval(() => {
    const now = performance.now();
    maxGapMs = Math.max(maxGapMs, now - lastBeat);
    lastBeat = now;
    say('beat');
  }, 250);
  const settled = await idle(180_000);
  clearInterval(heart);
  const block = cols();
  say('done', {
    state,
    maxGapMs: Math.round(maxGapMs),
    settled,
    coldDirty: [...e.coldDirty],
    chain: e.pendingChain?.kind ?? null,
    queue: e.rescueQueue.size,
    text: block.text.includes('Columns start here.'),
    preview: !!block.galley?.tdomColdPreview,
    stale: !!block.galley?.tdomStale,
    rescued: !!block.rescued,
    aborted: (e.rescueLog ?? []).filter((r) => r.id === id && r.outcome === 'aborted').length - abortedBefore,
  });
  code = 0;
} catch (err) {
  say('error', { message: String(err?.stack ?? err) });
} finally {
  await e.close().catch(() => {});
  rmSync(work, { recursive: true, force: true });
}
process.exit(code);
