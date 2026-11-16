// A reference to a label the document defines by other means than \label
// (xr's \externaldocument, \newlabel lines read from a file, the chapter
// window of a long document) keeps its value when its paragraph is typeset
// again; a label the engine held and lost still reads ?? (label-table.js).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { CheckpointEngine } from '../engine/checkpoint/engine-v3.js';
import { LabelTable } from '../engine/checkpoint/label-table.js';
import { drain } from '../tools/harness.mjs';

test('the label table remembers every key it has held', () => {
  const table = new LabelTable([['a', '1']]);
  table.set('b', '2');
  table.delete('a');
  assert.deepEqual([...table.keys()], ['b']);
  assert.ok(table.ever.has('a') && table.ever.has('b') && !table.ever.has('c'));
});

const texReady = spawnSync('lualatex', ['--version']).status === 0;

test('a reference to a label from outside the document survives a keystroke in its paragraph',
  { skip: !texReady && 'lualatex not installed' }, async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'tdom-external-labels-'));
    const source = String.raw`\documentclass{article}
\makeatletter\global\@namedef{r@outside}{{7.3}{42}}\makeatother
\begin{document}
OuterMarker see section \ref{outside} of the other volume.

\section{Inside}\label{inside}

InnerMarker see section \ref{inside} here.
\end{document}
`;
    const engine = new CheckpointEngine({ workDir: path.join(root, 'work') });
    const printed = (marker) => (engine.blocks.find((b) => b.text.includes(marker)).galley.items ?? [])
      .filter((item) => item.k === 'box').map((item) => (item.runs ?? []).filter((run) => run.t).map((run) => run.t).join('')).join(' ');
    try {
      await engine.open(source);
      await drain(engine);
      assert.match(printed('OuterMarker'), /section7\.3of/, 'resolved when the document is opened');
      assert.match(printed('InnerMarker'), /section1here/);
      const at = engine.getSource().indexOf('OuterMarker') + 'OuterMarker'.length;
      await engine.edit(at, at, 'X');
      await drain(engine);
      assert.match(printed('OuterMarkerX'), /section7\.3of/, 'and after its paragraph is typeset again');
      // the engine held `inside`: once its \label is gone the reference reads ??
      const label = engine.getSource().indexOf('\\label{inside}');
      await engine.edit(label, label + '\\label{inside}'.length, '');
      await drain(engine);
      assert.match(printed('InnerMarker'), /section\?\?here/);
    } finally {
      await engine.close().catch(() => {});
      rmSync(root, { recursive: true, force: true });
    }
  });
