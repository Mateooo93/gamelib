'use strict';
// Gamelib Electron main — window + IPC bridge to the engine.

const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('node:path');
const os = require('node:os');
const engine = require('./engine');

let win = null;
const send = (channel, payload) => {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
};

// Serialize engine ops so two transfers never interleave on one connection.
let opChain = Promise.resolve();
function serialized(fn) {
  const run = opChain.then(fn, fn);
  opChain = run.catch(() => {});
  return run;
}

function createWindow() {
  win = new BrowserWindow({
    width: 1200,
    height: 760,
    minWidth: 940,
    minHeight: 620,
    show: false,
    backgroundColor: '#171a21',
    title: 'Gamelib',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.once('ready-to-show', () => win.show());
  win.on('closed', () => { win = null; });
}

app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

const ok = (data) => ({ ok: true, ...data });
const fail = (error) => ({ ok: false, error: String(error && error.message || error) });
const wrap = (fn) => async (_e, args) => {
  try { return ok(await serialized(() => fn(args))); }
  catch (err) { return fail(err); }
};

ipcMain.handle('cfg:get', () => {
  const cfg = engine.loadConfig();
  return ok({ cfg, configPath: engine.defaultConfigPath(), os: process.platform });
});

ipcMain.handle('cfg:save', wrap(async ({ server, machine }) => {
  const cfg = engine.loadConfig();
  if (server) cfg.server = { port: 22, ...cfg.server, ...server };
  if (machine) cfg.machine = machine;
  engine.saveConfig(cfg);
  return { cfg };
}));

ipcMain.handle('game:save', wrap(async ({ id, name, folder, launch, saveDirs }) => {
  const cfg = engine.loadConfig();
  const tag = engine.osTag();
  const game = cfg.games[id] || { install: {}, launch: {}, saveDirs: {} };
  if (name) game.name = name;
  if (folder) game.install[tag] = folder;
  if (launch != null) game.launch[tag] = launch;
  if (saveDirs) {
    const list = String(saveDirs).split('\n').map((s) => s.trim()).filter(Boolean);
    game.saveDirs[tag] = list;
  }
  cfg.games[id] = game;
  engine.saveConfig(cfg);
  return { cfg };
}));

ipcMain.handle('status', wrap(async () => engine.status(engine.loadConfig())));

ipcMain.handle('install', wrap(async ({ id }) => {
  const r = await engine.installGame(engine.loadConfig(), id);
  return { id: r.id, dest: r.dest };
}));

ipcMain.handle('publish', wrap(async ({ id, name, dir }) => {
  const r = await engine.publishGame(engine.loadConfig(), id, dir, { name });
  return { id: r.id, os: r.os };
}));

ipcMain.handle('save-push', wrap(async ({ id }) => {
  const r = await engine.savePush(engine.loadConfig(), id);
  return { snapshot: r.snapshot, pruned: r.pruned };
}));

ipcMain.handle('save-pull', wrap(async ({ id }) => {
  const r = await engine.savePull(engine.loadConfig(), id);
  return { snapshot: r.snapshot, from: r.from };
}));

ipcMain.handle('play', wrap(async ({ id }) => {
  const cfg = engine.loadConfig();
  const gameId = id;
  const r = await engine.play(cfg, gameId, {
    onEvent: (ev) => send('engine-event', { id: gameId, ...ev }),
  });
  return { snapshot: r.pushed, pushError: r.error };
}));

ipcMain.handle('open-saves', wrap(async ({ id }) => {
  const dir = engine.openSaveFolder(engine.loadConfig(), id);
  return { dir };
}));

ipcMain.handle('pick-folder', async (_e, title) => {
  const r = await dialog.showOpenDialog(win, {
    title: title || 'Choose a folder',
    properties: ['openDirectory'],
  });
  return ok({ path: r.canceled ? null : r.filePaths[0] });
});

ipcMain.handle('shell:open', wrap(async ({ dir }) => {
  const { execFile } = require('node:child_process');
  if (process.platform === 'win32') execFile('explorer.exe', [dir]);
  else execFile('xdg-open', [dir]);
  return { dir };
}));
