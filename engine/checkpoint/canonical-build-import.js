import { createHash } from 'node:crypto';
import { lstat, readFile, realpath } from 'node:fs/promises';
import { gunzip as gunzipCallback } from 'node:zlib';
import { promisify } from 'node:util';
import path from 'node:path';
import { isPathInside } from '../project-inputs.js';
import { parseFlsFiles } from './fls.js';

const gunzip = promisify(gunzipCallback);
const SHA256 = /^[0-9a-f]{64}$/;
const REQUEST_ID = /^[A-Za-z0-9:_-]{1,128}$/;
const TOKEN = /^[0-9a-f-]{36}$/i;
const SEED_EXTENSIONS = new Set(['aux', 'toc', 'lof', 'lot', 'out']);
const TEX_SOURCE_EXTENSIONS = new Set(['.tex', '.sty', '.cls', '.def', '.cfg', '.lua']);
const MAX_ARTIFACT_BYTES = 256 * 1024 * 1024;
const MAX_FLS_BYTES = 8 * 1024 * 1024;
const MAX_SYNCTEX_COMPRESSED_BYTES = 8 * 1024 * 1024;
const MAX_SYNCTEX_BYTES = 32 * 1024 * 1024;
const MAX_INPUTS = 8192;
const MAX_PROJECT_INPUT_BYTES = 512 * 1024 * 1024;

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function reject(reason) {
  return { accepted: false, reason };
}

async function readRegularHashed(descriptor, { maxBytes = MAX_ARTIFACT_BYTES, root = null } = {}) {
  if (!descriptor || typeof descriptor.path !== 'string' || !path.isAbsolute(descriptor.path) ||
      !SHA256.test(String(descriptor.sha256 || '').toLowerCase())) return null;
  const file = path.resolve(descriptor.path);
  try {
    const stats = await lstat(file);
    if (!stats.isFile() || stats.isSymbolicLink() || stats.size < 1 || stats.size > maxBytes) return null;
    if (root) {
      const [realRoot, realFile] = await Promise.all([realpath(root), realpath(file)]);
      if (!isPathInside(realRoot, realFile)) return null;
    }
    const bytes = await readFile(file);
    if (bytes.length !== stats.size || sha256(bytes) !== descriptor.sha256.toLowerCase()) return null;
    return { file, bytes, sha256: descriptor.sha256.toLowerCase() };
  } catch {
    return null;
  }
}

function parseSyncTeXInputs(text, cwd) {
  const inputs = new Set();
  for (const line of String(text || '').split(/\r?\n/)) {
    const match = /^Input:\d+:(.+)$/.exec(line);
    if (!match) continue;
    inputs.add(path.resolve(cwd, match[1]));
    if (inputs.size > MAX_INPUTS) return null;
  }
  return inputs;
}

function compatibleProfile(profile, mainFile) {
  if (!profile || profile.runner !== 'latexmk' || profile.requestedEngine !== 'lualatex' ||
      profile.effectiveEngine !== 'lualatex' ||
      profile.synctex !== true || profile.interaction !== 'nonstopmode' ||
      profile.haltOnError !== true || profile.fileLineError !== true ||
      !Array.isArray(profile.extraArgs) || profile.extraArgs.length !== 0) return false;
  return typeof profile.mainFile === 'string' && path.normalize(profile.mainFile) === path.normalize(mainFile);
}

async function projectSourceInputs(flsFiles, projectRoot) {
  const realRoot = await realpath(projectRoot);
  const outputIdentities = new Set();
  for (const output of flsFiles.outputs) {
    try { outputIdentities.add(await realpath(output)); } catch { /* a recorder output may be removed after Build */ }
  }
  const results = new Map();
  for (const recordedPath of flsFiles.inputs) {
    if (flsFiles.outputs.has(recordedPath)) continue;
    let identity;
    try { identity = await realpath(recordedPath); } catch {
      if (isPathInside(projectRoot, recordedPath) &&
          !path.relative(projectRoot, recordedPath).split(path.sep).some((part) =>
            part === '.tex64' || part.startsWith('.tex64-build-'))) {
        return { error: 'fls-project-input-unavailable' };
      }
      continue;
    }
    const relative = path.relative(realRoot, identity);
    if (isPathInside(projectRoot, recordedPath) && !isPathInside(realRoot, identity)) {
      return { error: 'fls-project-input-outside-real-root' };
    }
    if (!isPathInside(realRoot, identity) || relative.split(path.sep).some((part) =>
      part === '.tex64' || part.startsWith('.tex64-build-')) || outputIdentities.has(identity)) continue;
    results.set(identity, recordedPath);
    if (results.size > MAX_INPUTS) return null;
  }
  return results;
}

/**
 * Validate a successful manual Build as a candidate for the engine's existing
 * observable-input canonical contract. This is deliberately not a hermetic
 * build proof: TeX-system files outside the project are assumed stable for the
 * lifetime of this process, and commands which bypass the recorder remain
 * unsupported. No bytes are published by this function.
 */
export async function validateCanonicalBuildImport({
  candidate,
  projectRoot,
  mainFile,
  source,
  effectiveProjectInput,
} = {}) {
  const root = path.resolve(projectRoot || '.');
  const rootFile = path.resolve(root, mainFile || '');
  if (!candidate || candidate.schemaVersion !== 1 || !REQUEST_ID.test(candidate.requestId || '') ||
      !TOKEN.test(candidate.token || '') || !compatibleProfile(candidate.profile, mainFile) ||
      candidate.provenance?.inputProof !== 'build-fls' || candidate.provenance?.dynamicInputs !== false ||
      !Array.isArray(candidate.provenance?.unknownInputs) || candidate.provenance.unknownInputs.length !== 0 ||
      candidate.provenance?.systemInputsStable !== true) return reject('profile-or-provenance-incompatible');
  if (!Number.isFinite(candidate.metrics?.durationMs) || candidate.metrics.durationMs <= 0 ||
      candidate.metrics.durationMs > 900_000) return reject('build-metrics-invalid');

  let realRoot, realRootFile;
  try {
    [realRoot, realRootFile] = await Promise.all([realpath(root), realpath(rootFile)]);
  } catch { return reject('project-root-unavailable'); }
  if (!isPathInside(root, rootFile)) return reject('main-file-outside-project');

  const artifacts = candidate.artifacts ?? {};
  const [pdf, synctex, fls] = await Promise.all([
    readRegularHashed(artifacts.pdf, { root }),
    readRegularHashed(artifacts.synctex, { root, maxBytes: MAX_SYNCTEX_COMPRESSED_BYTES }),
    readRegularHashed(artifacts.fls, { root, maxBytes: MAX_FLS_BYTES }),
  ]);
  if (!pdf || !pdf.bytes.subarray(0, 1024).includes(Buffer.from('%PDF-'))) return reject('pdf-invalid');
  if (!synctex) return reject('synctex-invalid');
  if (!fls) return reject('fls-invalid');

  const flsFiles = parseFlsFiles(fls.bytes.toString('utf8'), root);
  if (!flsFiles) return reject('fls-input-limit');
  let realCompileCwd;
  try { realCompileCwd = await realpath(flsFiles.compileCwd); } catch { return reject('fls-cwd-unavailable'); }
  if (realCompileCwd !== realRoot) return reject('fls-cwd-mismatch');
  const required = await projectSourceInputs(flsFiles, root);
  if (!required) return reject('fls-input-limit');
  if (required.error) return reject(required.error);
  if (!required.has(realRootFile)) return reject('fls-missing-main-input');

  const records = Array.isArray(candidate.inputs) ? candidate.inputs : [];
  if (!records.length || records.length > MAX_INPUTS) return reject('input-record-limit');
  const byPath = new Map();
  for (const record of records) {
    if (typeof record?.path !== 'string' || !path.isAbsolute(record.path) ||
        !SHA256.test(String(record.sha256 || '').toLowerCase())) return reject('input-record-invalid');
    const file = path.resolve(record.path);
    let identity;
    try { identity = await realpath(file); } catch { return reject('input-record-invalid'); }
    if (!isPathInside(realRoot, identity) || byPath.has(identity)) return reject('input-record-invalid');
    byPath.set(identity, { file, sha256: record.sha256.toLowerCase() });
  }
  if (required.size !== byPath.size || [...required.keys()].some((file) => !byPath.has(file))) {
    return reject('project-input-set-mismatch');
  }
  let projectInputBytes = 0;
  for (const identity of required.keys()) {
    const record = byPath.get(identity);
    let bytes;
    if (identity === realRootFile) bytes = Buffer.from(String(source), 'utf8');
    else {
      const override = await effectiveProjectInput(record.file);
      if (typeof override === 'string') bytes = Buffer.from(override, 'utf8');
      else {
        try { bytes = await readFile(record.file); } catch { return reject('project-input-unavailable'); }
      }
    }
    projectInputBytes += bytes.length;
    if (projectInputBytes > MAX_PROJECT_INPUT_BYTES) return reject('project-input-budget-exceeded');
    if (sha256(bytes) !== record.sha256) return reject('project-input-changed');
    if (TEX_SOURCE_EXTENSIONS.has(path.extname(record.file).toLowerCase()) &&
        /\\(?:directlua|lua_now(?::[A-Za-z]+)?|write18|ShellEscape)\b/.test(bytes.toString('utf8'))) {
      return reject('dynamic-input-command-unsupported');
    }
  }

  let syncText;
  try {
    if (artifacts.synctex?.compression !== 'gzip') return reject('synctex-compression-unsupported');
    syncText = (await gunzip(synctex.bytes, { maxOutputLength: MAX_SYNCTEX_BYTES })).toString('utf8');
  } catch {
    return reject('synctex-unreadable');
  }
  const recordedSyncInputs = parseSyncTeXInputs(syncText, root);
  if (!recordedSyncInputs) return reject('synctex-input-limit');
  const syncByIdentity = new Map();
  for (const recorded of recordedSyncInputs) {
    try {
      const identity = await realpath(recorded);
      if (!syncByIdentity.has(identity)) syncByIdentity.set(identity, new Set());
      syncByIdentity.get(identity).add(recorded);
    } catch { /* generated or now-missing input */ }
  }
  const syncInputMap = [];
  for (const identity of required.keys()) {
    const candidates = syncByIdentity.get(identity);
    const needsSourceCoordinates = identity === realRootFile || path.extname(identity).toLowerCase() === '.tex';
    if (!candidates?.size) {
      if (needsSourceCoordinates) return reject('synctex-project-input-missing');
      continue;
    }
    const flsRecorded = required.get(identity);
    const recorded = candidates.has(flsRecorded)
      ? flsRecorded
      : candidates.size === 1 ? candidates.values().next().value : null;
    if (!recorded) return reject('synctex-project-input-ambiguous');
    const logicalPath = identity === realRootFile ? rootFile : byPath.get(identity).file;
    syncInputMap.push({ logicalPath, recordedPath: recorded });
  }

  const seedFiles = {};
  const mainStem = path.basename(mainFile, path.extname(mainFile));
  for (const item of Array.isArray(artifacts.aux) ? artifacts.aux : []) {
    const ext = String(item?.ext || '').toLowerCase();
    if (!SEED_EXTENSIONS.has(ext) || seedFiles[ext] != null ||
        item?.logicalName !== `${mainStem}.${ext}`) continue;
    const read = await readRegularHashed(item, { root, maxBytes: 32 * 1024 * 1024 });
    if (read) seedFiles[ext] = read.bytes.toString('utf8');
  }
  // Content identity of every non-root project input the recorder observed,
  // hashed over the bytes TeX actually read (an unsaved overlay shadows disk).
  // The canonical layer proves a later revision equal to this generation by
  // re-hashing only the inputs that changed since.
  const inputManifest = [];
  for (const identity of required.keys()) {
    if (identity === realRootFile) continue;
    const record = byPath.get(identity);
    inputManifest.push({ logicalPath: record.file, sha256: record.sha256 });
  }
  return {
    accepted: true,
    requestId: candidate.requestId,
    token: candidate.token,
    pdf: pdf.file,
    pdfHash: pdf.sha256,
    synctex: synctex.file,
    synctexHash: synctex.sha256,
    seedFiles,
    syncInputMap,
    inputManifest,
    profile: candidate.profile,
    passes: Number.isSafeInteger(candidate.metrics?.passes) ? candidate.metrics.passes : 0,
    ms: candidate.metrics.durationMs,
    assumptions: ['system-inputs-stable-for-process', 'fls-observable-inputs-only'],
  };
}
