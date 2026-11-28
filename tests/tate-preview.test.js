import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

import { CheckpointEngine } from '../engine/checkpoint/engine-v3.js';
import { classifyDocument, appendVerificationLine, verifyTokens } from '../engine/checkpoint/safety.js';
import { compareCanonicalText } from '../engine/checkpoint/canonical-verification.js';
import { locateJump, parseJumpText, parseJumpTsv } from '../engine/checkpoint/jump-sync.js';

const fixture = name => readFileSync(new URL(`./fixtures/tate/${name}.tex`, import.meta.url), 'utf8');
const renderPage = (pdf, page) => execFileSync('pdftoppm', ['-r', '72', '-f', String(page), '-l', String(page), pdf], { maxBuffer: 8 * 1024 * 1024 });
const originalShip = process.env.TDOM_SHIP;

async function withEngine(run, { shipping = false } = {}) {
  const workDir = mkdtempSync(path.join(tmpdir(), 'tdom-tate-'));
  process.env.TDOM_SHIP = shipping ? '1' : '0';
  const engine = new CheckpointEngine({ workDir, docDir: workDir });
  try {
    await run(engine);
  } finally {
    await engine.close();
    if (originalShip === undefined) delete process.env.TDOM_SHIP;
    else process.env.TDOM_SHIP = originalShip;
  }
}

async function until(read, message, timeout = 45000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = read();
    if (value) return value;
    await sleep(25);
  }
  assert.fail(message);
}

async function currentCanonical(engine) {
  return until(() => {
    const info = engine.canonical.info();
    assert.ok(info.errorRev !== engine.srcRev, info.error);
    return info.rev === engine.srcRev && info;
  }, 'waiting for exact pages of the current source');
}

function assertExact(engine, report) {
  assert.equal(report.previewPolicy, 'shipping-exact');
  assert.ok(report.previewReasons.includes('vertical writing'));
  assert.equal(report.residentEditCandidate, false);
  assert.deepEqual(report.patches, []);
  assert.deepEqual(engine.getDisplayLists(), []);
}

test('direction syntax is a document safety signal, including in two-column and mixed paper', () => {
  const classify = (preamble, body) => classifyDocument(preamble, body).previewPolicy;
  for (const cls of ['ltjtarticle', 'ltjtbook', 'ltjtreport']) {
    assert.equal(classify(String.raw`\documentclass{${cls}}`, ''), 'shipping-exact');
  }
  const yoko = String.raw`\documentclass{ltjsarticle}`;
  assert.equal(classify(yoko, String.raw`\tate 本文`), 'shipping-exact');
  assert.equal(classify(yoko + '\n' + String.raw`\tate`, ''), 'shipping-exact');
  assert.equal(classify(yoko, String.raw`\parbox<t>{2cm}{文章}`), 'shipping-exact');
  assert.equal(classify(yoko, String.raw`\hbox{\tate 文章}`), 'shipping-exact');
  assert.equal(classify(String.raw`\documentclass[twocolumn,tate,paper=a5]{jlreq}`, String.raw`\onecolumn`), 'shipping-exact');
  assert.equal(classify(yoko, String.raw`\verb|\tate| % \parbox<t>{2cm}{文章}`), 'structured');
});

test('verification collects Japanese character bigrams across runs on one line', () => {
  const text = '庭に小さな池があります。水面には夕焼けが映っています。静かな風が吹きます。';
  const page = { number: 1, draw: [{ u: { blockId: 'body', ln: { runs: [...text].map(t => ({ t })) } } }] };
  const tokens = [];
  appendVerificationLine(page.draw[0].u.ln.runs, tokens);
  assert.deepEqual(tokens, verifyTokens(text));
  assert.ok(tokens.length >= 20);
  const codepoints = [];
  appendVerificationLine([{ t: '𠮷' }, { t: '野' }, { t: ' ' }, { t: '山' }, { t: '川' }, { t: 'a' }, { t: 'b' }], codepoints);
  assert.deepEqual(codepoints, ['𠮷野', '山川']);
  assert.deepEqual(compareCanonicalText([page], [text], 1).mismatches, []);
  assert.deepEqual([...compareCanonicalText([page], ['全然違う文章です。'], 1).demote], ['body']);
});

test('tate Jump rows read down and left, including a short heading', () => {
  const glyph = (char, x, y) => `<word xMin="${x}" yMin="${y}" xMax="${x + 10}" yMax="${y + 14}">${char}</word>`;
  const heading = [...'設問'];
  // Poppler can put glyphs from different tate columns in one XML line.
  const xml = [...'本日の設問'].map((char, i) => {
    const y = 20 + i * 10;
    return `<line>${glyph(char, 70, y)}${heading[i] ? glyph(heading[i], 90, y) : ''}</line>`;
  });
  const rows = parseJumpText(`<page>${xml.reverse().join('')}</page>`);
  assert.deepEqual(rows.map(row => row.text), ['設問', '本日の設問']);
  assert.deepEqual(locateJump(rows, String.raw`\section*{設問}`, []),
    { page: 1, direction: 'tate', boxes: [{ left: 90, top: 20, right: 100, bottom: 44 }] });
});

test('a real tate edit ships pixel-identical vertical pages and supports exact Jump both ways', { timeout: 120000 }, async () => {
  await withEngine(async engine => {
    const source = fixture('t01-ltjtarticle');
    assertExact(engine, await engine.open(source));
    assert.equal(engine.getGeometry().writingDirection, 'tate');
    const initial = await currentCanonical(engine);
    assert.equal(engine.getDOM().pageCount, initial.pageCount);
    await until(() => engine.shipping.info().baselineReady && !engine.shipBooting, 'waiting for a certified shipping baseline');
    let wave;
    engine.onShipWave = info => { wave = info; };
    const offset = source.indexOf('名前はまだ無い');
    assertExact(engine, await engine.edit(offset, offset, '私の'));
    const current = engine.getSource();
    const rev = engine.srcRev;
    await until(() => wave?.srcRev === rev && wave, 'waiting for a ship wave of this exact-only edit');
    const shippedPdf = engine.shipping.publishedPdf;
    const compiled = await currentCanonical(engine);
    const canonicalPdf = engine.canonical.last.pdf;
    for (const page of wave.pages) assert.deepEqual(renderPage(shippedPdf, page), renderPage(canonicalPdf, page));
    assert.deepEqual(engine.getDisplayLists(), []);
    assert.equal(engine.getDOM().pageCount, compiled.pageCount);

    const file = path.join(engine.canonical.workDir, 'canon.tex');
    const rows = parseJumpText(execFileSync('pdftotext', ['-bbox-layout', canonicalPdf, '-'], { encoding: 'utf8' }));
    const tsvRows = parseJumpTsv(execFileSync('pdftotext', ['-tsv', canonicalPdf, '-'], { encoding: 'utf8' }));
    for (const needle of ['私の名前はまだ無い', '書生という人間中', 'スーと持ち上げ', '薬缶だ']) {
      const line = current.split('\n').findIndex(value => value.includes(needle)) + 1;
      const row = rows.find(item => item.direction === 'tate' && item.text.includes(needle));
      assert.ok(row, needle);
      assert.ok(tsvRows.some(item => item.direction === 'tate' && item.text.includes(needle)));
      const why = {};
      const jump = await engine.canonical.jumpToSource({ file, line, source: current, rev, why, verticalWriting: true });
      assert.equal(jump?.direction, 'tate', JSON.stringify(why));
      assert.equal(jump.line, line);
      assert.equal(jump.page, row.page);
      assert.ok(jump.boxes.some(box => box.left === row.box.left && box.top === row.box.top), needle);
      assert.ok(jump.boxes.every(box => box.bottom - box.top > box.right - box.left));
      const glyph = row.glyphs[row.text.indexOf(needle) + 1];
      const point = { page: row.page, x: (glyph.box.left + glyph.box.right) / 2, y: (glyph.box.top + glyph.box.bottom) / 2 };
      const reverse = await engine.canonical.verticalSourceAtPoint({
        ...point, id: compiled.id, rootSource: current, inputs: [{ file, source: current }],
      });
      assert.equal(reverse?.hit?.line, line, needle);
    }
    const end = current.indexOf('\\end{document}');
    await engine.edit(end, end, '\\char"732B\\par\n');
    await currentCanonical(engine);
    const why = {};
    const answer = await engine.canonical.jumpToSource({
      file, line: current.slice(0, end).split('\n').length, source: engine.getSource(),
      rev: engine.srcRev, why, verticalWriting: true,
    });
    assert.equal(answer, null);
    assert.equal(why.reason, 'unreadable');
  }, { shipping: true });
});

test('LuaTeX-ja boot detects an indirect class, and rechecks edited preambles', { timeout: 120000 }, async () => {
  await withEngine(async engine => {
    writeFileSync(path.join(engine.docDir, 'directionfixture.cls'), String.raw`\LoadClass{ltjtarticle}`);
    const source = '\\documentclass{directionfixture}\n\\begin{document}\n小さな池の水が光ります。\n\\end{document}\n';
    const plain = source.replace('directionfixture', 'ltjsarticle');
    assertExact(engine, await engine.open(source));
    assert.equal(engine.getGeometry().writingDirection, 'tate');
    await currentCanonical(engine);
    const start = source.indexOf('directionfixture');
    const updated = await engine.edit(start, start + 'directionfixture'.length, 'ltjsarticle');
    assert.equal(updated.previewPolicy, 'structured');
    assert.equal(engine.getGeometry().writingDirection, 'yoko');
    assert.ok(engine.getDisplayLists().some(list => list.commands.some(command => command.op === 'glyphs')));
    await engine.canonical.ensure(plain, engine.srcRev);
    assertExact(engine, await engine.edit(start, start + 'ltjsarticle'.length, 'directionfixture'));
    assert.equal(engine.getGeometry().writingDirection, 'tate');
  });
});

test('the mixed direction and twocolumn tate fixtures use native pages even with shipping disabled', { timeout: 240000 }, async () => {
  for (const [name, direction] of [
    ['t03-jlreq-tate-article', 'tate'],
    ['t05-jlreq-tate-book', 'tate'],
    ['t08a-yoko-with-tate-boxes', 'yoko'],
    ['t08b-tate-with-yoko-boxes', 'tate'],
  ]) {
    await withEngine(async engine => {
      const source = fixture(name);
      const twocolumn = name.startsWith('t03') ? source.replace('[tate,', '[tate,twocolumn,') : source;
      const report = await engine.open(twocolumn);
      assertExact(engine, report);
      assert.equal(engine.getGeometry().writingDirection, direction);
      const canonical = await currentCanonical(engine);
      assert.equal(engine.getDOM().pageCount, canonical.pageCount);
      const where = engine.getSource().indexOf('\\end{document}');
      const edited = await engine.edit(where, where, '\\par\nこの文を加えます。\n');
      assertExact(engine, edited);
      assert.equal(edited.canonical.displayDemandRev, edited.srcRev);
      await currentCanonical(engine);
    });
  }
});

test('a leading body direction command bypasses the horizontal resident page', { timeout: 120000 }, async () => {
  await withEngine(async engine => {
    const source = fixture('t00-yoko-control');
    assert.equal((await engine.open(source)).previewPolicy, 'structured');
    await currentCanonical(engine);
    const start = source.indexOf('\\begin{document}') + '\\begin{document}'.length;
    assertExact(engine, await engine.edit(start, start, '\n\\tate\n'));
    await currentCanonical(engine);
    assert.ok(parseJumpText(execFileSync('pdftotext',
      ['-bbox-layout', engine.canonical.last.pdf, '-'], { encoding: 'utf8' })).some(row => row.direction === 'tate'));
  });
});

test('a package-created tate box is canonical-only even when its command is invisible to the source scan', { timeout: 60000 }, async () => {
  await withEngine(async engine => {
    writeFileSync(path.join(engine.docDir, 'directionbox.sty'), String.raw`\newcommand\hiddenbox{\hbox{\tate 縦の箱}}`);
    const source = String.raw`\documentclass{ltjsarticle}
\usepackage{directionbox}
\begin{document}
横組みの前の文です。

\hiddenbox

横組みの後ろの文です。
\end{document}
`;
    const report = await engine.open(source);
    assert.equal(report.previewPolicy, 'structured');
    const block = engine.blocks.find(item => item.text.includes('\\hiddenbox'));
    assert.equal(block.fidelity.canonicalOnly, true);
    const commands = engine.getDisplayLists().flatMap(list => list.commands).filter(command => command.src === block.id);
    assert.ok(commands.some(command => command.op === 'canon'));
    assert.ok(commands.every(command => command.op !== 'glyphs' && command.op !== 'chunk'));
    await currentCanonical(engine);
  });
});

test('the Japanese yoko controls verify without new demotions', { timeout: 100000 }, async () => {
  const sources = ['t00-yoko-control', 't15y-floats-yoko-control', 't18y-fancyhdr-yoko-control'].map(fixture);
  for (const source of sources) {
    await withEngine(async engine => {
      engine.canonical.idleMs = 25;
      const report = await engine.open(source);
      assert.equal(report.previewPolicy, 'structured');
      assert.equal(engine.getGeometry().writingDirection, 'yoko');
      const info = await currentCanonical(engine);
      await until(() => engine.verifyState?.rev === info.rev, 'waiting for verification of yoko pages');
      assert.deepEqual([...engine.fidelityDemoted], []);
      assert.ok(engine.blocks.every(block => !block.galley?.tdomTate));
    });
  }
});
