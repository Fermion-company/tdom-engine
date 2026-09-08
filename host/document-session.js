// The edit stream between a host editor and a running engine.
//
// A host pushes whole buffers; the engine wants a tight dirty range. This
// turns a full-source push into a minimal range edit against the last source
// the engine actually accepted, keeps unsaved child buffers as overlays, and
// re-opens the document when the two sides can no longer agree.

import fs from 'node:fs';
import path from 'node:path';

// Minimal range edit between two sources (common prefix/suffix trim), so the
// engine's checkpoint reuse sees a tight dirty range instead of a full-file
// replacement on every keystroke.
export function diffEdit(previous, next) {
  let start = 0;
  const maxStart = Math.min(previous.length, next.length);
  while (start < maxStart && previous.charCodeAt(start) === next.charCodeAt(start)) start += 1;
  let endPrevious = previous.length;
  let endNext = next.length;
  while (
    endPrevious > start &&
    endNext > start &&
    previous.charCodeAt(endPrevious - 1) === next.charCodeAt(endNext - 1)
  ) {
    endPrevious -= 1;
    endNext -= 1;
  }
  return { start, end: endPrevious, text: next.slice(start, endNext) };
}

const isWithin = (root, candidate) => {
  const rel = path.relative(root, candidate);
  return rel === '' || (!rel.startsWith(`..${path.sep}`) && rel !== '..' && !path.isAbsolute(rel));
};

export class DocumentSession {
  constructor({
    getUrl,
    request,
    ensureStarted = async () => {},
    timeoutMs = 90_000,
    readFileSync = fs.readFileSync,
    statSync = fs.statSync,
  }) {
    this.getUrl = getUrl;
    this.request = request;
    this.ensureStarted = ensureStarted;
    this.timeoutMs = timeoutMs;
    this.readFileSync = readFileSync;
    this.statSync = statSync;
    this.pushQueue = Promise.resolve();
    this.reset();
  }

  // Called on every engine (re)start: a fresh process has no document, so the
  // next push must be an /open rather than a range edit against a source only
  // the dead process ever saw.
  reset() {
    this.lastSource = null;
    this.lastPath = null;
    this.lastSessionKey = null;
    this.lastOverlays = new Map();
    this.lastRootMtimeMs = null;
  }

  // Resolve the configured root plus dirty project buffers into one snapshot.
  // Root changes become range edits, child buffers become overlay deltas, so
  // switching tabs inside one project never reopens the engine.
  resolveSnapshot(payload = {}) {
    const workspaceRoot =
      typeof payload.workspaceRoot === 'string' && path.isAbsolute(payload.workspaceRoot)
        ? path.resolve(payload.workspaceRoot)
        : null;
    const rootFile = typeof payload.rootFile === 'string' ? payload.rootFile.trim() : '';
    if (!workspaceRoot || !rootFile) {
      if (typeof payload.source !== 'string') throw new Error('tdom push requires source text');
      const filePath =
        typeof payload.path === 'string' && payload.path ? path.resolve(payload.path) : null;
      return {
        source: payload.source,
        filePath,
        projectRoot: null,
        // The active file path is part of document identity: two projects
        // with identical text still resolve images, includes and .bib
        // against different directories.
        sessionKey: filePath || 'legacy',
        overlays: new Map(),
        fresh: Boolean(payload.fresh),
        rootMtimeMs: null,
      };
    }

    const rootPath = path.resolve(workspaceRoot, rootFile);
    if (!isWithin(workspaceRoot, rootPath)) throw new Error('tdom root file escapes the workspace');
    const buffers = new Map();
    for (const item of Array.isArray(payload.buffers) ? payload.buffers : []) {
      const rel = typeof item?.path === 'string' ? item.path.trim() : '';
      const text =
        typeof item?.text === 'string'
          ? item.text
          : typeof item?.source === 'string'
            ? item.source
            : null;
      if (!rel || text === null) continue;
      const absolute = path.resolve(workspaceRoot, rel);
      if (!isWithin(workspaceRoot, absolute)) continue;
      buffers.set(absolute, text);
    }
    let rootMtimeMs = null;
    try {
      rootMtimeMs = this.statSync(rootPath).mtimeMs;
    } catch {}
    let source = buffers.get(rootPath);
    // A clean root that has not changed on disk is still the source the
    // engine holds — re-reading it would be a pointless full-file diff.
    if (
      source === undefined &&
      this.lastPath === rootPath &&
      this.lastSource !== null &&
      this.lastRootMtimeMs === rootMtimeMs
    ) {
      source = this.lastSource;
    }
    if (source === undefined) source = this.readFileSync(rootPath, 'utf8');
    buffers.delete(rootPath);
    return {
      source,
      filePath: rootPath,
      projectRoot: workspaceRoot,
      sessionKey: `${workspaceRoot}\0${rootPath}`,
      overlays: buffers,
      fresh: Boolean(payload.fresh) && this.lastSessionKey !== `${workspaceRoot}\0${rootPath}`,
      rootMtimeMs,
    };
  }

  async open(snapshot) {
    const overlays = [...snapshot.overlays].map(([filePath, text]) => ({ filePath, text }));
    await this.request(`${this.getUrl()}/open`, {
      method: 'POST',
      body: {
        text: snapshot.source,
        ...(snapshot.filePath ? { filePath: snapshot.filePath } : {}),
        ...(snapshot.projectRoot ? { projectRoot: snapshot.projectRoot } : {}),
        ...(overlays.length ? { overlays } : {}),
      },
      timeoutMs: this.timeoutMs,
    });
    this.adopt(snapshot);
  }

  adopt(snapshot) {
    this.lastSource = snapshot.source;
    this.lastPath = snapshot.filePath;
    this.lastSessionKey = snapshot.sessionKey;
    this.lastOverlays = new Map(snapshot.overlays);
    this.lastRootMtimeMs = snapshot.rootMtimeMs;
  }

  // Serialized: two concurrent pushes would diff against the same stale
  // source and send overlapping ranges.
  push(payload = {}) {
    const run = () => this.runPush(payload);
    const result = this.pushQueue.then(run, run);
    this.pushQueue = result.then(
      () => undefined,
      () => undefined
    );
    return result;
  }

  async runPush(payload) {
    await this.ensureStarted();
    const snapshot = this.resolveSnapshot(payload);
    const url = this.getUrl();
    if (!url) throw new Error('tdom engine is not running');

    const pathChanged = snapshot.filePath !== this.lastPath;
    const sessionChanged = snapshot.sessionKey !== this.lastSessionKey;
    if (snapshot.fresh || pathChanged || sessionChanged || this.lastSource === null) {
      await this.open(snapshot);
      return { ok: true, url };
    }

    const overlays = [];
    for (const [filePath, text] of snapshot.overlays) {
      if (this.lastOverlays.get(filePath) !== text) overlays.push({ filePath, text });
    }
    const removeOverlays = [...this.lastOverlays.keys()].filter(
      (filePath) => !snapshot.overlays.has(filePath)
    );
    const sourceChanged = snapshot.source !== this.lastSource;
    if (!sourceChanged && !overlays.length && !removeOverlays.length) {
      this.lastRootMtimeMs = snapshot.rootMtimeMs;
      return { ok: true, url };
    }

    const edit = sourceChanged
      ? diffEdit(this.lastSource, snapshot.source)
      : { start: 0, end: 0, text: '' };
    try {
      await this.request(`${url}/edit`, {
        method: 'POST',
        body: {
          ...edit,
          ...(Number.isFinite(Number(payload.clientEditAtEpochMs))
            ? { clientEditAtEpochMs: Number(payload.clientEditAtEpochMs) }
            : {}),
          ...(overlays.length ? { overlays } : {}),
          ...(removeOverlays.length ? { removeOverlays } : {}),
        },
        timeoutMs: this.timeoutMs,
      });
      this.lastSource = snapshot.source;
      this.lastOverlays = new Map(snapshot.overlays);
      this.lastRootMtimeMs = snapshot.rootMtimeMs;
    } catch {
      // Engine and host disagree about the source (restart, external change).
      // Resync with a fresh open rather than compounding the divergence.
      await this.open(snapshot);
    }
    return { ok: true, url };
  }

  // Speculative warm of the resident chain around the caret. Cheap, best
  // effort, and meaningless before a document is open.
  async focus(payload = {}) {
    const url = this.getUrl();
    if (!url || this.lastSource === null) {
      return { ok: false, error: 'live preview engine is not ready' };
    }
    const offset = Number(payload.offset);
    if (!Number.isFinite(offset)) return { ok: false, error: 'focus requires a finite offset' };
    const response = await this.request(`${url}/warm`, {
      method: 'POST',
      body: { offset },
      timeoutMs: 2_000,
    });
    return { ok: true, ...response };
  }
}
