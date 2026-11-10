import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';

const execFileP = promisify(execFile);

// A rescue owns one immutable PDF. Two conversion lanes overlap process
// startup without spawning one child for every page of a large environment.
export async function renderIsoPages(jobdir, pdf, pages, convert = execFileP) {
  const paths = Array.from({ length: pages }, (_, index) =>
    path.join(jobdir, index === pages - 1 ? 'iso.svg' : `page-${index + 1}.svg`));
  let next = 0, failure;
  const worker = async () => {
    while (next < pages && !failure) {
      const index = next++;
      try {
        await convert('pdftocairo', ['-svg', '-f', String(index + 1), '-l', String(index + 1), pdf, paths[index]],
          { timeout: 30_000 });
      } catch (error) {
        failure ??= error;
      }
    }
  };
  // A failure must wait for the other child before the caller removes the
  // directory or retries the same block through a cold compile.
  await Promise.all(Array.from({ length: Math.min(2, pages) }, worker));
  if (failure) throw failure;
  return paths;
}
