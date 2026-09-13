import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { CanonicalRenderer } from '../engine/checkpoint/canonical.js';
import { validateCanonicalBuildImport } from '../engine/checkpoint/canonical-build-import.js';

const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const descriptor = (file) => ({ path: file, sha256: hash(readFileSync(file)) });

async function waitForFile(file, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (!existsSync(file)) {
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${file}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), 'tdom-build-import-'));
  const main = path.join(root, 'main.tex');
  const child = path.join(root, 'chapter.tex');
  const image = path.join(root, 'figure.png');
  const pdf = path.join(root, '.tex64/cache/live-preview/gen/pdf.bin');
  const synctex = path.join(root, '.tex64/cache/live-preview/gen/synctex.bin.gz');
  const fls = path.join(root, '.tex64/cache/live-preview/gen/main.fls');
  for (const file of [pdf, synctex, fls]) {
    const parent = path.dirname(file);
    mkdirSync(parent, { recursive: true });
  }
  writeFileSync(main, '\\input{chapter}\n');
  writeFileSync(child, 'chapter\n');
  writeFileSync(image, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  writeFileSync(pdf, '%PDF-1.7\nfixture');
  writeFileSync(synctex, gzipSync([
    'SyncTeX Version:1',
    `Input:1:${main}`,
    `Input:2:${child}`,
    'Magnification:1000',
    'Unit:1',
    'X Offset:0',
    'Y Offset:0',
    'Content:',
    '{1',
    '(1,7:65536,131072:65536,65536,0',
    ')',
    '}1',
    'Post scriptum:',
  ].join('\n')));
  writeFileSync(fls, `PWD ${root}\nINPUT ./main.tex\nINPUT chapter.tex\nINPUT figure.png\nINPUT /usr/local/texlive/texmf-dist/tex/latex/base/article.cls\n`);
  const candidate = {
    schemaVersion: 1,
    requestId: 'build:1',
    token: '12345678-1234-1234-1234-123456789abc',
    profile: {
      runner: 'latexmk', requestedEngine: 'lualatex', effectiveEngine: 'lualatex',
      synctex: true, interaction: 'nonstopmode',
      haltOnError: true, fileLineError: true, extraArgs: [], mainFile: 'main.tex',
    },
    provenance: {
      inputProof: 'build-fls', dynamicInputs: false, unknownInputs: [], systemInputsStable: true,
    },
    metrics: { durationMs: 12_345 },
    artifacts: { pdf: descriptor(pdf), synctex: { ...descriptor(synctex), compression: 'gzip' }, fls: descriptor(fls), aux: [] },
    inputs: [descriptor(main), descriptor(child), descriptor(image)],
  };
  return { root, main, child, image, pdf, synctex, candidate };
}

test('Build import validates the current root and every project input recorded by fls', async () => {
  const data = fixture();
  try {
    const result = await validateCanonicalBuildImport({
      candidate: data.candidate,
      projectRoot: data.root,
      mainFile: 'main.tex',
      source: readFileSync(data.main, 'utf8'),
      effectiveProjectInput: () => null,
    });
    assert.equal(result.accepted, true);
    assert.deepEqual(result.syncInputMap, [
      { logicalPath: data.main, recordedPath: data.main },
      { logicalPath: data.child, recordedPath: data.child },
    ]);
    assert.deepEqual(result.assumptions, ['system-inputs-stable-for-process', 'fls-observable-inputs-only']);
  } finally {
    rmSync(data.root, { recursive: true, force: true });
  }
});

test('Build import rejects an overlay whose bytes differ from the compiled child', async () => {
  const data = fixture();
  try {
    const result = await validateCanonicalBuildImport({
      candidate: data.candidate,
      projectRoot: data.root,
      mainFile: 'main.tex',
      source: readFileSync(data.main, 'utf8'),
      effectiveProjectInput: (file) => file === data.child ? 'unsaved edit\n' : null,
    });
    assert.deepEqual(result, { accepted: false, reason: 'project-input-changed' });
  } finally {
    rmSync(data.root, { recursive: true, force: true });
  }
});

test('Build import rejects a pdflatex fallback even when LuaLaTeX was requested', async () => {
  const data = fixture();
  try {
    data.candidate.profile.effectiveEngine = 'pdflatex';
    const result = await validateCanonicalBuildImport({
      candidate: data.candidate,
      projectRoot: data.root,
      mainFile: 'main.tex',
      source: readFileSync(data.main, 'utf8'),
      effectiveProjectInput: () => null,
    });
    assert.deepEqual(result, { accepted: false, reason: 'profile-or-provenance-incompatible' });
  } finally {
    rmSync(data.root, { recursive: true, force: true });
  }
});

test('Build import retains the exact SyncTeX spelling for an equivalent path alias', async () => {
  const data = fixture();
  const alias = `${data.root}-alias`;
  try {
    symlinkSync(data.root, alias);
    writeFileSync(data.synctex, gzipSync([
      'SyncTeX Version:1',
      `Input:1:${path.join(alias, 'main.tex')}`,
      `Input:2:${path.join(alias, 'chapter.tex')}`,
    ].join('\n')));
    data.candidate.artifacts.synctex.sha256 = hash(readFileSync(data.synctex));
    const result = await validateCanonicalBuildImport({
      candidate: data.candidate,
      projectRoot: data.root,
      mainFile: 'main.tex',
      source: readFileSync(data.main, 'utf8'),
      effectiveProjectInput: () => null,
    });
    assert.equal(result.accepted, true);
    assert.equal(result.syncInputMap[0].recordedPath, path.join(alias, 'main.tex'));
  } finally {
    rmSync(alias, { force: true });
    rmSync(data.root, { recursive: true, force: true });
  }
});

test('imported generation maps logical root paths to normal-Build SyncTeX paths', async () => {
  const data = fixture();
  const workDir = path.join(data.root, 'work');
  const bin = path.join(data.root, 'bin');
  const syncLog = path.join(data.root, 'synctex-args.txt');
  mkdirSync(workDir, { recursive: true });
  mkdirSync(bin, { recursive: true });
  const pdfinfo = path.join(bin, 'pdfinfo');
  const synctexCommand = path.join(bin, 'synctex');
  writeFileSync(pdfinfo, '#!/bin/sh\nprintf "Creator: LuaTeX\\nProducer: LuaTeX-1.17\\nPages: 1\\nPage 1 size: 612 x 792 pts\\nPage 1 rot: 0\\n"\n');
  writeFileSync(synctexCommand, `#!/bin/sh\nprintf '%s\\n' "$@" >> '${syncLog}'\nif [ "$1" = edit ]; then\n  printf 'Input:${data.main}\\nLine:7\\nColumn:2\\n'\nelse\n  printf 'Page:1\\nx:10\\ny:20\\nh:8\\nv:20\\nW:20\\nH:10\\n'\nfi\n`);
  chmodSync(pdfinfo, 0o755);
  chmodSync(synctexCommand, 0o755);
  const oldPath = process.env.PATH;
  process.env.PATH = `${bin}${path.delimiter}${oldPath}`;
  const renderer = new CanonicalRenderer({ workDir, docDir: data.root });
  try {
    const lease = renderer.acquireBuildLease('build:1', 60_000);
    assert.equal(renderer.renewBuildLease('build:1', lease.token, 90_000).renewed, true);
    renderer.schedule('source', 1);
    const prepared = await renderer.prepareBuildGeneration({
      requestId: 'build:1', token: lease.token, source: 'source', rev: 1,
      pdf: data.pdf, pdfHash: hash(readFileSync(data.pdf)),
      synctex: data.synctex, synctexHash: hash(readFileSync(data.synctex)),
      syncInputMap: [{ logicalPath: path.join(workDir, 'canon.tex'), recordedPath: data.main }],
    });
    const generation = await renderer.commitBuildGeneration(prepared, 'source', 1);
    const forward = await renderer.forwardSyncAll({ file: path.join(workDir, 'canon.tex'), line: 7, id: generation.id });
    assert.equal(forward.length, 1);
    assert.match(readFileSync(syncLog, 'utf8'), new RegExp(`7:1:${data.main.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
    const reverse = await renderer.reverseSync({ page: 1, x: 10, y: 20, id: generation.id });
    assert.equal(reverse.file, path.join(workDir, 'canon.tex'));
    const boxes = await renderer.sourceEditBoxes({
      file: path.join(workDir, 'canon.tex'), page: 1, startLine: 7, endLine: 7, id: generation.id,
    });
    assert.equal(boxes.length, 1);
    assert.equal(boxes[0].line, 7);

    await assert.rejects(renderer.prepareBuildGeneration({
      requestId: 'build:1', token: lease.token, source: 'source', rev: 2,
      pdf: data.pdf, pdfHash: hash(readFileSync(data.pdf)),
      synctex: data.synctex, synctexHash: hash(readFileSync(data.synctex)),
      syncInputMap: [
        { logicalPath: path.join(workDir, 'canon.tex'), recordedPath: data.main },
        { logicalPath: data.child, recordedPath: data.main },
      ],
    }), /ambiguous Build SyncTeX input map/);

    renderer.schedule('source two', 2);
    const stale = await renderer.prepareBuildGeneration({
      requestId: 'build:1', token: lease.token, source: 'source two', rev: 2,
      pdf: data.pdf, pdfHash: hash(readFileSync(data.pdf)),
      synctex: data.synctex, synctexHash: hash(readFileSync(data.synctex)),
      syncInputMap: [{ logicalPath: path.join(workDir, 'canon.tex'), recordedPath: data.main }],
    });
    renderer.schedule('source three', 3);
    await assert.rejects(renderer.commitBuildGeneration(stale, 'source two', 2), /pending source/);
    assert.equal(renderer.info().scheduledRev, 3);
    renderer.dropPreparedBuildGeneration(stale);
  } finally {
    renderer.dispose();
    process.env.PATH = oldPath;
    rmSync(data.root, { recursive: true, force: true });
  }
});

for (const oldCompileOutcome of ['late-completion', 'killed-failure']) {
  test(`Build adoption supersedes an older paused canonical ${oldCompileOutcome} without requeue`, async () => {
    const data = fixture();
    const workDir = path.join(data.root, 'work');
    const bin = path.join(data.root, 'bin');
    const compileMarker = path.join(data.root, 'compile-marker');
    const geometryMarker = path.join(data.root, 'geometry-marker');
    const releaseGeometry = path.join(data.root, 'release-geometry');
    mkdirSync(workDir, { recursive: true });
    mkdirSync(bin, { recursive: true });
    const pdfinfo = path.join(bin, 'pdfinfo');
    const lualatex = path.join(bin, 'lualatex');
    writeFileSync(pdfinfo, `#!/bin/sh
last=''
for arg do last="$arg"; done
case "$last" in
  */canon-[0-9]*.pdf)
    : > '${geometryMarker}'
    while [ ! -f '${releaseGeometry}' ]; do sleep 0.01; done
    ;;
esac
printf 'Creator: LuaTeX\nProducer: LuaTeX-1.17\nPages: 1\nPage 1 size: 612 x 792 pts\nPage 1 rot: 0\n'
`);
    writeFileSync(lualatex, `#!/bin/sh
out=''
take=''
for arg do
  if [ "$take" = out ]; then out="$arg"; take=''; continue; fi
  if [ "$arg" = -output-directory ]; then take=out; fi
done
: > '${compileMarker}'
${oldCompileOutcome === 'killed-failure' ? "while :; do sleep 1; done" : `printf '%%PDF-1.7\\nold' > "$out/canon.pdf"
printf 'old sync' > "$out/canon.synctex.gz"
printf 'Output written on canon.pdf (1 page, 10 bytes).\\n'`}
`);
    chmodSync(pdfinfo, 0o755);
    chmodSync(lualatex, 0o755);
    const oldPath = process.env.PATH;
    process.env.PATH = `${bin}${path.delimiter}${oldPath}`;
    const renderer = new CanonicalRenderer({ workDir, docDir: data.root, debounceMs: 0 });
    let prepared = null;
    try {
      renderer.schedule('old source', 1);
      await waitForFile(compileMarker);
      if (oldCompileOutcome === 'late-completion') await waitForFile(geometryMarker);

      const lease = renderer.acquireBuildLease(`build:${oldCompileOutcome}`, 60_000);
      assert.equal(lease.acquired, true);
      renderer.schedule('imported source', 2);
      prepared = await renderer.prepareBuildGeneration({
        requestId: `build:${oldCompileOutcome}`,
        token: lease.token,
        source: 'imported source',
        rev: 2,
        pdf: data.pdf,
        pdfHash: hash(readFileSync(data.pdf)),
        synctex: data.synctex,
        synctexHash: hash(readFileSync(data.synctex)),
        syncInputMap: [{ logicalPath: path.join(workDir, 'canon.tex'), recordedPath: data.main }],
      });
      const adoption = renderer.commitBuildGeneration(prepared, 'imported source', 2);
      if (oldCompileOutcome === 'late-completion') writeFileSync(releaseGeometry, 'continue');
      const generation = await adoption;
      prepared = null;

      assert.equal(generation.rev, 2);
      assert.equal(renderer.info().id, generation.id);
      assert.equal(renderer.info().rev, 2);
      assert.equal(renderer.info().scheduledRev, null);
      assert.equal(renderer.info().error, null);
      assert.equal(renderer.releaseBuildLease(`build:${oldCompileOutcome}`, lease.token).released, true);
      await new Promise((resolve) => setTimeout(resolve, 50));
      assert.equal(renderer.info().id, generation.id);
      assert.equal(renderer.info().rev, 2);
      assert.equal(renderer.info().inFlight, false);
      assert.equal(renderer.info().error, null);
    } finally {
      writeFileSync(releaseGeometry, 'continue');
      renderer.dropPreparedBuildGeneration(prepared);
      renderer.dispose();
      process.env.PATH = oldPath;
      rmSync(data.root, { recursive: true, force: true });
    }
  });
}
