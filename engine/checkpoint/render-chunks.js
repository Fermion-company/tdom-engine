import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { cropSvg } from './util/svg.js';

const execFileP = promisify(execFile);

export async function cropRenderTargets({ jobdir, pdf, targets, chunks, forGalley, prefix }) {
  const paddingPath = path.join(jobdir, 'render-padding.txt');
  const padding = existsSync(paddingPath) ? Number(readFileSync(paddingPath, 'utf8')) : 0;
  if (!Number.isFinite(padding) || padding < 0) throw new Error('invalid render padding');
  let editPdf;
  for (const tgt of targets) {
    const svgPath = path.join(jobdir, `${prefix}-${tgt.page}.svg`);
    await execFileP(
      'pdftocairo',
      ['-svg', '-f', String(tgt.page), '-l', String(tgt.page), pdf, svgPath],
      { timeout: 30_000 }
    );
    const width = tgt.w + 2 * padding;
    const svg = cropSvg(readFileSync(svgPath, 'utf8'), width, tgt.h);
    const prev = chunks.get(tgt.key);
    chunks.set(tgt.key, {
      svg,
      wBp: width,
      logicalWBp: tgt.w,
      xBp: -padding,
      hBp: tgt.h,
      v: (prev?.v ?? 0) + 1,
      forGalley,
      editPdf: editPdf ??= readFileSync(pdf),
      editPage: tgt.page,
    });
  }
}
