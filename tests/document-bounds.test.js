// The body ends at the first ACTIVE \end{document}. Manuals quote the
// marker in listings and comments; cutting the body there dropped every
// later page from the resident (issue #65 of tex64-internal).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { documentBounds, segmentBody } from '../engine/segmenter.js';

const body = (src) => {
  const b = documentBounds(src);
  return src.slice(b.body.start, b.body.end);
};
const preamble = (src) => src.slice(0, documentBounds(src).preamble.end);

test('plain document keeps the old bounds', () => {
  const src = '\\documentclass{article}\n\\begin{document}\nHello\n\\end{document}\ntrailing notes';
  const b = documentBounds(src);
  assert.equal(b.hasBegin, true);
  assert.equal(b.preamble.end, src.indexOf('\\begin{document}'));
  assert.equal(b.body.start, src.indexOf('\\begin{document}') + '\\begin{document}'.length);
  assert.equal(b.body.end, src.indexOf('\\end{document}'));
});

test('missing \\begin{document} treats the whole file as body', () => {
  const src = 'just text\n\\end{document}';
  const b = documentBounds(src);
  assert.equal(b.hasBegin, false);
  assert.deepEqual(b.body, { start: 0, end: src.length });
});

test('\\end{document} inside verbatim does not end the body', () => {
  const src = '\\begin{document}\nA\n\\begin{verbatim}\n\\end{document}\n\\end{verbatim}\nB\n\\end{document}';
  assert.equal(body(src), '\nA\n\\begin{verbatim}\n\\end{document}\n\\end{verbatim}\nB\n');
});

test('a listing environment declared with \\lstnewenvironment is literal', () => {
  const src = [
    '\\usepackage{listings}',
    '\\lstnewenvironment{TeXBlock}[1][]{\\lstset{#1}}{}',
    '\\begin{document}',
    '\\begin{TeXBlock}[caption={x}]',
    '\\begin{multicols}{3}',
    '\\end{document}',
    '\\end{TeXBlock}',
    'After.',
    '\\end{document}',
  ].join('\n');
  assert.match(body(src), /After\.\n$/);
  assert.ok(documentBounds(src).literalEnvs.has('TeXBlock'));
});

test('fancyvrb, minted and tcolorbox declarations are literal too', () => {
  const names = documentBounds([
    '\\DefineVerbatimEnvironment{FrameVerb}{Verbatim}{frame=single}',
    '\\newminted{latex}{}',
    '\\newminted[pyblock]{python}{}',
    '\\newtcblisting[auto counter]{codebox}{}',
    '\\NewTCBListing{codetwo}{ O{} }{}',
    '\\begin{document}\\end{document}',
  ].join('\n')).literalEnvs;
  for (const name of ['FrameVerb', 'latexcode', 'pyblock', 'codebox', 'codetwo']) {
    assert.ok(names.has(name), name);
  }
});

test('comment lines never hold the markers', () => {
  const end = '\\begin{document}\nA\n% old ending kept for reference: \\end{document}\nB\n\\end{document}';
  assert.equal(body(end), '\nA\n% old ending kept for reference: \\end{document}\nB\n');
  const begin = '\\documentclass{article}\n% usage note: put \\begin{document} after the packages\n\\usepackage{x}\n\\begin{document}\nA\n\\end{document}';
  assert.match(preamble(begin), /\\usepackage\{x\}\n$/);
  assert.equal(body(begin), '\nA\n');
});

test('an escaped percent is text and \\\\% starts a comment', () => {
  const src = '\\begin{document}\n50\\% done \\end{document} tail';
  assert.equal(body(src), '\n50\\% done ');
  const row = '\\begin{document}\na & b \\\\% \\end{document}\nc\n\\end{document}';
  assert.equal(body(row), '\na & b \\\\% \\end{document}\nc\n');
});

test('inline \\verb and \\lstinline payloads are skipped', () => {
  const src = '\\begin{document}\nUse \\verb|\\end{document}| and \\lstinline{\\end{document}} last.\n\\end{document}';
  assert.equal(body(src), '\nUse \\verb|\\end{document}| and \\lstinline{\\end{document}} last.\n');
});

test('filecontents in the preamble may quote \\begin{document}', () => {
  const src = '\\begin{filecontents*}{x.tex}\n\\begin{document}\n\\end{filecontents*}\n\\documentclass{article}\n\\begin{document}\nA\n\\end{document}';
  assert.equal(body(src), '\nA\n');
});

test('alltt is not literal for the bounds', () => {
  const src = '\\begin{document}\n\\begin{alltt}\n\\end{document}\n\\end{alltt}\nB\n\\end{document}';
  assert.equal(body(src), '\n\\begin{alltt}\n');
});

test('text after the literal close on the same line is scanned', () => {
  const src = '\\begin{document}\n\\begin{verbatim}x\\end{verbatim} \\end{document} tail\n\\end{document}';
  assert.equal(body(src), '\n\\begin{verbatim}x\\end{verbatim} ');
});

test('segmentBody keeps a declared listing literal', () => {
  const text = '\\begin{TeXBlock}\n\\begin{multicols}{3}\n\n{\n\\end{TeXBlock}\n\nNext paragraph';
  const segs = segmentBody(text, 0, { literalEnvs: new Set(['TeXBlock']) }).map((s) => s.text);
  assert.deepEqual(segs, ['\\begin{TeXBlock}\n\\begin{multicols}{3}\n\n{\n\\end{TeXBlock}\n', 'Next paragraph']);
});
