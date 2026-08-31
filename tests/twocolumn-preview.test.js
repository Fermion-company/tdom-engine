import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { CheckpointEngine } from '../engine/checkpoint/engine-v3.js';
import {
  canonicalAnchorStructuralState,
  captureCanonicalAnchorBase,
  planTerminalCanonicalAnchor,
} from '../engine/checkpoint/canonical-anchor.js';

const available = await promisify(execFile)('lualatex', ['--version'], { timeout: 15_000 }).then(
  () => true,
  () => false
);
const opts = available ? {} : { skip: 'lualatex not installed' };

test('ordinary prose after a real onecolumn→twocolumn switch stays on the subsecond resident path', opts, async () => {
  const workDir = mkdtempSync(path.join(tmpdir(), 'tdom-twocolumn-preview-'));
  const engine = new CheckpointEngine({ workDir });
  try {
    const middle = `Middle prose ${'word '.repeat(24)}tail`;
    const decoratedMiddle = String.raw`\textbf{LIVE-EDIT:} ${middle}`;
    const source = String.raw`\documentclass{article}
\begin{document}
\onecolumn
Full-width title prose.

\twocolumn
First column prose.

${decoratedMiddle}

Last prose.
\end{document}
`;
    await engine.open(source);
    await engine.exportPDF();
    const base = engine.canonical.info();
    assert.equal(base.rev, engine.srcRev, 'last-good physical PDF is ready');
    assert.equal(engine.mode, 'structured');
    assert.equal(engine.previewPolicy, 'canonical-anchor');
    assert.equal(engine.getGeometry().twocolumn, 0, 'root geometry remains the class default');
    assert.ok(engine.blocks.every((block) => block.closure?.closed !== false),
      'real LaTeX column switches complete without recovery errors');

    const at = engine.getSource().indexOf(middle) + middle.length;
    const baseSnapshot = captureCanonicalAnchorBase({
      blocks: engine.blocks,
      domBlocks: engine.getDOM().blocks,
      edit: { start: at, end: at, text: ' fast' },
      certificate: engine.canonical.generationCertificate(),
    });
    assert.ok(baseSnapshot, 'the pre-edit galley is frozen against the immutable canonical generation');
    const t0 = performance.now();
    const report = await engine.edit(at, at, ' fast');
    const wall = performance.now() - t0;
    assert.ok(wall < 500, `resident prose update should stay subsecond (got ${wall.toFixed(0)}ms)`);
    assert.equal(report.previewPolicy, 'canonical-anchor');
    assert.ok(report.stats.blocksTypeset <= 2, 'only the edited paragraph and convergence probe run');

    const plan = planTerminalCanonicalAnchor({
      blocks: engine.blocks,
      domBlocks: engine.getDOM().blocks,
      report,
      geometry: engine.getGeometry(),
      edit: { start: at, end: at, text: ' fast' },
      baseSnapshot,
      acceptedAt: t0,
    });
    const editedBlock = engine.blocks.find((block) => block.text.includes('tail fast'));
    assert.equal(editedBlock?.galley?.state?.['tdom@twocolumn'], 1);
    assert.ok(editedBlock?.galley?.state?.['tdom@columnwidth'] > 0);
    assert.ok((editedBlock?.galley?.items ?? []).filter((item) => item.k === 'box').length > 1,
      'fixture is a wrapped paragraph');
    assert.equal(plan?.blockId, editedBlock?.id);
    assert.ok(plan?.changedLines.length >= 1, 'the complete base-to-current visual effect set is retained');
    assert.equal(plan?.linePlans.length, plan?.changedLines.length);
    assert.equal(plan?.baseLineWitnesses.length, plan?.currentLineWitnesses.length);
    assert.equal(plan?.geometry?.twocolumn, 1, 'anchor proof uses the block active layout');
    assert.deepEqual(plan?.source, baseSnapshot.source, 'the whole canonical block range is queried, not one source line');
  } finally {
    await engine.close();
    rmSync(workDir, { recursive: true, force: true });
  }
});

test('Japanese prose uses the same certified empty-rule path in one and two columns', opts, async () => {
  for (const columns of ['onecolumn', 'twocolumn']) {
    const workDir = mkdtempSync(path.join(tmpdir(), `tdom-ja-${columns}-preview-`));
    const engine = new CheckpointEngine({ workDir });
    try {
      const target = 'アイエ雨青wうあお和のえおwなおね';
      const source = String.raw`\documentclass[${columns}]{ltjsarticle}
\usepackage[most]{tcolorbox}
\begin{document}
\begin{tcolorbox}[breakable,title={確定済みの装飾枠}]
この装飾枠は通常の LuaLaTeX 経路で確定させる。
\end{tcolorbox}

${target}
\end{document}
`;
      await engine.open(source);
      await engine.exportPDF();
      const targetBlock = engine.blocks.find((block) => block.text.includes(target));
      assert.ok(targetBlock, `${columns}: target paragraph is independently segmented`);
      assert.equal(targetBlock.galley.backend?.schema, 2);
      assert.equal(targetBlock.galley.backend?.emptyRuleSubtype, 3);
      const rules = targetBlock.galley.items.flatMap((item) => item.runs ?? []).filter((run) => run.rule);
      assert.ok(rules.length > 0, `${columns}: real LuaTeX-ja emits structural rules`);
      assert.ok(rules.every((run) => run.rv === 2 && run.rs === 3),
        `${columns}: the raw empty_rule subtype survives serialization`);

      const at = engine.getSource().indexOf(target) + target.length;
      const baseSnapshot = captureCanonicalAnchorBase({
        blocks: engine.blocks,
        domBlocks: engine.getDOM().blocks,
        edit: { start: at, end: at, text: 'q' },
        certificate: engine.canonical.generationCertificate(),
      });
      assert.ok(baseSnapshot, `${columns}: Japanese paint witnesses are capturable`);
      const t0 = performance.now();
      const report = await engine.edit(at, at, 'q');
      const wall = performance.now() - t0;
      assert.ok(wall < 500, `${columns}: resident edit stays subsecond (got ${wall.toFixed(0)}ms)`);

      if (columns === 'twocolumn') {
        const editedBlock = engine.blocks.find((block) => block.id === targetBlock.id);
        assert.notEqual(JSON.stringify(editedBlock?.stateVec), baseSnapshot.stateVec,
          'the final glyph may legitimately change volatile paragraph-tail state');
        assert.equal(canonicalAnchorStructuralState(editedBlock?.stateVec), baseSnapshot.structuralStateVec,
          'counters and active column geometry remain identical');
        const plan = planTerminalCanonicalAnchor({
          blocks: engine.blocks,
          domBlocks: engine.getDOM().blocks,
          report,
          geometry: engine.getGeometry(),
          edit: { start: at, end: at, text: 'q' },
          baseSnapshot,
          acceptedAt: t0,
        });
        assert.equal(plan?.blockId, targetBlock.id);
        assert.ok(plan?.changedLines.length >= 1,
          'two-column Japanese prose reaches the same canonical-anchor proof as Latin prose');
      }
    } finally {
      await engine.close();
      rmSync(workDir, { recursive: true, force: true });
    }
  }
});

test('cursor-locus warming makes the first edit fast under the app checkpoint budget', opts, async () => {
  const previousMax = process.env.TDOM_MAX_CHECKPOINTS;
  const previousShip = process.env.TDOM_SHIP;
  process.env.TDOM_MAX_CHECKPOINTS = '8';
  process.env.TDOM_SHIP = '0';
  const workDir = mkdtempSync(path.join(tmpdir(), 'tdom-cursor-warm-preview-'));
  const engine = new CheckpointEngine({ workDir });
  try {
    const target = '末尾で最初に入力する通常の本文です';
    const paragraphs = Array.from({ length: 30 }, (_, index) =>
      `段落 ${index + 1}: 日本語の通常本文を十分な長さで配置して疎なチェックポイントを検証します。`
    ).join('\n\n');
    const source = String.raw`\documentclass[twocolumn]{ltjsarticle}
\begin{document}
${paragraphs}

${target}
\end{document}
`;
    await engine.open(source);
    const at = engine.getSource().indexOf(target) + target.length;
    const targetIndex = engine.blocks.findIndex((block) => block.text.includes(target));
    assert.ok(targetIndex > 8, 'fixture exceeds the sparse app checkpoint budget');

    const warmed = await engine.warmEditOffset(at);
    assert.equal(warmed.status, 'ready');
    assert.equal(warmed.target, targetIndex);
    assert.ok(engine.getDOM().checkpoints.includes(targetIndex));
    assert.ok(engine.getDOM().checkpoints.includes(targetIndex + 1));

    const report = await engine.edit(at, at, 'あ');
    assert.ok(report.stats.blocksTypeset <= 2,
      `first edit should start at the warmed locus (typeset ${report.stats.blocksTypeset} blocks)`);
    assert.ok(report.stats.typesetMs < 500,
      `warmed first edit should be subsecond (got ${report.stats.typesetMs}ms)`);
  } finally {
    await engine.close();
    rmSync(workDir, { recursive: true, force: true });
    if (previousMax === undefined) delete process.env.TDOM_MAX_CHECKPOINTS;
    else process.env.TDOM_MAX_CHECKPOINTS = previousMax;
    if (previousShip === undefined) delete process.env.TDOM_SHIP;
    else process.env.TDOM_SHIP = previousShip;
  }
});
