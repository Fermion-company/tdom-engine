import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  parseSyncTeXBatchOutput,
  prepareSyncTeXBatchHelper,
  querySyncTeXRange,
} from '../engine/checkpoint/synctex-batch.js';
import { CanonicalRenderer } from '../engine/checkpoint/canonical.js';

function payload(groups, overrides = {}) {
  return JSON.stringify({
    schemaVersion: 1,
    groups: groups.map((records, index) => ({ line: 8 + index, records })),
    firstLine: 8,
    lastLine: 8 + groups.length - 1,
    recordCount: groups.reduce((sum, records) => sum + records.length, 0),
    complete: true,
    ...overrides,
  });
}

const record = { page: 2, x: 318.25, y: 144.5, h: 310, v: 147, W: 225, H: 10 };

test('SyncTeX batch output requires every ordered line group and converts CLI fields exactly', () => {
  assert.deepEqual(parseSyncTeXBatchOutput(payload([[record], []]), { firstLine: 8, lastLine: 9 }), [[{
    page: 2,
    x: 318.25,
    y: 144.5,
    box: { left: 310, top: 137, right: 535, bottom: 149.5 },
  }], []]);
  assert.equal(parseSyncTeXBatchOutput(payload([[record]], { complete: false }), { firstLine: 8, lastLine: 8 }), null);
  assert.equal(parseSyncTeXBatchOutput(payload([[record]], { recordCount: 2 }), { firstLine: 8, lastLine: 8 }), null);
  assert.equal(parseSyncTeXBatchOutput(payload([[record], []], {
    groups: [{ line: 8, records: [record] }, { line: 10, records: [] }],
  }), { firstLine: 8, lastLine: 9 }), null);
});

test('SyncTeX batch process accepts complete output and fails closed on invalid output', async () => {
  const workDir = mkdtempSync(path.join(os.tmpdir(), 'tdom-synctex-batch-'));
  const calls = [];
  let output = payload([[record]]);
  const run = async (command, args) => {
    calls.push({ command, args });
    if (command === 'cc') {
      const executable = args[args.indexOf('-o') + 1];
      writeFileSync(executable, '#!/bin/sh\nexit 0\n');
      chmodSync(executable, 0o755);
      return { stdout: '', stderr: '' };
    }
    return { stdout: output, stderr: '' };
  };
  try {
    const executable = await prepareSyncTeXBatchHelper({ workDir, timeoutMs: 1_000, run });
    assert.equal(executable, path.join(workDir,
      process.platform === 'win32' ? 'tdom-synctex-batch.exe' : 'tdom-synctex-batch'));
    const groups = await querySyncTeXRange({
      workDir,
      pdf: '/paper/main.pdf',
      file: '/paper/main.tex',
      firstLine: 8,
      lastLine: 8,
      timeoutMs: 1_000,
      run,
    });
    assert.equal(groups?.[0]?.[0]?.page, 2);
    assert.equal(calls.filter((call) => call.command === 'cc').length, 1,
      'range query reuses the proactively prepared helper');
    assert.deepEqual(calls.at(-1).args, ['/paper/main.pdf', '/paper/main.tex', '8', '8', '1']);
    output = '{"schemaVersion":1,"complete":true';
    assert.equal(await querySyncTeXRange({
      workDir,
      pdf: '/paper/main.pdf',
      file: '/paper/main.tex',
      firstLine: 8,
      lastLine: 8,
      timeoutMs: 1_000,
      run,
    }), null);
    assert.equal(calls.filter((call) => call.command === 'cc').length, 1, 'compiled helper is reused');
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
});

test('range CLI fallback kills a late query and does not cache its failure as an empty result', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'tdom-synctex-deadline-'));
  const bin = path.join(root, 'bin');
  const workDir = path.join(root, 'work');
  const pdf = path.join(root, 'main.pdf');
  const synctex = path.join(root, 'main.synctex.gz');
  const source = path.join(root, 'main.tex');
  const completed = path.join(root, 'completed');
  mkdirSync(bin, { recursive: true });
  mkdirSync(workDir, { recursive: true });
  for (const file of [pdf, synctex, source]) writeFileSync(file, 'fixture');
  const cc = path.join(bin, 'cc');
  const cli = path.join(bin, 'synctex');
  writeFileSync(cc, '#!/bin/sh\nexit 1\n');
  writeFileSync(cli, `#!${process.execPath}\nsetTimeout(() => require('fs').writeFileSync(${JSON.stringify(completed)}, 'late'), 300);\n`);
  chmodSync(cc, 0o755);
  chmodSync(cli, 0o755);
  const oldPath = process.env.PATH;
  process.env.PATH = `${bin}${path.delimiter}${oldPath}`;
  const renderer = new CanonicalRenderer({ workDir, docDir: root });
  const generation = {
    id: 1,
    pdf,
    synctex,
    papers: [{ w: 612, h: 792, rotation: 0 }],
    syncInputMap: new Map(),
    readers: 0,
  };
  renderer.generations.set(1, generation);
  renderer.last = generation;
  try {
    const late = await renderer.forwardSyncRange({
      file: source,
      firstLine: 8,
      lastLine: 8,
      id: 1,
      deadline: performance.now() + 80,
    });
    assert.equal(late, null);
    await new Promise((resolve) => setTimeout(resolve, 350));
    assert.equal(existsSync(completed), false, 'timed-out CLI child did not finish');

    writeFileSync(cli, `#!${process.execPath}\nprocess.stdout.write('Page:1\\nx:10\\ny:20\\nh:8\\nv:20\\nW:20\\nH:10\\n');\n`);
    chmodSync(cli, 0o755);
    const recovered = await renderer.forwardSyncRange({
      file: source,
      firstLine: 8,
      lastLine: 8,
      id: 1,
      deadline: performance.now() + 2_000,
    });
    assert.equal(recovered?.[0]?.length, 1, 'deadline failure did not poison the generation cache');
    rmSync(cli, { force: true });
    const cached = await renderer.forwardSyncRange({
      file: source,
      firstLine: 8,
      lastLine: 8,
      id: 1,
      deadline: performance.now() + 100,
    });
    assert.equal(cached?.[0]?.length, 1, 'complete generation cache skips both native and CLI queries');
  } finally {
    renderer.dispose();
    process.env.PATH = oldPath;
    rmSync(root, { recursive: true, force: true });
  }
});
