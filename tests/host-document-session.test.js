import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DocumentSession, diffEdit } from '../host/document-session.js';
import { createLivePreviewHost, requestJson } from '../host/index.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const fakeEngineDir = path.join(here, 'fixtures', 'fake-engine');

const createHost = () =>
  createLivePreviewHost({
    engineDir: fakeEngineDir,
    // Ephemeral port: test files run in parallel, and a fixed preferred
    // port would make two engines race for the same listener.
    port: 0,
    startTimeoutMs: 5_000,
    pollIntervalMs: 20,
    onStdout: () => {},
    onStderr: () => {},
  });

const skippable = (t, error) => {
  if (error?.code === 'EPERM' || /listen EPERM/.test(error?.message || '')) {
    t.skip('loopback listeners are blocked by this sandbox');
    return true;
  }
  return false;
};

test('diffEdit computes minimal prefix/suffix ranges', () => {
  assert.deepEqual(diffEdit('abc', 'abXc'), { start: 2, end: 2, text: 'X' });
  assert.deepEqual(diffEdit('abXc', 'abc'), { start: 2, end: 3, text: '' });
  assert.deepEqual(diffEdit('hello world', 'hello brave world'), {
    start: 6,
    end: 6,
    text: 'brave ',
  });
  assert.deepEqual(diffEdit('same', 'same'), { start: 4, end: 4, text: '' });
  assert.deepEqual(diffEdit('', 'new'), { start: 0, end: 0, text: 'new' });
  const applied = (previous, next) => {
    const edit = diffEdit(previous, next);
    return previous.slice(0, edit.start) + edit.text + previous.slice(edit.end);
  };
  assert.equal(applied('\\section{A}\ntext', '\\section{B}\nmore text'), '\\section{B}\nmore text');
});

test('a failed edit resyncs with a fresh open instead of compounding', async () => {
  const sent = [];
  let failNextEdit = true;
  const session = new DocumentSession({
    getUrl: () => 'http://127.0.0.1:1',
    request: async (url, options) => {
      sent.push({ url, body: options.body });
      if (url.endsWith('/edit') && failNextEdit) {
        failNextEdit = false;
        throw new Error('engine lost the document');
      }
      return {};
    },
  });
  await session.push({ source: 'one', path: '/p/main.tex' });
  await session.push({ source: 'one two', path: '/p/main.tex' });
  assert.deepEqual(
    sent.map((entry) => entry.url.replace('http://127.0.0.1:1', '')),
    ['/open', '/edit', '/open']
  );
  assert.equal(sent.at(-1).body.text, 'one two');
  // The engine now holds the whole source again, so the next keystroke is a
  // range edit against it rather than another full reopen.
  await session.push({ source: 'one two three', path: '/p/main.tex' });
  assert.equal(sent.at(-1).url.endsWith('/edit'), true);
});

test('the engine sees minimal edits, warms and a reopen on project switch', async (t) => {
  const host = createHost();
  t.after(() => host.stop());
  try {
    await host.start();
  } catch (error) {
    if (skippable(t, error)) return;
    throw error;
  }

  await host.push({ source: '\\documentclass{article}\nhello', fresh: true });
  const clientEditAtEpochMs = Date.now();
  await host.push({ source: '\\documentclass{article}\nhello world', clientEditAtEpochMs });

  const doc = await requestJson(`${host.url}/doc`);
  assert.equal(doc.source, '\\documentclass{article}\nhello world');
  assert.deepEqual(doc.edits[0], { kind: 'open', text: '\\documentclass{article}\nhello' });
  assert.equal(doc.edits[1].kind, 'edit');
  assert.equal(doc.edits[1].text, ' world');
  assert.equal(doc.edits[1].end - doc.edits[1].start, 0, 'an insertion deletes nothing');
  assert.equal(doc.edits[1].clientEditAtEpochMs, clientEditAtEpochMs);

  const focus = await host.focus({ offset: 17 });
  assert.equal(focus.ok, true);
  assert.deepEqual((await requestJson(`${host.url}/doc`)).warms.at(-1), { offset: 17 });

  // The active file path is part of document identity. Switching projects
  // with identical text must still reopen so relative images, includes and
  // .bib entries resolve against the new project.
  const projectFile = path.join(here, 'fixtures', 'paper', 'main.tex');
  await host.push({ source: '\\documentclass{article}\nhello world', path: projectFile });
  const afterSwitch = await requestJson(`${host.url}/doc`);
  assert.equal(afterSwitch.edits.at(-1).kind, 'open');
  assert.equal(afterSwitch.edits.at(-1).filePath, path.resolve(projectFile));
});

test('the root document stays open while unsaved child buffers ride as overlays', async (t) => {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tdom-host-project-'));
  fs.mkdirSync(path.join(projectRoot, 'sections'));
  fs.writeFileSync(path.join(projectRoot, 'main.tex'), 'ROOT\n\\input{sections/intro}\n', 'utf8');
  fs.writeFileSync(path.join(projectRoot, 'sections', 'intro.tex'), 'saved child', 'utf8');
  const host = createHost();
  t.after(() => {
    host.stop();
    fs.rmSync(projectRoot, { recursive: true, force: true });
  });
  try {
    await host.start();
  } catch (error) {
    if (skippable(t, error)) return;
    throw error;
  }

  await host.push({
    workspaceRoot: projectRoot,
    rootFile: 'main.tex',
    buffers: [{ path: 'sections/intro.tex', text: 'unsaved child A' }],
  });
  await host.push({
    workspaceRoot: projectRoot,
    rootFile: 'main.tex',
    buffers: [
      { path: 'sections/intro.tex', text: 'unsaved child B' },
      { path: 'refs.bib', text: '@book{draft,title={Draft}}' },
    ],
  });
  await host.push({
    workspaceRoot: projectRoot,
    rootFile: 'main.tex',
    buffers: [{ path: 'refs.bib', text: '@book{draft,title={Draft}}' }],
  });

  const doc = await requestJson(`${host.url}/doc`);
  assert.equal(
    doc.source,
    'ROOT\n\\input{sections/intro}\n',
    'editing a child never replaces the root source'
  );
  const opened = doc.edits.at(-3);
  assert.equal(opened.kind, 'open');
  assert.equal(opened.filePath, path.join(projectRoot, 'main.tex'));
  assert.equal(opened.projectRoot, projectRoot);
  assert.deepEqual(opened.overlays, [
    { filePath: path.join(projectRoot, 'sections', 'intro.tex'), text: 'unsaved child A' },
  ]);
  const changed = doc.edits.at(-2);
  assert.equal(changed.kind, 'edit');
  assert.deepEqual(changed.overlays, [
    { filePath: path.join(projectRoot, 'sections', 'intro.tex'), text: 'unsaved child B' },
    { filePath: path.join(projectRoot, 'refs.bib'), text: '@book{draft,title={Draft}}' },
  ]);
  assert.equal(changed.text, '', 'an overlay-only change does not rewrite the root document');
  assert.deepEqual(doc.edits.at(-1).removeOverlays, [
    path.join(projectRoot, 'sections', 'intro.tex'),
  ]);
});

test('a root file outside the workspace is refused', () => {
  const session = new DocumentSession({ getUrl: () => 'http://127.0.0.1:1', request: async () => ({}) });
  assert.throws(
    () => session.resolveSnapshot({ workspaceRoot: '/work/space', rootFile: '../escape.tex' }),
    /escapes the workspace/
  );
});
