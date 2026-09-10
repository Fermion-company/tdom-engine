import { createHash } from 'node:crypto';
import path from 'node:path';
import { isPathInside } from './project-inputs.js';

export function openRequestIdentity({ text, filePath, docDir, overlays, removeOverlays }) {
  const hash = createHash('sha256');
  const add = (value) => {
    const bytes = Buffer.from(String(value), 'utf8');
    hash.update(String(bytes.length));
    hash.update(':');
    hash.update(bytes);
    hash.update(';');
  };
  add(filePath);
  add(docDir);
  add(text);
  const accepted = new Map();
  let totalBytes = 0;
  for (const item of Array.isArray(overlays) ? overlays : []) {
    const overlayPath = typeof item?.filePath === 'string' ? path.resolve(item.filePath) : null;
    const overlayText = typeof item?.text === 'string' ? item.text : null;
    if (!overlayPath || overlayText === null || !isPathInside(docDir, overlayPath)) continue;
    const bytes = Buffer.byteLength(overlayText);
    totalBytes += bytes;
    if (bytes > 8 * 1024 * 1024 || totalBytes > 32 * 1024 * 1024) {
      throw new Error('project overlay exceeds the live-preview text limit');
    }
    accepted.set(overlayPath, overlayText);
  }
  for (const raw of Array.isArray(removeOverlays) ? removeOverlays : []) {
    const overlayPath = typeof raw === 'string' ? path.resolve(raw) : null;
    if (overlayPath && isPathInside(docDir, overlayPath)) accepted.delete(overlayPath);
  }
  for (const [overlayPath, overlayText] of [...accepted].sort(([a], [b]) => a.localeCompare(b))) {
    add(overlayPath);
    add(overlayText);
  }
  return hash.digest('hex');
}

export class OpenRequestConflictError extends Error {
  constructor() {
    super('openRequestId was reused with a different document');
    this.name = 'OpenRequestConflictError';
    this.code = 'OPEN_REQUEST_ID_CONFLICT';
  }
}

export class OpenRequestCache {
  constructor(limit = 8) {
    this.limit = limit;
    this.entries = new Map();
  }

  run(token, identity, operation) {
    if (!token) return operation();
    const prior = this.entries.get(token);
    if (prior) {
      if (prior.identity !== identity) throw new OpenRequestConflictError();
      this.entries.delete(token);
      this.entries.set(token, prior);
      return prior.promise;
    }

    const entry = { identity, pending: true, promise: null };
    const promise = Promise.resolve().then(operation);
    entry.promise = promise;
    this.entries.set(token, entry);
    promise.then(
      () => {
        entry.pending = false;
        this.#trim();
      },
      () => {
        if (this.entries.get(token) === entry) this.entries.delete(token);
      }
    );
    this.#trim();
    return promise;
  }

  #trim() {
    let completed = [...this.entries.values()].filter((entry) => !entry.pending).length;
    if (completed <= this.limit) return;
    for (const [token, entry] of this.entries) {
      if (entry.pending) continue;
      this.entries.delete(token);
      completed -= 1;
      if (completed <= this.limit) break;
    }
  }
}
