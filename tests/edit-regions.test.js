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

test('alignment metadata retains cells across groups, split lines and optional row spacing', () => {
  const source = String.raw`\begin{longtable}{lccc}
Header & $x$ & & $x$ \\*[2pt]
\endhead
A\&B & \multicolumn{2}{c}{$\begin{matrix}a&b\\c&d\end{matrix}$} &
  $x$ \tabularnewline
\end{longtable}
Outside $x$.`;
  const { regions, text } = instrumentEditRegions(source);
  const math = regions.filter(r => r.kind === 'math');
  assert.equal(text, source);
  assert.deepEqual(math.map(r => [r.tableColumn, r.tableColumns]),
    [[1, 4], [3, 4], [1, 4], [3, 4], [undefined, undefined]]);
  assert.equal(math[0].tableRow, math[1].tableRow);
  assert.equal(math[2].tableRow, math[3].tableRow);
  assert.notEqual(math[0].tableRow, math[2].tableRow);
  for (const r of math) assert.equal(source.slice(r.contentStart, r.contentEnd), r.value);
});

test('nested tables keep their own cells even with closing commands in comments and inline code', () => {
  const source = String.raw`\begin{tabular}{lc}
A & \verb|& $fake$ \end{tabular}| \begin{tabular}{lc}
Nested & $n$ \\ % \end{tabular}
Other & $m$ \\
\end{tabular} \\
Tail & $t$ \\
\end{tabular}
Outside $x$`;
  const { text, regions } = instrumentEditRegions(source);
  assert.equal(text, source);
  assert.deepEqual(regions.map(r => r.value), ['A', 'Nested', 'n', 'Other', 'm', 'Tail', 't', 'Outside', 'x']);
  for (const [label, value] of [['Nested', 'n'], ['Other', 'm'], ['Tail', 't']]) {
    const a = regions.find(r => r.value === label), b = regions.find(r => r.value === value);
    assert.equal(a.tableRow, b.tableRow);
    assert.deepEqual([a.tableColumn, b.tableColumn, b.tableColumns], [0, 1, 2]);
  }
  assert.equal(new Set(regions.filter(r => r.kind === 'math' && r.tableRow != null).map(r => r.tableRow)).size, 3);
  assert.equal(regions[0].tableLiteralAfter, String.raw`& $fake$ \end{tabular}`);
  assert.equal(regions.at(-1).tableRow, undefined);
});

test('a verbatim listing and literal inline examples cannot introduce environment or math spans', () => {
  const source = String.raw`\begin{quote}
\begin{verbatim}
\begin{quote} $fake$ \end{quote}
\end{verbatim}
\lstinline[language=TeX]!\end{quote}! \mintinline{tex}{$fake$}
Real $a$ \verb*+\end{quote}+
\end{quote}`;
  assert.deepEqual(discoverEditRegions(source).map(r => r.value), ['Real', 'a']);
});

test('unfinished inline code stays on its line while typing', () => {
  for (const literal of [String.raw`\verb|unfinished`, String.raw`\lstinline[language=TeX`, String.raw`\mintinline{tex}{unfinished`]) {
    const source = literal + '\nVisible $x$';
    assert.deepEqual(discoverEditRegions(source).map(r => r.value), ['Visible', 'x']);
  }
});

test('printed control names stay read-only while the table keeps its true cells', () => {
  const src = String.raw`\begin{tabular}{ll}
\string\verb & $a$ \\
Key \texttt{\string\end{tabular}} & $b$ \\
\end{tabular}`;
  const regions = discoverEditRegions(src);
  const a = regions.find(r => r.value === 'a'), b = regions.find(r => r.value === 'b');
  assert.deepEqual([a.tableColumn, b.tableColumn, a.tableColumns, b.tableColumns], [1, 1, 2, 2]);
  assert.equal(a.tableLiteralBefore, '\\verb');
  assert.equal(regions.find(r => r.value === 'Key').tableLiteralAfter, '\\end');
  assert.equal(new Set([a.tableRow, b.tableRow]).size, 2);
  assert.deepEqual(regions.map(r => r.value), ['a', 'Key', 'tabular', 'b']);
});

test('detokenized ink is counted exactly in a table without creating editable code', () => {
  const src = String.raw`\begin{tabular}{ll}
Label \texttt{\detokenize{# & \end{tabular} $ \verb \# \%}} & $m$ \\
Next & $n$ \\
\end{tabular}`;
  const regions = discoverEditRegions(src);
  assert.deepEqual(regions.map(r => r.value), ['Label', 'm', 'Next', 'n']);
  assert.equal(regions[0].tableLiteralAfter, String.raw`## & \end {tabular} $ \verb \# \%`);
  assert.deepEqual(regions.filter(r => r.kind === 'math').map(r => [r.tableColumn, r.tableColumns]), [[1, 2], [1, 2]]);
});

test('math comments keep their source span and cannot close a printed formula', () => {
  for (const [open, close] of [['$', '$'], ['\\(', '\\)'], ['\\[', '\\]']]) {
    const math = 'x% ' + close + ' $fake$\n+1';
    const regions = discoverEditRegions(open + math + close).filter(region => region.kind === 'math');
    assert.equal(regions.length, 1);
    assert.equal(regions[0].sourceValue, math);
    assert.equal(regions[0].value, 'x+1');
  }
});
