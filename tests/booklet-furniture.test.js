import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { CheckpointEngine } from '../engine/checkpoint/engine-v3.js';
import { furnitureBands } from '../engine/checkpoint/canonical-arrival.js';
import { hfBandChunkKey, hfRenderChunkKey } from '../engine/checkpoint/display-list.js';
import { bandPaint, samePaint } from '../engine/checkpoint/furniture-render.js';

const fixture = new URL('../../TeX64-Pro/testing/issue-121-wip/r9/booklet/math-print.tex', import.meta.url);
const skip = !existsSync(fixture) ? 'requires the TeX64-Pro audit booklet'
  : spawnSync('lualatex', ['--version']).status !== 0 ? 'lualatex unavailable' : false;

const lesson = String.raw`\clearpage
\Kou{14}{総合演習}
\begin{ascolorbox4A}[出典：オリジナル]{例題1}
不等式 $x^2-4x+3<0$ を解け。
\end{ascolorbox4A}
\begin{memo}
左辺を因数分解すると $(x-1)(x-3)$ になる。
\end{memo}
\begin{zuhyo}
\begin{tikzpicture}[x=8mm,y=6mm]
\draw[->] (-.5,0) -- (4.5,0) node[right] {$x$};
\draw[domain=-.2:4.2,samples=40,thick] plot (\x,{(\x)^2-4*\x+3});
\end{tikzpicture}

\end{zuhyo}



`;

async function until(check, timeout) {
  const end = performance.now() + timeout;
  do {
    const result = check();
    if (result) return result;
    await delay(50);
  } while (performance.now() < end);
  return null;
}

test('adding lesson 14 keeps sheets 25–28 and draws the new booklet bands before canonical', { skip, timeout: 420_000 }, async () => {
  const source = readFileSync(fixture, 'utf8');
  const workDir = mkdtempSync(path.join(tmpdir(), 'tdom-booklet-furniture-'));
  const realFork = process.env.TDOM_ISO_REAL_FORK;
  process.env.TDOM_ISO_REAL_FORK = '1';
  const engine = new CheckpointEngine({ workDir });
  const slots = ['h', 'f'];
  const preceding = [25, 26, 27, 28];
  const edited = [29, 30];
  const list = (sheet) => engine.getDisplayLists()[sheet - 1];
  const shown = (sheet, id) => list(sheet)?.commands.some((command) => command.chunk === id);
  const bands = (sheet, key) => slots.map((slot) => key(sheet, slot));
  const openingReady = () => [...preceding, 29].every((sheet) => bands(sheet, hfBandChunkKey)
    .every((key) => shown(sheet, key) && engine.chunks.get(key)?.rec?.verified === true));
  try {
    const opened = await engine.open(source, 'main.tex');
    // A completed local sheet is insufficient: blocks farther down the
    // opening walk can still change which physical sheet owns that ink.
    assert.ok(engine.blocks.every((block) => block.galley), 'the first reply includes the full resident walk');
    for (const sheet of [3, 4, 10, 25, 29]) {
      assert.ok(opened.patches.some((patch) => patch.type === 'replace-page' && patch.page === sheet),
        `the initial layout includes a display list for sheet ${sheet}`);
    }
    assert.ok(engine.opening, 'the walk alone does not settle the opening');
    assert.equal(engine.hfPending, true, 'opening already owes the booklet furniture');
    assert.equal(engine.hfJob, null, 'no header worker is admitted during opening');
    assert.equal(engine.hfWatchVersion, null, 'opening continuations carry no furniture trace');
    const openingCommands = engine.getDisplayLists().flatMap((page) => page.commands);
    assert.ok(openingCommands.every((cmd) => cmd.op !== 'folio' && cmd.src !== '_hf'),
      'opening provisional pages publish no furniture');
    const canonical = await until(() => {
      const info = engine.canonical.info();
      return info.id && info.rev === engine.srcRev ? info : null;
    }, 180_000);
    assert.ok(canonical, 'the scheduled opening baseline is accepted');
    const ready = await until(openingReady, 100_000);
    const binding = engine.hfBindings?.get(canonical.id);
    assert.ok(ready, 'opening bands and correspondence: ' + JSON.stringify({
      opening: Boolean(engine.opening), residentPages: engine.pages.length,
      rescueQueued: engine.rescueQueue.size, rescuePumping: engine.rescuePumping,
      canonicalBodyWork: engine.canonicalBodyWork, headerPending: engine.hfPending,
      headerCurrent: engine.hfSig === engine.currentSpecs?.sig, checking: binding?.checking,
      bands: [...preceding, 29].map(sheet => ({
        sheet, verified: binding?.pages.get(sheet)?.verified,
        visible: bands(sheet, hfBandChunkKey).map(key => Boolean(shown(sheet, key)))
      })),
      diagnostics: engine.diagnostics.slice(-5)
    }));
    assert.equal(engine.opening, null, 'furniture lands after the opening queues drain');
    const signatures = preceding.map((sheet) => list(sheet).body);
    const versions = preceding.flatMap((sheet) => bands(sheet, hfBandChunkKey).map((key) => engine.chunks.get(key).v));

    // Exercise resident append paint against the opening generation.
    engine.canonical.schedule = () => {};
    const note = '巻末（29ページ）にまとめてある。';
    const at = source.indexOf(note) + note.length;
    assert.ok(at >= note.length);
    await engine.edit(at, at, 'テスト');
    await engine.warmPage(28);
    const appendix = engine.getSource().indexOf('%% ================= 付録');
    assert.ok(appendix > 0);
    await engine.edit(appendix, appendix, lesson);
    const appendedAt = performance.now();
    const early = await until(() => edited.every((sheet) => bands(sheet, hfRenderChunkKey)
      .every((key) => shown(sheet, key))), 8_000);
    assert.ok(early, 'both provisional bands on sheets 29 and 30 within eight seconds');
    const snapshots = [];
    for (const ms of [8_000, 45_000]) {
      await delay(Math.max(0, appendedAt + ms - performance.now()));
      assert.notEqual(engine.canonical.info().rev, engine.srcRev);
      assert.deepEqual(preceding.map((sheet) => list(sheet).body), signatures, `sheets 25–28 keep their body signatures at +${ms} ms`);
      assert.deepEqual(preceding.flatMap((sheet) => bands(sheet, hfBandChunkKey).map((key) => shown(sheet, key) && engine.chunks.get(key).v)),
        versions, `sheets 25–28 still show their original bands at +${ms} ms`);
      snapshots.push(edited.flatMap((sheet) => bands(sheet, hfRenderChunkKey).map((key) => {
        assert.ok(shown(sheet, key), `${key} is visible at +${ms} ms`);
        return engine.chunks.get(key).svg;
      })));
    }

    const exact = await engine.canonical.ensure(engine.getSource(), engine.srcRev);
    const bounds = furnitureBands(engine.geometry);
    let index = 0;
    for (const sheet of edited) {
      const text = spawnSync('pdftotext', ['-f', String(sheet), '-l', String(sheet), '-layout', exact.pdf, '-'], { encoding: 'utf8' });
      assert.equal(text.status, 0, text.stderr);
      const words = text.stdout.replace(/\s+/g, '');
      assert.ok(words.includes(sheet === 29 ? '数学第14講総合演習' : '数学参考問題の答え'));
      assert.ok(words.includes(`―${sheet}―`));
      const svgPath = path.join(workDir, `exact-${sheet}.svg`);
      const convert = spawnSync('pdftocairo', ['-svg', '-f', String(sheet), '-l', String(sheet), '-noshrink', '-nocenter', exact.pdf, svgPath]);
      assert.equal(convert.status, 0, String(convert.stderr));
      const full = readFileSync(svgPath, 'utf8');
      for (const slot of slots) {
        const [a, b] = bounds[slot];
        const rows = slot === 'h' ? [a, b - 4] : [a + 4, b];
        const oracle = bandPaint(full, ...rows);
        assert.ok(oracle.length, `sheet ${sheet} ${slot} has exact ink`);
        for (const snap of snapshots) {
          assert.ok(samePaint(bandPaint(snap[index], ...rows), oracle), `sheet ${sheet} ${slot} matches exact paint within 1 bp`);
        }
        index++;
      }
    }
  } finally {
    if (realFork === undefined) delete process.env.TDOM_ISO_REAL_FORK;
    else process.env.TDOM_ISO_REAL_FORK = realFork;
    await engine.close();
    rmSync(workDir, { recursive: true, force: true });
  }
});
