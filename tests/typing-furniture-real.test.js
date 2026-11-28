// Release audit round 21 (class W): the production server and the Live
// iframe, a document opened and typed into at once. Prose typed on sheet 2
// from +1 s, one key every 300 ms for 30 s. v0.1.32 (c53846b) showed the
// running head and the numbered foot from its first paint and kept them; the
// candidate showed none until 3.6 s after the last key. In the server the
// opening an edit had superseded waited for work every keystroke re-arms
// (the shipping chain's boot timer, the keystroke's deferred settle), and
// the first header map for paused isolated renders and the shipping quiet
// window. CheckpointEngine alone, without the shipping chain or the frame's
// warms, did not show it.
//
// Rule: a prose keystroke that does not change what a sheet's head or foot
// prints never removes a shown and still valid head or foot, and while the
// typing goes on the first verified head and foot of the edited sheet are
// published between keystrokes, no later than c53846b showed them + 1 s.
// c53846b's times below were measured with this very harness on this Mac
// (TeX64-Pro/testing/issue-121-wip/final/scratch/engine-fix/logs/typing-real-base.log).
//
// TDOM_TYPING_ENGINE=<engine dir>: run the same driver against another tree.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const engine = process.env.TDOM_TYPING_ENGINE || fileURLToPath(new URL('..', import.meta.url));
const host = path.resolve(fileURLToPath(new URL('..', import.meta.url)), '../TeX64-Pro');
const hostRequire = createRequire(path.join(host, 'package.json'));
const record = process.env.TDOM_TYPING_RECORD === '1';

async function until(read, label, timeout = 45_000) {
  const deadline = Date.now() + timeout;
  do {
    const value = await read();
    if (value) return value;
    await sleep(60);
  } while (Date.now() < deadline);
  assert.fail(label);
}

async function boot(t, project) {
  const reservation = createServer();
  reservation.listen(0, '127.0.0.1');
  await once(reservation, 'listening');
  const { port } = reservation.address();
  await new Promise((resolve) => reservation.close(resolve));
  // (the production server's configuration: the shipping chain, canonical
  // anchor, isolated renders forked for real)
  const child = spawn(process.execPath, ['server.js'], {
    cwd: engine, detached: true, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, PORT: String(port), TDOM_WORKDIR: path.join(project, 'work'),
      TDOM_MAX_CHECKPOINTS: '8', DEVELOPER_DIR: process.env.DEVELOPER_DIR || '/Library/Developer/CommandLineTools',
      TDOM_SAMPLE: 'demo-lua.tex', TDOM_SHIP: '1', TDOM_SHIP_PRIVATE_PDF: '1',
      TDOM_CANONICAL_ANCHOR: '1', TDOM_ISO_REAL_FORK: '1',
      TDOM_HOST_WEB_ROOT: path.join(host, 'Resources/web'),
      TDOM_PDFJS_PATH: hostRequire.resolve('pdfjs-dist/legacy/build/pdf.mjs') },
  });
  let log = '';
  const append = (chunk) => { log = (log + chunk).slice(-65_536); if (process.env.TDOM_TYPING_SERVER_LOG) process.stderr.write(chunk); };
  child.stdout.on('data', append);
  child.stderr.on('data', append);
  const exited = once(child, 'exit');
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM');
      await Promise.race([exited, sleep(5500, null, { ref: false })]);
      if (child.exitCode === null && child.signalCode === null) process.kill(-child.pid, 'SIGKILL');
    }
  });
  const origin = 'http://127.0.0.1:' + port;
  await until(async () => {
    if (child.exitCode !== null) assert.fail(log);
    return fetch(origin + '/status').then((response) => response.ok, () => false);
  }, 'server did not listen');
  const request = async (url, body) => {
    const response = await fetch(origin + url, body === undefined ? undefined : {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    });
    assert.ok(response.ok, url + ' ' + response.status + ' ' + (response.ok ? '' : await response.text()));
    return response.json();
  };
  return { origin, request };
}

// The audit's article: a running section mark and a numbered foot.
const article = String.raw`\documentclass{article}
\usepackage{fancyhdr}
\pagestyle{fancy}
\fancyhf{}
\renewcommand{\headrulewidth}{0pt}
\renewcommand{\sectionmark}[1]{\markboth{#1}{#1}}
\fancyhead[L]{\leftmark}
\fancyfoot[C]{Sheet \thepage}
\begin{document}
\section{Alpha lesson}
This is the introduction. It explains the exercise.

\clearpage
Second exercise. We begin with the example.

The class then reads the question together.
\clearpage
Third exercise. This page uses the same running heading.
\end{document}
`;

// Six two-sided pages, a section on sheets 1, 3 and 5: the even head prints
// the left mark, the odd head the right mark.
const twoside = String.raw`\documentclass[twoside]{article}
\usepackage{fancyhdr}
\pagestyle{fancy}
\fancyhf{}
\renewcommand{\headrulewidth}{0pt}
\renewcommand{\sectionmark}[1]{\markboth{#1}{#1}}
\fancyhead[LE]{\leftmark}
\fancyhead[RO]{\rightmark}
\fancyfoot[C]{Sheet \thepage}
\begin{document}
\section{Alpha lesson}
This is the introduction. It explains the exercise.

\clearpage
Second exercise. We begin with the example.

The class then reads the question together.
\clearpage
\section{Beta lesson}
Third exercise. This sheet opens the second lesson.

\clearpage
Fourth exercise. The second lesson goes on.

\clearpage
\section{Gamma lesson}
Fifth exercise. This sheet opens the third lesson.

\clearpage
Sixth exercise. The third lesson ends here.
\end{document}
`;

const fixtures = {
  // (c53846b: head and foot of sheet 2 first shown at +532 and +513 ms from
  // the open request in two runs of this driver, then in every sample)
  article: { source: article, heads: ['Alphalesson', 'Alphalesson', 'Alphalesson'], baselineMs: 532 },
  // (c53846b: +517 and +655 ms)
  twoside: { source: twoside, heads: ['Alphalesson', 'Alphalesson', 'Betalesson', 'Betalesson', 'Gammalesson', 'Gammalesson'],
    baselineMs: 655 },
};
const needle = 'We begin with the example.';
const sheet = 2;
const KEY_MS = 300, KEYS = 100, START_MS = 1050, SAMPLE_MS = 500;

async function typeAndWatch(t, chromium, name) {
  const { source, heads, baselineMs } = fixtures[name];
  const dir = mkdtempSync(path.join(tmpdir(), `tdom-typing-${name}-`));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const at = source.indexOf(needle) + needle.length;
  const filePath = path.join(dir, 'main.tex');
  writeFileSync(filePath, source);
  const { origin, request } = await boot(t, dir);
  const browser = await chromium.launch({ headless: true, args: ['--single-process', '--no-zygote', '--in-process-gpu'] });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 950, height: 1050 } });
  await page.addInitScript(() => {
    window.addEventListener('message', ({ data, source }) => {
      if (data?.source === 'tdom-embed' && data.action === 'reset-pending') {
        source.postMessage({ source: 'tdom-host', activationId: 'typing', action: 'reset-ack', documentEpoch: data.documentEpoch }, '*');
      }
    });
  });
  await page.route(origin + '/typing-host', (route) => route.fulfill({ contentType: 'text/html',
    body: '<style>*{margin:0}iframe{border:0;width:100vw;height:100vh}</style><iframe></iframe>' }));
  await page.goto(origin + '/typing-host');
  const started = performance.now();
  const epoch = Date.now();
  const opened = request('/open', { filePath, projectRoot: dir, text: source });
  const loading = opened.then(async () => {
    await page.locator('iframe').evaluate((e) => { e.src = '/?embed=1&theme=light&activationId=typing'; });
    const frame = await until(() => page.frames().find((f) => f.url().includes('embed=1')), 'preview frame');
    // What each painted frame shows on the sheets in view: the text of the
    // head and foot drawn over provisional paper, or that an exact page shows.
    await frame.evaluate(({ epoch, sheet }) => {
      window.typingFrames = [];
      let scrolled = false, last;
      const visible = (e) => e.checkVisibility({ opacityProperty: true, visibilityProperty: true });
      function tick() {
        const probe = document.querySelector(`#pages > .page[data-page="${sheet}"]`);
        if (probe && !scrolled) { probe.scrollIntoView({ block: 'start', behavior: 'instant' }); scrolled = true; }
        const view = [...document.querySelectorAll('#pages > .page')].filter((p) => {
          const b = p.getBoundingClientRect();
          return b.top < innerHeight && b.bottom > 0;
        }).map((p) => {
          const img = p.querySelector('img.canon');
          const exact = Boolean(img?.complete && img.naturalWidth && visible(img) && p.classList.contains('is-final') &&
            getComputedStyle(img).clipPath === 'none');
          // (the head and foot drawn over the paper, told apart by where they
          // stand: c53846b's runs carry no slot attribute)
          const box = p.getBoundingClientRect();
          const nodes = [...p.querySelectorAll('[data-src="_hf"],[data-hf-slot],:scope > svg > text[text-anchor="middle"]:not([data-src])')]
            .filter((n) => n.tagName.toLowerCase() === 'text' && visible(n));
          const slot = (upper) => nodes.filter((n) => (n.getBoundingClientRect().top - box.top < box.height / 2) === upper)
            .map((n) => n.textContent).join('').replace(/\s/g, '');
          return { n: Number(p.dataset.page), exact, h: slot(true), f: slot(false) };
        });
        const state = JSON.stringify(view);
        if (state !== last) { last = state; window.typingFrames.push({ ms: Date.now() - epoch, view }); }
        requestAnimationFrame(tick);
      }
      tick();
    }, { epoch, sheet });
    return frame;
  });
  loading.catch(() => {});
  await sleep(Math.max(0, START_MS - (performance.now() - started)));
  const phrase = ' Then we compare the answers and explain the steps in order. Each student checks the examples again. ';
  let queued = opened;
  const typingFrom = performance.now();
  for (let i = 0; i < KEYS; i++) {
    const remaining = typingFrom + KEY_MS * i - performance.now();
    if (remaining > 0) await sleep(remaining);
    const key = phrase[i % phrase.length];
    queued = queued.then(() => request('/edit', { start: at + i, end: at + i, text: key }));
    queued.catch(() => {});
  }
  const lastKeyMs = performance.now() - started;
  const reports = await queued;
  const frame = await loading;
  await sleep(1000);
  const frames = await frame.evaluate(() => window.typingFrames);
  return { frames, heads, baselineMs, lastKeyMs, blocks: reports?.stats?.blocksTypeset, source: (await request('/doc')).source };
}

function judge(name, { frames, heads, baselineMs, lastKeyMs }) {
  const shows = (view, n) => {
    const p = view.find((v) => v.n === n);
    return p && (p.exact || (p.h === heads[n - 1] && p.f === `Sheet${n}`));
  };
  // never a wrong head or number on any sheet drawn
  for (const { ms, view } of frames) {
    for (const p of view) {
      if (p.exact || !(p.n >= 1 && p.n <= heads.length)) continue;
      assert.ok(!p.h || p.h === heads[p.n - 1], `${name} +${ms} ms: sheet ${p.n} shows the head "${p.h}"`);
      assert.ok(!p.f || p.f === `Sheet${p.n}` || p.f === String(p.n), `${name} +${ms} ms: sheet ${p.n} shows the foot "${p.f}"`);
    }
  }
  const first = frames.find(({ view }) => shows(view, sheet))?.ms ?? Infinity;
  const at = (ms) => [...frames].reverse().find((f) => f.ms <= ms)?.view ?? [];
  const samples = [];
  for (let ms = Math.min(first, baselineMs + 1000); ms <= lastKeyMs; ms += SAMPLE_MS) samples.push(Boolean(shows(at(ms), sheet)));
  const share = samples.filter(Boolean).length / Math.max(1, samples.length);
  return { first, share, samples: samples.length };
}

const skipReason = () => {
  try { hostRequire.resolve('playwright'); } catch { return 'Playwright unavailable'; }
  if (spawnSync('lualatex', ['--version'], { stdio: 'ignore' }).status !== 0) return 'LuaLaTeX unavailable';
  return false;
};

for (const name of Object.keys(fixtures)) {
  test(`typing on sheet 2 right after open keeps its head and foot (${name}, production server and iframe)`,
    { skip: skipReason(), timeout: 150_000 }, async (t) => {
      const { chromium } = hostRequire('playwright');
      const run = await typeAndWatch(t, chromium, name);
      if (process.env.TDOM_TYPING_FRAMES) writeFileSync(`${process.env.TDOM_TYPING_FRAMES}-${name}.json`, JSON.stringify(run.frames));
      const verdict = judge(name, run);
      t.diagnostic(JSON.stringify({ name, ...verdict, lastKeyMs: Math.round(run.lastKeyMs), blocks: run.blocks }));
      if (record) return;
      assert.ok(run.source.includes(needle + ' Then we compare'), 'every key reached the source');
      assert.ok(verdict.first <= run.baselineMs + 1000,
        `head and foot of sheet ${sheet} first shown at +${verdict.first} ms; c53846b +${run.baselineMs} ms`);
      assert.ok(verdict.share >= 0.9, `head and foot shown in ${(verdict.share * 100).toFixed(0)} % of ${verdict.samples} samples`);
    });
}
