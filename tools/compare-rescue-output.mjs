// Serial before/after snapshots, including every SVG byte and block state.
// --engine=/path/to/baseline selects a read-only baseline copy.
import { readFileSync, mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import { drain } from './harness.mjs';

const args = process.argv.slice(2);
const file = path.resolve(args.find(a => !a.startsWith('--')));
const root = args.find(a => a.startsWith('--engine='))?.slice(9) ?? path.resolve(import.meta.dirname, '..');
if (Number(process.env.TDOM_MAX_CHECKPOINTS) !== 8) throw new Error('Set TDOM_MAX_CHECKPOINTS=8');
const { CheckpointEngine } = await import(pathToFileURL(path.join(root, 'engine/checkpoint/engine-v3.js')));
const workDir = mkdtempSync(path.join(os.tmpdir(), 'tdom-rescue-compare-'));
const engine = new CheckpointEngine({ workDir, docDir: path.dirname(file) });
const hash = s => createHash('sha256').update(s).digest('hex');
async function snapshot(kind) {
  await drain(engine);
  await engine.renderTask;
  await engine.canonical.ensure(engine.getSource(), engine.srcRev);
  await drain(engine);
  await engine.renderTask;
  if (args.includes('--warm-all')) {
    for (const block of [...engine.blocks]) {
      await engine.warmEditOffset(Math.floor((block.start + block.end) / 2));
      await drain(engine);
      await engine.renderTask;
    }
  }
  const canonical = [];
  for (let page = 1; page <= engine.canonical.info().pageCount; page++) {
    canonical.push(hash(await engine.canonical.pageSVG(page)));
  }
  const blocks = engine.blocks.map(b => [b.id, b.galleyHash, b.stateVec]);
  const chunks = [...engine.chunks].sort(([a], [b]) => a.localeCompare(b)).map(([id, c]) =>
    [id, hash(c.svg), c.wBp, c.hBp, c.xBp ?? null]);
  const dump = args.find(a => a.startsWith('--dump='))?.slice(7);
  if (dump) {
    mkdirSync(dump, { recursive: true });
    writeFileSync(path.join(dump, kind + '.json'), JSON.stringify({
      blocks: engine.blocks.map(b => ({ id: b.id, galley: b.galley })),
      chunks: [...engine.chunks],
    }));
  }
  console.log(JSON.stringify({ kind, mode: engine.mode, policy: engine.previewPolicy, blocks, chunks, canonical,
    signature: hash(JSON.stringify({ blocks, chunks, canonical })), pageCache: engine.isoPageCache?.stats,
    diagnostics: engine.diagnostics }));
}
try {
  const source = readFileSync(file, 'utf8');
  await engine.open(source);
  await snapshot('initial');
  const line = Number(args.find(a => a.startsWith('--line='))?.slice(7));
  const needle = args.find(a => a.startsWith('--needle='))?.slice(9);
  const start = source.indexOf('\\begin{multicols');
  let pos = line ? source.split('\n').slice(0, line).join('\n').length :
    source.indexOf('。', start >= 0 ? start : source.indexOf('\\begin{document}'));
  if (pos < 0) pos = source.indexOf('.', source.indexOf('\\begin{document}') + 16);
  if (needle) {
    const at = source.indexOf(needle, source.indexOf('\\begin{document}'));
    if (at < 0) throw new Error('Edit needle not found');
    pos = at + needle.length;
  }
  if (pos < 0) throw new Error('Specify --line=N for a prose edit');
  await engine.edit(pos, pos, 'a');
  await snapshot('edited');
  await engine.edit(pos, pos + 1, '');
  await snapshot('restored');
} finally {
  await engine.close();
  rmSync(workDir, { recursive: true, force: true });
}
