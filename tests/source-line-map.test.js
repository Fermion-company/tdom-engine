import assert from 'node:assert/strict';
import test from 'node:test';
import { findSourceWord, mapSourceLines } from '../web/source-line-map.js';

function map(before, after, line, options) {
  return mapSourceLines(before, after).location(line, options).line;
}

const question = String.raw`\item Explain why inertia affects the moving object.`;
const exercise = ['Opening passage.', '% First note', question, '% Last note', 'Closing passage.'].join('\n');
const variants = [
  ['comments above and inside', '% New rubric\n' + exercise.replace(question, '% Award partial credit\n' + question), 5],
  ['comments deleted above and below', exercise.replace('% First note\n', '').replace('% Last note\n', ''), 2],
  ['comments inserted below', exercise + '\n% Further reading', 3],
  ['trailing comment changed', exercise.replace(question, question + ' % Mark each step.'), 3],
  ['label added', exercise.replace(question, question + String.raw`\label{exercise:inertia}`), 3],
  ['indentation changed', exercise.replace(question, '\t  ' + question), 3],
  ['clicked word edited', exercise.replace('inertia', 'momentum'), 3, { word: 'inertia', prev: 'why', next: 'affects' }],
  ['split, click first half', exercise.replace('affects', '\naffects'), 3, { word: 'inertia', prev: 'why', next: 'affects' }],
  ['split, click second half', exercise.replace('affects', '\naffects'), 4, { word: 'moving', prev: 'the', next: 'object' }],
];

for (const [name, after, expected, options] of variants) {
  test(name, () => assert.equal(map(exercise, after, 3, options), expected));
}

test('a clicked occurrence uses neighbouring words across a new line break', () => {
  const before = 'Opening\nCheck mass before, review mass afterwards.\nClosing';
  assert.equal(map(before, before.replace('review', '\nreview'), 2,
    { word: 'mass', prev: 'review', next: 'afterwards' }), 3);
  assert.equal(map(before, before.replace('review', '\nreview'), 2, { column: 7 }), 2);
});

test('joined source lines land on the line with their shared text', () => {
  const before = exercise.replace('affects', '\naffects');
  assert.equal(map(before, exercise, 4, { word: 'moving' }), 3);
});

test('all five identical lines survive an insertion between occurrences', () => {
  const lines = ['Opening', ...Array(5).fill(question), 'Closing'];
  const after = lines.toSpliced(3, 0, '% New rubric').join('\n');
  assert.deepEqual([2, 3, 4, 5, 6].map(line => map(lines.join('\n'), after, line)), [2, 3, 5, 6, 7]);
});

test('deleted ink falls back to the nearest surviving line in its own block', () => {
  const before = 'Outside\n\nExercise opening\nA soon deleted sentence\nExercise ending\n\nNext exercise';
  const after = before.replace('A soon deleted sentence\n', '');
  assert.equal(map(before, after, 4, { block: { start: 3, end: 5 } }), 3);
});

test('a wholly replaced block falls back to its current start', () => {
  const before = 'Outside\n\nRetired exercise\nOld instructions\n\nNext exercise';
  const after = 'Outside\n\nReplacement passage\nFresh question\n\nNext exercise';
  assert.equal(map(before, after, 4, { block: { start: 3, end: 4 } }), 3);
});

test('Japanese text split inside a column follows the clicked glyph', () => {
  const before = '題名\n吾輩は猫である。名前はまだ無い。\n次の段落';
  const after = before.replace('名前', '\n名前');
  assert.equal(map(before, after, 2, { word: '無', prev: '名前はまだ', next: 'い' }), 3);
});

test('resident text identifies its source line even when a printed row has wrapped', () => {
  const source = 'Opening\nFirst check the force. Review these examples.\nThen check the mass.\nClosing';
  const block = { start: { line: 2, column: 1 }, end: { line: 3, column: 21 } };
  assert.deepEqual(findSourceWord(source, block, { word: 'check', prev: 'Then', next: 'the' }), { line: 3, column: 6 });
  assert.equal(findSourceWord(source, block, { word: 'check' }), null);
  assert.equal(findSourceWord(source, block, { word: 'Closing' }), null);
});

test('an ambiguous clicked word uses the nearest confirmed line instead of a duplicate', () => {
  const before = 'Keep this instruction\nForce\nEnd of block';
  const after = 'Keep this instruction\nForce and weight\nForce versus mass\nEnd of block';
  assert.equal(map(before, after, 2, { word: 'Force', block: { start: 1, end: 3 } }), 1);
});

test('one edit in a very long manuscript still maps its changed source line', () => {
  const opening = 'Retained text.\n'.repeat(150_000);
  const ending = 'The answer still explains the evidence.';
  assert.equal(map(opening + ending, opening + '  ' + ending, 150_001), 150_001);
});

const printedQuestion = String.raw`\item Qz011 Please show your work for this problem.`;
const oldWorksheet = ['Opening.', printedQuestion, 'Next question.'].join('\n');
const labelled = printedQuestion + String.raw`\label{exercise:eleven}`;
for (const [name, after, expected] of [
  ['a commented draft', ['% ' + printedQuestion, labelled], 3],
  ['a draft in the comment environment', [String.raw`\begin{comment}`, printedQuestion, String.raw`\end{comment}`, labelled], 5],
  ['nested false branches', [String.raw`\iffalse`, String.raw`\iftrue`, printedQuestion, String.raw`\fi`, String.raw`\else`, labelled, String.raw`\fi`], 7],
  ['a draft after end of document', [labelled, String.raw`\end{document}`, printedQuestion], 2],
  ['an escaped backslash before a real comment', [String.raw`\\% ` + printedQuestion, labelled], 3],
  ['an escaped percent before real ink', ['% ' + printedQuestion, String.raw`\% ` + labelled], 3],
  ['a quoted end marker in inline verbatim', [String.raw`\verb|\end{document}| % ` + printedQuestion, labelled], 3],
  ['a quoted end marker in a listing', [String.raw`\begin{verbatim}`, String.raw`\end{document}`, String.raw`\end{verbatim}`, '% ' + printedQuestion, labelled], 6],
]) {
  test(`a retained exercise skips ${name}`, () => {
    const current = ['Opening.', ...after, 'Next question.'].join('\n');
    assert.equal(map(oldWorksheet, current, 2, { word: 'work', prev: 'your', next: 'for' }), expected);
  });
}

test('neighbouring ink separates a moved and rewrapped exercise from similar wording', () => {
  const first = 'Show your algebra work before checking your solution.';
  const second = 'Show your geometry work before sketching your solution.';
  const before = ['Opening', first, second, 'Closing'].join('\n');
  const after = ['Opening', ' Show your geometry', 'work before sketching your solution.',
    '% ' + first, ' Show your algebra', 'work before checking your solution.', 'Closing'].join('\n');
  assert.equal(map(before, after, 2, { word: 'work', prev: 'algebra', next: 'before' }), 6);
  assert.equal(map(before, after, 3, { word: 'work', prev: 'geometry', next: 'before' }), 3);
});

test('resident word lookup ignores identical draft words at the same visual column', () => {
  const source = ['% ' + printedQuestion, String.raw`\iffalse`, printedQuestion, String.raw`\fi`, labelled].join('\n');
  const range = { start: { line: 1, column: 1 }, end: { line: 5, column: 90 } };
  assert.equal(findSourceWord(source, range, { word: 'work', prev: 'your', next: 'for' }).line, 5);
});

test('a deleted question uses a nearby printed line and keeps a line fallback if none remain', () => {
  assert.equal(map(oldWorksheet, '% no exercise\n% ' + printedQuestion + '\nNext question.', 2), 3);
  assert.equal(map(printedQuestion, '% ' + printedQuestion, 1), 1);
});
