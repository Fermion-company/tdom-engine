// The daemon encodes every galley to JSON inside TeX. Its encoder is tuned
// for speed; the bytes it writes must stay those of the reference encoder,
// because galley hashes (and with them page identity) are built on them.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const texlua = spawnSync('texlua', ['-v']).status === 0;

test('the daemon\'s JSON encoder writes the reference encoder\'s bytes', { skip: !texlua && 'texlua not installed' }, () => {
  const daemon = readFileSync(path.join(ROOT, 'engine/checkpoint/daemon.lua'), 'utf8');
  const from = daemon.indexOf('local function jstr(s)');
  const to = daemon.indexOf('-- ---------------------------------------------------------------- boot');
  assert.ok(from > 0 && to > from, 'the json section of daemon.lua');
  const dir = mkdtempSync(path.join(tmpdir(), 'tdom-json-'));
  try {
    const section = path.join(dir, 'section.lua');
    writeFileSync(section, daemon.slice(from, to));
    const out = execFileSync('texlua', [path.join(ROOT, 'tests/fixtures/daemon-json-reference.lua'), section], { encoding: 'utf8' });
    assert.match(out, /^diffs 0 of 20000 /);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
