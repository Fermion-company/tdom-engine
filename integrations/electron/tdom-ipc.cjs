'use strict';

// Electron main-process wiring for the host layer — a worked example, not a
// dependency of the engine.
//
// Electron main is CommonJS while this package is ESM, so the host modules
// are loaded with a dynamic import. Every IPC handler is async anyway, so the
// one-time await costs nothing measurable.
//
// Electron ships its own Node, so the engine is spawned as
// `process.execPath` with ELECTRON_RUN_AS_NODE=1 rather than requiring the
// user to have a system Node.

const loadHost = () => import('../../host/index.js');

async function createElectronLivePreviewHost(options = {}) {
  const { createLivePreviewHost } = await loadHost();
  const { extraEnv, ...rest } = options;
  return createLivePreviewHost({
    ...rest,
    execPath: process.execPath,
    extraEnv: { ELECTRON_RUN_AS_NODE: '1', ...(extraEnv || {}) },
  });
}

// `getHost` may return the host or a promise for it, so an app can create the
// engine lazily on the first preview start instead of at boot.
function registerTdomHostHandlers({ ipcMain, getHost, channelPrefix = 'tdom' }) {
  // The renderer must never see a rejected invoke: a failed engine start is
  // an expected state (no TeX, no checkout) that the UI reports in place.
  const guard = async (operation) => {
    try {
      return await operation();
    } catch (error) {
      return { ok: false, error: error?.message || String(error) };
    }
  };
  const host = async () => getHost();

  ipcMain.handle(`${channelPrefix}:start`, () => guard(async () => (await host()).start()));
  ipcMain.handle(`${channelPrefix}:status`, async () => (await host()).getStatus());
  ipcMain.handle(`${channelPrefix}:stop`, () => guard(async () => (await host()).stop()));
  ipcMain.handle(`${channelPrefix}:push`, (_event, payload) =>
    guard(async () => (await host()).push(payload))
  );
  ipcMain.handle(`${channelPrefix}:focus`, (_event, payload) =>
    guard(async () => (await host()).focus(payload))
  );
}

module.exports = { createElectronLivePreviewHost, registerTdomHostHandlers };
