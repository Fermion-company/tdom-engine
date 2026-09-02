'use strict';

// Renderer-facing bridge. The shape matches what host/live-driver.js expects,
// so a renderer wires the driver to `window.tdom` directly.

const { contextBridge, ipcRenderer } = require('electron');

const createTdomBridge = (channelPrefix = 'tdom') => ({
  start: () => ipcRenderer.invoke(`${channelPrefix}:start`),
  status: () => ipcRenderer.invoke(`${channelPrefix}:status`),
  stop: () => ipcRenderer.invoke(`${channelPrefix}:stop`),
  push: (payload) => ipcRenderer.invoke(`${channelPrefix}:push`, payload),
  focus: (payload) => ipcRenderer.invoke(`${channelPrefix}:focus`, payload),
});

const exposeTdomBridge = (key = 'tdom', channelPrefix = 'tdom') =>
  contextBridge.exposeInMainWorld(key, createTdomBridge(channelPrefix));

module.exports = { createTdomBridge, exposeTdomBridge };
