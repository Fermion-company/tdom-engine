import assert from 'node:assert/strict';
import test from 'node:test';
import macros from '../web/math-macro-projection.cjs';

const tex = String.raw;
const definitions = {
  ratio: { args: 2, body: tex`\frac {\sqrt [3]{#1}}{#2}` },
  twice: { args: 1, body: '#1+#1' },
  appendx: { args: 1, body: '#1x' },
};

test('edits one argument in the second copy and keeps the exact macro spelling', () => {
  const raw = tex`\ratio{a}{b} + \ratio  {q} {z}`;
  const projected = macros.project(raw, definitions);
  assert.equal(projected.text, tex`\frac {\sqrt [3]{a}}{b} + \frac {\sqrt [3]{q}}{z}`);
  assert.equal(macros.rewrite(raw, projected, projected.text.replace('{q}', '{qt}')), raw.replace('{q}', '{qt}'));
});

test('editing one printed copy of a repeated parameter expands only that call', () => {
  const raw = tex`\twice{x}+\twice{y}`;
  const projected = macros.project(raw, definitions);
  assert.equal(macros.rewrite(raw, projected, 'z+x+y+y'), tex`z+x+\twice{y}`);
});

test('nested arguments retain their source and adjacent control words remain separate tokens', () => {
  const raw = tex`\ratio{\appendx{\alpha}}{z}`;
  const projected = macros.project(raw, definitions);
  assert.equal(projected.text, tex`\frac {\sqrt [3]{\alpha x}}{z}`);
  assert.equal(macros.rewrite(raw, projected, projected.text.replace('alpha', 'beta')), raw.replace('alpha', 'beta'));
});

test('unsupported source uses the native result', () => {
  for (const raw of [tex`\ratio x y`, tex`\ratio{a}`, tex`\ratio{a}{b}\verb+x+`, tex`\ratio%heading`]) {
    assert.equal(macros.project(raw, definitions), null);
  }
});

test('labels and operator names keep their literal contents on a paper edit', () => {
  const raw = tex`\ratio{q}{z}\label{eq:\twice{a}}+\operatorname*{\twice{b}}`;
  const projected = macros.project(raw, definitions);
  assert.ok(projected.text.endsWith(tex`\label{eq:\twice{a}}+\operatorname*{\twice{b}}`));
  assert.equal(macros.rewrite(raw, projected, projected.text.replace('{q}', '{qt}')), raw.replace('{q}', '{qt}'));
});

const optional = { radical: { args: 2, default: '3', body: tex`\sqrt[#1]{#2}` } };
test('editing the radicand retains omitted and explicit options including spaces', () => {
  const raw = tex`\radical {x}+\radical  [5] {y}`, projected = macros.project(raw, optional);
  assert.equal(projected.text, tex`\sqrt[3]{x}+\sqrt[5]{y}`);
  for (const symbol of ['x', 'y']) {
    assert.equal(macros.rewrite(raw, projected, projected.text.replace(symbol, symbol + 't')), raw.replace(symbol, symbol + 't'));
  }
});

test('editing an omitted default creates an explicit option only at the edited call', () => {
  const raw = tex`\radical {x}+\radical{y}`, projected = macros.project(raw, optional);
  assert.equal(macros.rewrite(raw, projected, projected.text.replace('[3]', '[7]')), tex`\radical[7] {x}+\radical{y}`);
  const empty = { f: { args: 2, default: '', body: 'x^{#1}+{#2}' } };
  const before = macros.project(tex`\f{y}`, empty);
  assert.equal(macros.rewrite(tex`\f{y}`, before, 'x^{2}+{y}'), tex`\f[2]{y}`);
});

test('balanced braces protect optional delimiters and incomplete options defer to TeX', () => {
  const raw = tex`\radical[{a]b}]{x}`, projected = macros.project(raw, optional);
  assert.equal(projected.text, tex`\sqrt[a]b]{x}`);
  assert.equal(macros.rewrite(raw, projected, projected.text.replace('b', 'bc')), raw.replace('b', 'bc'));
  assert.equal(macros.project(tex`\radical[{a} {x}`, optional), null);
});
