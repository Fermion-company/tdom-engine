import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { cropSvg } from './util/svg.js';

const execFileP = promisify(execFile);

export async function cropRenderTargets({ jobdir, pdf, targets, chunks, forGalley, prefix }) {
  for (const tgt of targets) {
    const svgPath = path.join(jobdir, `${prefix}-${tgt.page}.svg`);
    await execFileP(
      'pdftocairo',
      ['-svg', '-f', String(tgt.page), '-l', String(tgt.page), pdf, svgPath],
      { timeout: 30_000 }
    );
    const svg = cropSvg(readFileSync(svgPath, 'utf8'), tgt.w, tgt.h);
    const prev = chunks.get(tgt.key);
    chunks.set(tgt.key, {
      svg,
      wBp: tgt.w,
      hBp: tgt.h,
      v: (prev?.v ?? 0) + 1,
      forGalley,
    });
  }
}
