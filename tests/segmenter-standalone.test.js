// Standalone generated-content commands (\maketitle, \tableofcontents, …)
// must be isolated into their own block on BOTH sides: text typed on the
// very next line (no blank line) is the user's paragraph, and it must not
// share the fate of the title block (whole-block exact chunk, freezable).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { segmentBody } from '../engine/segmenter.js';

const texts = (src) => segmentBody(src, 0).map((s) => s.text);

test('a line holding only \\maketitle becomes its own block', () => {
  assert.deepEqual(texts('\\maketitle\nTEXT LINE\n\n\\section{A}\nBody text'), [
    '\\maketitle',
    'TEXT LINE\n',
    '\\section{A}\nBody text',
  ]);
});

test('standalone command splits away from the paragraph above it', () => {
  assert.deepEqual(texts('para above\n\\maketitle\npara below'), [
    'para above\n',
    '\\maketitle',
    'para below',
  ]);
});

test('inside an environment the command does not split', () => {
  assert.deepEqual(texts('\\begin{titlepage}\n\\maketitle\n\\end{titlepage}'), [
    '\\begin{titlepage}\n\\maketitle\n\\end{titlepage}',
  ]);
});

test('a trailing comment still counts as standalone', () => {
  assert.deepEqual(texts('\\maketitle % comment\nafter'), ['\\maketitle % comment', 'after']);
});

test('toc family is isolated the same way', () => {
  assert.deepEqual(texts('\\tableofcontents\nchapter text'), ['\\tableofcontents', 'chapter text']);
});

test('documents without standalone lines segment as before', () => {
  assert.deepEqual(texts('one para\n\nsecond para\n\n\\section{S}\nsec body'), [
    'one para\n',
    'second para\n',
    '\\section{S}\nsec body',
  ]);
});

test('\\maketitle with an argument-like tail stays a normal paragraph start', () => {
  // not "only the command on the line" — the conservative rule leaves it merged
  assert.deepEqual(texts('\\maketitle text on the same line\nmore'), [
    '\\maketitle text on the same line\nmore',
  ]);
});

test('align row spacing does not swallow the following prose', () => {
  assert.deepEqual(texts('\\begin{align}\na&=b\\\\[2mm]\nc&=d\n\\end{align}\n\nplain tail'), [
    '\\begin{align}\na&=b\\\\[2mm]\nc&=d\n\\end{align}\n',
    'plain tail',
  ]);
});

test('a real display delimiter still owns internal blank lines', () => {
  assert.deepEqual(texts('before\\[\nx=1\n\ny=2\n\\]\nafter\n\ntail'), [
    'before\\[\nx=1\n\ny=2\n\\]\nafter\n',
    'tail',
  ]);
});

test('KKluaverb payloads do not open braces or comments for the segmenter', () => {
  assert.deepEqual(texts('A \\KKverb|{| B.\n\nNext.'), ['A \\KKverb|{| B.\n', 'Next.']);
  assert.deepEqual(texts('\\KKcodeS\n\\begin{itemize} % {\n\n\\KKcodeE\n\nNext.'), [
    '\\KKcodeS\n\\begin{itemize} % {\n\n\\KKcodeE\n',
    'Next.',
  ]);
});

test('diffBlocks keeps the unchanged blocks between two changed regions (#96)', async () => {
  const { diffBlocks } = await import('../engine/segmenter.js');
  const old = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j'].map((t, i) => ({ id: `o${i}`, hash: t, text: t, start: 0, end: 0 }));
  const segs = ['a', 'B', 'X', 'c', 'd', 'e', 'f', 'g', 'h', 'I', 'j'].map((t) => ({ hash: t, text: t, start: 0, end: 0 }));
  let n = 0;
  const d = diffBlocks(old, segs, () => n++);
  assert.deepEqual(d.blocks.map((b) => b.id), ['o0', 'o1', 'b0', 'o2', 'o3', 'o4', 'o5', 'o6', 'o7', 'o8', 'o9']);
  assert.deepEqual([...d.dirty], ['o1', 'b0', 'o8']);
  assert.equal(d.bounds.regions, 2);
  // the boundary before c (old 2) survives before its new place (3), after an edit
  assert.deepEqual(d.bounds.boundaryMap.get(2), { to: 3, exact: false });
  assert.deepEqual(d.bounds.boundaryMap.get(1), { to: 1, exact: true });
  assert.equal(d.bounds.boundaryMap.has(8), false, 'the boundary before an edited block does not');
  assert.deepEqual(d.bounds.changedOld, [1, 8]);
  assert.deepEqual(d.bounds.changedNew, [1, 2, 9]);
});
