import path from 'node:path';

const READER = /\\(?:input|include)\b/g;
const UNRESOLVED_READER = /\\(?:openin|read|InputIfFileExists|IfFileExists)\b|\\csname\s*(?:input|include)\b/;

const resolved = (value) => typeof value === 'string' ? path.resolve(value) : null;

function readersAccounted(text, parentFile, trace) {
  const source = String(text ?? '');
  if (UNRESOLVED_READER.test(source)) return false;
  const lexicalCount = [...source.matchAll(READER)].length;
  const tracedCount = trace.filter((read) => resolved(read?.parentFile) === parentFile).length;
  return lexicalCount === tracedCount;
}

/** Prove that one current, statically expanded child has no other project
 * reader that could observe its changed bytes outside the owned block. */
export function singleLiteralChildReadProof({
  source,
  sourceFile,
  targetFile,
  trace,
  includes,
  inputEpoch,
}) {
  const root = resolved(sourceFile);
  const target = resolved(targetFile);
  const reads = Array.isArray(trace) ? trace : [];
  if (!root || !target || !Number.isInteger(Number(inputEpoch))) return null;
  const targetReads = reads.filter((read) => resolved(read?.actualPath) === target);
  if (targetReads.length !== 1) return null;
  const targetRead = targetReads[0];
  if (!Number.isInteger(targetRead.depth) || targetRead.depth < 0 ||
      !Number.isInteger(targetRead.rootUnit)) return null;
  // Each ancestor must itself be read once as literal \input. An \include
  // or \subfile can introduce aux or group semantics at that boundary.
  let read = targetRead;
  for (let depth = targetRead.depth; depth >= 0; depth--) {
    if (read.command !== 'input' || read.depth !== depth || read.rootUnit !== targetRead.rootUnit ||
        typeof read.raw !== 'string' || !read.raw.trim() ||
        path.isAbsolute(read.raw.trim()) || /[\\#{}]/.test(read.raw)) return null;
    const parent = resolved(read.parentFile);
    if (!parent) return null;
    if (parent === root || depth === 0) {
      if (parent !== root || depth !== 0) return null;
      break;
    }
    const parents = reads.filter((candidate) => resolved(candidate?.actualPath) === parent);
    if (parents.length !== 1) return null;
    read = parents[0];
  }

  if (!readersAccounted(source, root, reads)) return null;
  const reached = new Set(reads.map((read) => resolved(read?.actualPath)).filter(Boolean));
  for (const actualPath of reached) {
    const cached = includes?.get(actualPath);
    if (typeof cached?.text !== 'string' || !readersAccounted(cached.text, actualPath, reads)) return null;
  }
  return Object.freeze({
    source,
    inputEpoch: Number(inputEpoch),
    targetFile: target,
    read: Object.freeze({ ...targetRead }),
  });
}
