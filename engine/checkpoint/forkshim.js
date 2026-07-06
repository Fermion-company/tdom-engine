// Build (once) the fork shim shared by every resident TeX tree — the
// checkpoint engine's dormant chain and the shipping chain both load it.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const execFileP = promisify(execFile);
const DIR = path.dirname(fileURLToPath(import.meta.url));

export async function ensureShim(workDir) {
  const so = path.join(workDir, 'tdomfork.so');
  if (existsSync(so)) return so;
  const src = path.join(DIR, 'tdomfork.c');
  const args =
    process.platform === 'darwin'
      ? ['-O2', '-shared', '-undefined', 'dynamic_lookup', '-o', so, src]
      : ['-O2', '-shared', '-fPIC', '-o', so, src];
  await execFileP('cc', args, { timeout: 60_000 });
  return so;
}
