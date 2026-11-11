// Which index processor a project uses. latexmk reads it from the project's
// latexmkrc ($makeindex), and a Japanese book names upmendex with a style
// file there; plain makeindex then writes an .ind the book's own macros
// cannot read, and the compile stops at \printindex.

import { readFileSync } from 'node:fs';
import path from 'node:path';

// Only the processors an index is made with: the rc file is the project's
// and a compile that starts by itself must not run whatever it names.
const INDEX_TOOLS = new Set(['makeindex', 'mendex', 'upmendex', 'xindex', 'texindy', 'xindy']);

function words(text) {
  const out = [];
  for (const match of text.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)) out.push(match[1] ?? match[2] ?? match[3]);
  return out;
}

/** The $makeindex of a latexmkrc as { command, template } (template words
 * still holding latexmk's %S, %D, %O …), or null when there is none, it
 * names another program, or it uses Perl this reader does not follow. */
export function parseLatexmkMakeindex(rc, docDir) {
  let found = null;
  for (const match of rc.matchAll(/^[ \t]*\$makeindex\s*=\s*(?:"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)')\s*;/gm)) found = match;
  if (!found) return null;
  let text = found[1] ?? found[2];
  if (found[1] != null) {
    // a variable holding the folder latexmk was started in
    const roots = new Set();
    for (const match of rc.matchAll(/^[ \t]*(?:my\s+|our\s+)?\$(\w+)\s*=\s*(?:Cwd::)?(?:cwd|getcwd)\s*(?:\(\s*\))?\s*;/gm)) roots.add(match[1]);
    text = text.replace(/\$\{?(\w+)\}?/g, (whole, name) => (roots.has(name) ? docDir : whole));
    if (/\$/.test(text)) return null;
  }
  const [command, ...template] = words(text);
  if (!command || !INDEX_TOOLS.has(path.basename(command)) || command !== path.basename(command)) return null;
  return { command, template };
}

/** The project's index command for one .idx, or null (plain makeindex). */
export function projectIndexCommand(docDir, idx, ind) {
  if (!docDir) return null;
  for (const name of ['.latexmkrc', 'latexmkrc']) {
    let rc;
    try { rc = readFileSync(path.join(docDir, name), 'utf8'); } catch { continue; }
    const parsed = parseLatexmkMakeindex(rc, docDir);
    if (!parsed) continue;
    const base = idx.replace(/\.idx$/i, '');
    const fill = { S: idx, D: ind, B: base, R: path.basename(base), O: '' };
    const args = parsed.template
      .map((word) => word.replace(/%([SDBRO])/g, (_, key) => fill[key]))
      .filter((word) => word !== '');
    return { command: parsed.command, args, cwd: docDir };
  }
  return null;
}
