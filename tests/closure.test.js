import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sourceClosure } from '../engine/checkpoint/closure.js';

const closed = (text) => sourceClosure(text).closed;

test('ordinary prose is immediately eligible', () => {
  assert.equal(closed('A normal paragraph, including 日本語。'), true);
});

test('groups, environments, and math wait for their real closing syntax', () => {
  assert.equal(closed('\\textbf{still typing'), false);
  assert.equal(closed('\\textbf{done}'), true);
  assert.equal(closed('\\begin{tikzpicture}\n\\draw (0,0)'), false);
  assert.equal(closed('\\begin{tikzpicture}\n\\draw (0,0);\n\\end{tikzpicture}'), true);
  assert.equal(closed('price $x + y'), false);
  assert.equal(closed('price $x + y$'), true);
  assert.equal(closed('\\[x+y'), false);
  assert.equal(closed('\\[x+y\\]'), true);
});

test('literal payloads and comments do not corrupt nesting', () => {
  assert.equal(closed('\\verb|{|'), true);
  assert.equal(closed('\\verb|unfinished'), false);
  assert.equal(closed('% { \\begin{bad}\nplain'), true);
  assert.equal(closed('\\begin{verbatim}\n{ % $ \\foo\n\\end{verbatim}'), true);
  assert.equal(closed('\\begin{verbatim}\nnot done'), false);
});

test('primitive conditionals are conservative without guessing package macros', () => {
  assert.equal(closed('\\ifnum 1=1 yes'), false);
  assert.equal(closed('\\ifnum 1=1 yes\\else no\\fi'), true);
  assert.equal(closed('\\ifthenelse{a}{b}{c}'), true);
  assert.equal(closed('\\newif\\ifcustom'), true);
});

test('a bare trailing escape waits, while an ordinary control word goes to native TeX', () => {
  assert.equal(closed('text \\'), false);
  assert.equal(closed('text \\LaTeX'), true);
});
