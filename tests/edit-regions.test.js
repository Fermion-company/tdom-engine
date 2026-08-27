import test from 'node:test';
import assert from 'node:assert/strict';
import { discoverEditRegions, instrumentEditRegions } from '../engine/edit-regions.js';

test('discovers printed prose and math without exposing structural arguments', () => {
  const source = String.raw`A simple sentence with \textbf{bold words} and $x^2+1$.
\label{sec:hidden}\ref{sec:hidden}\includegraphics{secret-name.png}`;
  const regions = discoverEditRegions(source);
  assert.deepEqual(regions.map((r) => [r.kind, r.value]), [
    ['text', 'A simple sentence with'],
    ['text', 'bold words'],
    ['text', 'and'],
    ['math', 'x^2+1'],
    ['text', '.'],
  ]);
  assert.equal(regions.find((region) => region.kind === 'math')?.display, false);
  assert.equal(regions.some((r) => r.value.includes('sec:hidden')), false);
  assert.equal(regions.some((r) => r.value.includes('secret-name')), false);
});

test('supports title fields, display delimiters, and math environments', () => {
  const source = String.raw`\title{A New Result}
\[a+b=c\]
\begin{align}x&=1\\y&=2\end{align}`;
  const regions = discoverEditRegions(source);
  assert.deepEqual(regions.map((r) => [r.kind, r.value]), [
    ['text', 'A New Result'],
    ['math', 'a+b=c'],
    ['math', 'x&=1\\\\y&=2'],
  ]);
  assert.deepEqual(regions.filter((region) => region.kind === 'math').map((region) => region.display), [
    true,
    true,
  ]);
});

test('edit metadata leaves the resident TeX source byte-identical', () => {
  const source = 'Hello $x+y$ world.';
  const result = instrumentEditRegions(source);
  assert.equal(result.regions.length, 3);
  assert.equal(result.text, source);
});

test('comments and verbatim bodies are never offered as printed prose', () => {
  const source = 'Visible words. % hidden words\n\\begin{verbatim}\nnot editable\n\\end{verbatim}\nTail words.';
  assert.deepEqual(discoverEditRegions(source).map((r) => r.value), ['Visible words.', 'Tail words.']);
});

test('environment placement options are structural while captions stay editable', () => {
  const source = String.raw`\begin{figure}[h]
\includegraphics{plot.pdf}
\caption{Measured response}
\label{fig:response}
\end{figure}`;
  assert.deepEqual(discoverEditRegions(source).map((r) => [r.kind, r.value]), [
    ['text', 'Measured response'],
  ]);
});

test('table layout arguments stay structural while captions and cells are editable', () => {
  const source = String.raw`\begin{table}[ht]
\caption{Measured values}
\begin{tabular}{lrr}
Method & Train & Test \\
Alpha & 0.98 & 0.95 \\
\end{tabular}
\end{table}`;
  const regions = discoverEditRegions(source);
  assert.deepEqual(regions.map((r) => [r.kind, r.value]), [
    ['text', 'Measured values'],
    ['text', 'Method'],
    ['text', 'Train'],
    ['text', 'Test'],
    ['text', 'Alpha'],
    ['text', '0.98'],
    ['text', '0.95'],
  ]);
  assert.equal(regions.some((region) => region.value === 'lrr'), false);
});

test('punctuation and escaped visible symbols preserve their source replacement span', () => {
  const regions = discoverEditRegions(String.raw`Result $x$. Cost is 50\% & stable.`);
  assert.deepEqual(regions.map((r) => [r.kind, r.value, r.sourceValue]), [
    ['text', 'Result', 'Result'],
    ['math', 'x', 'x'],
    ['text', '. Cost is 50', '. Cost is 50'],
    ['text', '%', String.raw`\%`],
    ['text', 'stable.', 'stable.'],
  ]);
});

test('common styled, linked, and spanning paper text exposes only its printed argument', () => {
  const source = String.raw`\href{https://example.test/a_b}{project page}
\textcolor[HTML]{336699}{colored result}
\multicolumn{2}{c}{Joint estimate}
\multirow{2}{*}{Method A}
\makebox[4cm][l]{boxed note}`;
  const regions = discoverEditRegions(source);
  assert.deepEqual(regions.map((region) => region.value), [
    'project page',
    'colored result',
    'Joint estimate',
    'Method A',
    'boxed note',
  ]);
  for (const structural of ['https://example.test/a_b', 'HTML', '336699', '2', '*', '4cm', 'l']) {
    assert.equal(regions.some((region) => region.value === structural), false);
  }
});

test('lists and theorem-like environments include their visible labels and bodies', () => {
  const source = String.raw`\begin{description}
\item[Estimator] Unbiased under the assumptions.
\end{description}
\begin{theorem}[Consistency]
The estimator converges almost surely.
\end{theorem}`;
  assert.deepEqual(discoverEditRegions(source).map((region) => region.value), [
    'Estimator',
    'Unbiased under the assumptions.',
    'Consistency',
    'The estimator converges almost surely.',
  ]);
});
