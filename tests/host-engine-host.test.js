import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { EngineHost } from '../host/engine-host.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const fakeEngineDir = path.join(here, 'fixtures', 'fake-engine');

// Sandboxes that forbid loopback listeners cannot exercise the spawn path;
// the pure resolution and environment assertions above still run there.
const skippable = (t, error) => {
  if (error?.code === 'EPERM' || /listen EPERM/.test(error?.message || '')) {
    t.skip('loopback listeners are blocked by this sandbox');
    return true;
  }
  return false;
};

test('the spawn environment pins the engine knobs a host must not inherit', () => {
  const host = new EngineHost({
    engineDir: fakeEngineDir,
    workDir: '/tmp/tdom-work',
    hostWebRoot: '/tmp/host-web',
    pdfjsPath: '/tmp/pdf.mjs',
    binDirs: ['/opt/texlive/bin'],
    extraEnv: { ELECTRON_RUN_AS_NODE: '1' },
  });
  host.port = 4646;
  const env = host.buildSpawnEnv();
  assert.equal(env.PORT, '4646');
  assert.equal(env.ELECTRON_RUN_AS_NODE, '1');
  assert.equal(env.TDOM_WORKDIR, '/tmp/tdom-work');
  assert.equal(env.TDOM_HOST_WEB_ROOT, '/tmp/host-web');
  assert.equal(env.TDOM_PDFJS_PATH, '/tmp/pdf.mjs');
  assert.equal(env.TDOM_MAX_CHECKPOINTS, process.env.TDOM_MAX_CHECKPOINTS || '8');
  assert.equal(env.TDOM_SHIP, process.env.TDOM_SHIP ?? '1');
  assert.equal(env.TDOM_SHIP_PRIVATE_PDF, process.env.TDOM_SHIP_PRIVATE_PDF ?? '1');
  assert.equal(env.TDOM_CANONICAL_ANCHOR, process.env.TDOM_CANONICAL_ANCHOR ?? '1');
  const pathDirs = env.PATH.split(path.delimiter);
  assert.equal(pathDirs[0], '/opt/texlive/bin', 'host TeX directories precede the inherited PATH');
  // poppler and the cc that builds the fork shim live outside the TeX tree,
  // and a GUI-launched app inherits almost no PATH.
  assert.ok(pathDirs.includes('/opt/homebrew/bin'));
  assert.ok(pathDirs.includes('/usr/local/bin'));
});

test('boot uses a sample that actually exists', () => {
  const engineDir = '/fake/engine';
  const host = new EngineHost({
    engineDir,
    existsSync: (candidate) =>
      candidate === path.join(engineDir, 'server.js') ||
      candidate === path.join(engineDir, 'samples', 'minimal.tex'),
  });
  assert.equal(host.pickBootSample(), 'minimal.tex');
  // No samples directory at all: fall back to the engine's own default and
  // let the engine report the problem.
  assert.equal(new EngineHost({ engineDir, existsSync: () => false }).pickBootSample(), 'demo-lua.tex');
  // An explicit choice always wins.
  assert.equal(
    new EngineHost({ engineDir, bootSample: 'paper.tex', existsSync: () => false }).pickBootSample(),
    'paper.tex'
  );
});

test('a missing engine is reported as unavailable, not spawned', async () => {
  const host = new EngineHost({ engineDir: '/fake/engine', existsSync: () => false });
  await assert.rejects(() => host.start(), /was not found at \/fake\/engine/);
  assert.equal(host.getStatus().state, 'unavailable');
  assert.equal(host.getStatus().available, false);
});

test('start waits for readiness and stop tears the process down', async (t) => {
  const host = new EngineHost({
    engineDir: fakeEngineDir,
    // Ephemeral port: test files run in parallel, and a fixed preferred
    // port would make two engines race for the same listener.
    port: 0,
    startTimeoutMs: 5_000,
    pollIntervalMs: 20,
    onStdout: () => {},
    onStderr: () => {},
  });
  t.after(() => host.stop());

  let started;
  try {
    started = await host.start();
  } catch (error) {
    if (skippable(t, error)) return;
    throw error;
  }
  assert.equal(started.ok, true);
  assert.match(started.url, /^http:\/\/127\.0\.0\.1:\d+$/);
  const status = host.getStatus();
  assert.equal(status.state, 'ready');
  assert.equal(status.running, true);

  host.stop();
  assert.equal(host.isRunning(), false);
  assert.equal(host.url, null);
  assert.equal(host.getStatus().state, 'stopped');
});
