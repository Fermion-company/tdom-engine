import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

function resolveFont(name) {
  try {
    return execFileSync('kpsewhich', [name], { encoding: 'utf8' }).trim();
  } catch {
    return '';
  }
}

/** Wait until a PDF file exists and ends with %%EOF (flushed completely). */
async function waitForPdf(p, timeoutMs = 5000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try {
      const buf = readFileSync(p);
      if (buf.length > 8 && buf.subarray(-32).toString('latin1').includes('%%EOF')) return;
    } catch {
      /* not there yet */
    }
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error('render child produced no complete PDF');
}

export { waitForPdf, resolveFont };
