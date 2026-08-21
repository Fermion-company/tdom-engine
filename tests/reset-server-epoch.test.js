import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import http from 'node:http';
import { createServer } from 'node:net';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const execFileP = promisify(execFile);

const freePort = () => new Promise((resolve, reject) => {
  const socket = createServer();
  socket.listen(0, '127.0.0.1', () => {
    const { port } = socket.address();
    socket.close(() => resolve(port));
  });
  socket.on('error', reject);
});

const hasLuaLatex = async () => {
  try {
    await execFileP('lualatex', ['--version'], { timeout: 10_000 });
    return true;
  } catch {
    return false;
  }
};

const texReady = await hasLuaLatex();

test('server brackets open and engine reboots with one exact document epoch', {
  skip: !texReady && 'lualatex not installed',
  timeout: 120_000,
}, async (t) => {
  const port = await freePort();
  const child = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(port), TDOM_SAMPLE: 'demo-lua.tex' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (chunk) => { output += chunk; });
  child.stderr.on('data', (chunk) => { output += chunk; });
  t.after(() => child.kill('SIGTERM'));
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`server did not start:\n${output}`)), 90_000);
    const poll = setInterval(() => {
      if (!output.includes('listening on')) return;
      clearInterval(poll);
      clearTimeout(timer);
      resolve();
    }, 25);
    child.once('exit', (code) => {
      clearInterval(poll);
      clearTimeout(timer);
      reject(new Error(`server exited with ${code}:\n${output}`));
    });
  });

  const base = `http://127.0.0.1:${port}`;
  const events = [];
  let eventBuffer = '';
  const eventRequest = http.get(`${base}/events`);
  t.after(() => eventRequest.destroy());
  await new Promise((resolve, reject) => {
    eventRequest.once('response', (response) => {
      response.setEncoding('utf8');
      response.on('data', (chunk) => {
        eventBuffer += chunk;
        const frames = eventBuffer.split('\n\n');
        eventBuffer = frames.pop();
        for (const frame of frames) {
          const data = frame.split('\n').find((line) => line.startsWith('data: '));
          if (data) events.push(JSON.parse(data.slice(6)));
        }
      });
      resolve();
    });
    eventRequest.once('error', reject);
  });

  const source = String.raw`\documentclass{article}
\title{Epoch Two}
\author{TDOM}
\begin{document}
\maketitle
Document epoch two.
\end{document}
`;
  const opened = await fetch(`${base}/open`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      text: source,
      filePath: path.join(ROOT, 'samples', 'epoch-two.tex'),
      projectRoot: path.join(ROOT, 'samples'),
    }),
  });
  assert.equal(opened.status, 200);
  const doc = await opened.json();
  assert.equal(doc.documentEpoch, 2);

  const deadline = Date.now() + 5_000;
  while (!events.some((event) => event.kind === 'reset' && event.documentEpoch === 2) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  const pendingIndex = events.findIndex((event) =>
    event.kind === 'reset-pending' && event.documentEpoch === 2
  );
  const completeIndex = events.findIndex((event) => event.kind === 'reset' && event.documentEpoch === 2);
  assert.ok(pendingIndex >= 0, 'reset-pending for epoch 2 was broadcast');
  assert.ok(completeIndex > pendingIndex, 'reset completes only after its pending announcement');
  assert.equal((await fetch(`${base}/status`).then((response) => response.json())).documentEpoch, 2);

  // A root preamble edit enters CheckpointEngine.edit() like an ordinary
  // keystroke, but prepareUpdate must destroy and reboot the resident tree.
  // The engine callback has to advance the epoch before that boot, not only
  // after the report reveals stats.rebooted=true.
  const titleStart = source.indexOf('Epoch Two');
  const titleText = 'Epoch Three';
  const preambleEdit = await fetch(`${base}/edit`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      start: titleStart,
      end: titleStart + 'Epoch Two'.length,
      text: titleText,
    }),
  });
  assert.equal(preambleEdit.status, 200);
  const preambleReport = await preambleEdit.json();
  assert.equal(preambleReport.stats.rebooted, true);

  const preambleDeadline = Date.now() + 5_000;
  while (!events.some((event) => event.kind === 'reset' && event.documentEpoch === 3) && Date.now() < preambleDeadline) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }

  const pendingPreambleIndex = events.findIndex((event) =>
    event.kind === 'reset-pending' && event.documentEpoch === 3
  );
  const completePreambleIndex = events.findIndex((event) =>
    event.kind === 'reset' && event.documentEpoch === 3
  );
  assert.ok(pendingPreambleIndex >= 0, 'preamble reboot announces epoch 3');
  assert.equal(events[pendingPreambleIndex].reason, 'engine-preamble-reboot');
  assert.ok(
    completePreambleIndex > pendingPreambleIndex,
    'preamble reboot completes only after its pending announcement'
  );
  assert.equal((await fetch(`${base}/status`).then((response) => response.json())).documentEpoch, 3);

  // Ordinary body typing must keep the current epoch. Gating every edit
  // would be correct-looking but would replace the live hot path with a
  // static-preview flash on every keystroke.
  const afterPreamble = source.slice(0, titleStart) + titleText + source.slice(titleStart + 'Epoch Two'.length);
  const bodyStart = afterPreamble.indexOf('Document epoch two');
  const bodyEdit = await fetch(`${base}/edit`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      start: bodyStart,
      end: bodyStart + 'Document epoch two'.length,
      text: 'Document epoch three',
    }),
  });
  assert.equal(bodyEdit.status, 200);
  assert.equal((await fetch(`${base}/status`).then((response) => response.json())).documentEpoch, 3);
  assert.equal(
    events.some((event) => event.kind === 'reset-pending' && event.documentEpoch === 4),
    false,
    'body typing does not create a document reset epoch'
  );

  // Failure is also terminal for the handshake. A bibliography preparation
  // error happens after /open has announced reset-pending but before
  // engine.open; the server must emit the matching reset completion instead
  // of leaving the host permanently stuck in pending mode.
  const failingSource = String.raw`\documentclass{article}
\begin{document}
Missing citation \cite{does-not-exist}.
\bibliographystyle{plain}
\bibliography{tdom-reset-test-file-that-does-not-exist}
\end{document}
`;
  const failedOpen = await fetch(`${base}/open`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      text: failingSource,
      filePath: path.join(ROOT, 'samples', 'epoch-failed-open.tex'),
      projectRoot: path.join(ROOT, 'samples'),
    }),
  });
  assert.equal(failedOpen.status, 500);

  const failureDeadline = Date.now() + 5_000;
  while (!events.some((event) => event.kind === 'reset' && event.documentEpoch === 4) && Date.now() < failureDeadline) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  const pendingFailureIndex = events.findIndex((event) =>
    event.kind === 'reset-pending' && event.documentEpoch === 4
  );
  const completeFailureIndex = events.findIndex((event) =>
    event.kind === 'reset' && event.documentEpoch === 4
  );
  assert.ok(pendingFailureIndex >= 0, 'failed reset announces epoch 4');
  assert.ok(
    completeFailureIndex > pendingFailureIndex,
    'failed reset still releases its matching pending epoch'
  );
  const failedStatus = await fetch(`${base}/status`).then((response) => response.json());
  assert.equal(failedStatus.documentEpoch, 4);
  assert.equal(failedStatus.busy, false);
});
