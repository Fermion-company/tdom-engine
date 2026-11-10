import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensureShim, buildPrebuiltShim, ShimUnavailableError } from '../engine/checkpoint/forkshim.js';

const sourceDir = fileURLToPath(new URL('../engine/checkpoint', import.meta.url));
const src = path.join(sourceDir, 'tdomfork.c');
const hash = createHash('sha256').update(fs.readFileSync(src)).digest('hex');
const prebuilt = path.join(sourceDir, 'prebuilt/tdomfork-darwin-arm64.so');
const cached = '/work/tdomfork.so';
const xcode = '/Applications/Xcode.app/Contents/Developer';
const sdk = `${xcode}/Platforms/MacOSX.platform/Developer/SDKs/MacOSX.sdk`;
const clt = '/Library/Developer/CommandLineTools/SDKs';

function fixture({ compile, probe, env = {} } = {}) {
  const files = new Map([[src, fs.readFileSync(src)], [sdk, 'directory']]);
  const calls = [], logs = [];
  const fakeFs = {
    existsSync: p => files.has(p),
    readFileSync(p) { if (!files.has(p)) throw new Error(`ENOENT: ${p}`); return files.get(p); },
    readdirSync: () => ['MacOSX9.3.sdk', 'MacOSX27.0.sdk', 'MacOSX26.4.sdk', 'MacOSX.sdk'],
    copyFileSync: (from, to) => files.set(to, fakeFs.readFileSync(from)),
    renameSync(from, to) { fakeFs.copyFileSync(from, to); files.delete(from); },
    writeFileSync: (p, data) => files.set(p, data),
    rmSync: p => files.delete(p),
    mkdirSync() {},
  };
  const exec = async (cmd, args, opts) => {
    calls.push({ cmd, args, opts });
    assert.ok(opts.timeout > 0 && opts.timeout <= 15000);
    assert.equal(opts.killSignal, 'SIGKILL');
    if (cmd === 'cc') {
      await compile?.(opts.env.SDKROOT, calls);
      files.set(args[args.indexOf('-o') + 1], 'compiled');
    } else if (cmd === 'lualatex') {
      await probe?.(files.get(args.at(-1)), args.at(-1));
      return { stdout: 'TDOM_SHIM_OK\n' };
    } else if (cmd === 'xcrun') return { stdout: sdk };
    else if (cmd === 'xcode-select') return { stdout: xcode };
    return { stdout: '' };
  };
  const put = (p, content = 'prebuilt', stamp = hash) => {
    files.set(p, content); files.set(`${p}.sha256`, stamp + '\n');
  };
  return { files, calls, logs, put, options: {
    fs: fakeFs, exec, env, platform: 'darwin', arch: 'arm64', log: line => logs.push(line),
  } };
}
const cc = f => f.calls.filter(c => c.cmd === 'cc');

test('valid prebuilt wins over cache and works without a compiler', async () => {
  const f = fixture({ compile: () => assert.fail('must not compile') });
  f.put(prebuilt); f.put(cached, 'old cache');
  assert.equal(await ensureShim('/work', f.options), cached);
  assert.equal(f.files.get(cached), 'prebuilt');
  assert.equal(f.files.get(cached + '.sha256').trim(), hash);
  assert.equal(cc(f).length, 0);
  assert.deepEqual(f.calls.map(c => c.cmd), ['lualatex', 'lualatex']);
});

test('prebuilt hash mismatch is ignored before loading; a verified cache is reused', async () => {
  const f = fixture();
  f.put(prebuilt, 'wrong', 'stale'); f.put(cached, 'cache');
  await ensureShim('/work', f.options);
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].args.at(-1), cached);
  assert.equal(f.files.get(cached), 'cache');
});

test('mismatched prebuilt without cache compiles and stamps current source', async () => {
  const f = fixture(); f.put(prebuilt, 'wrong', 'stale');
  await ensureShim('/work', f.options);
  assert.equal(cc(f).length, 1);
  assert.equal(f.files.get(cached), 'compiled');
  assert.equal(f.files.get(cached + '.sha256').trim(), hash);
});

test('default SDK failure retries discovered SDK and caches the first success', async () => {
  const f = fixture({ compile: root => { if (!root) throw new Error('ld: tapi error'); } });
  await ensureShim('/work', f.options);
  assert.deepEqual(cc(f).map(c => c.opts.env.SDKROOT), [undefined, sdk]);
  assert.ok(f.logs.some(line => line.includes('ld: tapi error')));
  assert.equal(f.files.get(cached), 'compiled');
});

test('Xcode-selected SDK is tried after xcrun, then versioned CLT SDKs newest first', async () => {
  const f = fixture({ compile: () => { throw new Error('ld failed'); } });
  const exec = f.options.exec;
  f.files.set('/xcrun.sdk', 'dir');
  f.options.exec = (cmd, args, opts) => cmd === 'xcrun' ? Promise.resolve({ stdout: '/xcrun.sdk' }) : exec(cmd, args, opts);
  await assert.rejects(ensureShim('/work', f.options), error => {
    assert.ok(error instanceof ShimUnavailableError);
    assert.equal(error.code, 'TDOM_SHIM_UNAVAILABLE');
    assert.equal(error.sourceHash, hash);
    assert.equal(error.platform, 'darwin');
    assert.equal(error.arch, 'arm64');
    assert.equal(error.message, 'ld failed');
    assert.equal(error.attempts.filter(a => a.kind === 'compile').length, 6);
    return true;
  });
  assert.deepEqual(cc(f).map(c => c.opts.env.SDKROOT), [undefined, '/xcrun.sdk', sdk,
    `${clt}/MacOSX27.0.sdk`, `${clt}/MacOSX26.4.sdk`, `${clt}/MacOSX9.3.sdk`]);
  assert.ok(!f.files.has(cached));
  assert.ok(![...f.files.keys()].some(p => p.includes('.tmp-')));
});

test('explicit SDKROOT is tried first and never replaced', async () => {
  const f = fixture({ env: { SDKROOT: '/chosen.sdk' }, compile: () => { throw new Error('bad user SDK'); } });
  await assert.rejects(ensureShim('/work', f.options), { code: 'TDOM_SHIM_UNAVAILABLE' });
  assert.deepEqual(f.calls.map(c => c.cmd), ['cc']);
  assert.equal(cc(f)[0].opts.env.SDKROOT, '/chosen.sdk');
});

for (const [name, stamp, broken] of [['stale', 'old', false], ['broken', hash, true]]) {
  test(`${name} cache is replaced and probed, even when its stamp matches`, async () => {
    const f = fixture({ probe: bytes => { if (bytes === 'broken') throw new Error('missing flush'); } });
    f.put(cached, broken ? 'broken' : 'old', stamp);
    await ensureShim('/work', f.options);
    assert.equal(f.files.get(cached), 'compiled');
    assert.equal(cc(f).length, 1);
  });
}

test('unloadable prebuilt falls back and invalid compiler output is never published', async () => {
  const f = fixture({ probe: () => { throw new Error('missing flush'); } });
  f.put(prebuilt); f.put(cached, 'broken');
  await assert.rejects(ensureShim('/work', f.options), { code: 'TDOM_SHIM_UNAVAILABLE', message: 'missing flush' });
  assert.ok(!f.files.has(cached));
  assert.ok(!f.files.has(cached + '.sha256'));
});

test('compile and SDK discovery share a bounded total deadline', async () => {
  let now = 0;
  const f = fixture({ compile: () => { now += 60_000; throw new Error('timed out'); } });
  f.options.now = () => now;
  await assert.rejects(ensureShim('/work', f.options), { code: 'TDOM_SHIM_UNAVAILABLE' });
  assert.equal(cc(f).length, 1);
});

test('Linux retains the ordinary PIC compile with no macOS SDK search', async () => {
  const f = fixture(); f.options.platform = 'linux'; f.options.arch = 'x64';
  await ensureShim('/work', f.options);
  assert.ok(cc(f)[0].args.includes('-fPIC'));
  assert.ok(!f.calls.some(c => c.cmd === 'xcrun'));
});

test('concurrent resident and shipping requests share one acquisition', async () => {
  const f = fixture();
  await Promise.all([ensureShim('/work', f.options), ensureShim('/work', f.options)]);
  assert.equal(cc(f).length, 1);
});

test('loader checks every exported function including flush', () => {
  const source = fs.readFileSync(src, 'utf8');
  const probe = fs.readFileSync(path.join(sourceDir, 'forkshim-probe.lua'), 'utf8');
  for (const [, name] of source.matchAll(/lua_setfield\(L, -2, "([^"]+)"\)/g)) {
    assert.ok(probe.includes(`'${name}'`), name);
  }
});

test('prebuilt architecture and deployment target do not depend on the build runner', async () => {
  for (const target of [undefined, '12.0']) {
    const f = fixture({ env: target ? { MACOSX_DEPLOYMENT_TARGET: target } : {} });
    f.options.arch = 'x64';
    const so = await buildPrebuiltShim(f.options);
    assert.equal(path.basename(so), 'tdomfork-darwin-x64.so');
    assert.equal(cc(f)[0].opts.env.MACOSX_DEPLOYMENT_TARGET, target || '11.0');
    const args = cc(f)[0].args;
    assert.equal(args[args.indexOf('-arch') + 1], 'x86_64');
    assert.equal(f.files.get(so + '.sha256').trim(), hash);
  }
});

test('real compile, LuaTeX load, prebuilt install and missing-flush cache repair', async t => {
  const run = promisify(execFile);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tdom-shim-smoke-'));
  t.after(() => fs.rmSync(dir, { force: true, recursive: true }));
  const env = { ...process.env, TDOM_MAX_CHECKPOINTS: '8' };
  fs.writeFileSync(path.join(dir, 'cc.c'), 'int main(void) { return 0; }\n');
  try {
    await run('cc', [path.join(dir, 'cc.c'), '-o', path.join(dir, 'cc')], { env, timeout: 15000 });
    await run('lualatex', ['--version'], { env, timeout: 5000 });
  } catch (error) { t.skip(`cc/LuaTeX unavailable: ${error.message}`); return; }
  fs.copyFileSync(src, path.join(dir, 'tdomfork.c'));
  fs.copyFileSync(path.join(sourceDir, 'forkshim-probe.lua'), path.join(dir, 'forkshim-probe.lua'));
  const options = { sourceDir: dir, env };
  const built = await buildPrebuiltShim(options);
  const installed = await ensureShim(dir, { ...options, exec: (cmd, ...args) => {
    assert.notEqual(cmd, 'cc', 'prebuilt must work without a compiler');
    return run(cmd, ...args);
  } });
  assert.equal(fs.readFileSync(installed + '.sha256', 'utf8').trim(), hash);
  fs.rmSync(path.dirname(built), { recursive: true });
  fs.writeFileSync(path.join(dir, 'tdomfork.c'), fs.readFileSync(src, 'utf8').replace('"flush"', '"missing_flush"'));
  const bad = await buildPrebuiltShim(options);
  fs.copyFileSync(bad, installed);
  fs.copyFileSync(src, path.join(dir, 'tdomfork.c'));
  fs.rmSync(path.dirname(bad), { recursive: true });
  await ensureShim(dir, options);
  assert.equal(fs.readFileSync(installed + '.sha256', 'utf8').trim(), hash);
});
