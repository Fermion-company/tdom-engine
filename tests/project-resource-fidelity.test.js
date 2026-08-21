import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { expandIncludes, includeOnlyFromSource } from '../engine/checkpoint/include-expander.js';
import { applyFidelity } from '../engine/checkpoint/fidelity-gate.js';
import { segmentBody } from '../engine/segmenter.js';
import { describeExternalBibliography, prepareExternalBibliography } from '../engine/project-bibliography.js';
import { resolveProjectInput, withProjectInputs } from '../engine/project-inputs.js';
import { buildJobBlockBody } from '../engine/checkpoint/job-body.js';
import { chunkTargets } from '../engine/checkpoint/chunk-targets.js';

const bibtexAvailable = await promisify(execFile)('bibtex', ['--version'], { timeout: 15_000 }).then(
  () => true,
  () => false
);

test('standalone include inherits nested image fidelity and watches both files', () => {
  const docDir = mkdtempSync(path.join(tmpdir(), 'tdom-project-assets-'));
  const sections = path.join(docDir, 'sections');
  const figures = path.join(docDir, 'figures');
  mkdirSync(sections);
  mkdirSync(figures);
  const child = path.join(sections, 'intro.tex');
  const image = path.join(figures, 'sample.png');
  writeFileSync(child, String.raw`\section{Intro}
\includegraphics{../figures/sample.png}
`);
  writeFileSync(image, 'fake-png-for-resource-discovery');
  const watched = new Set();
  try {
    const segs = expandIncludes(segmentBody('\\include{sections/intro}\n', 0), 0, {
      docDir,
      workDir: docDir,
      includes: new Map(),
      diagnostics: [],
      watchInclude: (full) => watched.add(full),
    });
    assert.equal(segs.length, 1, 'include boundaries stay attached to real chapter content');
    assert.equal(segs[0].includeStart, true);
    assert.equal(segs[0].includeEnd, true);
    assert.doesNotMatch(segs[0].text, /\\clearpage/);
    assert.equal(segs[0].externalGraphics, true, 'nested image marks only the owning chapter block exact');
    assert.equal(segs[0].file, child, 'expanded chapter keeps its real source identity');
    assert.deepEqual(segs[0].sourceStart, { line: 1, column: 1 });
    assert.deepEqual(segs[0].sourceEnd, { line: 3, column: 1 });
    assert.ok(watched.has(child), 'included TeX source is watched');
    assert.ok(watched.has(image), 'nested image asset is watched');

    const block = { id: 'b1', text: segs[0].text, externalGraphics: segs[0].externalGraphics };
    applyFidelity(block, { items: [] }, { fonts: new Map(), fidelityDemoted: new Map() });
    assert.equal(block.fidelity.level, 'exact-preview-required');
    assert.equal(block.needsRender, true);
  } finally {
    rmSync(docDir, { recursive: true, force: true });
  }
});

test('source-level graphics force their owning floats onto exact TeX chunks', () => {
  const block = {
    id: 'b1',
    text: String.raw`\begin{figure}\includegraphics{plot.pdf}\end{figure}`,
    externalGraphics: true,
  };
  const galley = {
    w: 300,
    h: 10,
    d: 0,
    items: [],
    floats: [{ n: 7, w: 200, h: 120, d: 0, items: [], gfx: false }],
  };
  block.galley = galley;
  applyFidelity(block, galley, { fonts: new Map(), fidelityDemoted: new Map() });
  assert.deepEqual(block.fidelity.floats.get(7), { exact: true, noBridge: true });
  assert.ok(chunkTargets(block).some((target) => target.key === 'b1#7'));
});

test('a changed source block drops citation dependencies removed from its stale galley', () => {
  const block = {
    id: 'b1',
    text: String.raw`Now cite \cite{new}.`,
    sourceChanged: true,
    galley: { refs: ['cite:old'] },
  };
  const result = buildJobBlockBody({
    block,
    idx: 0,
    blocks: [block],
    ck: { vstale: false },
    override: null,
    labelTable: new Map([['cite:old', '1'], ['cite:new', '2']]),
    hrefTable: new Map(),
    geometry: {},
    volatilePrelude: () => '',
  });
  assert.deepEqual(Object.keys(result.refSnapshot), ['cite:new']);
});

test('unsaved project overlays shadow child TeX and bibliography without copying the project', () => {
  const docDir = mkdtempSync(path.join(tmpdir(), 'tdom-project-overlay-'));
  const overlayDir = mkdtempSync(path.join(tmpdir(), 'tdom-overlay-bytes-'));
  mkdirSync(path.join(docDir, 'sections'));
  mkdirSync(path.join(overlayDir, 'sections'));
  writeFileSync(path.join(docDir, 'sections', 'intro.tex'), String.raw`Saved text \cite{saved}.`);
  writeFileSync(path.join(overlayDir, 'sections', 'intro.tex'), String.raw`Unsaved text \cite{draft}.`);
  writeFileSync(path.join(docDir, 'refs.bib'), '@book{saved,title={Saved}}');
  writeFileSync(path.join(overlayDir, 'refs.bib'), '@book{draft,title={Draft}}');
  const source = String.raw`\documentclass{article}
\begin{document}
\include{sections/intro}
\bibliographystyle{plain}
\bibliography{refs}
\end{document}`;
  try {
    const child = resolveProjectInput('sections/intro', { docDir, overlayDir, extensions: ['.tex'] });
    assert.equal(child?.actualPath, path.join(docDir, 'sections', 'intro.tex'));
    assert.equal(child?.readPath, path.join(overlayDir, 'sections', 'intro.tex'));
    assert.equal(child?.overlay, true);
    const descriptor = describeExternalBibliography(source, docDir, overlayDir);
    assert.deepEqual(descriptor?.citations, ['draft'], 'citation scan consumes the unsaved child');
    assert.deepEqual(descriptor?.files, [path.join(docDir, 'refs.bib')], 'source identity stays in the real project');
    const env = withProjectInputs({ TEXINPUTS: 'system' }, { docDir, overlayDir });
    assert.ok(env.TEXINPUTS.startsWith(`${overlayDir}${path.delimiter}${docDir}${path.delimiter}`));
    assert.equal(existsSync(path.join(overlayDir, 'main.tex')), false, 'unchanged project files are never mirrored');
  } finally {
    rmSync(docDir, { recursive: true, force: true });
    rmSync(overlayDir, { recursive: true, force: true });
  }
});

test('external BibTeX materializes the cited entries for resident and canonical TeX', {
  skip: bibtexAvailable ? false : 'bibtex not installed',
}, async () => {
  const docDir = mkdtempSync(path.join(tmpdir(), 'tdom-external-bib-'));
  const workDir = path.join(docDir, 'work');
  const canonicalWorkDir = path.join(docDir, 'canonical');
  const source = String.raw`\documentclass{article}
\begin{document}
See \cite{knuth1984}.
\bibliographystyle{plain}
\bibliography{refs}
\end{document}`;
  writeFileSync(path.join(docDir, 'refs.bib'), String.raw`@book{knuth1984,
  title={The TeXbook},
  author={Knuth, Donald E.},
  year={1984},
  publisher={Addison-Wesley}
}`);
  try {
    const descriptor = describeExternalBibliography(source, docDir);
    assert.deepEqual(descriptor?.citations, ['knuth1984']);
    const result = await prepareExternalBibliography({
      source,
      descriptor,
      docDir,
      documentFile: 'main.tex',
      workDir,
      canonicalWorkDir,
    });
    assert.equal(result.prepared, true);
    for (const file of [path.join(workDir, 'driver.bbl'), path.join(canonicalWorkDir, 'canon.bbl')]) {
      const bbl = readFileSync(file, 'utf8');
      assert.match(bbl, /\\bibitem\{knuth1984\}/);
      assert.match(bbl, /The TeXbook/);
    }
  } finally {
    rmSync(docDir, { recursive: true, force: true });
  }
});

test('includeonly excludes unselected chapters from the provisional source DOM', () => {
  const docDir = mkdtempSync(path.join(tmpdir(), 'tdom-include-only-'));
  try {
    writeFileSync(path.join(docDir, 'one.tex'), 'One.\n');
    writeFileSync(path.join(docDir, 'two.tex'), 'Two.\n');
    const includeOnly = includeOnlyFromSource(String.raw`\includeonly{one.tex}`);
    const segs = expandIncludes(segmentBody('\\include{one}\n\\include{two}\n', 0), 0, {
      docDir,
      workDir: docDir,
      includes: new Map(),
      includeOnly,
      diagnostics: [],
      watchInclude: () => {},
    });
    assert.equal(segs.length, 1);
    assert.equal(segs[0].file, path.join(docDir, 'one.tex'));
  } finally {
    rmSync(docDir, { recursive: true, force: true });
  }
});
