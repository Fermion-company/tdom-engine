import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import { readSyncTeXSourcePage, sourceBoxesOnPage, visitSyncTeXSheets } from '../engine/checkpoint/pdf-source-boxes.js';

const header = ['SyncTeX Version:1', 'Magnification:1000', 'Unit:1', 'X Offset:0', 'Y Offset:0', 'Content:'];
async function withSync(lines, run) {
  const dir = await mkdtemp(path.join(tmpdir(), 'tdom-source-page-'));
  try {
    const file = path.join(dir, 'paper.synctex.gz');
    await writeFile(file, gzipSync(lines.join('\r\n')));
    await run(file);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test('only the requested sheet is retained, including later input declarations and split UTF-8 sequences', async () => {
  // A multi-byte filename crosses the gzip output chunk boundary.
  const file = '/tmp/原稿.tex', prefix = header.join('\r\n') + '\r\n';
  const padding = '!' + ' '.repeat(65536 - Buffer.byteLength(prefix + '!\r\nInput:1:/tmp/') - 1);
  const rows = ['(2,7:65536,131072:65536,65536,0', 'h2,8:131072,131072:65536,0,0', ')'];
  const lines = [...header, padding, 'Input:1:' + file, '{1', '(1,2:0,0:0,0,0', ')', '}1', '{2', ...rows, '}2',
    'Input:2:' + file, 'Post scriptum:'];
  await withSync(lines, async filename => {
    const page = await readSyncTeXSourcePage(filename, 2);
    assert.deepEqual(page.lines, rows);
    assert.equal(page.inputs.get(1), file);
    const query = line => sourceBoxesOnPage(page, { file, page: 2, startLine: line, endLine: line });
    const [parent] = query(7), [child] = query(8);
    assert.equal(child.parentId, parent.id);
    assert.deepEqual(child.ancestors, [parent.id]);
    assert.equal(child.parentChildCount, 1);
    assert.equal(child.empty, true);
    assert.equal(query(2).length, 0);
  });
});

test('a repeated page or a late transform invalidates the page even after its content has ended', async () => {
  for (const suffix of [['{1', '}1'], ['Post scriptum:', 'X Offset:1'], ['{2', '}3']]) {
    await withSync([...header, '{1', '}1', ...suffix], async filename => {
      assert.equal(await readSyncTeXSourcePage(filename, 1), null);
    });
  }
});

test('replay rows keep their input file and translate each root feed to its original line', async () => {
  const lines = [...header, 'Input:1:/ship/feed-u7.tex', 'Input:2:/ship/input-mirror/child.tex',
    'Input:3:/ship/driver-ship.tex', '{1', '(1,2:0,0:65536,65536,0',
    'h2,2:0,0:65536,65536,0', 'h3,2:0,0:65536,65536,0', ')', '}1', 'Post scriptum:'];
  await withSync(lines, async filename => {
    const sheet = await readSyncTeXSourcePage(filename, 1);
    const sourceInputs = new Map([[1, { file: '/doc/main.tex', offset: 20 }],
      [2, { file: '/doc/child.tex', offset: 0 }]]);
    const boxes = sourceBoxesOnPage(sheet, { sourceInputs, page: 1, startLine: 1, endLine: Infinity });
    assert.deepEqual(boxes.map(row => [row.file, row.line]), [['/doc/main.tex', 22], ['/doc/child.tex', 2]]);
    assert.equal(boxes[1].parentId, boxes[0].id);
  });
});

test('the DVI origin translates page coordinates only for an explicitly selected DVI engine', async () => {
  const source = '/doc/main.tex';
  for (const format of ['dvi', 'pdf']) {
    const lines = ['SyncTeX Version:1', 'Input:1:' + source, 'Output:' + format, 'Magnification:1000',
      'Unit:1', 'X Offset:4736287', 'Y Offset:4736287', 'Content:', '{1',
      '(1,4:0,0:65536,65536,0', ')', '}1', 'Post scriptum:'];
    await withSync(lines, async filename => {
      assert.equal(await readSyncTeXSourcePage(filename, 1), null);
      const sheet = await readSyncTeXSourcePage(filename, 1, { dvi: true });
      if (format === 'pdf') {
        assert.equal(sheet, null);
        return;
      }
      const [row] = sourceBoxesOnPage(sheet, { file: source, page: 1, startLine: 4, endLine: 4 });
      assert.ok(Math.abs(row.box.left - 72) < 0.001);
      assert.ok(Math.abs(row.box.bottom - 72) < 0.001);
      assert.ok(Math.abs(row.box.right - row.box.left - 72 / 72.27) < 0.001);
    });
  }
});

test('a cross-page lookup visits sheets in order and discards counts from invalid or cancelled streams', async () => {
  await withSync([...header, '{1', 'first', '}1', '{2', 'second', '}2'], async filename => {
    const seen = [];
    assert.equal(await visitSyncTeXSheets(filename, (page, lines) => seen.push([page, lines])), true);
    assert.deepEqual(seen, [[1, ['first']], [2, ['second']]]);
    await assert.rejects(visitSyncTeXSheets(filename, () => {}, { signal: AbortSignal.abort() }), { name: 'AbortError' });
  });
  await withSync([...header, '{1', '}1', '{1', '}1'], async filename => {
    assert.equal(await visitSyncTeXSheets(filename, () => {}), false);
  });
});
