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
