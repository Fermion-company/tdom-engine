// Node-side host layer: everything a host application needs to run the engine
// as a live preview for its own editor.
//
//   const host = createLivePreviewHost({ workDir, binDirs });
//   await host.start();                       // spawn + wait for readiness
//   await host.push({ source, path });        // stream the buffer as it changes
//   host.getStatus().url                      // embed <url>/?embed=1 in an iframe
//   host.stop();                              // SIGTERM; reaps the resident TeX tree
//
// The browser-side pieces (embed-client.js, live-driver.js) are imported
// directly by renderer code; they are not re-exported here so this module
// stays usable from plain Node.

import { EngineHost, DEFAULT_PORT, DEFAULT_START_TIMEOUT_MS, findAvailablePort } from './engine-host.js';
import { DocumentSession, diffEdit } from './document-session.js';
import { requestJson } from './http-json.js';
import {
  ENGINE_MARKER,
  ENGINE_NAME,
  NO_FILE_ACCESS,
  defaultCheckoutCandidates,
  packageEngineDir,
  resolveEngineDir,
} from './engine-dir.js';

export {
  DEFAULT_PORT,
  DEFAULT_START_TIMEOUT_MS,
  DocumentSession,
  ENGINE_MARKER,
  ENGINE_NAME,
  EngineHost,
  NO_FILE_ACCESS,
  defaultCheckoutCandidates,
  diffEdit,
  findAvailablePort,
  packageEngineDir,
  requestJson,
  resolveEngineDir,
};

export function createLivePreviewHost(options = {}) {
  const request = options.requestImpl || requestJson;
  const engine = new EngineHost({ ...options, requestImpl: request });
  const session = new DocumentSession({
    request,
    getUrl: () => engine.url,
    ensureStarted: () => engine.start(),
    timeoutMs: engine.startTimeoutMs,
    ...(options.readFileSync ? { readFileSync: options.readFileSync } : {}),
    ...(options.statSync ? { statSync: options.statSync } : {}),
  });
  // A restarted engine holds no document, and a dead one holds nothing at
  // all; either way the next push must re-open rather than diff.
  engine.onReady = () => session.reset();
  engine.onEnd = () => session.reset();

  return {
    engine,
    session,
    start: () => engine.start(),
    getStatus: () => engine.getStatus(),
    isRunning: () => engine.isRunning(),
    get url() {
      return engine.url;
    },
    push: (payload) => session.push(payload),
    focus: (payload) =>
      engine.isRunning() && engine.state === 'ready'
        ? session.focus(payload)
        : Promise.resolve({ ok: false, error: 'live preview engine is not ready' }),
    stop: () => engine.stop(),
    shutdown: () => engine.stop(),
  };
}
