// LuaTeX `-recorder` output. One file list per compile: every path TeX opened
// for reading (INPUT) or writing (OUTPUT), relative to the recorded PWD.
// Shared by the Build import (main.fls) and the canonical compile (canon.fls).

import path from 'node:path';

export const MAX_FLS_INPUTS = 8192;

export function parseFlsFiles(text, cwd, { maxInputs = MAX_FLS_INPUTS } = {}) {
  const inputs = new Set();
  const outputs = new Set();
  let compileCwd = cwd;
  for (const line of String(text || '').split(/\r?\n/)) {
    if (!line.startsWith('PWD ')) continue;
    const value = line.slice(4).trim();
    if (path.isAbsolute(value)) compileCwd = path.resolve(value);
    break;
  }
  for (const line of String(text || '').split(/\r?\n/)) {
    const kind = line.startsWith('INPUT ') ? 'input' : line.startsWith('OUTPUT ') ? 'output' : null;
    if (!kind) continue;
    const raw = line.slice(kind === 'input' ? 6 : 7).trim();
    if (!raw) continue;
    (kind === 'input' ? inputs : outputs).add(path.resolve(compileCwd, raw));
    if (inputs.size + outputs.size > maxInputs * 2) return null;
  }
  return { inputs, outputs, compileCwd };
}
