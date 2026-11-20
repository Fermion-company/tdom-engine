import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { rmSync } from 'node:fs';
import { createServer } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { spawn } from 'node:child_process';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const execFileP = promisify(execFile);

async function freePort() {
  return await new Promise((resolve, reject) => {
    const server = createServer();
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
    server.on('error', reject);
  });
}

async function startServer(t) {
  const port = await freePort();
  const child = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    // the small demo boots in seconds; the default stress doc takes minutes
    env: { ...process.env, PORT: String(port), TDOM_SAMPLE: 'demo-lua.tex' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (chunk) => {
    output += chunk.toString();
  });
  child.stderr.on('data', (chunk) => {
    output += chunk.toString();
  });
  await new Promise((resolve, reject) => {
    // the server boots a resident lualatex tree before listening
    const timeout = setTimeout(() => reject(new Error(`server did not start:\n${output}`)), 120_000);
    child.on('exit', (code) => {
      clearTimeout(timeout);
      reject(new Error(`server exited with ${code}:\n${output}`));
    });
    const poll = setInterval(() => {
      if (output.includes('listening on')) {
        clearInterval(poll);
        clearTimeout(timeout);
        resolve();
      }
    }, 50);
  });
  t.after(() => {
    child.kill('SIGTERM');
  });
  return `http://127.0.0.1:${port}`;
}

async function hasLuaLatex() {
  try {
    await execFileP('lualatex', ['--version'], { timeout: 10_000 });
    return true;
  } catch {
    return false;
  }
}

async function waitForCanonical(base, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const status = await fetch(`${base}/status`).then((res) => res.json());
    if (status.canonical?.id > 0 && !status.canonical.inFlight) return status.canonical;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('canonical compile did not settle');
}

// the server itself requires lualatex now (final display = LuaLaTeX output)
const texReady = await hasLuaLatex();

test('server stores, lists, and reads uploaded TeX files', { skip: !texReady && 'lualatex not installed' }, async (t) => {
  const base = await startServer(t);
  const name = `server-api-${Date.now()}.tex`;
  const file = path.join(ROOT, 'samples', 'uploads', name);
  t.after(() => rmSync(file, { force: true }));

  const body = '\\section{API Preview}\\nSaved body.\\n';
  const save = await fetch(`${base}/texfiles`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name, text: body }),
  });
  assert.equal(save.status, 201);
  const saved = await save.json();
  assert.equal(saved.texPath, `uploads/${name}`);

  const list = await fetch(`${base}/texfiles`).then((res) => res.json());
  assert.ok(list.some((item) => item.texPath === saved.texPath));

  const read = await fetch(`${base}/texfiles/${encodeURIComponent(saved.texPath)}`);
  assert.equal(read.status, 200);
  const payload = await read.json();
  assert.equal(payload.text, body);
  assert.equal(payload.size, Buffer.byteLength(body, 'utf8'));
});

test('server compiles AI style previews to a real PDF when LuaLaTeX is available', { skip: !texReady && 'lualatex not installed' }, async (t) => {
  const base = await startServer(t);
  const source = String.raw`\documentclass{article}
\begin{document}
Style preview $E=mc^2$.
\end{document}
`;
  const res = await fetch(`${base}/ai-preview`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ source }),
  });
  assert.equal(res.status, 201);
  const preview = await res.json();
  assert.match(preview.url, /^\/ai-preview\/[a-z0-9-]+\.pdf$/);

  const pdf = await fetch(`${base}${preview.url}`);
  assert.equal(pdf.status, 200);
  const head = Buffer.from(await pdf.arrayBuffer()).subarray(0, 5).toString('latin1');
  assert.equal(head, '%PDF-');
});

test('two viewers can fetch the same uncached canonical page concurrently', { skip: !texReady && 'lualatex not installed' }, async (t) => {
  const base = await startServer(t);
  const canonical = await waitForCanonical(base);
  const url = `${base}/canonical/1.svg?c=${canonical.id}`;
  const [first, second] = await Promise.all([fetch(url), fetch(url)]);
  assert.equal(first.status, 200);
  assert.equal(second.status, 200);
  const [firstSvg, secondSvg] = await Promise.all([first.text(), second.text()]);
  assert.match(firstSvg, /<svg\b/);
  assert.equal(secondSvg, firstSvg, 'both viewers receive the same generation pixels');
});

test('a viewer gets the source snapshot of the revision it staged while the next edit is queued (tex64-internal #103)', { skip: !texReady && 'lualatex not installed' }, async (t) => {
  const base = await startServer(t);
  const post = (body) => fetch(`${base}/edit`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  }).then((res) => res.json());
  const doc = await fetch(`${base}/doc`).then((res) => res.json());
  const at = doc.source.indexOf('watch the inspector') + 'watch'.length;
  assert.ok(at > 'watch'.length);
  // a viewer that stages pages asks for snapshots
  await fetch(`${base}/dom`).then((res) => res.json());
  const first = await post({ start: at, end: at, text: 'X' });
  // the next keystroke is sent at once; the snapshot of the first follows it
  const second = post({ start: at + 1, end: at + 1, text: 'Y' });
  const snapshot = await fetch(`${base}/dom?srcRev=${first.srcRev}`).then((res) => res.json());
  assert.equal(snapshot.srcRev, first.srcRev, 'the snapshot of the staged revision, not of the queued edit');
  assert.ok(snapshot.blocks?.length > 0);
  const next = await second;
  assert.equal(next.srcRev, first.srcRev + 1);
  // an unknown revision still takes the queue and answers the current state
  const current = await fetch(`${base}/dom?srcRev=1`).then((res) => res.json());
  assert.equal(current.srcRev, next.srcRev);
});

test('a block that only moved to another page travels as its new place; a host can ask for the revision alone', { skip: !texReady && 'lualatex not installed' }, async (t) => {
  const base = await startServer(t);
  const post = (body) => fetch(`${base}/edit`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  }).then((res) => res.json());
  const doc = await fetch(`${base}/doc`).then((res) => res.json());
  // (a snapshot asked for by its revision is kept, and carries the stamp a later change is taken from)
  const status = await fetch(`${base}/status`).then((res) => res.json());
  const held = await fetch(`${base}/dom?srcRev=${status.srcRev}`).then((res) => res.json());
  assert.ok(Number.isSafeInteger(held.domStamp), JSON.stringify(Object.keys(held)));
  // a page break in front of a paragraph in the middle: every block after it stands on another page
  const at = doc.source.indexOf('watch the inspector');
  const line = doc.source.lastIndexOf('\n', at) + 1;
  const answer = await post({ start: line, end: line, text: '\\clearpage ', slim: true });
  assert.deepEqual(Object.keys(answer).sort(), ['rev', 'slim', 'srcRev'], 'the revision alone, not the report');
  assert.ok(Number.isSafeInteger(answer.srcRev));
  const delta = await fetch(`${base}/dom?srcRev=${answer.srcRev}&base=${held.domStamp}`).then((res) => res.json());
  assert.equal(Number(delta.delta?.base), held.domStamp);
  assert.ok(delta.moved.length > 0, 'blocks after the break are sent as their new place');
  assert.ok(delta.blocks.length < delta.moved.length, JSON.stringify({ blocks: delta.blocks.length, moved: delta.moved.length }));
  // applied the way the viewer does, the change gives the snapshot the server would send whole
  const APP = (await import('node:fs')).readFileSync(new URL('../web/app.js', import.meta.url), 'utf8');
  const applySnapshotDelta = Function(`${APP.slice(
    APP.indexOf('function applySnapshotDelta'), APP.indexOf('// The update that brings a revision also brings its source map')
  )}; return applySnapshotDelta;`)();
  const applied = applySnapshotDelta(held, delta);
  const whole = await fetch(`${base}/dom?srcRev=${answer.srcRev}`).then((res) => res.json());
  assert.equal(whole.srcRev, answer.srcRev);
  assert.deepEqual(applied.blocks, whole.blocks);
  assert.deepEqual(applied.sources, whole.sources);
  assert.ok(whole.blocks.some((block, i) => JSON.stringify(block.pages) !== JSON.stringify(held.blocks[i]?.pages)), 'pages did change');
  // A character typed: the block typed in travels whole, the blocks after it as one run of
  // offsets; a line break typed: the blocks after it as one run of lines as well. No block
  // is named, and none but the one typed in is sent.
  const step = async (from, edit, check) => {
    const done = await post({ ...edit, slim: true });
    const change = await fetch(`${base}/dom?srcRev=${done.srcRev}&base=${from.domStamp}`).then((res) => res.json());
    assert.equal(Number(change.delta?.base), from.domStamp);
    const now = await fetch(`${base}/dom?srcRev=${done.srcRev}`).then((res) => res.json());
    const got = applySnapshotDelta(from, change);
    assert.deepEqual(got.blocks, now.blocks);
    assert.deepEqual(got.sources, now.sources);
    check(change, now);
    return now;
  };
  const source = (await fetch(`${base}/doc`).then((res) => res.json())).source;
  const word = source.indexOf('watch the inspector');
  const typed = await step(whole, { start: word, end: word, text: 'x' }, (change, now) => {
    assert.deepEqual(change.cut, [now.blocks.length, 0, []], 'the same blocks in the same order: none named');
    // (the block typed in, and the few the keystroke typeset again beside it)
    assert.ok(change.blocks.length >= 1 && change.blocks.length <= 6, JSON.stringify(change.blocks.map((block) => block.id)));
    assert.deepEqual(change.at, change.blocks.map((block) => now.blocks.findIndex((item) => item.id === block.id)));
    assert.ok(change.shift.length >= 1 && change.shift.length <= change.blocks.length, JSON.stringify(change.shift));
    assert.ok(change.shift.every((run) => run[2] === 1 && run[3] === 0), 'one character further, at the same place in the list');
    assert.equal(change.shift.at(-1)[1], now.blocks.length, 'to the last block');
    const inRuns = change.shift.reduce((sum, run) => sum + run[1] - run[0], 0);
    assert.equal(inRuns + change.blocks.length, now.blocks.length - change.at[0], 'every block from the one typed in on, and none before');
    assert.deepEqual(change.lines, []);
    assert.deepEqual(change.moved, []);
  });
  const lineStart = source.lastIndexOf('\n', word) + 1;
  // (in front of the blank line before the paragraph: one line more above everything after it)
  const blank = source.lastIndexOf('\n\n', lineStart);
  assert.ok(blank > 0);
  await step(typed, { start: blank, end: blank, text: '\n' }, (change, now) => {
    assert.deepEqual(change.cut, [now.blocks.length, 0, []]);
    assert.ok(change.lines.length >= 1, JSON.stringify(change.lines));
    assert.ok(change.lines.every((run) => run[2] === 1), JSON.stringify(change.lines));
    assert.ok(change.blocks.length <= 6, `blocks sent whole: ${change.blocks.length} of ${now.blocks.length}, lines ${JSON.stringify(change.lines)}, at ${JSON.stringify(change.at)}`);
    const lowered = change.lines.reduce((sum, run) => sum + run[1] - run[0], 0);
    assert.ok(lowered >= now.blocks.length - change.lines[0][0] - change.blocks.length,
      `the blocks after the line, as runs: ${JSON.stringify(change.lines)} of ${now.blocks.length}, whole at ${JSON.stringify(change.at)}`);
    assert.equal(now.blocks.at(-1).source.start.line, typed.blocks.at(-1).source.start.line + 1);
  });
  // without `slim` the answer is the report, as before
  const report = await post({ start: line, end: line + 1, text: '\\' });
  assert.ok(Array.isArray(report.patches));
});

test('a stream that takes cuts gets each page\'s list as its change from the one before; put together it is the plain list', { skip: !texReady && 'lualatex not installed' }, async (t) => {
  const base = await startServer(t);
  const http = await import('node:http');
  // an event stream read as the events it carries
  const listen = (query) => {
    const events = [];
    const waiting = [];
    let buffer = '';
    const request = http.get(`${base}/events${query}`, (res) => {
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        buffer += chunk;
        for (let end = buffer.indexOf('\n\n'); end >= 0; end = buffer.indexOf('\n\n', 0)) {
          const frame = buffer.slice(0, end);
          buffer = buffer.slice(end + 2);
          if (!frame.startsWith('data: ')) continue;
          const text = frame.slice(6);
          events.push({ text, msg: JSON.parse(text) });
          while (waiting.length) waiting.shift()();
        }
      });
    });
    t.after(() => request.destroy());
    const next = async (from, want) => {
      const until = Date.now() + 30_000;
      for (;;) {
        const index = events.findIndex((event, i) => i >= from && want(event.msg));
        if (index >= 0) return index;
        if (Date.now() > until) throw new Error('no such event');
        await Promise.race([new Promise((resolve) => waiting.push(resolve)), new Promise((resolve) => setTimeout(resolve, 200))]);
      }
    };
    return { events, next };
  };
  const plain = listen('');
  const cuts = listen('?lists=cut');
  await new Promise((resolve) => setTimeout(resolve, 300));
  // the viewer's own way of putting the lists in place
  const APP = (await import('node:fs')).readFileSync(new URL('../web/app.js', import.meta.url), 'utf8');
  const from = APP.indexOf('const streamLists = new Map();');
  const resolveStreamLists = Function(`${APP.slice(from, APP.indexOf('\n}\n', APP.indexOf('function resolveStreamLists(')) + 3)}; return resolveStreamLists;`)();
  const post = (body) => fetch(`${base}/edit`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  }).then((res) => res.json());
  const doc = await fetch(`${base}/doc`).then((res) => res.json());
  const at = doc.source.indexOf('watch the inspector');
  assert.ok(at > 0);
  const updateOf = (srcRev) => (msg) => msg.kind === 'update' && msg.report?.srcRev === srcRev;
  const lists = (msg) => (msg.report?.patches ?? msg.patches ?? []).filter((patch) => patch.type === 'replace-page').map((patch) => patch.displayList);
  let seenPlain = 0;
  let seenCuts = 0;
  const forms = [];
  const bytes = [];
  let previous = null;
  for (let key = 0; key < 4; key++) {
    const answer = await post({ start: at + key, end: at + key, text: 'x' });
    assert.ok(Array.isArray(answer.patches), 'the answer of an edit is the report with plain lists');
    for (const patch of answer.patches) if (patch.type === 'replace-page') assert.ok(Array.isArray(patch.displayList.commands));
    const p = await plain.next(seenPlain, updateOf(answer.srcRev));
    const c = await cuts.next(seenCuts, updateOf(answer.srcRev));
    // every event up to this one, in the stream's order (async repaints between two keys carry lists too)
    for (let i = seenCuts; i <= c; i++) {
      const sent = lists(cuts.events[i].msg).map((list) => list.commands);
      for (const value of sent) forms.push(Array.isArray(value) ? 'plain' : Array.isArray(value.all) ? 'all' : 'cut');
      assert.equal(resolveStreamLists(cuts.events[i].msg), true, `event ${i} of the stream could be put together`);
    }
    for (let i = seenPlain; i <= p; i++) for (const list of lists(plain.events[i].msg)) assert.ok(Array.isArray(list.commands), 'a stream that did not ask gets plain lists');
    assert.deepEqual(cuts.events[c].msg, plain.events[p].msg, 'put together, the event is the plain one');
    assert.deepEqual(lists(plain.events[p].msg), answer.patches.filter((patch) => patch.type === 'replace-page').map((patch) => patch.displayList));
    bytes.push([plain.events[p].text.length, cuts.events[c].text.length]);
    // the commands a keystroke did not change are the objects held from the event before
    const now = lists(cuts.events[c].msg)[0];
    if (previous && now && previous.page === now.page) {
      const kept = now.commands.filter((command) => previous.commands.includes(command)).length;
      assert.ok(kept > now.commands.length / 2, `${kept} of ${now.commands.length} commands are the ones held`);
    }
    previous = now ?? previous;
    seenPlain = p + 1;
    seenCuts = c + 1;
  }
  assert.ok(forms.includes('all'), 'the first list of a page travels whole');
  assert.ok(forms.includes('cut'), `later ones as cuts: ${forms.join(' ')}`);
  assert.ok(!forms.includes('plain'), 'a stream that asked gets no plain list');
  const last = bytes.at(-1);
  assert.ok(last[1] < last[0] / 2, `a later keystroke's event is much smaller as a cut: ${JSON.stringify(bytes)}`);
  // a list that does not continue what is held is refused (the viewer then takes a new stream)
  const forged = { kind: 'patches', patches: [{ type: 'replace-page', displayList: { page: previous.page, commands: { n: 999999, base: 123456, of: 1, head: 0, tail: 0, mid: [] } } }] };
  assert.equal(resolveStreamLists(forged), false);
  // a plain list on the stream drops the base for that page
  assert.equal(resolveStreamLists({ kind: 'patches', patches: [{ type: 'replace-page', displayList: { page: previous.page, commands: [] } }] }), true);
});

test('a host names an outer paper: its sheets around the chapter are served, the chapter\'s own are not', { skip: !texReady && 'lualatex not installed' }, async (t) => {
  const base = await startServer(t);
  const post = (body) => fetch(`${base}/outer`, { method: 'POST', body: JSON.stringify(body) }).then(async (r) => [r.status, await r.json()]);
  // any PDF stands in for the paper of a full Build: here the demo's own
  await waitForCanonical(base);
  const pdfBytes = Buffer.from(await (await fetch(`${base}/canonical.pdf`)).arrayBuffer());
  const { mkdtempSync, writeFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const dir = mkdtempSync(path.join(tmpdir(), 'tdom-outer-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const pdfPath = path.join(dir, 'paper.pdf');
  writeFileSync(pdfPath, pdfBytes);
  const { stdout } = await execFileP('pdfinfo', [pdfPath]);
  const pages = Number(/Pages:\s+(\d+)/.exec(stdout)[1]);
  assert.ok(pages >= 2);

  assert.equal((await post({ pdfPath, pages, before: pages + 1, afterFrom: pages + 2 }))[0], 400);
  assert.equal((await post({ pdfPath: 'relative.pdf', pages, before: 0, afterFrom: 1 }))[0], 400);
  const [status, answer] = await post({ pdfPath, pages, before: 1, afterFrom: pages + 1 });
  assert.equal(status, 200);
  const outer = (await (await fetch(`${base}/status`)).json()).outer;
  assert.deepEqual(outer, { key: answer.key, before: 1, afterFrom: pages + 1, pages });
  const sheet = await fetch(`${base}/outer/1.svg?k=${encodeURIComponent(outer.key)}`);
  assert.equal(sheet.status, 200);
  assert.match(await sheet.text(), /<svg/);
  assert.equal((await fetch(`${base}/outer/2.svg?k=${encodeURIComponent(outer.key)}`)).status, 404, 'a sheet of the chapter itself');
  assert.equal((await fetch(`${base}/outer/1.svg?k=stale`)).status, 404, 'another paper\'s key');
  assert.equal((await post({ clear: true }))[0], 200);
  assert.equal((await (await fetch(`${base}/status`)).json()).outer, null);
});
