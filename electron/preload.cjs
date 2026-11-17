// Ctrl+Rest: preload.
// 1. Loads the SmartSpectra bridge the renderer SDK talks through.
// 2. Exposes one small API so the app can ask main for the API key.

require('@smartspectra/node-sdk/preload');

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('ctrlRest', {
  isElectron: true,
  getApiKey: () => ipcRenderer.invoke('ctrl-rest:api-key'),
});
