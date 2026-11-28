// Jump reads a pass's SyncTeX a line at a time, keeping only what the lookup
// needs (canonical.js readJumpRecordsOf / readSyncTeXForPage). Past 8 MB
// compressed it used to give no answer at all, with the status mark green.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { CanonicalRenderer, readJumpRecordsOf, readSyncTeXForPage } from '../engine/checkpoint/canonical.js';
import { parseJumpRecords, jumpRecords, indexStartRecords } from '../engine/checkpoint/jump-sync.js';
import { parseSyncTeXSourceBoxes } from '../engine/checkpoint/pdf-source-boxes.js';

const header = ['SyncTeX Version:1', 'Input:1:/p/main.tex', 'Input:2:/p/child.tex',
  'Magnification:1000', 'Unit:1', 'X Offset:0', 'Y Offset:0', 'Content:'];
const pageOf = (n, rows) => [`{${n}`, `[1,1:0,0:100,100,0`, ...rows, ']', `}${n}`];
const sample = (filler = []) => [
  ...header,
  ...filler,
  ...pageOf(1, ['(1,5:0,100:100,10,2', 'x1,5:50,100', 'x2,7:60,100', ')', '(2,8:0,200:100,10,2', 'g2,8:10,200', ')']),
  // a file opened on page 2: its Input line is inside the page
  ...pageOf(2, ['Input:3:/p/index.ind', '(3,1:0,50:100,10,2', 'x3,1:5,50', ')', '(1,9:0,80:100,10,2', 'k1,9:7,80', ')']),
  'Postamble:', 'Count:9', 'Post scriptum:', '',
].join('\n');

const write = (t, text, name = 'canon.synctex.gz') => {
  const dir = mkdtempSync(path.join(tmpdir(), 'tdom-jump-stream-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, name);
  writeFileSync(file, name.endsWith('.gz') ? gzipSync(text) : text);
  return file;
};

test('the records kept for one input are the ones the whole file gives for it', async (t) => {
  const file = write(t, sample());
  const full = parseJumpRecords(sample(), '/p');
  const child = await readJumpRecordsOf(file, '/p', input => input === '/p/child.tex');
  for (const line of [5, 7, 8]) assert.deepEqual(jumpRecords(child, '/p/child.tex', line), jumpRecords(full, '/p/child.tex', line));
  assert.equal(jumpRecords(child, '/p/child.tex', 7)[0].box.top, jumpRecords(full, '/p/child.tex', 7)[0].box.top,
    'a record keeps the box around it, which belongs to another input');
  // other inputs' records are not kept
  assert.equal(jumpRecords(child, '/p/main.tex', 5).length, 0);
  assert.ok(jumpRecords(full, '/p/main.tex', 5).length > 0);
  // the generated index, for a line that prints it
  const withIndex = await readJumpRecordsOf(file, '/p', input => /\.ind$/i.test(input));
  assert.deepEqual(indexStartRecords(withIndex), indexStartRecords(full));
});

test('a SyncTeX far past 8 MB compressed is read', async (t) => {
  // Lines Jump does not read, and that do not compress: 9 MB of them.
  const filler = [];
  for (let i = 0; i < 9 * 1024; i += 1) filler.push(`Z${randomBytes(768).toString('base64')}`);
  const text = sample(filler);
  const file = write(t, text);
  const records = await readJumpRecordsOf(file, '/p', input => input === '/p/main.tex');
  assert.ok(records, 'read');
  assert.equal(jumpRecords(records, '/p/main.tex', 9)[0].page, 2);
  const page = await readSyncTeXForPage(file, 1);
  assert.deepEqual(parseSyncTeXSourceBoxes(page, { file: '/p/child.tex', page: 1, startLine: 1, endLine: 20 }),
    parseSyncTeXSourceBoxes(text, { file: '/p/child.tex', page: 1, startLine: 1, endLine: 20 }));
});

test('the page kept for the source boxes gives the boxes the whole file gives', async (t) => {
  const file = write(t, sample(), 'canon.synctex');
  for (const page of [1, 2]) {
    const kept = await readSyncTeXForPage(file, page);
    for (const input of ['/p/main.tex', '/p/child.tex', '/p/index.ind']) {
      assert.deepEqual(parseSyncTeXSourceBoxes(kept, { file: input, page, startLine: 1, endLine: 20 }),
        parseSyncTeXSourceBoxes(sample(), { file: input, page, startLine: 1, endLine: 20 }), `${input} p.${page}`);
    }
  }
});

test('a file that cannot be read through gives no records, and an unfamiliar form none either', async (t) => {
  const whole = gzipSync(sample());
  const dir = mkdtempSync(path.join(tmpdir(), 'tdom-jump-stream-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const truncated = path.join(dir, 'cut.synctex.gz');
  writeFileSync(truncated, whole.subarray(0, Math.floor(whole.length / 2)));
  assert.equal(await readJumpRecordsOf(truncated, '/p', () => true).catch(() => null), null);
  assert.equal(await readJumpRecordsOf(path.join(dir, 'missing.synctex.gz'), '/p', () => true).catch(() => null), null);
  const transformed = write(t, sample().replace('Content:', 'Content:\n<1,2:0,0'));
  assert.equal(await readJumpRecordsOf(transformed, '/p', () => true), null);
});

test('no pass of the source asked about: no answer, and why', async () => {
  const workDir = mkdtempSync(path.join(tmpdir(), 'tdom-jump-why-'));
  const renderer = new CanonicalRenderer({ workDir });
  try {
    const why = {};
    assert.equal(await renderer.jumpToSource({ file: path.join(workDir, 'canon.tex'), line: 1, source: 'x', rev: 1, why }), null);
    assert.equal(why.reason, 'not-current');
  } finally {
    renderer.dispose();
    rmSync(workDir, { recursive: true, force: true });
  }
});

test('a current pass says "no ink" for a line it typeset nothing for, and "not an input" for other text', { timeout: 60_000 }, async () => {
  const workDir = mkdtempSync(path.join(tmpdir(), 'tdom-jump-why-'));
  const renderer = new CanonicalRenderer({ workDir });
  const child = 'ChildContentWitness';
  const rootSource = ['\\documentclass{article}', '\\newcommand\\unused{}', '\\begin{document}', 'RootWitness', '\\input{child}', '\\end{document}'].join('\n');
  const file = path.join(workDir, 'child.tex');
  const root = path.join(workDir, 'canon.tex');
  writeFileSync(file, child);
  try {
    await renderer.ensure(rootSource, 1);
    assert.ok(await renderer.jumpToSource({ file: root, line: 4, source: rootSource, rev: 1 }));
    // (a preamble line is answered with the output nearest it: only a line
    // with nothing typeset anywhere near, such as one past the end, has none)
    const past = {};
    assert.equal(await renderer.jumpToSource({ file: root, line: 40, source: rootSource, rev: 1, why: past }), null);
    assert.equal(past.reason, 'no-ink');
    const changed = {};
    assert.equal(await renderer.jumpToSource({ file, line: 1, source: `${child} new`, rootSource, rev: 1, why: changed }), null);
    assert.equal(changed.reason, 'not-an-input');
  } finally {
    renderer.dispose();
    rmSync(workDir, { recursive: true, force: true });
  }
});
