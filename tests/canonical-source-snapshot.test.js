import assert from 'node:assert/strict';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

test('canonical source capture follows TeX text reads off the compile path and is generation-bound', { timeout: 45_000 }, async () => {
  // The engine reads inputs by their real path; macOS's temp dir is a symlink.
  const project = fs.realpathSync(fs.mkdtempSync(path.join(tmpdir(), 'tdom-source-snapshot-')));
  const workDir = path.join(project, 'work');
  fs.mkdirSync(workDir);
  const late = path.join(project, 'late.custom');
  const style = path.join(project, 'journal.sty');
  const png = path.join(project, 'figure.png');
  fs.writeFileSync(late, 'Original chapter.\n');
  fs.writeFileSync(style, String.raw`\ProvidesPackage{journal}\newcommand\notice{Welcome.}`);
  fs.writeFileSync(png, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGMwTpsJAAICATNWh+JUAAAAAElFTkSuQmCC', 'base64'));
  const source = String.raw`\documentclass{article}
\usepackage{journal,graphicx}
\begin{document}
\notice\ \includegraphics[width=1cm]{figure.png}
\newpage
\input{late.custom}
\end{document}
`;

  const readSync = fs.readFileSync;
  const readAsync = fs.promises.readFile;
  const binaryReads = [];
  const sourceReads = [];
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  let captureStarted;
  const capturing = new Promise(resolve => { captureStarted = resolve; });
  fs.readFileSync = function (file, ...args) {
    if (file === png && new Error().stack.includes('captureSyncSources')) binaryReads.push(file);
    return readSync(file, ...args);
  };
  fs.promises.readFile = async function (file, ...args) {
    if (file === png) binaryReads.push(file);
    if (file === style || file === late) sourceReads.push(file);
    if (file === late && sourceReads.filter(item => item === late).length === 1) {
      captureStarted();
      await gate;
    }
    return readAsync(file, ...args);
  };
  syncBuiltinESMExports();
  let renderer;
  try {
    const { CanonicalRenderer } = await import('../engine/checkpoint/canonical.js');
    renderer = new CanonicalRenderer({ docDir: project, workDir });
    const printed = renderer.ensure(source, 1);
    const opening = await printed;
    assert.deepEqual(binaryReads, [], 'snapshot capture never opens the asset');
    assert.equal(typeof renderer.syncSourcesFor, 'function');
    await capturing;
    assert.equal(opening.pageCount, 2, 'canonical generation lands while its source read is pending');
    assert.equal(opening.syncSources.has(late), false);
    release();
    const old = await renderer.syncSourcesFor(opening.id);
    assert.deepEqual([...old.keys()].sort(), [late, style, path.join(workDir, 'canon.tex')].sort());
    assert.equal(old.get(late), 'Original chapter.\n');

    fs.writeFileSync(late, '% New paragraph marker.\nOriginal chapter.\n');
    renderer.invalidateInputs({ changed: [late] });
    const newer = await renderer.ensure(source, 2);
    assert.equal((await renderer.syncSourcesFor(newer.id)).get(late), '% New paragraph marker.\nOriginal chapter.\n');
    assert.equal(old.get(late), 'Original chapter.\n');
    assert.equal(sourceReads.filter(item => item === style).length, 1, 'reuse a previously verified hash');
    assert.deepEqual(binaryReads, []);

    await renderer.resetDocument(project);
    assert.equal(await renderer.syncSourcesFor(opening.id), undefined);
    assert.equal(await renderer.syncSourcesFor(newer.id), undefined);
  } finally {
    release();
    renderer?.dispose();
    fs.readFileSync = readSync;
    fs.promises.readFile = readAsync;
    syncBuiltinESMExports();
  }
});
