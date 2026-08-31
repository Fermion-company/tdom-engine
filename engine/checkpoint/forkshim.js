// Build (once) the fork shim shared by every resident TeX tree — the
// checkpoint engine's dormant chain and the shipping chain both load it.

import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { promisify } from 'node:util';
import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const execFileP = promisify(execFile);
const DIR = path.dirname(fileURLToPath(import.meta.url));

export async function ensureShim(workDir) {
  const so = path.join(workDir, 'tdomfork.so');
  const src = path.join(DIR, 'tdomfork.c');
  const stamp = `${so}.sha256`;
  const sourceHash = createHash('sha256').update(readFileSync(src)).digest('hex');
  if (existsSync(so) && existsSync(stamp) && readFileSync(stamp, 'utf8').trim() === sourceHash) {
    return so;
  }
  // Persistent app work directories survive engine updates. Compile to a
  // private path, then atomically replace the old dylib so a crash or a
  // concurrent boot can never leave a truncated shared object behind.
  const pending = `${so}.tmp-${process.pid}`;
  const args =
    process.platform === 'darwin'
      ? ['-O2', '-shared', '-undefined', 'dynamic_lookup', '-o', pending, src]
      : ['-O2', '-shared', '-fPIC', '-o', pending, src];
  try {
    await execFileP('cc', args, { timeout: 60_000 });
    renameSync(pending, so);
    writeFileSync(stamp, sourceHash + '\n');
  } finally {
    rmSync(pending, { force: true });
  }
  return so;
}
