// What a furniture render proves (furniture-render.js), and when a sheet's
// furniture may be drawn at all (engine-v3.js #validatedFurniture). From the
// final engine release review of v0.1.33:
//  - A3: a control of an earlier timeline was requested under the TARGET's
//    page number, so another sheet of that timeline (or none at all) was
//    shipped as the control.
//  - B4: an absent control "matched" a blank exact band (samePaint([], [])).
//  - M2: two Cairo pages whose clip paths differ but share a file-local id
//    proved equal paint.
//  - M1: a choice cached for a page's spec was drawn after the sheet's
//    placement stopped being verified.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { bandPaint, controlProof, renderTimelines, samePaint } from '../engine/checkpoint/furniture-render.js';
import { hfRenderBody, furniturePageKey } from '../engine/checkpoint/page-metadata.js';
import { CheckpointEngine } from '../engine/checkpoint/engine-v3.js';
import { reconcile } from '../engine/checkpoint/pagebuilder.js';
import { placementVerified } from '../engine/checkpoint/canonical-arrival.js';
import { drain } from '../tools/harness.mjs';

const texReady = spawnSync('lualatex', ['--version']).status === 0;
const cairo = spawnSync('pdftocairo', ['-v']).status === 0;

const spec = (page, folio = page) => ({ page, folio, fmt: 'arabic', style: 'fancy', lmark: '', rmark: '', fl: '', tpl: 't', lp: '3' });
// (the control record of an earlier binding's sheet `n`: furniture-render.js historicalControls/priorControl)
const control = (gen, n, specs) => ({ page: n, specs, metas: [{ rec: { gen, n } }, { rec: { gen, n } }] });
// The id each shipped sheet carries and the folio TeX sets for it, in PDF order.
function shipments(timelines) {
  const body = hfRenderBody(timelines);
  return [...body.matchAll(/\\global\\c@page=(\d+)(?:(?!\\global\\c@page=)[\s\S])*?\\TDOM@shipfurniture\{(\d+)\}/g)]
    .map((m) => ({ folio: Number(m[1]), id: Number(m[2]) }));
}

test('a control of an earlier timeline is shipped for its own sheet, under its own folio, once per control', () => {
  const gen = { id: 1 };
  // the bound generation had three sheets, its third numbered 7; the layout now has five
  const historical = [spec(1), spec(2), spec(3, 7)];
  const current = [1, 2, 3, 4, 5].map((n) => spec(n));
  // target 5 beyond the old count, using old sheet 2; target 4 sharing that control
  const shared = control(gen, 2, historical);
  let { timelines, order } = renderTimelines(current, [5, 4], new Map([[5, shared], [4, shared]]));
  assert.equal(shared.id, 6, 'an id no sheet of the current timeline has');
  assert.deepEqual(order, [6, 4, 5], 'the control once, before the targets');
  assert.deepEqual(shipments(timelines), [{ folio: 2, id: 6 }, { folio: 4, id: 4 }, { folio: 5, id: 5 }],
    'old sheet 2 under its own folio');
  // target 2 inside the old count, using another old sheet (3, folio 7)
  const other = control(gen, 3, historical);
  ({ timelines, order } = renderTimelines(current, [2], new Map([[2, other]])));
  assert.deepEqual(shipments(timelines), [{ folio: 7, id: 6 }, { folio: 2, id: 2 }],
    'old sheet 3 is shipped, not old sheet 2');
  // two controls of two generations for the same old sheet number keep apart
  const a = control({ id: 1 }, 2, historical), b = control({ id: 2 }, 2, historical);
  ({ order } = renderTimelines(current, [4, 5], new Map([[4, a], [5, b]])));
  assert.notEqual(a.id, b.id);
  assert.deepEqual(order, [a.id, b.id, 4, 5]);
  // a control of the current timeline is the sheet itself
  const sameTimeline = { id: 3, metas: [] };
  ({ order } = renderTimelines(current, [5], new Map([[5, sameTimeline]])));
  assert.deepEqual(order, [3, 5]);
});

// One-page Cairo-like SVG, its head band painted (or not) in rows 0-40.
const page = (body) => `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="100" height="100" viewBox="0 0 100 100">
${body}
</svg>`;
const ink = page('<path fill-rule="nonzero" fill="rgb(0%, 0%, 0%)" fill-opacity="1" d="M 10 10 L 30 10 L 30 20 L 10 20 Z M 10 10 "/>');
const blank = page('');

test('a slot is proven only against a control that was actually shipped; two shipped blank slots agree', () => {
  const rows = { h: [0, 40], f: [60, 100] };
  const exact = (head, foot) => [{ svg: head }, { svg: foot }];
  const controls = new Map([
    [5, { id: 6, metas: exact(blank, blank) }], // absent control, blank exact bands
    [4, { id: 7, metas: exact(blank, blank) }], // shipped blank, blank exact
    [3, { id: 8, metas: exact(blank, blank) }], // shipped ink in the head, blank exact head
    [2, { id: 9, metas: [{ svg: ink }, undefined] }], // shipped, no exact foot band at all
  ]);
  const svgs = new Map([[7, blank], [8, ink], [9, ink]]);
  const proven = controlProof(svgs, controls, rows);
  assert.deepEqual(proven.get(6), [false, false], 'absent control: no proof for either slot');
  assert.deepEqual(proven.get(7), [true, true], 'shipped blank against blank: proven');
  assert.deepEqual(proven.get(8), [false, true], 'ink against blank: that slot alone fails');
  assert.deepEqual(proven.get(9), [true, false], 'no exact band to compare with: no proof');
});

// A PDF page (50 x 100 bp) painting a blue square in its head through the
// clip `clip`, after `before` (painted in its foot).
function clippedPdf(clip, before = '') {
  const stream = `${before}q ${clip} W n 0.2 0.4 0.8 rg 0 60 40 40 re f Q`;
  const objs = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Count 1 /Kids [3 0 R] >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 50 100] /Resources << >> /Contents 4 0 R >>',
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`];
  let pdf = '%PDF-1.4\n';
  const at = [];
  objs.forEach((o, i) => { at.push(pdf.length); pdf += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const xref = pdf.length;
  pdf += `xref\n0 5\n0000000000 65535 f \n${at.map((p) => `${String(p).padStart(10, '0')} 00000 n \n`).join('')}`;
  return pdf + `trailer\n<< /Size 5 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
}

test('clip paths are compared by what they are, not by their file-local ids', { skip: !cairo && 'pdftocairo not installed' }, () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'tdom-clip-paint-'));
  try {
    const svg = (name, pdf) => {
      writeFileSync(path.join(dir, `${name}.pdf`), pdf);
      const out = spawnSync('pdftocairo', ['-svg', path.join(dir, `${name}.pdf`), path.join(dir, `${name}.svg`)]);
      assert.equal(out.status, 0, String(out.stderr));
      return readFileSync(path.join(dir, `${name}.svg`), 'utf8');
    };
    const lower = '0 60 m 40 60 l 40 100 l h', upper = '0 60 m 40 100 l 0 100 l h';
    const a = svg('a', clippedPdf(lower));
    const b = svg('b', clippedPdf(upper));
    // the same clip as `a`, after another clipped paint in the foot: another id
    const c = svg('c', clippedPdf(lower, 'q 0 0 m 10 0 l 10 10 l h W n 0 0 0 rg 0 0 10 10 re f Q '));
    const id = (s) => [...s.matchAll(/clip-path="url\(#([^)]+)\)"/g)].map((m) => m[1]);
    assert.deepEqual(id(a), id(b), 'Cairo gives both clips the same id');
    assert.notDeepEqual(id(a).at(-1), id(c).at(-1), 'and the same clip another id after another one');
    const head = (s) => bandPaint(s, 0, 45);
    assert.ok(head(a).length && head(b).length);
    assert.equal(samePaint(head(a), head(b)), false, 'opposite triangles are different paint');
    assert.equal(samePaint(head(a), head(c)), true, 'the same triangle under another id is the same paint');
    // a reference to a definition the file does not have proves nothing
    const missing = a.replace(/<clipPath[\s\S]*?<\/clipPath>/g, '');
    assert.equal(samePaint(head(missing), head(missing)), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a sheet whose placement is not verified draws no furniture, whatever is cached for its spec', { skip: !texReady && 'lualatex not installed' }, async () => {
  const workDir = mkdtempSync(path.join(tmpdir(), 'tdom-placement-cache-'));
  const engine = new CheckpointEngine({ workDir });
  engine.canonical.schedule = () => {};
  const furniture = (list) => list.commands.filter((c) => c.src === '_hf' || c.op === 'folio');
  try {
    await engine.open(String.raw`\documentclass{article}
\pagestyle{headings}
\begin{document}
\section{Alpha}

First paragraph.

\clearpage

Second paragraph.
\end{document}
`, undefined, { canonicalBaseline: false });
    await drain(engine);
    for (let i = 0; i < 400 && engine.hfPending; i++) await new Promise((resolve) => setTimeout(resolve, 25));
    assert.equal(engine.hfPending, false);
    const verified = engine.pages;
    const first = verified[0];
    assert.equal(placementVerified(engine, first), true);
    assert.ok(furniture(engine.getDisplayLists()[0]).length, 'sheet 1 draws its folio');
    // the same spec, its body now owing an exact picture (pagebuilder.js reconcile keeps the specs)
    // (a page the paginator made again: no display list yet)
    const { dl, ...again } = first;
    const { pages, furnitureUnchanged } = reconcile([{ ...again, pendingExact: ['owed-picture'] }, ...verified.slice(1)],
      verified, (x, y) => furniturePageKey(x) === furniturePageKey(y));
    assert.ok(furnitureUnchanged, 'the spec is reused');
    engine.currentSpecs.pages = pages;
    engine.pages = pages;
    assert.equal(placementVerified(engine, pages[0]), false);
    const pending = engine.getDisplayLists()[0];
    assert.ok(pending.commands.some((c) => c.op === 'pending-exact'));
    assert.deepEqual(furniture(pending), [], 'no head, foot or folio on the unverified sheet');
    // verified again: its furniture comes back
    engine.currentSpecs.pages = verified;
    engine.pages = verified;
    assert.ok(furniture(engine.getDisplayLists()[0]).length, 'sheet 1 draws its folio again');
  } finally {
    await engine.close();
    rmSync(workDir, { recursive: true, force: true });
  }
});
