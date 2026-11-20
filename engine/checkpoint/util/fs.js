import { execFileSync } from 'node:child_process';
import { closeSync, fstatSync, openSync, readSync } from 'node:fs';

function resolveFont(name) {
  try {
    return execFileSync('kpsewhich', [name], { encoding: 'utf8' }).trim();
  } catch {
    return '';
  }
}

/** Whether a PDF file exists and ends with %%EOF (flushed completely). */
function pdfComplete(p) {
  let fd = null;
  try {
    fd = openSync(p, 'r');
    const size = fstatSync(fd).size;
    if (size <= 8) return false;
    const tail = Buffer.alloc(32);
    const got = readSync(fd, tail, 0, 32, Math.max(0, size - 32));
    return tail.toString('latin1', 0, got).includes('%%EOF');
  } catch {
    return false; // not there yet
  } finally {
    if (fd !== null) closeSync(fd);
  }
}

/** Wait until a PDF file exists and ends with %%EOF (flushed completely). */
async function waitForPdf(p, timeoutMs = 5000) {
  const t0 = Date.now();
  for (;;) {
    if (pdfComplete(p)) return;
    const waited = Date.now() - t0;
    if (waited >= timeoutMs) break;
    // The child writes the end of the file as it exits, a few milliseconds
    // after it reports DONE. Looked at every 25 ms, a block's exact pixels
    // waited 12 ms on average for a file that was already complete, and 76 ms
    // was measured; only the last 32 bytes are read, so looking often is cheap.
    await new Promise((r) => setTimeout(r, waited < 60 ? 2 : waited < 300 ? 8 : 25));
  }
  throw new Error('render child produced no complete PDF');
}

export { waitForPdf, resolveFont };
