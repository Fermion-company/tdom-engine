import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parseLatexmkMakeindex, projectIndexCommand } from '../engine/checkpoint/index-tool.js';

test('the index processor and style of a latexmkrc are used as latexmk would', () => {
  const rc = String.raw`$pdf_mode = 4;
use Cwd;
my $proj_root = cwd();
# $makeindex = "makeindex %O -o %D %S";
$makeindex = "upmendex %O -s $proj_root/styles/book.ist -o %D %S";
`;
  assert.deepEqual(parseLatexmkMakeindex(rc, '/books/one'), {
    command: 'upmendex', template: ['%O', '-s', '/books/one/styles/book.ist', '-o', '%D', '%S'] });
  const dir = mkdtempSync(path.join(tmpdir(), 'tdom-rc-'));
  try {
    writeFileSync(path.join(dir, '.latexmkrc'), rc);
    // beside the .idx, with bare names: openout_any refuses absolute outputs
    assert.deepEqual(projectIndexCommand(dir, '/work/canon.idx', '/work/canon.ind'), {
      command: 'upmendex', args: ['-s', `${dir}/styles/book.ist`, '-o', 'canon.ind', 'canon.idx'], cwd: '/work' });
    // a style named relative to the project folder still resolves from there
    mkdirSync(path.join(dir, 'styles'));
    writeFileSync(path.join(dir, 'styles', 'rel.ist'), '');
    writeFileSync(path.join(dir, '.latexmkrc'), `$makeindex = 'mendex -s styles/rel.ist -o %D %S';`);
    assert.deepEqual(projectIndexCommand(dir, '/work/canon.idx', '/work/canon.ind').args,
      ['-s', path.join(dir, 'styles', 'rel.ist'), '-o', 'canon.ind', 'canon.idx']);
    assert.equal(projectIndexCommand(mkdtempSync(path.join(tmpdir(), 'tdom-rc-none-')), '/w/a.idx', '/w/a.ind'), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('anything but an index processor is left to plain makeindex', () => {
  assert.equal(parseLatexmkMakeindex(`$makeindex = 'sh -c "rm -rf x" %S';`, '/d'), null);
  assert.equal(parseLatexmkMakeindex(`$makeindex = '/tmp/evil/makeindex %S';`, '/d'), null);
  assert.equal(parseLatexmkMakeindex(`$makeindex = "mendex -s $ENV{HOME}/x.ist %S";`, '/d'), null, 'Perl this reader does not follow');
  assert.equal(parseLatexmkMakeindex(`$pdf_mode = 4;`, '/d'), null);
  assert.deepEqual(parseLatexmkMakeindex(`$makeindex = 'mendex -U %O -o %D %S';`, '/d'),
    { command: 'mendex', template: ['-U', '%O', '-o', '%D', '%S'] });
});
