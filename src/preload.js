'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('gamelib', {
  cfgGet: () => ipcRenderer.invoke('cfg:get'),
  cfgSave: (p) => ipcRenderer.invoke('cfg:save', p),
  gameSave: (p) => ipcRenderer.invoke('game:save', p),
  status: () => ipcRenderer.invoke('status'),
  install: (id) => ipcRenderer.invoke('install', { id }),
  publish: (p) => ipcRenderer.invoke('publish', p),
  savePush: (id) => ipcRenderer.invoke('save-push', { id }),
  savePull: (id) => ipcRenderer.invoke('save-pull', { id }),
  play: (id) => ipcRenderer.invoke('play', { id }),
  openSaves: (id) => ipcRenderer.invoke('open-saves', { id }),
  pickFolder: (title) => ipcRenderer.invoke('pick-folder', title),
  openPath: (dir) => ipcRenderer.invoke('shell:open', { dir }),
  updateCheck: () => ipcRenderer.invoke('update:check'),
  updateDownload: (url) => ipcRenderer.invoke('update:download', { url }),
  updateReveal: (file) => ipcRenderer.invoke('update:reveal', { file }),
  onUpdateProgress: (cb) => ipcRenderer.on('update:progress', (_e, p) => cb(p)),
  onEvent: (cb) => ipcRenderer.on('engine-event', (_e, ev) => cb(ev)),
});
