// A keystroke re-scans only the neighbourhood of the change (segmentBody's
// memo). Whatever the edit, the blocks must be the ones a scan of the whole
// text gives.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { segmentBody } from '../engine/segmenter.js';

// deterministic pseudo-random numbers
function rng(seed) {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

const PIECES = [
  'Plain words of a paragraph, with 50\\% of them plain.\n',
  'もう一つの段落です。日本語の文も混ぜます。\n',
  '\n', '\n', '\n', '\n\n',
  '\\section{A heading}\n', '\\subsection{Another}\nText right under it.\n', '\\par\n',
  '\\begin{itemize}\n\\item one\n\n\\item two\n\\end{itemize}\n',
  '\\begin{quote}\n', '\\end{quote}\n', '\\begin{center}', '\\end{center}\n',
  '\\[\n  a = b \\\\[2mm]\n  c = d\n\\]\n', '\\[', '\\]\n',
  '\\begin{verbatim}\n{ unbalanced % not a comment\n\n\\end{verbatim}\n', '\\begin{verbatim}\n', '\\end{verbatim}\n',
  '\\begin{lstlisting}\nint x = {1;\n\\end{lstlisting}\n', '\\begin{TeXBlock}\n\\section{no}\n\n{\n\\end{TeXBlock}\n',
  '\\begin{alltt}\n100% literal {\\bf x}\n\\end{alltt}\n', '\\begin{alltt}\n', '\\end{alltt}\n',
  '\\KKcodeS\n{ }}} \\section{x}\n\n\\KKcodeE\n', '\\KKcodeS\n', '\\KKcodeE\n', '\\KKcodeS inline \\KKcodeE\n',
  'A \\verb|%{| inline and \\KKverb|\\x{| too. % comment {\n', '% a comment line {\n',
  '{\\bfseries a group\n', 'that closes here}\n', '{', '}', '\\{ printed \\} braces \\\\}\n',
  '\\maketitle\n', '\\tableofcontents\n', '\\input{chapters/one}\n', '\\include{two}\n', '\\printindex\n',
  '\\newcommand{\\foo}[1]{%\n  #1\n\n  again}\n', 'x', ' ', '\\', '%', '\\begin{', 'figure}', '\\end{figure}\n',
];
const LITERAL = new Set(['TeXBlock']);

const pick = (random, list) => list[Math.floor(random() * list.length)];
// mostly paragraphs between blank lines, so that a document has many blocks
// and an edit usually leaves blocks standing on both sides of it
function document(random, pieces) {
  let text = '';
  for (let i = 0; i < pieces; i++) {
    text += random() < 0.6 ? `${pick(random, PIECES.slice(0, 2))}\n` : pick(random, PIECES);
  }
  return text;
}
function edit(random, text) {
  const at = Math.floor(random() * (text.length + 1));
  const kind = random();
  if (kind < 0.35) return text.slice(0, at) + pick(random, PIECES) + text.slice(at);
  if (kind < 0.55) return text.slice(0, at) + pick(random, ['a', 'あ', '\n', '\n\n', ' ', '{', '}', '%', '\\']) + text.slice(at);
  const length = Math.floor(random() * (kind < 0.8 ? 3 : 60));
  if (kind < 0.9) return text.slice(0, at) + text.slice(at + length);
  return text.slice(0, at) + document(random, 1 + Math.floor(random() * 3)) + text.slice(at + length);
}

test('a re-scan around the change gives the blocks of a whole scan, for any edit', () => {
  let scanned = 0;
  for (let seed = 1; seed <= 300; seed++) {
    const random = rng(seed);
    const options = seed % 3 === 0 ? { literalEnvs: LITERAL } : {};
    const base = seed % 4 === 0 ? 137 : 0;
    const memo = {};
    let text = document(random, 5 + Math.floor(random() * 60));
    assert.deepEqual(segmentBody(text, base, { ...options, memo }), segmentBody(text, base, options), `seed ${seed} first scan`);
    for (let step = 0; step < 40; step++) {
      text = edit(random, text);
      const whole = segmentBody(text, base, options);
      assert.deepEqual(segmentBody(text, base, { ...options, memo }), whole, `seed ${seed} step ${step}`);
      scanned += whole.length;
    }
  }
  assert.ok(scanned > 50_000, `the edits covered documents of many blocks (${scanned} blocks compared)`);
});

test('the memo is left alone by what the caller does to its blocks, and by another text', () => {
  const memo = {};
  const text = 'One.\n\nTwo.\n\nThree.\n';
  const first = segmentBody(text, 0, { memo });
  first[1].text = 'changed by the caller';
  first[1].structuralSinks.push('x');
  first.length = 1;
  assert.deepEqual(segmentBody(text, 0, { memo }), segmentBody(text, 0));
  const other = '\\section{Unrelated}\nBody.\n';
  assert.deepEqual(segmentBody(other, 0, { memo }), segmentBody(other, 0));
  assert.deepEqual(segmentBody(text + 'Four.\n', 9, { memo }), segmentBody(text + 'Four.\n', 9), 'another base offset');
  assert.deepEqual(segmentBody(text, 0, { memo, literalEnvs: LITERAL }), segmentBody(text, 0, { literalEnvs: LITERAL }));
  const events = [{ at: 6, sinks: ['multicols'], effects: [{ kind: 'begin' }] }];
  assert.deepEqual(segmentBody(text, 0, { memo, structuralEvents: events }), segmentBody(text, 0, { structuralEvents: events }));
  assert.deepEqual(segmentBody(text, 0, { memo }), segmentBody(text, 0), 'after a scan with structural events');
});

test('only the neighbourhood of a change is scanned again', () => {
  const paragraphs = Array.from({ length: 4000 }, (_, i) => `Paragraph ${i} with some words in it.\n`).join('\n');
  const memo = {};
  segmentBody(paragraphs, 0, { memo });
  const at = paragraphs.indexOf('Paragraph 2000') + 5;
  const edited = paragraphs.slice(0, at) + 'X' + paragraphs.slice(at);
  const time = (run) => { const t = performance.now(); for (let i = 0; i < 20; i++) run(i); return (performance.now() - t) / 20; };
  const whole = time(() => segmentBody(edited, 0));
  let flip = false;
  const around = time(() => { flip = !flip; segmentBody(flip ? edited : paragraphs, 0, { memo }); });
  assert.deepEqual(segmentBody(edited, 0, { memo }), segmentBody(edited, 0));
  assert.ok(around < whole / 2, `re-scan ${around.toFixed(2)} ms against ${whole.toFixed(2)} ms for the whole text`);
});
