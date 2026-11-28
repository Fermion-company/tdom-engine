import assert from 'node:assert/strict';
import { once } from 'node:events';
import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const engineRoot = fileURLToPath(new URL('..', import.meta.url));
const glyphText = (commands) => commands.filter(command => command.op === 'glyphs')
  .map(command => command.text).join('').replace(/\s/g, '');

async function until(check, ms = 30_000) {
  const deadline = Date.now() + ms;
  do {
    const value = await check();
    if (value) return value;
    await wait(50);
  } while (Date.now() < deadline);
  return null;
}

test('unsaved direct and nested inputs replace a resident page before canonical catches up', { timeout: 60_000 }, async (t) => {
  try {
    execFileSync('lualatex', ['--version'], { stdio: 'ignore' });
  } catch {
    t.skip('lualatex not installed');
    return;
  }

  const dir = mkdtempSync(path.join(tmpdir(), 'tdom-child-live-'));
  const project = path.join(dir, 'project');
  mkdirSync(path.join(project, 'ch'), { recursive: true });
  const filePath = path.join(project, 'main.tex');
  const source = String.raw`\documentclass{article}
\pagestyle{empty}
\newcommand\SwitchLayout{\twocolumn}
\begin{document}
\input{ch/chapter}
\include{ch/appendix}
\SwitchLayout

Final paragraph.
\end{document}
`;
  const chapter = 'Editable chapter text in a short paragraph.\n\n\\input{ch/nested}\n';
  const nested = 'Editable nested text in a short paragraph.\n\n';
  const appendix = 'The appendix has its own auxiliary file.\n\n';
  const chapterPath = path.join(project, 'ch/chapter.tex');
  const nestedPath = path.join(project, 'ch/nested.tex');
  const appendixPath = path.join(project, 'ch/appendix.tex');
  for (const [file, text] of [[filePath, source], [chapterPath, chapter], [nestedPath, nested], [appendixPath, appendix]]) {
    writeFileSync(file, text);
  }

  const listener = createServer().listen(0, '127.0.0.1');
  await once(listener, 'listening');
  const { port } = listener.address();
  await new Promise(resolve => listener.close(resolve));
  const server = spawn(process.execPath, ['server.js'], {
    cwd: engineRoot,
    env: {
      ...process.env, PORT: String(port), TDOM_WORKDIR: path.join(dir, 'work'),
      TDOM_SAMPLE: 'demo-lua.tex', TDOM_MAX_CHECKPOINTS: '8', TDOM_SHIP: '1',
      TDOM_SHIP_PRIVATE_PDF: '1', TDOM_CANONICAL_ANCHOR: '1',
    },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let output = '';
  server.stderr.on('data', chunk => { output += chunk; });
  const exited = once(server, 'exit');
  t.after(async () => {
    server.kill('SIGTERM');
    await exited;
    rmSync(dir, { recursive: true, force: true });
  });

  const request = async (endpoint, body) => {
    const response = await fetch(`http://127.0.0.1:${port}${endpoint}`, body === undefined ? {} : {
      method: 'POST', body: JSON.stringify(body),
    });
    const result = await response.json();
    assert.ok(response.ok, JSON.stringify(result));
    return result;
  };
  assert.ok(await until(() => request('/status').catch(() => null)), output);
  const opened = await request('/open', { filePath, projectRoot: project, text: source });
  assert.equal(opened.previewPolicy, 'shipping-exact');
  const openRevision = opened.report.srcRev;
  let status;
  const base = await until(async () => {
    status = await request('/status');
    const { canonical } = status;
    assert.notEqual(canonical.errorRev, openRevision, canonical.error);
    return canonical.id && canonical.rev === openRevision ? canonical : null;
  }, 15_000);
  assert.ok(base, JSON.stringify(status?.canonical) + output);
  assert.ok(status.shipping, JSON.stringify(status.shipRetry) + output);

  for (const [childPath, before, word] of [[chapterPath, chapter, 'chapter'], [nestedPath, nested, 'nested']]) {
    const after = before.replace(word, word + 'X');
    const report = await request('/edit', {
      start: 0, end: 0, text: '', overlays: [{ filePath: childPath, text: after }],
    });
    assert.equal(report.canonical.id, base.id, 'the previous canonical generation still supplies the paper');
    assert.equal(report.residentEditCandidate, true, JSON.stringify({
      verdict: report.stats?.chainVerdict, refusal: report.canonicalAnchorRefused,
    }));
    assert.equal(report.canonicalAnchor?.policy, 'terminal', report.canonicalAnchorRefused);
    assert.ok(report.patches.some(patch => patch.page === 1 && patch.type === 'replace-page' &&
      glyphText(patch.displayList.commands).includes(`Editable${word}Xtext`)));
    assert.equal(readFileSync(childPath, 'utf8'), before, 'the edit is still unsaved');
  }

  const report = await request('/edit', {
    start: 0, end: 0, text: '',
    overlays: [{ filePath: appendixPath, text: appendix.replace('appendix', 'appendixX') }],
  });
  assert.equal(report.residentEditCandidate, false);
  assert.equal(report.stats.chainVerdict, 'shipping-deferred');
  assert.deepEqual(report.patches, []);
});
