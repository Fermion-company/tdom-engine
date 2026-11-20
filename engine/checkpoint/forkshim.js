// The checkpoint and shipping trees share one verified LuaTeX fork shim.
import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import * as fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const execFileP = promisify(execFile);
const DIR = path.dirname(fileURLToPath(import.meta.url));
const CLT_SDKS = '/Library/Developer/CommandLineTools/SDKs';
const pendingBoots = new Map();

export class ShimUnavailableError extends Error {
  constructor(ctx) {
    super(ctx.attempts.at(-1)?.error || 'tdomfork.so unavailable');
    this.name = 'ShimUnavailableError';
    this.code = 'TDOM_SHIM_UNAVAILABLE';
    this.platform = ctx.platform;
    this.arch = ctx.arch;
    this.sourceHash = ctx.sourceHash;
    this.attempts = ctx.attempts;
  }
}

function context(options) {
  const ctx = {
    fs, exec: execFileP, env: process.env, platform: process.platform, arch: process.arch,
    sourceDir: DIR, log: (line) => console.error(`[tdom-shim] ${line}`), now: Date.now,
    ...options, attempts: [],
  };
  ctx.src = path.join(ctx.sourceDir, 'tdomfork.c');
  ctx.sourceHash = createHash('sha256').update(ctx.fs.readFileSync(ctx.src)).digest('hex');
  ctx.deadline = ctx.now() + 60_000;
  return ctx;
}

async function attempt(ctx, kind, target, fn) {
  const record = { kind, target, ok: false };
  ctx.log(`${kind}: ${target}`);
  try {
    const result = await fn();
    record.ok = true;
    ctx.log(`${kind}: ${target}: ok`);
    return result;
  } catch (error) {
    record.error = String(error.stderr || error.stdout || error.message || error).trim().slice(-8192);
    ctx.log(`${kind}: ${target}: ${record.error}`);
    throw error;
  } finally {
    ctx.attempts.push(record);
  }
}

function timeout(ctx, limit) {
  const remaining = ctx.deadline - ctx.now();
  if (remaining <= 0) throw new Error('tdomfork.so build timed out');
  return Math.min(remaining, limit);
}

async function verify(ctx, so) {
  const result = await ctx.exec('lualatex', ['--luaonly', path.join(ctx.sourceDir, 'forkshim-probe.lua'), so], {
    env: ctx.env, timeout: timeout(ctx, 5000), killSignal: 'SIGKILL', maxBuffer: 64 * 1024,
  });
  if (!String(result.stdout).split(/\r?\n/).includes('TDOM_SHIM_OK')) {
    throw new Error(`tdomfork.so load verification failed: ${result.stdout || result.stderr || so}`);
  }
}

async function stamped(ctx, so, kind) {
  if (!ctx.fs.existsSync(so)) return false;
  try {
    await attempt(ctx, kind, so, async () => {
      if (ctx.fs.readFileSync(`${so}.sha256`, 'utf8').trim() !== ctx.sourceHash) {
        throw new Error('tdomfork.c hash mismatch');
      }
      await verify(ctx, so);
    });
    return true;
  } catch { return false; }
}

async function* sdkCandidates(ctx) {
  // SDKROOT is an explicit toolchain choice. Never silently replace it.
  yield ctx.env.SDKROOT || null;
  if (ctx.platform !== 'darwin' || ctx.env.SDKROOT) return;
  const seen = new Set();
  for (const [command, args] of [
    ['xcrun', ['--sdk', 'macosx', '--show-sdk-path']],
    ['xcode-select', ['-p']],
  ]) {
    try {
      const result = await attempt(ctx, 'sdk-discovery', command, () => ctx.exec(command, args, {
        env: ctx.env, timeout: timeout(ctx, 2000), killSignal: 'SIGKILL', maxBuffer: 64 * 1024,
      }));
      const root = String(result.stdout).trim();
      const sdk = command === 'xcrun' ? root : path.join(root, 'Platforms/MacOSX.platform/Developer/SDKs/MacOSX.sdk');
      if (root && !seen.has(sdk) && ctx.fs.existsSync(sdk)) {
        seen.add(sdk);
        yield sdk;
      }
    } catch { /* try the next SDK source */ }
  }
  let versions = [];
  try { versions = ctx.fs.readdirSync(CLT_SDKS).filter(name => /^MacOSX\d+(?:\.\d+)*\.sdk$/.test(name)); }
  catch { /* Command Line Tools need not be installed */ }
  versions.sort((a, b) => b.localeCompare(a, 'en', { numeric: true }));
  for (const name of versions) {
    const sdk = path.join(CLT_SDKS, name);
    if (!seen.has(sdk)) yield sdk;
  }
}

async function compile(ctx, pending, validate) {
  for await (const sdk of sdkCandidates(ctx)) {
    try {
      await attempt(ctx, 'compile', sdk || 'default', async () => {
        const args = ctx.platform === 'darwin'
          ? ['-O2', '-shared', '-undefined', 'dynamic_lookup', '-arch', ctx.arch === 'x64' ? 'x86_64' : ctx.arch, '-o', pending, ctx.src]
          : ['-O2', '-shared', '-fPIC', '-o', pending, ctx.src];
        await ctx.exec('cc', args, {
          env: sdk ? { ...ctx.env, SDKROOT: sdk } : ctx.env,
          timeout: timeout(ctx, 15_000), killSignal: 'SIGKILL', maxBuffer: 256 * 1024,
        });
        if (validate) await verify(ctx, pending);
      });
      return;
    } catch {
      ctx.fs.rmSync(pending, { force: true });
      if (ctx.now() >= ctx.deadline) break;
    }
  }
  throw new ShimUnavailableError(ctx);
}

function publish(ctx, pending, so) {
  // A persistent cache survives app updates. Publish only complete, checked
  // bytes, and publish the source stamp last so interrupted writes miss cache.
  ctx.fs.rmSync(`${so}.sha256`, { force: true });
  ctx.fs.renameSync(pending, so);
  ctx.fs.writeFileSync(`${so}.sha256`, ctx.sourceHash + '\n');
}

async function obtainShim(workDir, options) {
  const ctx = context(options);
  const so = path.join(workDir, 'tdomfork.so');
  const prebuilt = path.join(ctx.sourceDir, 'prebuilt', `tdomfork-${ctx.platform}-${ctx.arch}.so`);
  const pending = `${so}.tmp-${process.pid}-${randomUUID()}`;
  try {
    if (await stamped(ctx, prebuilt, 'prebuilt')) {
      try {
        await attempt(ctx, 'install', prebuilt, async () => {
          ctx.fs.copyFileSync(prebuilt, pending);
          await verify(ctx, pending);
          publish(ctx, pending, so);
        });
        return so;
      } catch { /* a verified cache may still be usable */ }
    }
    if (await stamped(ctx, so, 'cache')) return so;
    ctx.fs.rmSync(so, { force: true });
    ctx.fs.rmSync(`${so}.sha256`, { force: true });
    await compile(ctx, pending, true);
    publish(ctx, pending, so);
    return so;
  } catch (error) {
    if (error instanceof ShimUnavailableError) throw error;
    ctx.attempts.push({ kind: 'install', target: so, ok: false, error: error.message });
    throw new ShimUnavailableError(ctx);
  } finally {
    ctx.fs.rmSync(pending, { force: true });
  }
}

export async function ensureShim(workDir, options = {}) {
  const key = path.resolve(workDir);
  if (pendingBoots.has(key)) return pendingBoots.get(key);
  const pending = obtainShim(key, options);
  pendingBoots.set(key, pending);
  try { return await pending; }
  finally { pendingBoots.delete(key); }
}

// Packaging runners need a C toolchain, but need not install TeX. Each
// shipped library is still probed in the user's actual LuaTeX before use.
export async function buildPrebuiltShim(options = {}) {
  const ctx = context(options);
  // The runner's OS must not become the minimum OS for the shipped shim.
  // macOS 11 is the first arm64 release; these APIs are available there.
  if (ctx.platform === 'darwin') ctx.env = {
    ...ctx.env, MACOSX_DEPLOYMENT_TARGET: ctx.env.MACOSX_DEPLOYMENT_TARGET || '11.0',
  };
  const dir = path.join(ctx.sourceDir, 'prebuilt');
  const so = path.join(dir, `tdomfork-${ctx.platform}-${ctx.arch}.so`);
  ctx.fs.mkdirSync(dir, { recursive: true });
  const pending = `${so}.tmp-${process.pid}-${randomUUID()}`;
  try {
    await compile(ctx, pending, false);
    publish(ctx, pending, so);
    return so;
  } finally { ctx.fs.rmSync(pending, { force: true }); }
}
