import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { readFileSync, writeFileSync } from 'node:fs';
import { readIsoPageKeys } from './iso-page-cache.js';
import { pdfPageSvgArgs } from './util/svg.js';

const execFileP = promisify(execFile);

// A rescue owns one immutable PDF. Two conversion lanes overlap process
// startup without spawning one child for every page of a large environment.
export async function renderIsoPages(jobdir, pdf, pages, convert = execFileP, cache = null, readKeys = readIsoPageKeys) {
  const paths = Array.from({ length: pages }, (_, index) =>
    path.join(jobdir, index === pages - 1 ? 'iso.svg' : `page-${index + 1}.svg`));
  const keys = cache && pages > 1 ? await readKeys(pdf, pages) : null;
  const completed = [];
  let next = 0, failure;
  const worker = async () => {
    while (next < pages && !failure) {
      const index = next++;
      try {
        const previous = keys && cache.get(keys[index]);
        if (previous !== undefined && previous !== null && process.env.TDOM_ISO_PAGE_CACHE_VERIFY !== '1') {
          writeFileSync(paths[index], previous);
          continue;
        }
        await convert('pdftocairo', pdfPageSvgArgs(index + 1, pdf, paths[index]),
          { timeout: 30_000 });
        if (keys) {
          const svg = readFileSync(paths[index]);
          if (previous && !previous.equals(svg)) throw new Error('ISO page cache differs from fresh SVG');
          completed.push([keys[index], svg]);
        }
      } catch (error) {
        failure ??= error;
      }
    }
  };
  // A failure must wait for the other child before the caller removes the
  // directory or retries the same block through a cold compile.
  await Promise.all(Array.from({ length: Math.min(2, pages) }, worker));
  if (failure) throw failure;
  for (const [key, svg] of completed) cache.set(key, svg);
  return paths;
}
