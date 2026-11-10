// Headless companion to the Electron Jump referee. Never modifies the inputs.
// Usage: node tools/jump-repro.mjs <stress-docs> <review-json-dir> <output-dir>
// Run serially, with TDOM_MAX_CHECKPOINTS=8 and a writable TEXMFCACHE.
import { readFileSync, writeFileSync, mkdirSync, readdirSync, cpSync, existsSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
const { CanonicalRenderer } = await import(process.env.JUMP_RENDERER || '../engine/checkpoint/canonical.js');

const exec = promisify(execFile);
const [documents, review, output] = process.argv.slice(2);
if (!output) throw new Error('Expected documents, review JSON directory, output directory');
const selected = new Set((process.env.DOCS || '02,03,04,06,07,08,10,13,14,16,17,18,19,20').split(','));
const results = [];
const before = 'Inserted paragraph one, long enough to move everything below it down the page. 追加した段落その一です。\n\nInserted paragraph two keeps going for a while so that it wraps onto a second line of the column. 追加した段落その二です。\n\nInserted paragraph three. 追加した段落その三です。\n\n';
const inside = 'A paragraph added in the middle of the document, three lines of it when wrapped in a narrow column, so later lines move. 途中に足した段落です。\n\n';
for (const name of readdirSync(documents).filter(n => selected.has(n.slice(0, 2))).sort()) {
  const root = path.resolve(output, name), truthDir = path.join(root, 'truth');
  mkdirSync(root, { recursive: true });
  const lines = readFileSync(path.join(documents, name, 'main.tex'), 'utf8').split('\n');
  const body = lines.findIndex(l => /begin\{document\}/.test(l));
  const candidates = lines.flatMap((l, i) => i > body && l.length > 20 && /^[^\\%\s{}&]/.test(l) ? [i] : []);
  const edits = candidates.length ? [{ line: candidates[0], text: before }] : [];
  const middle = candidates[Math.floor(candidates.length * 0.4)];
  if (middle !== undefined && middle !== candidates[0]) edits.push({ line: middle, text: inside });
  for (const edit of edits.sort((a, b) => b.line - a.line)) lines[edit.line] = edit.text + lines[edit.line];
  const source = lines.join('\n'), edited = source.split('\n');
  const prior = path.join(review, `js2-${name}.json`);
  const recorded = existsSync(prior) ? JSON.parse(readFileSync(prior)).rows.filter(r => r.kind === 'token') : null;
  if (recorded) for (const r of recorded) {
    if (!edited[r.line - 1]?.includes(r.token)) throw new Error(`${name}:${r.line}: review source drift (${r.token})`);
  }
  cpSync(path.join(documents, name), truthDir, { recursive: true, filter: f =>
    !/\.(pdf|aux|log|synctex\.gz|fls|fdb_latexmk|out|toc|lof|lot)$/.test(f) });
  writeFileSync(path.join(truthDir, 'main.tex'), source);
  console.log(`${name}: compiling independent truth`);
  await exec('latexmk', ['-lualatex', '-interaction=nonstopmode', '-halt-on-error', 'main.tex'],
    { cwd: truthDir, timeout: 600_000, maxBuffer: 32 << 20 });
  const tsv = (await exec('pdftotext', ['-tsv', path.join(truthDir, 'main.pdf'), '-'], { maxBuffer: 64 << 20 })).stdout;
  writeFileSync(path.join(root, 'truth.tsv'), tsv);
  const words = tsv.split('\n').filter(l => l.startsWith('5\t')).map(l => {
    const c = l.split('\t');
    return { page: +c[1], x: +c[6], y: +c[7] + +c[9] / 2, text: c.slice(11).join('\t') };
  });
  let targets = recorded;
  if (!targets) {
    const counts = new Map();
    for (const l of edited.slice(body + 1).filter(l => !/^\s*%/.test(l))) {
      for (const w of l.replace(/\\[A-Za-z@]+/g, ' ').match(/[A-Za-z]{7,}/g) ?? []) counts.set(w, (counts.get(w) || 0) + 1);
    }
    targets = edited.flatMap((l, i) => {
      if (i <= body || /^\s*%/.test(l)) return [];
      const token = (l.replace(/\\[A-Za-z@]+/g, ' ').match(/[A-Za-z]{7,}/g) ?? []).find(w =>
        counts.get(w) === 1 && words.filter(p => (p.text.match(/[A-Za-z]{7,}/g) ?? []).includes(w)).length === 1);
      return token ? [{ line: i + 1, token }] : [];
    });
    if (targets.length > 36) targets = Array.from({ length: 36 }, (_, i) => targets[Math.floor(i * targets.length / 36)]);
  }
  // \include opens nested aux files below the output directory.
  const workDir = path.join(root, 'engine');
  const makeDirs = (from, to) => {
    mkdirSync(to, { recursive: true });
    for (const entry of readdirSync(from, { withFileTypes: true })) if (entry.isDirectory()) makeDirs(path.join(from, entry.name), path.join(to, entry.name));
  };
  makeDirs(truthDir, workDir);
  const renderer = new CanonicalRenderer({ workDir, docDir: truthDir });
  try {
    const generation = await renderer.ensure(source, 2);
    const rows = [];
    for (const target of targets) {
      const matches = words.filter(w => (w.text.match(/[A-Za-z]{7,}/g) ?? []).includes(target.token));
      if (matches.length !== 1) throw new Error(`${name}: nonunique referee token ${target.token}`);
      const truth = matches[0], started = performance.now();
      const answer = await renderer.jumpToSource({ file: path.join(renderer.workDir, 'canon.tex'), source, rev: 2, line: target.line });
      const ms = performance.now() - started, boxes = answer?.boxes ?? [];
      const marker = answer && { page: answer.page, top: Math.min(...boxes.map(b => b.top)), bottom: Math.max(...boxes.map(b => b.bottom)),
        left: Math.min(...boxes.map(b => b.left)), right: Math.max(...boxes.map(b => b.right)) };
      const verdict = !marker ? 'NO_MARKER' : marker.page !== truth.page ? 'WRONG_PAGE' :
        truth.y < marker.top - 8 || truth.y > marker.bottom + 8 ? 'WRONG_Y' :
          truth.x < marker.left - 12 || truth.x > marker.right + 12 ? 'WRONG_X' : 'OK';
      rows.push({ line: target.line, token: target.token, text: edited[target.line - 1], truth, marker, answer, verdict, ms, prior: target.verdict });
    }
    const index = await generation.jumpIndex;
    if (index) writeFileSync(path.join(root, 'index.json'), JSON.stringify({ rows: index.rows,
      records: index.records && { ...index.records, inputs: [...index.records.inputs], records: [...index.records.records] } }));
    const result = { name, ok: rows.filter(r => r.verdict === 'OK').length, total: rows.length, rows };
    results.push(result);
    writeFileSync(path.join(root, 'results.json'), JSON.stringify(result, null, 2));
    console.log(`${name}: ${result.ok}/${result.total}`);
    for (const r of rows.filter(r => r.verdict !== 'OK')) console.log(JSON.stringify(r));
  } finally { renderer.dispose(); }
}
writeFileSync(path.join(output, 'results.json'), JSON.stringify(results, null, 2));
