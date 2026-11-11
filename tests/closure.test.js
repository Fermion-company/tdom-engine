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

test('fancyvrb and declared listing environments are literal', () => {
  assert.equal(sourceClosure('\\begin{Verbatim}\nfake closer: \\end{document}\n{\n\\end{Verbatim}').closed, true);
  const listing = '\\begin{TeXBlock}\n\\end{document}\n\\end{TeXBlock}';
  assert.equal(sourceClosure(listing).closed, false);
  assert.equal(sourceClosure(listing, { literalEnvs: new Set(['TeXBlock']) }).closed, true);
});

test('\\string quotes \\verb and inline listings are literal payloads', () => {
  assert.equal(closed('a replacement for \\texttt{\\string\\verb}.'), true);
  assert.equal(closed('handled by listings: \\lstinline!\\end{document}! and more'), true);
  assert.equal(closed('\\lstinline[language=TeX]|{|'), true);
  assert.equal(closed('\\lstinline{\\end{document}}'), true);
  assert.equal(closed('\\mintinline{latex}|\\begin{x}|'), true);
  assert.equal(closed('\\lstinline!unfinished'), false);
});

test('KKluaverb payloads are literal: braces and % inside do not hold the block', () => {
  assert.equal(sourceClosure('A \\KKverb|{ % | B.').closed, true);
  assert.equal(sourceClosure('\\KKcodeS\n\\begin{itemize} % {\n\\KKcodeE').closed, true);
  assert.equal(sourceClosure('A \\KKverb|still typing').reason, 'verb-payload');
  assert.equal(sourceClosure('\\KKcodeS\n{').reason, 'verb-payload');
});

test('a document switch may open in one block and close in a later one', async () => {
  const { carriedConditionals, declaredConditionals } = await import('../engine/checkpoint/closure.js');
  const documentConditionals = declaredConditionals('\\documentclass{book}\n\\newif\\ifshortbuild\n\\shortbuildfalse\n');
  assert.deepEqual([...documentConditionals], ['ifshortbuild']);
  const blocks = ['Chapter one.', '\\ifshortbuild\\else', 'Chapter two.', 'Last paragraph.\n\\fi\n\\printindex', 'After.']
    .map((text) => ({ text }));
  const carried = carriedConditionals(blocks, { documentConditionals });
  assert.deepEqual(carried, [0, 0, 1, 1, 0]);
  blocks.forEach((block, i) => {
    assert.equal(sourceClosure(block.text, { documentConditionals, carried: carried[i] }).closed, true, block.text);
  });
  // without the context the same \fi is unfinished typing, and so is a
  // conditional of TeX's own left open
  assert.equal(sourceClosure('Last paragraph.\n\\fi', { documentConditionals }).reason, 'unexpected:fi');
  assert.equal(sourceClosure('\\ifx a', { documentConditionals }).reason, 'conditional:ifx');
  assert.equal(sourceClosure('x \\fi \\fi', { documentConditionals, carried: 1 }).reason, 'unexpected:fi');
});
