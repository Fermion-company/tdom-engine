import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  existsSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileP = promisify(execFile);
const DIR = path.dirname(fileURLToPath(import.meta.url));
const VENDOR_DIR = path.resolve(DIR, '../../vendor/synctex');
const PROBE = path.join(DIR, 'synctex-batch-probe.c');
const VENDOR_FILES = [
  'synctex_parser.c',
  'synctex_parser.h',
  'synctex_parser_advanced.h',
  'synctex_parser_c-auto.h',
  'synctex_parser_local.h',
  'synctex_parser_utils.c',
  'synctex_parser_utils.h',
  'synctex_version.h',
];
const MAX_LINES = 512;
const MAX_RECORDS = 100_000;
const MAX_OUTPUT_BYTES = 8 * 1024 * 1024;
const BUILD_TIMEOUT_MS = 60_000;
const QUERY_TIMEOUT_MS = 5_000;
const builds = new Map();
const unavailableBuilds = new Set();
let cachedSourceHash = null;

function sourceHash() {
  if (cachedSourceHash) return cachedSourceHash;
  const hash = createHash('sha256');
  for (const file of [PROBE, ...VENDOR_FILES.map((name) => path.join(VENDOR_DIR, name))]) {
    hash.update(path.basename(file));
    hash.update('\0');
    hash.update(readFileSync(file));
    hash.update('\0');
  }
  cachedSourceHash = hash.digest('hex');
  return cachedSourceHash;
}

async function buildHelper(workDir, run, timeoutMs) {
  const executable = path.join(workDir, process.platform === 'win32' ? 'tdom-synctex-batch.exe' : 'tdom-synctex-batch');
  const stamp = `${executable}.sha256`;
  const hash = sourceHash();
  if (existsSync(executable) && existsSync(stamp) && readFileSync(stamp, 'utf8').trim() === hash) {
    return executable;
  }
  const suffix = `${process.pid}-${randomUUID()}`;
  const pendingExecutable = `${executable}.tmp-${suffix}`;
  const pendingStamp = `${stamp}.tmp-${suffix}`;
  const args = [
    '-O2',
    '-I', VENDOR_DIR,
    '-o', pendingExecutable,
    PROBE,
    path.join(VENDOR_DIR, 'synctex_parser.c'),
    path.join(VENDOR_DIR, 'synctex_parser_utils.c'),
    '-lz',
  ];
  try {
    await run('cc', args, {
      timeout: Math.min(BUILD_TIMEOUT_MS, Math.max(1, Math.floor(timeoutMs))),
      maxBuffer: 2 * 1024 * 1024,
    });
    writeFileSync(pendingStamp, `${hash}\n`);
    renameSync(pendingExecutable, executable);
    renameSync(pendingStamp, stamp);
    return executable;
  } finally {
    rmSync(pendingExecutable, { force: true });
    rmSync(pendingStamp, { force: true });
  }
}

async function ensureHelper(workDir, run, timeoutMs) {
  const resolvedWorkDir = path.resolve(workDir);
  const key = `${resolvedWorkDir}:${sourceHash()}`;
  if (unavailableBuilds.has(key)) throw new Error('SyncTeX helper compiler is unavailable');
  let job = builds.get(key);
  if (job) {
    const existing = await job.catch(() => null);
    if (existing && existsSync(existing)) return existing;
    if (builds.get(key) === job) builds.delete(key);
    job = null;
  }
  if (!job) {
    job = buildHelper(resolvedWorkDir, run, timeoutMs);
    builds.set(key, job);
    job.catch(() => {
      if (builds.get(key) === job) builds.delete(key);
    });
    job.catch((error) => {
      // A missing compiler/zlib or a normal compiler failure will not heal
      // during this engine process. A deadline kill may succeed on a later,
      // warmer request, so leave that case retryable.
      if (!error?.killed && !error?.signal) unavailableBuilds.add(key);
    });
  }
  return await job;
}

async function beforeTimeout(promise, timeoutMs) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('SyncTeX helper build deadline exceeded')), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** Build the document-independent range helper before a first proof needs it.
 * Failure is deliberately non-fatal: range queries retain their per-line
 * SyncTeX CLI fallback when a compiler or zlib is unavailable. */
export async function prepareSyncTeXBatchHelper({
  workDir,
  timeoutMs = BUILD_TIMEOUT_MS,
  run = execFileP,
} = {}) {
  if (typeof workDir !== 'string' || !workDir ||
      !Number.isFinite(timeoutMs) || timeoutMs < 1 || typeof run !== 'function') return null;
  const budget = Math.min(BUILD_TIMEOUT_MS, Math.max(1, Math.floor(timeoutMs)));
  try {
    return await beforeTimeout(ensureHelper(workDir, run, budget), budget);
  } catch {
    return null;
  }
}

function finiteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function parsedRecord(record) {
  if (!record || !Number.isInteger(record.page) || record.page < 1 ||
      ![record.x, record.y, record.h, record.v, record.W, record.H].every(finiteNumber)) return null;
  return {
    page: record.page,
    x: record.x,
    y: record.y,
    box: {
      left: record.h,
      top: record.v - record.H,
      right: record.h + Math.max(0, record.W),
      bottom: record.v + Math.max(1, record.H * 0.25),
    },
  };
}

/** Validate the native helper as an all-or-nothing range result. */
export function parseSyncTeXBatchOutput(output, { firstLine, lastLine } = {}) {
  if (!Number.isInteger(firstLine) || !Number.isInteger(lastLine) || firstLine < 1 ||
      lastLine < firstLine || lastLine - firstLine >= MAX_LINES ||
      typeof output !== 'string' || Buffer.byteLength(output) > MAX_OUTPUT_BYTES) return null;
  let value;
  try {
    value = JSON.parse(output);
  } catch {
    return null;
  }
  if (value?.schemaVersion !== 1 || value?.complete !== true ||
      value.firstLine !== firstLine || value.lastLine !== lastLine ||
      !Array.isArray(value.groups) || value.groups.length !== lastLine - firstLine + 1 ||
      !Number.isInteger(value.recordCount) || value.recordCount < 0 || value.recordCount > MAX_RECORDS) return null;
  let recordCount = 0;
  const groups = [];
  for (let index = 0; index < value.groups.length; index++) {
    const group = value.groups[index];
    if (group?.line !== firstLine + index || !Array.isArray(group.records)) return null;
    const records = [];
    for (const record of group.records) {
      const parsed = parsedRecord(record);
      if (!parsed || ++recordCount > MAX_RECORDS) return null;
      records.push(parsed);
    }
    groups.push(records);
  }
  return recordCount === value.recordCount ? groups : null;
}

/** Parse one immutable SyncTeX generation once and query a bounded line range.
 * Any build, process, output, or completeness failure returns null so the
 * caller can use the installed SyncTeX CLI without changing correctness. */
export async function querySyncTeXRange({
  workDir,
  pdf,
  file,
  firstLine,
  lastLine,
  firstColumn = 1,
  timeoutMs = QUERY_TIMEOUT_MS,
  run = execFileP,
} = {}) {
  if (![workDir, pdf, file].every((value) => typeof value === 'string' && value) ||
      !Number.isInteger(firstLine) || !Number.isInteger(lastLine) || firstLine < 1 ||
      lastLine < firstLine || lastLine - firstLine >= MAX_LINES ||
      !Number.isInteger(firstColumn) || firstColumn < 1 ||
      !Number.isFinite(timeoutMs) || timeoutMs < 1) return null;
  try {
    const deadline = Date.now() + Math.min(QUERY_TIMEOUT_MS, Math.max(1, Math.floor(timeoutMs)));
    const buildBudget = deadline - Date.now();
    if (buildBudget < 1) return null;
    const executable = await prepareSyncTeXBatchHelper({ workDir, timeoutMs: buildBudget, run });
    if (!executable) return null;
    const remaining = deadline - Date.now();
    if (remaining < 1) return null;
    const result = await run(executable, [
      pdf,
      file,
      String(firstLine),
      String(lastLine),
      String(firstColumn),
    ], {
      cwd: workDir,
      timeout: remaining,
      maxBuffer: MAX_OUTPUT_BYTES,
      env: process.env,
    });
    return parseSyncTeXBatchOutput(String(result?.stdout ?? ''), { firstLine, lastLine });
  } catch {
    return null;
  }
}
