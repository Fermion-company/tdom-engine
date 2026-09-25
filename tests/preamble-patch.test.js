// tex64-internal #93: which preamble edits re-run declarations instead of rebooting.
import test from 'node:test';
import assert from 'node:assert/strict';
import { planPreamblePatch, scanPreamble } from '../engine/checkpoint/preamble-patch.js';

const pre = (parts) => ['\\documentclass{article}', '\\usepackage{amsmath}', ...parts].join('\n');
const plan = (before, after, extra = {}) => planPreamblePatch({ bootPreamble: before, prevPreamble: before, preamble: after, ...extra });

test('scanPreamble reads owned declarations and leaves the rest', () => {
  const s = scanPreamble(pre([
    '\\newcommand*{\\a}[2][x]{#1-#2} % note',
    '\\newcommand\\b{B}',
    '\\newenvironment{box}[1]{\\begin{center}#1}{\\end{center}}',
    '\\NewDocumentCommand{\\c}{m}{(#1)}',
    '\\DeclareMathOperator*{\\argmax}{arg\\,max}',
    '\\makeatletter\\newcommand\\d@x{D}\\makeatother',
    '\\renewcommand{\\thesection}{S\\arabic{section}}',
  ]));
  assert.deepEqual(s.decls.map((d) => d.key), ['command:a', 'command:b', 'environment:box', 'xcommand:c', 'operator:argmax', 'command:d@x']);
  assert.match(s.other, /renewcommand\{\\thesection\}/);
});

test('a changed body is a patch; the prelude re-runs it and restores @', () => {
  const p = plan(pre(['\\newcommand{\\foo}{A}', '\\newcommand{\\bar}{\\foo!}']), pre(['\\newcommand{\\foo}{B}', '\\newcommand{\\bar}{\\foo!}']));
  assert.equal(p.ok, true);
  assert.deepEqual(p.names, ['foo']);
  assert.match(p.prelude, /\\let\\foo\\relax%\n\\newcommand\{\\foo\}\{B\}%/);
  assert.ok(!/\\newcommand\{\\bar\}/.test(p.prelude), 'only changed declarations re-run');
  assert.ok(p.touches('x \\bar y'), 'a use through another declaration counts');
  assert.ok(p.touches('\\foo'));
  assert.ok(!p.touches('\\foobar'));
  assert.match(p.prelude, /catcode`\\@=\\TDOMdefsat/);
});

test('an edit back to the booted preamble leaves no prelude but still dirties the users', () => {
  const boot = pre(['\\newcommand{\\foo}{A}']);
  const p = planPreamblePatch({ bootPreamble: boot, prevPreamble: pre(['\\newcommand{\\foo}{B}']), preamble: boot });
  assert.equal(p.ok, true);
  assert.equal(p.prelude, '');
  assert.ok(p.dirtyRe.test('\\foo'));
});

test('comment-only edits are a patch with nothing to do', () => {
  const p = plan(pre(['\\newcommand{\\foo}{A}']), pre(['% a note', '\\newcommand{\\foo}{A} % why']));
  assert.equal(p.ok, true);
  assert.equal(p.prelude, '');
  assert.equal(p.dirtyRe, null);
});

test('everything else reboots', () => {
  const base = pre(['\\newcommand{\\foo}{A}']);
  const refused = (after, extra) => plan(base, after, extra).reason;
  assert.equal(refused(pre(['\\usepackage{amssymb}', '\\newcommand{\\foo}{A}'])), 'not-only-declarations');
  assert.equal(refused(pre(['\\newcommand{\\fooo}{A}'])), 'not-only-declarations', 'a renamed declaration');
  assert.equal(plan(pre(['\\renewcommand{\\foo}{A}']), pre(['\\renewcommand{\\foo}{B}'])).reason, 'not-only-declarations');
  assert.equal(plan(pre(['\\newcommand{\\foo}{A}', '\\title{\\foo}']), pre(['\\newcommand{\\foo}{B}', '\\title{\\foo}'])).reason, 'used-in-preamble');
  assert.equal(plan(pre(['\\ExplSyntaxOn\\newcommand{\\foo}{A}\\ExplSyntaxOff']), pre(['\\ExplSyntaxOn\\newcommand{\\foo}{B}\\ExplSyntaxOff'])).reason, 'expl3-declaration');
  assert.equal(refused(pre(['\\newcommand{\\foo}{B}']), { packageText: '\\def\\x{\\foo}' }), 'used-in-package');
  assert.equal(refused(pre(['\\newcommand{\\foo}{B}']), { blockTexts: ['\\newcommand{\\baz}{\\foo}'] }), 'used-in-body-definition');
  assert.equal(refused(pre(['\\newcommand{\\foo}{B'])), 'unreadable-declaration');
});
