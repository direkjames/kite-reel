// The short list of things the editor screen may ask Windows to do.
const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('kiteNative', {
  pickOpen: kind => ipcRenderer.invoke('pick-open', kind),
  pickSave: (kind, name) => ipcRenderer.invoke('pick-save', kind, name),
  // where a file dropped onto the window lives on disk
  pathForFile: file => { try { return webUtils.getPathForFile(file) || ''; } catch (e) { return ''; } },
  reveal: file => ipcRenderer.send('reveal', file),
  onUpdate: callback => {
    ipcRenderer.on('update', (event, state) => callback(state));
    ipcRenderer.invoke('update-state').then(state => { if (state) callback(state); }).catch(() => {});
  },
  installUpdate: () => ipcRenderer.send('install-update'),
});
