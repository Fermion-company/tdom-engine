// Integration coverage for the server and embed frame used by TeX64.
// TDOM_ANCHOR_SWEEP=1 adds the two-width, three-minute diagnostic sweep.
// TDOM_ANCHOR_RECORD=1 records the baseline without asserting the motion bound.
// TDOM_ANCHOR_SINGLE_PROCESS=1 also supports a sandbox without Mach rendezvous.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import path from 'node:path';
import test from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { parseJumpText } from '../engine/checkpoint/jump-sync.js';

const engine = fileURLToPath(new URL('..', import.meta.url));
const host = path.resolve(engine, '../TeX64-Pro');
const fixture = path.join(host, 'testing/realapp-verify-20261125/fixtures/jdoc');
const scratch = process.env.TDOM_ANCHOR_SCRATCH || path.join(host, 'testing/codex-sol-20261126/scratch-anchor');
const hostRequire = createRequire(path.join(host, 'package.json'));
const full = process.env.TDOM_ANCHOR_SWEEP === '1';
const record = process.env.TDOM_ANCHOR_RECORD === '1';
const widthOverride = Number(process.env.TDOM_ANCHOR_WIDTH);
const widths = widthOverride > 0 ? [widthOverride] : full ? [900, 500] : [500];
const rounded = n => Math.round(n * 100) / 100;

async function until(read, label, timeout = 45_000) {
  const deadline = Date.now() + timeout;
  let last;
  do {
    last = await read();
    if (last) return last;
    await sleep(60);
  } while (Date.now() < deadline);
  assert.fail(label);
}

async function boot(t, project) {
  const reservation = createServer();
  reservation.listen(0, '127.0.0.1');
  await once(reservation, 'listening');
  const { port } = reservation.address();
  await new Promise(resolve => reservation.close(resolve));
  const child = spawn(process.execPath, ['server.js'], {
    cwd: engine, detached: true, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, PORT: String(port), TDOM_WORKDIR: path.join(project, 'work'),
      TDOM_MAX_CHECKPOINTS: '8', DEVELOPER_DIR: process.env.DEVELOPER_DIR || '/Library/Developer/CommandLineTools',
      TDOM_SAMPLE: 'demo-lua.tex', TDOM_SHIP: '1', TDOM_SHIP_PRIVATE_PDF: '1',
      TDOM_CANONICAL_ANCHOR: '1', TDOM_ISO_REAL_FORK: '1',
      TDOM_HOST_WEB_ROOT: path.join(host, 'Resources/web'),
      TDOM_PDFJS_PATH: hostRequire.resolve('pdfjs-dist/legacy/build/pdf.mjs') },
  });
  t.diagnostic('engine pid ' + child.pid);
  let log = '';
  const append = chunk => { log = (log + chunk).slice(-32_768); };
  child.stdout.on('data', append);
  child.stderr.on('data', append);
  const exited = once(child, 'exit');
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM');
      await Promise.race([exited, sleep(5500, null, { ref: false })]);
      if (child.exitCode === null && child.signalCode === null) process.kill(-child.pid, 'SIGKILL');
    }
    writeFileSync(path.join(project, 'server.log'), log);
  });
  const origin = 'http://127.0.0.1:' + port;
  await until(async () => {
    if (child.exitCode !== null) assert.fail(log);
    return fetch(origin + '/status').then(response => response.ok, () => false);
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

// The two readers use the baselines of the same painted token. Canonical
// metadata is fetched as soon as a displayed generation is sampled and
// cached by page and generation, before that generation can be retired.
function tokenRows(glyphs) {
  const rows = new Map();
  for (const { y, x, text } of glyphs) {
    const key = Math.round(y * 2);
    if (!rows.has(key)) rows.set(key, []);
    rows.get(key).push({ y, x, text });
  }
  const tokens = {};
  for (const row of rows.values()) {
    row.sort((a, b) => a.x - b.x);
    const owners = row.flatMap(glyph => Array.from(glyph.text.replace(/\s/gu, ''), text => ({ text, y: glyph.y })));
    for (const match of owners.map(glyph => glyph.text).join('').matchAll(/Qz\d{3}/g)) {
      tokens[match[0]] = owners[match.index].y;
    }
  }
  return tokens;
}

async function openFrame(context, { origin, request }, width, exactPages) {
  const page = await context.newPage();
  await page.setViewportSize({ width, height: 850 });
  const missing = [];
  const errors = [];
  page.on('response', response => {
    if (response.status() === 404) missing.push(new URL(response.url()).pathname + new URL(response.url()).search);
  });
  page.on('pageerror', error => errors.push(String(error)));
  await page.route(origin + '/anchor-test-host', route => route.fulfill({ contentType: 'text/html', body:
    '<style>body{margin:0}iframe{border:0;width:100vw;height:100vh}</style><script>' +
    'window.addEventListener("message",({data})=>{if(data?.source!=="tdom-embed")return;' +
    'if(data.action==="reset-pending")window.pendingReset=data;else if(!data.action){window.snapshot=data;' +
    'window.snapshotCount=(window.snapshotCount||0)+1;}});</script>' +
    '<iframe src="' + origin + '/?embed=1&theme=light&bg=%23ffffff&activationId=anchor"></iframe>',
  }));
  await page.goto(origin + '/anchor-test-host');
  const frame = await until(() => page.mainFrame().childFrames().find(candidate => candidate.url().startsWith(origin)), 'real embedded frame', 5000);
  await frame.waitForLoadState('load');
  assert.equal(await frame.evaluate(() => typeof captureViewAnchor), 'function',
    JSON.stringify({ errors, missing, frame: frame.url(), html: (await frame.content()).slice(0, 180) }));
  const post = (action, payload = {}) => page.evaluate(({ action, payload }) => {
    document.querySelector('iframe').contentWindow.postMessage(
      { source: 'tdom-host', activationId: 'anchor', action, ...payload }, '*');
  }, { action, payload });
  const snapshot = () => page.evaluate(() => window.snapshot);
  const settled = async (rev, token) => {
    try {
      return await until(async () => {
        const state = await snapshot();
        return state?.painted && state.ready && !state.presentationPending &&
          (rev == null || state.srcRev >= rev) && (!token || state.viewportToken === token && state.tokenPointShown) && state;
      }, 'frame did not settle at revision ' + rev + ', handoff ' + token);
    } catch (error) {
      const visible = await frame.evaluate(() => {
        const pane = document.getElementById('pages').getBoundingClientRect();
        return [...document.querySelectorAll('#pages > .page')].filter(page => {
          const box = page.getBoundingClientRect();
          return box.bottom > pane.top && box.top < pane.bottom;
        }).map(page => ({ ...page.dataset, dirty: pageDirtyRev.get(Number(page.dataset.page)),
          classes: page.className }));
      });
      assert.fail(error.message + ' ' + JSON.stringify({ snapshot: await snapshot(), visible, missing, errors }));
    }
  };
  await page.exposeFunction('anchorExactPage', (id, n, ship) => {
    const key = ship || id + ':' + n;
    if (!exactPages.has(key)) {
      const endpoint = ship ? '/ship-glyphs?page=' + n + '&' + ship.split('?')[1] : '/canonical/glyphs?c=' + id + '&page=' + n;
      exactPages.set(key, request(endpoint).then(({ glyphs }) => tokenRows(glyphs.map(g => ({
        y: g.baseline, x: g.left, text: g.text,
      })))).catch(error => ({ error: String(error) })));
    }
  });
  await frame.evaluate(`(() => {
    const tokenRows = ${tokenRows};
    const pane = document.getElementById('pages');
    const lists = new WeakMap();
    const requested = new Set();
    const frames = [];
    window.anchorFrames = frames;
    function tick(time) {
      const view = pane.getBoundingClientRect();
      const visible = [];
      for (const div of pane.querySelectorAll(':scope > .page')) {
        const box = div.getBoundingClientRect();
        if (box.bottom < view.top || box.top > view.bottom) continue;
        const n = Number(div.dataset.page);
        const exact = div.classList.contains('is-final') && div.querySelector('img.canon');
        const sheet = { n, top: box.top, height: box.height, width: box.width };
        if (exact) {
          sheet.paper = Number(div.dataset.canonPaperH);
          const id = div.dataset.canonPresentedId;
          const src = div.dataset.canonPresentedSrc || '';
          const ship = src.startsWith('/ship/') ? src : '';
          sheet.key = ship || id + ':' + n;
          if (!requested.has(sheet.key)) {
            requested.add(sheet.key);
            void window.anchorExactPage(id, n, ship);
          }
        } else {
          const svg = div.querySelector(':scope > svg:not(.tdom-canonical-delta)');
          if (svg) {
            const old = lists.get(svg);
            if (!old || old.epoch !== div.provisionalEpoch) {
              const tokens = tokenRows([...svg.querySelectorAll('text[data-src]')].map(node => ({
                y: Number(node.getAttribute('y')), x: Number(node.getAttribute('x')), text: node.textContent,
              })));
              lists.set(svg, { epoch: div.provisionalEpoch, tokens });
            }
            const svgBox = svg.getBoundingClientRect();
            Object.assign(sheet, { top: svgBox.top, height: svgBox.height,
              paper: svg.viewBox.baseVal.height, tokens: lists.get(svg).tokens });
          }
        }
        visible.push(sheet);
      }
      frames.push({ time, scroll: pane.scrollTop, visible, zoom, canonical: canonical?.rev, applied: appliedSrcRev });
      requestAnimationFrame(tick);
    }
    requestAnimationFrame(tick);
    window.anchorTrace = [];
    const trace = (event, values) => anchorTrace.push({ time: performance.now(), event, ...values });
    const identity = anchor => anchor && { kind: anchor.kind, page: anchor.page, src: anchor.src,
      row: anchor.line, text: anchor.content?.text.slice(0, 36), baseline: anchor.baseline };
    const capture = captureViewAnchor;
    captureViewAnchor = (...args) => {
      const held = { jump: viewAnchorHolds.jump(), handoff: viewAnchorHolds.handoff(), editor: !!directEditor };
      const anchor = capture(...args);
      trace('capture', { ...held, anchor: identity(anchor), touched: args[0]?.size });
      return anchor;
    };
    const keep = keepViewAnchorLine;
    keepViewAnchorLine = (anchor, committing, ready) => {
      const stages = keep(anchor, committing, ready);
      if (anchor) trace('stage', { before: committing.map(stage => stage.dl.page),
        after: stages.map(stage => stage.dl.page), waiting: viewAnchorWait?.key });
      return stages;
    };
    const scroll = scrollViewAnchor;
    scrollViewAnchor = (anchor, now) => {
      const delta = scroll(anchor, now);
      trace('restore', { anchor: identity(anchor),
        now: now && { page: now.page, top: now.top, bottom: now.bottom, baseline: now.baseline, exact: now.exact },
        delta });
      return delta;
    };
    const commit = tryCommitProvisionalStages;
    tryCommitProvisionalStages = (...args) => {
      const start = performance.now();
      const before = anchorTrace.length;
      const result = commit(...args);
      if (anchorTrace.length !== before) trace('commit', { ms: performance.now() - start, sourceRev: appliedSrcRev });
      return result;
    };
  })()`);
  const frames = () => frame.evaluate(() => window.anchorFrames.splice(0));
  const locate = async (sample, wanted) => {
    const tokens = [];
    for (const sheet of sample.visible) {
      const values = sheet.tokens ?? (sheet.key && await exactPages.get(sheet.key));
      if (!values || !sheet.paper) continue;
      assert.ok(!values.error, values.error);
      for (const [token, baseline] of Object.entries(values)) {
        if (wanted && token !== wanted) continue;
        tokens.push({ token, page: sheet.n, y: sheet.top + baseline * sheet.height / sheet.paper, layer: sheet.key || 'resident' });
      }
    }
    return tokens;
  };
  const fitPx = width - 40;
  await post('paper-width', { fitPx, paperPx: fitPx });
  return { page, frame, post, snapshot, settled, frames, locate, missing, errors, fitPx };
}

async function canonicalAt(request, rev, error = false) {
  return until(async () => {
    const doc = await request('/doc');
    const c = doc.canonical;
    if (!error && c?.error && c.errorRev === rev) assert.fail(JSON.stringify(c.error));
    return (error ? c?.error && c.errorRev === rev : c?.id && c.rev === rev && !c.error) && doc;
  }, 'canonical did not reach revision ' + rev);
}

async function handoff(view, place, token) {
  await view.post('goto-sync', { x: 0, blockHeight: 0, marker: false, viewportToken: token, ...place });
  await view.settled(null, token);
  await view.post('handoff-done');
}

async function readingPosition(view) {
  await handoff(view, { page: 7, y: 385, blockY: 385 }, 'reader');
  const frame = (await view.frames()).at(-1);
  const reading = (await view.locate(frame)).filter(point => point.page === 7)
    .sort((a, b) => Math.abs(a.y - 425) - Math.abs(b.y - 425))[0];
  assert.ok(reading, 'a measurable token in the middle of page 7');
  const scroll = dy => view.frame.evaluate(dy => { document.getElementById('pages').scrollTop += dy; }, dy);
  await scroll(73);
  await sleep(90);
  const moved = (await view.locate((await view.frames()).at(-1), reading.token))[0];
  assert.ok(moved && Math.abs(moved.y - reading.y + 73) < 0.1, 'token reader measures a known 73px scroll');
  await scroll(-73);
  await sleep(90);
  return reading;
}

async function measure(view, reading, action, name, request) {
  const previous = (await view.frames()).at(-1);
  assert.ok(previous, 'baseline animation frame for ' + name);
  const before = (await view.locate(previous, reading.token))[0];
  assert.ok(before, 'baseline token for ' + name);
  const start = Date.now();
  const report = await action();
  const editMs = Date.now() - start;
  const { canonical } = await canonicalAt(request, report.srcRev);
  await view.settled(report.srcRev);
  await until(() => view.frame.evaluate(rev => {
    const pane = document.getElementById('pages').getBoundingClientRect();
    return [...document.querySelectorAll('#pages > .page.is-final')].some(page => {
      const box = page.getBoundingClientRect();
      return box.bottom > pane.top && box.top < pane.bottom && Number(page.dataset.canonPresentedRev) === rev;
    });
  }, report.srcRev), 'the canonical revision was not presented');
  await sleep(200);
  const frames = await view.frames();
  const motion = [];
  for (const frame of frames) {
    const after = (await view.locate(frame, reading.token))[0];
    motion.push({ time: rounded(frame.time - previous.time), dy: after ? rounded(after.y - before.y) : null,
      scroll: frame.scroll - previous.scroll, layer: after?.layer, zoom: frame.zoom, canonical: frame.canonical, applied: frame.applied });
  }
  assert.ok(motion.length > 2, 'sampled animation frames for ' + name);
  const bad = motion.filter(point => point.dy == null || Math.abs(point.dy) > 2);
  const last = motion.at(-1);
  const transitions = motion.filter((point, i) => {
    const previous = motion[i - 1];
    return !previous || ['dy', 'scroll', 'layer', 'canonical'].some(key => point[key] !== previous[key]);
  });
  return { name, token: reading.token, startedAt: previous.time, editMs, displacement: last.dy, scrollDelta: last.scroll,
    movedFrames: bad.length, zoomChanged: motion.some(point => point.zoom !== previous.zoom),
    exactAfter: last.layer?.startsWith(canonical.id + ':') === true, transitions, motion };
}

async function canonicalTokenPlace(request, token, near) {
  const { canonical } = await request('/doc');
  const pages = Array.from({ length: canonical.pageCount }, (_, i) => i + 1)
    .sort((a, b) => Math.abs(a - near) - Math.abs(b - near));
  for (const n of pages) {
    if (n > canonical.pageCount) continue;
    const { glyphs } = await request('/canonical/glyphs?c=' + canonical.id + '&page=' + n);
    const rows = tokenRows(glyphs.map(g => ({ y: g.baseline, x: g.left, text: g.text })));
    const y = rows[token];
    if (y === undefined) continue;
    return { page: n, x: 0, y, blockY: y, blockHeight: 0, rev: canonical.rev };
  }
  assert.fail('could not locate ' + token + ' in the canonical PDF');
}
async function positionToken(view, request, reading) {
  const { rev, ...point } = await canonicalTokenPlace(request, reading.token, 7);
  await handoff(view, { ...point, y: point.y + 4, blockY: point.y + 4 }, 'reader-' + rev);
  await sleep(250);
}

async function jump(view, request, source, filePath, token, live, fallback) {
  const doc = await request('/doc');
  const offset = source.indexOf(token);
  assert.ok(offset >= 0, 'Jump token exists in the source');
  const sourceLine = source.slice(0, offset).split('\n').length;
  const payload = { ...fallback, sourceFile: filePath, sourceLine };
  if (live) {
    const hit = await request('/synctex/jump', { file: filePath, line: sourceLine,
      documentEpoch: doc.documentEpoch, srcRev: doc.layoutSrcRev });
    assert.ok(hit.boxes?.length, 'real current Jump position');
    const top = Math.min(...hit.boxes.map(box => box.top));
    const bottom = Math.max(...hit.boxes.map(box => box.bottom));
    Object.assign(payload, { page: hit.page, y: (top + bottom) / 2, blockY: top, blockHeight: bottom - top,
      liveRevision: { documentEpoch: hit.documentEpoch, srcRev: hit.srcRev, canonicalId: hit.id } });
  }
  await until(async () => (await view.snapshot())?.srcRev === doc.layoutSrcRev, 'Jump source revision was not applied');
  const previous = (await view.frames()).at(-1);
  await view.post('goto-sync', payload);
  await canonicalAt(request, doc.layoutSrcRev);
  await view.settled(doc.layoutSrcRev);
  await sleep(1450);
  const frames = [previous, ...await view.frames()];
  const steps = [];
  for (let i = 1; i < frames.length; i++) {
    const scroll = frames[i].scroll - frames[i - 1].scroll;
    if (Math.abs(scroll) <= 2) continue;
    const before = (await view.locate(frames[i - 1], token))[0]?.y ?? null;
    const after = (await view.locate(frames[i], token))[0]?.y ?? null;
    steps.push({ scroll, before, after, ms: rounded(frames[i].time - previous.time) });
  }
  const movements = steps.filter(step => step.before == null || step.after == null || Math.abs(step.after - step.before) > 2);
  const target = (await view.locate(frames.at(-1), token))[0];
  return { live, token, steps, movements: movements.length, y: target?.y ?? null };
}

async function resetHandoff(view, request, reading, changePreamble) {
  const previous = (await view.frames()).at(-1);
  const before = (await view.locate(previous, reading.token))[0];
  assert.ok(before, 'reset token was in sight');
  const sheet = previous.visible.find(sheet => sheet.n === before.page);
  const y = (before.y + 4 - sheet.top) * sheet.paper / sheet.height;
  await handoff(view, { page: before.page, y, blockY: y }, 'before-reset');
  const center = (await view.snapshot()).viewportCenter;
  const original = (await view.locate((await view.frames()).at(-1), reading.token))[0];
  await view.page.evaluate(() => { window.pendingReset = null; });
  const editing = changePreamble();
  const reset = await until(() => view.page.evaluate(() => window.pendingReset), 'preamble edit did not start a reset');
  await view.post('reset-ack', { documentEpoch: reset.documentEpoch });
  const { srcRev } = await editing;
  await canonicalAt(request, srcRev);
  await until(async () => (await view.snapshot())?.documentEpoch === reset.documentEpoch, 'frame did not adopt reset');
  const { source, ...point } = center;
  await view.post('paper-width', { fitPx: view.fitPx, paperPx: center.paperPx });
  await handoff(view, { ...point, blockY: point.y, sourceFile: source?.file, sourceLine: source?.line,
    sourceFraction: source?.fraction, sourceAnchor: source?.text ? source : undefined }, 'after-reset');
  await sleep(200);
  const final = (await view.locate((await view.frames()).at(-1), reading.token))[0];
  return { source, fromPage: original?.page, toPage: final?.page, dy: final && original ? rounded(final.y - original.y) : null };
}

test('the real embed keeps the reader line through edits above it', { timeout: full ? 420_000 : 130_000 }, async t => {
  let chromium;
  try { ({ chromium } = hostRequire('playwright')); } catch { return t.skip('Playwright unavailable'); }
  if (!existsSync(path.join(fixture, 'main.tex'))) return t.skip('TeX64 jdoc fixture unavailable');
  if (spawnSync('lualatex', ['--version'], { stdio: 'ignore' }).status !== 0) return t.skip('LuaLaTeX unavailable');
  let browser;
  try {
    browser = await chromium.launch({ headless: true,
      ...(process.env.TDOM_ANCHOR_SINGLE_PROCESS === '1' && { args: ['--single-process', '--no-zygote', '--in-process-gpu'] }) });
  } catch (error) { return t.skip('Chromium unavailable (' + error.message.split('\n')[0] + ')'); }
  t.after(() => browser.close());
  mkdirSync(scratch, { recursive: true });
  const project = mkdtempSync(path.join(scratch, 'run-'));
  const { origin, request } = await boot(t, project);
  t.diagnostic('measurements and server log in ' + project);
  const original = readFileSync(path.join(fixture, 'main.tex'), 'utf8');
  const sourceDir = path.join(project, 'doc');
  const filePath = path.join(sourceDir, 'main.tex');
  mkdirSync(path.join(sourceDir, 'ch'), { recursive: true });
  writeFileSync(path.join(sourceDir, 'ch/one.tex'), readFileSync(path.join(fixture, 'ch/one.tex')));
  let source = original;
  const exactPages = new Map();
  async function edit(start, end, text) {
    assert.ok(start >= 0 && end >= start);
    const next = source.slice(0, start) + text + source.slice(end);
    const report = await request('/edit', { start, end, text, slim: true, clientEditAtEpochMs: Date.now() });
    source = next;
    return report;
  }
  const results = [];
  const save = () => writeFileSync(path.join(project, 'measurements.json'), JSON.stringify(results, null, 2));
  const context = await browser.newContext();
  for (const width of widths) {
    source = original;
    writeFileSync(filePath, source);
    const open = await request('/open', { text: source, filePath, projectRoot: sourceDir });
    const view = await openFrame(context, { origin, request }, width, exactPages);
    try {
      t.diagnostic(JSON.stringify({ open: open.layoutSrcRev, mode: open.mode, policy: open.previewPolicy, canonical: open.canonical }));
      await canonicalAt(request, open.layoutSrcRev);
      const started = Date.now();
      const widthResults = [];
      const logs = { width, results: widthResults, trace: [], missing: view.missing, errors: view.errors };
      results.push(logs);
      const add = async resultPromise => {
        const result = await resultPromise;
        widthResults.push(result);
        const { motion, ...summary } = result;
        t.diagnostic(JSON.stringify({ width, ...summary }));
        logs.trace = await view.frame.evaluate(() => window.anchorTrace);
        save();
      };
      const reading = await readingPosition(view);
      const p5 = await request('/canonical/glyphs?c=' + (await request('/doc')).canonical.id + '&page=5');
      const tokens = tokenRows(p5.glyphs.map(g => ({ y: g.baseline, x: g.left, text: g.text })));
      const above = Object.keys(tokens)[0];
      assert.ok(above && above !== reading.token);
      let insert = source.indexOf('\n', source.indexOf(above));
      const keyTimes = [];
      const typed = await measure(view, reading, async () => {
        let report;
        for (const char of '。これは追記した文です。紙面の行がどう変わるかを確かめます。') {
          const start = Date.now();
          report = await edit(insert, insert, char);
          insert++;
          const elapsed = Date.now() - start;
          keyTimes.push(elapsed);
          await sleep(Math.max(0, 80 - elapsed));
        }
        return report;
      }, 'typing above', request);
      typed.keyTimes = keyTimes;
      await add(typed);
      const paragraph = '\n\n' + 'この段落を追加して、読み手の位置が保たれることを確かめる。'.repeat(4) + '\n\n';
      const index = source.lastIndexOf('\n\n', source.indexOf(above)) + 2;
      await positionToken(view, request, reading);
      await add(measure(view, reading, () => edit(index, index, paragraph), 'paragraph above', request));
      if (full) {
        await positionToken(view, request, reading);
        const block = '\\clearpage\n\n' + ('追加した紙面。'.repeat(24) + '\n\n').repeat(18) + '\\clearpage\n\n';
        await add(measure(view, reading, () => edit(index, index, block), 'page-sized block above', request));
        await positionToken(view, request, reading);
        const paragraphStart = source.lastIndexOf('\n\n', source.indexOf(above)) + 2;
        const paragraphEnd = source.indexOf('\n\n', source.indexOf(above)) + 2;
        assert.ok(paragraphStart > index && paragraphEnd > paragraphStart);
        await add(measure(view, reading, () => edit(paragraphStart, paragraphEnd, ''), 'delete paragraph above', request));
        if (width === widths.at(-1) && process.env.TDOM_ANCHOR_CHECKS !== '0') {
          await handoff(view, { page: 2, y: 400, blockY: 400 }, 'before-jumps');
          const { rev: fallbackRev, ...fallback } = await canonicalTokenPlace(request, 'Qz078', 7);
          const paste = await edit(index, index, block);
          logs.jumpAfterPaste = await jump(view, request, source, filePath, 'Qz078', false, fallback);
          save();
          logs.jumpWithRevision = await jump(view, request, source, filePath, 'Qz022', true, fallback);
          assert.ok(paste.srcRev > fallbackRev);
          save();
          const undoPlace = await canonicalTokenPlace(request, 'Qz119', 11);
          const invalid = '\\tdomUndefinedControlSequence ';
          const error = await edit(index, index, invalid);
          await canonicalAt(request, error.srcRev, true);
          const undo = await edit(index, index + invalid.length, '');
          logs.jumpAfterUndo = await jump(view, request, source, filePath, 'Qz119', false, undoPlace);
          const undoState = await view.settled(undo.srcRev);
          logs.pendingAfterUndo = undoState.presentationPending;
          await view.page.locator('iframe').evaluate(frame => { frame.style.visibility = 'hidden'; });
          await sleep(450);
          const hiddenCount = await view.page.evaluate(() => window.snapshotCount);
          await view.page.locator('iframe').evaluate(frame => { frame.style.visibility = ''; });
          await until(() => view.page.evaluate(count => window.snapshotCount > count, hiddenCount), 'no snapshot after showing the frame');
          const shown = await view.settled(undo.srcRev);
          logs.pendingAfterShow = shown.presentationPending;
          save();
          await positionToken(view, request, reading);
          const preamble = source.indexOf('\\begin{document}');
          logs.reset = await resetHandoff(view, request, reading,
            () => edit(preamble, preamble, '\\addtolength{\\textheight}{-83pt}\n'));
          const visibleEdit = source.indexOf(reading.token) + reading.token.length;
          const inView = await measure(view, reading, () => edit(visibleEdit, visibleEdit, ' 読み進める行を編集中。'),
            'edit line in view', request);
          logs.inViewScroll = [...new Set(inView.motion.map(point => point.scroll).filter(delta => delta !== 0))];
          save();
          let pageNumber = 2;
          while (Date.now() - started < Number(process.env.TDOM_ANCHOR_SOAK_MS ?? 180_000)) {
            await view.post('goto-page', { page: pageNumber });
            await sleep(4000);
            pageNumber = pageNumber % 12 + 1;
            await view.frames();
          }
          t.diagnostic(JSON.stringify({ width, jumps: [logs.jumpAfterPaste, logs.jumpWithRevision, logs.jumpAfterUndo],
            pasteRev: paste.srcRev, reset: logs.reset, pendingAfterUndo: logs.pendingAfterUndo,
            pendingAfterShow: logs.pendingAfterShow, inViewScroll: logs.inViewScroll,
            sweepMs: Date.now() - started, missing: view.missing }));
          if (!record) {
            for (const movement of [logs.jumpAfterPaste, logs.jumpWithRevision, logs.jumpAfterUndo]) {
              assert.ok(movement.movements >= 1 && movement.movements <= (movement.live ? 1 : 2), JSON.stringify(movement));
              assert.ok(movement.steps[0]?.ms <= 1500, JSON.stringify(movement));
              assert.ok(movement.y > 125 && movement.y < 725, JSON.stringify(movement));
            }
            assert.ok(logs.reset.dy != null && Math.abs(logs.reset.dy) <= 3, JSON.stringify(logs.reset));
            assert.notEqual(logs.reset.fromPage, logs.reset.toPage, 'the preamble edit repaginates the reader text');
            assert.deepEqual(logs.inViewScroll, [], 'the frame did not scroll while the edit line was in view');
            assert.deepEqual(view.missing, [], 'no frame request returned 404');
          }
        }
      }

      t.diagnostic(JSON.stringify({ width, ...reading, above, missing: view.missing, errors: view.errors }));
      if (!record) for (const event of widthResults) {
        assert.equal(event.movedFrames, 0, event.name + ' moved the reader token: ' + JSON.stringify(event.motion.filter(point => point.dy == null || Math.abs(point.dy) > 2).slice(0, 5)));
        assert.ok(event.exactAfter, event.name + ' did not show the token on the new exact page');
        assert.ok(!event.zoomChanged, event.name + ' changed zoom');
      }
    } finally {
      if (results.at(-1)?.width === width) results.at(-1).trace = await view.frame.evaluate(() => window.anchorTrace);
      save();
      await view.page.close();
    }
  }
});

test('an edit in the live chapter keeps the reader on outer Build paper on both sides', { timeout: 90000 }, async t => {
  let chromium;
  try { ({ chromium } = hostRequire('playwright')); } catch { return t.skip('Playwright unavailable'); }
  if (spawnSync('lualatex', ['--version'], { stdio: 'ignore' }).status !== 0) return t.skip('LuaLaTeX unavailable');
  let browser;
  try {
    browser = await chromium.launch({ headless: true,
      ...(process.env.TDOM_ANCHOR_SINGLE_PROCESS === '1' && { args: ['--single-process', '--no-zygote', '--in-process-gpu'] }) });
  } catch (error) { return t.skip('Chromium unavailable (' + error.message.split('\n')[0] + ')'); }
  t.after(() => browser.close());
  const scratchR10 = process.env.TDOM_ANCHOR_SCRATCH || path.join(host, 'testing/codex-sol-20261126/scratch-viewer-r10');
  mkdirSync(scratchR10, { recursive: true });
  const project = mkdtempSync(path.join(scratchR10, 'outer-'));
  const sourceDir = path.join(project, 'doc');
  mkdirSync(sourceDir);
  const filePath = path.join(sourceDir, 'main.tex');
  const chapter = path.join(sourceDir, 'chapter.tex');
  const before = path.join(sourceDir, 'before.tex');
  const after = path.join(sourceDir, 'after.tex');
  const source = String.raw`\documentclass{article}
\begin{document}
\input{before}
\input{chapter}
\clearpage
\input{after}
\end{document}`;
  const prose = 'Original chapter paragraph on the open sheet.\n';
  writeFileSync(filePath, source);
  writeFileSync(chapter, prose);
  writeFileSync(before, Array.from({ length: 10 }, (_, i) => `Build sheet ${i + 1}.\\clearpage\n`).join(''));
  writeFileSync(after, Array.from({ length: 4 }, (_, i) => `Build sheet ${i + 12}.\\clearpage\n`).join(''));
  assert.equal(spawnSync('lualatex', ['-interaction=batchmode', '-halt-on-error', 'main.tex'], { cwd: sourceDir }).status, 0);
  const { origin, request } = await boot(t, project);
  const opened = await request('/open', { filePath, projectRoot: sourceDir, text: source,
    overlays: [before, after].map(filePath => ({ filePath, text: '' })) });
  const context = await browser.newContext();
  const view = await openFrame(context, { origin, request }, 500, new Map());
  await canonicalAt(request, opened.layoutSrcRev);
  await view.settled(opened.layoutSrcRev);
  await request('/outer', { pdfPath: path.join(sourceDir, 'main.pdf'), pages: 15, before: 10, afterFrom: 12 });
  await view.frame.evaluate(() => pollStatus());
  const read = () => view.frame.evaluate(() => {
    const pane = pagesEl.getBoundingClientRect();
    const at = document.elementFromPoint(pane.left + pagesEl.clientWidth / 2, pane.top + pagesEl.clientHeight / 2)
      ?.closest('.page,.outer-page');
    return { top: pagesEl.scrollTop, sheet: at?.dataset.sheet ?? at?.dataset.page, outer: at?.classList.contains('outer-page') };
  });
  for (const sheet of [3, 14]) {
    await view.frame.evaluate(sheet => {
      const el = sheet <= 10 ? outerBeforeEl.children[sheet - 1] : outerAfterEl.children[sheet - 12];
      const pane = pagesEl.getBoundingClientRect();
      const box = el.getBoundingClientRect();
      pagesEl.scrollTop += box.top + box.height / 2 - pane.top - pagesEl.clientHeight / 2;
    }, sheet);
    const start = await read();
    assert.equal(start.sheet, String(sheet));
    assert.equal(start.outer, true);
    const edited = await request('/edit', { start: 0, end: 0, text: '',
      overlays: [{ filePath: chapter, text: prose.replace('Original', `Edited from sheet ${sheet} in the`) }], slim: true });
    const samples = [];
    for (let i = 0; i < 6; i++) { samples.push(await read()); await sleep(100); }
    await canonicalAt(request, edited.srcRev);
    await view.settled(edited.srcRev);
    samples.push(await read());
    t.diagnostic(JSON.stringify({ start, end: samples.at(-1) }));
    assert.ok(samples.every(sample => sample.outer && sample.sheet === start.sheet && Math.abs(sample.top - start.top) <= 2),
      JSON.stringify(samples));
  }
});

test('embedded Cmd-click maps the older exact paper to both current source lines', { timeout: 90_000 }, async t => {
  let chromium;
  try { ({ chromium } = hostRequire('playwright')); } catch { return t.skip('Playwright unavailable'); }
  if (spawnSync('lualatex', ['--version'], { stdio: 'ignore' }).status !== 0) return t.skip('LuaLaTeX unavailable');
  let browser;
  try {
    browser = await chromium.launch({ headless: true,
      ...(process.env.TDOM_ANCHOR_SINGLE_PROCESS === '1' && { args: ['--single-process', '--no-zygote', '--in-process-gpu'] }) });
  } catch (error) { return t.skip('Chromium unavailable (' + error.message.split('\n')[0] + ')'); }
  t.after(() => browser.close());
  mkdirSync(scratch, { recursive: true });
  const project = mkdtempSync(path.join(scratch, 'kept-click-'));
  const filePath = path.join(project, 'main.tex');
  const source = String.raw`\documentclass{article}
\begin{document}
Opening paragraph.

A movable paragraph.

\clearpage

\begin{enumerate}
\item Qz009 Please show your work for this problem.
% Existing rubric line.
\item Qz011 Please show your work for this problem.
\item Qz013 Please show your work for this problem.
\item Please check the units.
\item Please check the units.
\end{enumerate}
\clearpage
\input{child}
\end{document}
`;
  const childFile = path.join(project, 'child.tex');
  const childSource = 'Qz021 First child exercise.\n\nQz023 Second child exercise.\n';
  writeFileSync(childFile, childSource);
  writeFileSync(filePath, source);
  const { origin, request } = await boot(t, project);
  const opened = await request('/open', { filePath, projectRoot: project, text: source });
  const context = await browser.newContext();
  const view = await openFrame(context, { origin, request }, 650, new Map());
  const { canonical } = await canonicalAt(request, opened.layoutSrcRev);
  await handoff(view, { page: 2, y: 150, blockY: 150 }, 'before-kept-click');
  const sheet = view.frame.locator('#pages > .page[data-page="2"]');
  const openingPaper = await until(() => sheet.evaluate(el => el.classList.contains('is-final') &&
    el.querySelector('img.canon')?.naturalWidth && el.dataset.canonPresentedSrc), 'the original exact paper');
  const { glyphs } = await request(`/canonical/glyphs?c=${canonical.id}&page=2`);
  const rows = tokenRows(glyphs.map(g => ({ y: g.baseline, x: g.left, text: g.text })));
  await view.page.evaluate(() => {
    window.sourceClicks = [];
    window.addEventListener('message', ({ data }) => {
      if (data?.source === 'tdom-embed' && data.action === 'source') window.sourceClicks.push({ file: data.file, line: data.line });
    });
  });
  const clicks = async () => {
    for (const token of ['Qz011', 'Qz013']) {
      assert.ok(rows[token]);
      const count = await view.page.evaluate(() => window.sourceClicks.length);
      const point = await sheet.evaluate((el, baseline) => {
        const rect = el.getBoundingClientRect();
        return { x: rect.width * 210 / Number(el.dataset.canonPaperW),
          y: rect.height * (baseline - 2) / Number(el.dataset.canonPaperH) };
      }, rows[token]);
      await sheet.click({ position: point, modifiers: ['Meta'] });
      await until(() => view.page.evaluate(n => window.sourceClicks.length > n, count), 'Cmd-click sent a source location', 5000);
    }
    return view.page.evaluate(() => window.sourceClicks.slice(-2));
  };
  const lineFor = token => source.slice(0, source.indexOf(token)).split('\n').length;
  const lines = ['Qz011', 'Qz013'].map(lineFor);
  assert.deepEqual(await clicks(), lines.map(line => ({ file: filePath, line })));
  const requestId = 'kept-click';
  const lease = await until(async () => {
    const reply = await fetch(origin + '/canonical/build-lease/acquire', { method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ requestId, projectRoot: project, mainFile: filePath, ttlMs: 60_000 }) });
    const result = await reply.json();
    if (result.reason === 'preview-work-settling' || result.reason === 'resident-bootstrap-active') return false;
    assert.ok(reply.ok, JSON.stringify(result));
    return result;
  }, 'the Build lease is ready');
  // Hold the decoded sheet across the edits so each gesture addresses the
  // same physical ink even if a resident replacement is ready first.
  await view.frame.evaluate(() => {
    const update = updateCanonState;
    const commit = tryCommitProvisionalStages;
    const retire = retireDisplacedPaper;
    window.resumeClickPaint = () => {
      updateCanonState = update;
      tryCommitProvisionalStages = commit;
      retireDisplacedPaper = retire;
    };
    updateCanonState = page => { if (page !== 2) update(page); };
    tryCommitProvisionalStages = () => {};
    retireDisplacedPaper = (page, ...args) => { if (page.dataset.page !== '2') retire(page, ...args); };
  });
  let current = source;
  try {
    const rubric = '% Award one mark for the method.\n% Accept equivalent forms.\n% Give partial credit for units.\n% Check the final sign.\n';
    const withRubric = source.replace('\\item Qz011', rubric + '\\item Qz011');
    const apply = async text => {
      const edit = await request('/edit', { start: 0, end: current.length, text, slim: true });
      current = text;
      await until(() => view.frame.evaluate(rev => appliedSrcRev === rev, edit.srcRev), 'the edited source reached the frame');
    };
    const checkClicks = async () => {
      assert.ok(await sheet.evaluate(el => el.classList.contains('is-final')), 'the clicked paper is actually showing');
      assert.equal(await sheet.evaluate(el => el.dataset.canonPresentedSrc), openingPaper);
      assert.deepEqual(await clicks(), ['Qz011', 'Qz013'].map(token => ({
        file: filePath, line: current.split('\n').findIndex(line => !line.trimStart().startsWith('%') && line.includes(token)) + 1,
      })));
    };
    await t.test('insert four rubric comments inside the list', async () => {
      await apply(withRubric);
      await checkClicks();
    });
    await t.test('delete a line inside the surviving list', async () => {
      await apply(source.replace('% Existing rubric line.\n', ''));
      const box = (await request('/canonical/boxes?c=' + canonical.id)).pages[1].find(box => box.text === 'Qz011');
      assert.ok(box);
      const hit = await request('/synctex', { id: canonical.id, displayedSourceRev: canonical.rev, page: 2,
        x: (box.left + box.right) / 2, y: (box.top + box.bottom) / 2 });
      assert.equal(hit.line, lines[0] - 1);
      await checkClicks();
    });
    await t.test('move a paragraph above the clicked block', async () => {
      await apply(withRubric.replace('Opening paragraph.\n\nA movable paragraph.', 'A movable paragraph.\n\nOpening paragraph.'));
      await checkClicks();
      const boxes = (await request('/canonical/boxes?c=' + canonical.id)).pages[0];
      const box = boxes.find(box => box.text === 'movable');
      assert.ok(box);
      const moved = await request('/synctex', { id: canonical.id, displayedSourceRev: canonical.rev, page: 1,
        x: (box.left + box.right) / 2, y: (box.top + box.bottom) / 2 });
      assert.equal(moved.line, 3);
    });
    await t.test('preserve the two occurrences of identical exercise lines', async () => {
      await apply(withRubric.replace('\\item Please check the units.', '% Marker A\n\\item Please check the units.')
        .replace('units.\n\\item Please check', 'units.\n% Marker B\n\\item Please check'));
      const boxes = (await request('/canonical/boxes?c=' + canonical.id)).pages[1].filter(box => box.text === 'units.');
      assert.equal(boxes.length, 2);
      const hits = [];
      for (const box of boxes) hits.push(await request('/synctex', {
        id: canonical.id, displayedSourceRev: canonical.rev, page: 2,
        x: (box.left + box.right) / 2, y: (box.top + box.bottom) / 2,
      }));
      assert.deepEqual(hits.map(hit => hit.line), current.split('\n')
        .flatMap((line, i) => line === '\\item Please check the units.' ? [i + 1] : []));
    });
    await t.test('map a click in the edited child against its own source', async () => {
      const text = '% Child-only rubric.\n% Second note.\n' + childSource;
      await request('/edit', { start: 0, end: 0, text: '', overlays: [{ filePath: childFile, text }], slim: true });
      const box = (await request('/canonical/boxes?c=' + canonical.id)).pages[2].find(box => box.text === 'Qz023');
      assert.ok(box);
      const hit = await request('/synctex', { id: canonical.id, displayedSourceRev: canonical.rev, page: 3,
        x: (box.left + box.right) / 2, y: (box.top + box.bottom) / 2 });
      assert.deepEqual({ file: hit.file, line: hit.line }, { file: childFile, line: 5 });
    });
    await t.test('a changed trailing marking note keeps the printed exercise addressable', async () => {
      await apply(withRubric.replace('Qz011 Please show your work for this problem.',
        'Qz011 Please show your work for this problem. % Award a method mark here.'));
      await checkClicks();
    });
    await t.test('label and indentation edits keep the same mounted glyphs clickable', async () => {
      for (const text of [
        source.replace('Qz011 Please show your work for this problem.', '$&\\label{exercise:eleven}'),
        source.replace('\\item Qz011', '\t  $&'),
      ]) {
        await apply(text);
        await checkClicks();
      }
      await apply(source.replace('Qz011 Please show your work', 'Qz011 Please show\nyour work'));
      assert.ok(await sheet.evaluate(el => el.classList.contains('is-final')));
      assert.equal(await sheet.evaluate(el => el.dataset.canonPresentedSrc), openingPaper);
      const boxes = (await request('/canonical/boxes?c=' + canonical.id)).pages[1];
      const box = boxes.filter(box => box.text === 'work')[1];
      assert.ok(box);
      const count = await view.page.evaluate(() => window.sourceClicks.length);
      await sheet.click({ position: await sheet.evaluate((el, box) => {
        const rect = el.getBoundingClientRect();
        return { x: rect.width * (box.left + box.right) / (2 * Number(el.dataset.canonPaperW)),
          y: rect.height * (box.top + box.bottom) / (2 * Number(el.dataset.canonPaperH)) };
      }, box), modifiers: ['Meta'] });
      await until(() => view.page.evaluate(n => window.sourceClicks.length > n, count), 'rewrapped click navigation', 5000);
      assert.deepEqual(await view.page.evaluate(() => window.sourceClicks.at(-1)), { file: filePath, line: lines[0] + 1 });
    });
    await t.test('a physical Cmd-click skips the commented draft above the labelled question', async () => {
      await apply(source.replace(/(\\item Qz011[^\n]+)/, '% $1\n$1\\label{exercise:eleven}'));
      await checkClicks();
      const boxes = (await request('/canonical/boxes?c=' + canonical.id)).pages[1];
      const box = boxes.find(box => box.text === 'Qz011');
      const hit = await request('/synctex', { id: canonical.id, displayedSourceRev: canonical.rev, page: 2,
        x: (box.left + box.right) / 2, y: (box.top + box.bottom) / 2 });
      assert.equal(hit.line, lines[0] + 1);
      assert.match(hit.lineText, /^\\item Qz011.*\\label/);
    });
    await t.test('swapped and indented exercise lines keep their own retained ink', async () => {
      await apply(source.replace(/(\\item Qz011[^\n]+)\n(\\item Qz013[^\n]+)/, '  $2\n  $1'));
      await checkClicks();
    });
    await t.test('an older resident block with no word evidence navigates to its opening ink', async () => {
      await apply(withRubric);
      const target = await sheet.evaluate((el, line) => {
        const state = presentedPageState(el);
        const block = state.snapshot.blocks.find(({ source }) => source?.start?.line <= line && source?.end?.line >= line);
        const node = document.createElement('span');
        node.id = 'older-resident-hit';
        node.dataset.src = block.id;
        node.dataset.line = String(line - block.source.start.line);
        el.provisionalSnapshot = state.snapshot;
        el.classList.remove('is-final');
        el.append(node);
        return { id: node.id };
      }, lines[0]);
      const count = await view.page.evaluate(() => window.sourceClicks.length);
      try {
        await view.frame.locator('#' + target.id).dispatchEvent('click', { metaKey: true });
        await until(() => view.page.evaluate(n => window.sourceClicks.length > n, count), 'resident click navigation', 5000);
        assert.deepEqual(await view.page.evaluate(() => window.sourceClicks.at(-1)),
          { file: filePath, line: current.split('\n').findIndex(line => line.startsWith('\\item Qz009')) + 1 });
      } finally {
        await sheet.evaluate((el, id) => {
          document.getElementById(id)?.remove();
          el.classList.add('is-final');
        }, target.id);
      }
    });
    await t.test('an older ordinary exact page can be clicked without a retained block snapshot', async () => {
      await apply(withRubric);
      const oldKey = await sheet.evaluate(el => {
        const key = presentedSnapshotKey(el.dataset.canonPresentedId, el.dataset.canonPresentedRev);
        presentedDomSnapshots.delete(key);
        return el.dataset.canonPresentedSrc;
      });
      assert.equal(oldKey, openingPaper);
      await checkClicks();
    });
  } finally {
    await view.frame.evaluate(() => window.resumeClickPaint());
    await request('/canonical/build-lease/release', { requestId, token: lease.token });
  }
  await t.test('current canonical clicks keep their existing refinement', async () => {
    const fresh = await until(async () => {
      const status = await request('/status');
      return status.canonical?.rev === status.srcRev && status.canonical.id !== canonical.id && status.canonical;
    }, 'the current generation');
    const box = (await request('/canonical/boxes?c=' + fresh.id)).pages[1].find(box => box.text === 'Qz011');
    assert.ok(box);
    const params = { id: fresh.id, page: 2, x: (box.left + box.right) / 2, y: (box.top + box.bottom) / 2 };
    const existing = await request('/synctex', params);
    const fromFrame = await request('/synctex', { ...params, displayedSourceRev: fresh.rev });
    assert.equal(fromFrame.line, current.slice(0, current.indexOf('Qz011')).split('\n').length);
    assert.deepEqual(fromFrame, existing);
  });
});

test('retained resident text uses its painted word and its own source snapshot', { timeout: 90_000 }, async t => {
  let chromium;
  try { ({ chromium } = hostRequire('playwright')); } catch { return t.skip('Playwright unavailable'); }
  let browser;
  try {
    browser = await chromium.launch({ headless: true,
      ...(process.env.TDOM_ANCHOR_SINGLE_PROCESS === '1' && { args: ['--single-process', '--no-zygote', '--in-process-gpu'] }) });
  } catch (error) { return t.skip('Chromium unavailable (' + error.message.split('\n')[0] + ')'); }
  t.after(() => browser.close());
  const project = mkdtempSync(path.join(scratch, 'kept-resident-'));
  const filePath = path.join(project, 'main.tex');
  const source = String.raw`\documentclass{article}
\begin{document}
The opening line is very long. This sentence explains the importance of the first rule in enough detail to occupy much more than a single printed row.
Then the isolated Keyword identifies the second source line.
\end{document}
`;
  writeFileSync(filePath, source);
  const connection = await boot(t, project);
  const { request } = connection;
  const opened = await request('/open', { filePath, projectRoot: project, text: source });
  const context = await browser.newContext();
  await context.route('**/canonical/*.svg?**', route => route.abort());
  const view = await openFrame(context, connection, 650, new Map());
  const sheet = view.frame.locator('#pages > .page[data-page="1"]');
  await until(() => sheet.evaluate((el, rev) => !el.classList.contains('is-final') &&
    Number(el.provisionalSnapshot?.srcRev) === rev, opened.layoutSrcRev), 'the original resident paper');
  const before = await until(() => sheet.evaluate(el => {
    const rows = new Map();
    for (const node of el.querySelectorAll('svg text[data-src]')) {
      const key = node.getAttribute('y');
      if (!rows.has(key)) rows.set(key, []);
      rows.get(key).push(node);
    }
    for (const row of rows.values()) {
      const glyphs = row.sort((a, b) => Number(a.getAttribute('x')) - Number(b.getAttribute('x')))
        .flatMap(node => [...node.textContent].map((char, index) => ({ node, char, index })));
      const start = glyphs.map(glyph => glyph.char).join('').indexOf('Keyword');
      if (start < 0) continue;
      const { node, index } = glyphs[start + 2];
      const box = node.getExtentOfChar(index);
      const point = new DOMPoint(box.x + box.width / 2, box.y + box.height / 2).matrixTransform(node.getScreenCTM());
      return { x: point.x, y: point.y };
    }
    return null;
  }), 'the printed keyword in the mounted resident SVG', 5000).catch(async error => {
    const ink = await sheet.evaluate(el => ({
      text: el.querySelector('svg')?.textContent,
      inks: el.provisionalDl?.commands.map(({ op, text }) => [op, text]),
    }));
    assert.fail(error.message + ' ' + JSON.stringify(ink));
  });
  await view.frame.evaluate(() => { tryCommitProvisionalStages = () => {}; });
  await view.page.evaluate(() => {
    window.addEventListener('message', ({ data }) => {
      if (data?.source === 'tdom-embed' && data.action === 'source') window.residentClick = data;
    });
  });
  const notes = '% One note\n% Two notes\n% Three notes\n';
  const updated = source.replace('The opening', notes + 'The opening').replace('Then the isolated Keyword', 'Then the isolated\nKeyword');
  const edit = await request('/edit', { start: 0, end: source.length, text: updated, slim: true });
  await until(() => view.frame.evaluate(rev => appliedSrcRev === rev, edit.srcRev), 'the edited text reached the resident frame');
  assert.ok(await sheet.evaluate((el, rev) => !el.classList.contains('is-final') &&
    el.provisionalSnapshot?.srcRev === rev, opened.layoutSrcRev));
  await sheet.evaluate(el => {
    const snapshot = el.provisionalSnapshot;
    el.provisionalSnapshot = { ...snapshot,
      sources: [{ file: '/other-chapter/main.tex', text: 'A different source file.' }, ...snapshot.sources] };
  });
  const reverse = [];
  view.page.on('request', req => {
    if (new URL(req.url()).pathname === '/synctex') reverse.push(req.postDataJSON());
  });
  await view.page.keyboard.down('Meta');
  try {
    await view.page.mouse.click(before.x, before.y);
  } finally {
    await view.page.keyboard.up('Meta');
  }
  const hit = await until(() => view.page.evaluate(() => window.residentClick), 'resident click reached the host', 5000);
  assert.deepEqual({ file: path.resolve(project, hit.file), line: hit.line },
    { file: filePath, line: updated.split('\n').findIndex(line => line.startsWith('Keyword')) + 1 });
  assert.deepEqual(reverse, [], 'resident paper has its own source evidence');
});

for (const ruby of [false, true]) {
  test(`retained tate clicks follow the displayed columns${ruby ? ' with ruby' : ''}`, { timeout: 120_000 }, async t => {
    let chromium;
    try { ({ chromium } = hostRequire('playwright')); } catch { return t.skip('Playwright unavailable'); }
    try {
      const browser = await chromium.launch({ headless: true,
        ...(process.env.TDOM_ANCHOR_SINGLE_PROCESS === '1' && { args: ['--single-process', '--no-zygote', '--in-process-gpu'] }) });
      t.after(() => browser.close());
      const project = mkdtempSync(path.join(scratch, 'kept-tate-'));
      const filePath = path.join(project, 'main.tex');
      const novel = readFileSync(new URL('./fixtures/tate/t01-ltjtarticle.tex', import.meta.url), 'utf8');
      const source = ruby ? novel.replace('\\begin{document}', '\\usepackage{luatexja-ruby}\n\\begin{document}')
        .replace('書生という人間中', '\\ruby{書生}{しょせい}という人間中') : novel;
      writeFileSync(filePath, source);
      const connection = await boot(t, project);
      const { origin, request } = connection;
      const opened = await request('/open', { filePath, projectRoot: project, text: source });
      const { canonical } = await canonicalAt(request, opened.layoutSrcRev);
      const context = await browser.newContext();
      const view = await openFrame(context, connection, 700, new Map());
      const sheet = view.frame.locator('#pages > .page[data-page="1"]');
      const image = await until(() => sheet.evaluate(el => el.classList.contains('is-final') &&
        el.querySelector('img.canon')?.naturalWidth && el.dataset.canonPresentedSrc), 'the opening vertical image');
      assert.equal(Number(await sheet.getAttribute('data-canon-presented-id')), canonical.id);
      const pdf = path.join(project, 'opening.pdf');
      writeFileSync(pdf, Buffer.from(await (await fetch(origin + '/canonical.pdf')).arrayBuffer()));
      const extracted = spawnSync('pdftotext', ['-bbox-layout', pdf, '-'], { encoding: 'utf8' });
      assert.equal(extracted.status, 0, extracted.stderr);
      const rows = parseJumpText(extracted.stdout);
      const needles = ['名前はまだ無い', ruby ? 'という人間中' : '書生という人間中', 'スーと持ち上げ', '薬缶だ'];
      const points = needles.map(needle => {
        const row = rows.find(item => item.direction === 'tate' && item.text.includes(needle));
        assert.ok(row, needle);
        const glyph = row.glyphs[row.text.indexOf(needle) + Math.min(needle.length - 1, ruby ? 3 : 1)].box;
        return { needle, x: (glyph.left + glyph.right) / 2, y: (glyph.top + glyph.bottom) / 2 };
      });
      await view.page.evaluate(() => {
        window.sourceClicks = [];
        window.addEventListener('message', ({ data }) => {
          if (data?.source === 'tdom-embed' && data.action === 'source') window.sourceClicks.push({ file: data.file, line: data.line });
        });
      });
      let current = source;
      const check = async (subset = points) => {
        assert.ok(await sheet.evaluate(el => el.classList.contains('is-final')));
        assert.equal(await sheet.getAttribute('data-canon-presented-src'), image);
        for (const point of subset) {
          const position = await sheet.evaluate((el, point) => {
            const rect = el.getBoundingClientRect();
            return { x: rect.width * point.x / Number(el.dataset.canonPaperW),
              y: rect.height * point.y / Number(el.dataset.canonPaperH) };
          }, point);
          const count = await view.page.evaluate(() => window.sourceClicks.length);
          await sheet.click({ position, modifiers: ['Meta'] });
          await until(() => view.page.evaluate(n => window.sourceClicks.length > n, count), 'tate click navigation', 5000);
          assert.deepEqual(await view.page.evaluate(() => window.sourceClicks.at(-1)),
            { file: filePath, line: current.split('\n').findIndex(line => line.includes(point.needle)) + 1 });
        }
      };
      await check();
      const requestId = 'kept-tate';
      const lease = await until(async () => {
        const response = await fetch(origin + '/canonical/build-lease/acquire', {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ requestId, projectRoot: project, mainFile: filePath, ttlMs: 60_000 }),
        });
        const lease = await response.json();
        return lease.token && lease;
      }, 'the tate Build lease');
      const notes = '% A note 1\n% A note 2\n% A note 3\n';
      const opening = source.replace('\\begin{document}\n', '$&' + notes);
      const addBelow = text => text.replace('\\end{document}', '% End note\n$&');
      const variants = [
        ['insert three comments above the original glyphs', opening],
        ['insert a comment between two paragraphs', opening.replace('しかもあとで', '% Between paragraphs\nしかもあとで')],
        ['insert comments below the original glyphs', addBelow(opening)],
        ['delete the added comments above', addBelow(source)],
        ['delete comments below', source],
        ['append a comment inside a printed paragraph', opening.replace('名前はまだ無い。', '$& % Editor note\n')],
        ['add a label before the clicked paragraphs', opening.replace('\\section{はじめに}', '$&\\label{opening}')],
        ['indent the clicked source paragraph', opening.replace('しかもあとで', '  しかもあとで')],
        ['rewrap a clicked column in the source', opening.replace('第一毛をもって', '第一毛をもって%\n')],
      ];
      try {
        for (const [name, updated] of (ruby ? variants.slice(0, 2) : variants)) {
          await t.test(name, async () => {
            const edit = await request('/edit', { start: 0, end: current.length, text: updated, slim: true });
            current = updated;
            await until(() => view.frame.evaluate(rev => appliedSrcRev === rev, edit.srcRev), 'edited source accepted by the frame');
            await check();
          });
        }
      } finally {
        await request('/canonical/build-lease/release', { requestId, token: lease.token });
      }
    } catch (error) {
      if (String(error).includes('browserType.launch')) return t.skip('Chromium unavailable (' + error.message.split('\n')[0] + ')');
      throw error;
    }
  });
}

test('a heading edit publishes its slot withdrawal before a new canonical can land', { timeout: 90_000 }, async t => {
  let chromium;
  try { ({ chromium } = hostRequire('playwright')); } catch { return t.skip('Playwright unavailable'); }
  if (spawnSync('lualatex', ['--version'], { stdio: 'ignore' }).status !== 0) return t.skip('LuaLaTeX unavailable');
  let browser;
  try {
    browser = await chromium.launch({ headless: true,
      ...(process.env.TDOM_ANCHOR_SINGLE_PROCESS === '1' && { args: ['--single-process', '--no-zygote', '--in-process-gpu'] }) });
  } catch (error) { return t.skip('Chromium unavailable (' + error.message.split('\n')[0] + ')'); }
  t.after(() => browser.close());

  mkdirSync(scratch, { recursive: true });
  const project = mkdtempSync(path.join(scratch, 'withdrawn-pdf-cut-'));
  const filePath = path.join(project, 'main.tex');
  const source = String.raw`\documentclass[twoside]{article}
\usepackage{fancyhdr,tikz}
\pagestyle{fancy}\fancyhf{}\renewcommand\headrulewidth{0pt}
\newcommand\Head[1]{\begin{tikzpicture}[remember picture,overlay]
\draw[line width=.5pt] ([xshift=2cm,yshift=-2cm]current page.north west) -- ([xshift=-2cm,yshift=-2cm]current page.north east);
\node[anchor=west] at ([xshift=2cm,yshift=-1.6cm]current page.north west) {#1};
\node at ([yshift=1.4cm]current page.south) {--- \thepage\ ---};
\end{tikzpicture}}
\fancyhead[L]{\Head{\rightmark}}
\begin{document}
\markboth{ALPHA}{ALPHA}
{\color{blue}Name:} First question.
\clearpage
\markboth{BETA}{BETA}
Second question.
\clearpage
\markboth{GAMMA}{GAMMA}
Third question.
\clearpage
\markboth{OMEGA}{OMEGA}
Fourth question.
\end{document}`;
  writeFileSync(filePath, source);
  const { origin, request } = await boot(t, project);
  const opened = await request('/open', { filePath, projectRoot: project, text: source });
  const view = await openFrame(await browser.newContext(), { origin, request }, 650, new Map());
  const { canonical } = await canonicalAt(request, opened.layoutSrcRev);
  const sheet = view.frame.locator('#pages > .page[data-page="2"]');
  await sheet.evaluate(el => el.scrollIntoView({ block: 'center' }));
  await until(() => sheet.evaluate(el => el.classList.contains('is-final') && el.querySelector('img.canon')?.naturalWidth),
    'opening exact page');
  const before = await until(async () => {
    const slots = (await request('/doc')).pages[1].commands.filter(cmd => cmd.chunk?.startsWith('__hf-2-'));
    return slots.length === 2 && slots;
  }, 'both cuts of the original artwork');
  const requestId = 'withdrawn-pdf-cut';
  const lease = await until(async () => {
    const response = await fetch(origin + '/canonical/build-lease/acquire', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ requestId, projectRoot: project, mainFile: filePath, ttlMs: 25_000 }),
    });
    const result = await response.json();
    if (result.reason === 'preview-work-settling' || result.reason === 'resident-bootstrap-active') return false;
    assert.ok(response.ok, JSON.stringify(result));
    return result;
  }, 'the Build lease is ready');
  try {
    const start = source.indexOf('{BETA}{BETA}');
    const edit = await request('/edit', { start, end: start + '{BETA}{BETA}'.length, text: '{DELTA}{DELTA}' });
    const pagePatch = edit.patches.find(patch => patch.type === 'replace-page' && patch.page === 2);
    assert.ok(pagePatch, 'the foreground edit delivers a revised sheet');
    assert.ok(!pagePatch.displayList.commands.some(cmd => before.some(old => old.chunk === cmd.chunk && old.cv === cmd.cv)),
      'the foreground patch withdraws both cuts of the old artwork');
    let paint;
    try {
      await until(async () => {
        paint = await sheet.evaluate(el => ({
          srcRev: appliedSrcRev,
          canonId: canonical?.id,
          oldCuts: [...el.querySelectorAll('.chunkwin')].filter(win =>
            win.querySelector('img')?.getAttribute('src')?.startsWith('/chunk/__hf-2-') &&
            getComputedStyle(win).visibility !== 'hidden' && getComputedStyle(win).opacity !== '0')
            .map(win => win.querySelector('img').getAttribute('src')),
          exact: el.classList.contains('is-final'),
          clip: el.querySelector('img.canon')?.style.clipPath,
        }));
        return paint.srcRev === edit.srcRev && paint.canonId === canonical.id &&
          (!paint.exact || paint.clip) && !paint.oldCuts.length;
      }, 'the old PDF artwork is no longer visible', 3000);
    } finally {
      t.diagnostic(JSON.stringify(paint));
    }
  } finally {
    await request('/canonical/build-lease/release', { requestId, token: lease.token });
  }
});

test('the real booklet keeps all eleven answer rules on sheet 25 through unrelated edits', { timeout: 350_000 }, async t => {
  const booklet = path.join(host, 'testing/issue-121-wip/r9/booklet/math-print.tex');
  if (!existsSync(booklet)) return t.skip('Issue 121 booklet fixture unavailable');
  let chromium;
  try { ({ chromium } = hostRequire('playwright')); } catch { return t.skip('Playwright unavailable'); }
  if (spawnSync('lualatex', ['--version'], { stdio: 'ignore' }).status !== 0) return t.skip('LuaLaTeX unavailable');
  let browser;
  try {
    browser = await chromium.launch({ headless: true,
      ...(process.env.TDOM_ANCHOR_SINGLE_PROCESS === '1' && { args: ['--single-process', '--no-zygote', '--in-process-gpu'] }) });
  } catch (error) { return t.skip('Chromium unavailable (' + error.message.split('\n')[0] + ')'); }
  t.after(() => browser.close());

  mkdirSync(scratch, { recursive: true });
  const project = mkdtempSync(path.join(scratch, 'booklet-rules-'));
  const filePath = path.join(project, 'math-print.tex');
  const source = readFileSync(booklet, 'utf8');
  writeFileSync(filePath, source);
  const { origin, request } = await boot(t, project);
  const page = await browser.newPage({ viewport: { width: 1076, height: 1100 } });
  await request('/open', { filePath, projectRoot: project, text: source });
  await page.route(origin + '/booklet-test-host', route => route.fulfill({ contentType: 'text/html', body:
    '<style>*{margin:0}iframe{border:0;width:100vw;height:100vh}</style>' +
    '<iframe src="/?embed=1&theme=light&activationId=booklet"></iframe>',
  }));
  await page.goto(origin + '/booklet-test-host');
  const frame = await until(() => page.mainFrame().childFrames().find(candidate => candidate.url().includes('embed=1')), 'booklet frame');
  const opened = await until(async () => {
    const status = await request('/status');
    return status.canonical?.rev === status.srcRev && !status.busy && status;
  }, 'opening exact booklet', 230_000);
  assert.equal(opened.canonical.pageCount, 30);
  const sheet = n => frame.locator(`#pages > .page[data-page="${n}"]`);
  const visit = n => sheet(n).evaluate(el => el.scrollIntoView({ block: 'center', behavior: 'instant' }));

  async function ruleCount() {
    await visit(25);
    const png = await sheet(25).screenshot();
    // The audit measures the ruled area below the left column's questions.
    return page.evaluate(async png => {
      const img = new Image();
      img.src = 'data:image/png;base64,' + png;
      await img.decode();
      const { width, height } = img;
      const left = Math.round(width * 0.145), right = Math.round(width * 0.435);
      const top = Math.round(height * 0.66), bottom = Math.round(height * 0.91);
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0);
      const { data } = ctx.getImageData(left, top, right - left, bottom - top);
      const stride = (right - left) * 4;
      let rules = 0, previous = false;
      for (let row = 0; row < data.length; row += stride) {
        let sum = 0;
        for (let x = row; x < row + stride; x += 4) sum += data[x] + data[x + 1] + data[x + 2];
        const ink = sum < (right - left) * 3 * 248;
        if (ink && !previous) rules++;
        previous = ink;
      }
      return rules;
    }, png.toString('base64'));
  }

  await visit(25);
  const exactPaper = await until(() => sheet(25).evaluate(el => el.classList.contains('is-final') &&
    el.querySelector('img.canon')?.naturalWidth && el.dataset.canonPresentedSrc), 'sheet 25 exact pixels');
  assert.equal(await ruleCount(), 11, 'opening worksheet');
  await visit(2);
  const before = await request('/doc');
  const requestId = 'booklet-rules';
  const lease = await until(async () => {
    const response = await fetch(origin + '/canonical/build-lease/acquire', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ requestId, projectRoot: project, mainFile: filePath, ttlMs: 60_000 }),
    });
    const result = await response.json();
    return result.token && result;
  }, 'booklet Build lease');
  try {
    const endOfSentence = '巻末（29ページ）にまとめてある。';
    const at = source.indexOf(endOfSentence);
    assert.ok(at >= 0);
    const end = at + endOfSentence.length;
    const edit = await request('/edit', { start: end, end, text: '字', slim: true });
    const editedAt = Date.now();
    await until(() => frame.evaluate(rev => appliedSrcRev === rev, edit.srcRev), 'the edited source reached the frame');
    const counts = [];
    for (const elapsed of [8000, 45000]) {
      await sleep(Math.max(0, editedAt + elapsed - Date.now()));
      counts.push(await ruleCount());
    }
    const after = await request('/doc');
    const beforeByPage = new Map(before.pages.map(list => [list.page, list.body]));
    const changed = after.pages.filter(list => beforeByPage.get(list.page) !== list.body).map(list => list.page);
    t.diagnostic(JSON.stringify({ rules: counts, changed, exactPaper }));
    assert.deepEqual(counts, [11, 11], 'sheet 25 rules at +8 s and +45 s');
    assert.deepEqual(changed, [2], 'only the body of the edited sheet changed');
    assert.equal(await sheet(25).evaluate(el => el.dataset.canonPresentedSrc), exactPaper);
  } finally {
    await request('/canonical/build-lease/release', { requestId, token: lease.token });
  }
});
