import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  NO_FILE_ACCESS,
  defaultCheckoutCandidates,
  packageEngineDir,
  resolveEngineDir,
} from '../host/engine-dir.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('an explicit directory and the environment override every search', () => {
  assert.equal(resolveEngineDir({ explicitDir: '/opt/engine' }).dir, '/opt/engine');
  assert.equal(
    resolveEngineDir({ envDir: '  /opt/from-env  ', explicitDir: '/opt/engine' }).dir,
    '/opt/from-env'
  );
  // A blank env var is not a choice.
  assert.equal(resolveEngineDir({ envDir: '   ', explicitDir: '/opt/engine' }).dir, '/opt/engine');
});

test('a developer checkout wins over a vendored copy', () => {
  const vendored = '/fake/resources/tdom-engine';
  const checkout = path.join('/fake/home', 'tdom-engine');
  const resolved = resolveEngineDir({
    homeDir: '/fake/home',
    vendoredDir: vendored,
    existsSync: (candidate) =>
      candidate === path.join(vendored, 'server.js') ||
      candidate === path.join(checkout, 'server.js'),
  });
  assert.equal(resolved.dir, checkout);
  assert.equal(resolved.needsAccess, null);
});

test('the vendored copy is the packaged-app fallback', () => {
  const vendored = '/fake/resources/tdom-engine';
  const resolved = resolveEngineDir({
    homeDir: '/fake/home',
    vendoredDir: vendored,
    existsSync: (candidate) => candidate === path.join(vendored, 'server.js'),
  });
  assert.equal(resolved.dir, vendored);
});

test('this repository resolves itself with no configuration', () => {
  assert.equal(packageEngineDir(), repoRoot);
  // No checkout, no vendored copy: the host layer inside the engine repo is
  // its own engine, so tools and examples need no setup.
  assert.equal(resolveEngineDir({ homeDir: '/fake/home' }).dir, repoRoot);
});

test('a blocked probe reports the access it needs instead of a bogus miss', () => {
  const home = '/fake/home';
  const candidates = defaultCheckoutCandidates(home);
  const fileAccess = {
    ...NO_FILE_ACCESS,
    classify: (candidate) => (candidate === candidates[0] ? { key: 'developer-dir' } : null),
    probeIfAllowed: (candidate, probe) => (candidate === candidates[0] ? null : probe()),
  };
  const resolved = resolveEngineDir({
    homeDir: home,
    existsSync: () => false,
    fileAccess,
  });
  assert.equal(resolved.needsAccess, 'developer-dir');
  // The reported directory is one the user could actually create.
  assert.equal(resolved.dir, candidates.at(-1));
});
