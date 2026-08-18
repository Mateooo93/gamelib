'use strict';
// Gamelib engine — Steam-like game library + cloud saves over HTTPS.
// Pure Node (no Electron imports) so the CLI and the GUI share this code path.
//
// Transport: the gamelib daemon on the server (server/server.js). Auth is a
// bearer password; TLS is pinned to the daemon's self-signed cert
// (server-cert.pem next to the config). Files are moved with tar over the
// API — on Windows the bundled tar handles extraction, nothing extra to install.
//
// Server layout (dataDir on the remote, default ~/gamelib):
//   library.json                  game registry
//   games/<id>/<osTag>.tar        published game payload per platform
//   saves/<id>/<timestamp>/       save snapshots: saves.tar.gz + meta.json

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const transport = require('./transport');

const GAME_ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/;
const SNAPSHOT_LIMIT = 20;            // snapshots kept per game
const SAVE_CLOCK_TOLERANCE_MS = 120_000; // cross-machine clock tolerance
// Entries that should NEVER appear inside a game save folder — if one shows
// up, the profile got nested inside itself (bad config / bad pull) and
// syncing would just spread the mess further.
const PROFILE_JUNK = ['GPUCache', 'Code Cache', 'Network', 'Local Storage', 'blob_storage',
  'shared_proto_db', 'DawnGraphiteCache', 'DawnWebGPUCache', 'saves', 'custom_maps', 'meta'];

function assertCleanSaveDirs(dirs) {
  for (const d of dirs) {
    const root = resolveDir(d);
    if (!root) continue;
    let entries;
    try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { continue; }
    const bad = entries.find((e) => e.isDirectory() && PROFILE_JUNK.includes(e.name));
    if (bad) {
      throw new GamelibError(
        `save folder ${d} contains a nested profile folder (${bad.name}) — refusing to sync. ` +
        `Clean the folder (keep only real save files) and try again.`);
    }
  }
}

class GamelibError extends Error {}

function osTag() {
  return process.platform === 'win32' ? 'windows' : process.platform;
}

function configDir() {
  if (process.platform === 'win32') return path.join(process.env.APPDATA || os.homedir(), 'gamelib');
  return path.join(os.homedir(), '.config', 'gamelib');
}

function defaultConfigPath() {
  return path.join(configDir(), 'config.json');
}

function loadConfig(file = defaultConfigPath()) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return { server: { host: '', port: 8443, password: '' }, machine: os.hostname(), games: {} };
  }
}

function saveConfig(cfg, file = defaultConfigPath()) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(cfg, null, 2));
}

function expandPath(p) {
  let s = String(p).replace(/^~(?=$|[\\/])/, os.homedir());
  if (process.platform === 'win32') {
    s = s.replace(/%([^%]+)%/g, (_, k) => process.env[k] ?? `%${k}%`);
  }
  return s;
}

// Real path of a (possibly symlinked) directory.
function resolveDir(p) {
  const expanded = expandPath(p);
  try {
    return fs.realpathSync(expanded, { encoding: 'utf8' });
  } catch {
    return null;
  }
}

function validate(gameId) {
  if (!GAME_ID_RE.test(gameId)) throw new GamelibError(`invalid game id: ${gameId}`);
  return gameId;
}

// --- remote helpers -------------------------------------------------------

async function readLibrary(cfg) {
  return transport.api(cfg, 'GET', '/api/library', { json: true });
}

async function writeLibrary(cfg, lib) {
  await transport.api(cfg, 'PUT', '/api/library', { body: JSON.stringify(lib, null, 2) });
}

async function listSnapshots(cfg, gameId) {
  const r = await transport.api(cfg, 'GET', `/api/saves/${validate(gameId)}`, { json: true });
  return (r.snapshots || []).filter((s) => typeof s === 'string');
}

async function latestSnapshotMeta(cfg, gameId) {
  const snaps = await listSnapshots(cfg, gameId);
  for (const ts of snaps) {
    // Walk newest-first; a snapshot with no meta/tar is a broken upload —
    // skip it instead of failing the whole sync.
    const r = await transport.api(cfg, 'GET', `/api/saves/${validate(gameId)}/${ts}/meta.json`, { json: true }).catch(() => null);
    if (r && typeof r === 'object' && r.error) continue;
    return { ts, ...r };
  }
  return null;
}

async function pruneSnapshots(cfg, gameId) {
  const snaps = await listSnapshots(cfg, gameId);
  const extra = snaps.slice(SNAPSHOT_LIMIT);
  for (const ts of extra) {
    await transport.api(cfg, 'DELETE', `/api/saves/${validate(gameId)}/${ts}`);
  }
  return extra.length;
}

// --- local helpers ----------------------------------------------------------

function newestFileMtime(dir) {
  const root = resolveDir(dir);
  if (!root) return 0;
  let newest = 0;
  const stack = [root];
  while (stack.length) {
    const cur = stack.pop();
    let entries;
    try { entries = fs.readdirSync(cur, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      const p = path.join(cur, e.name);
      if (e.isDirectory()) stack.push(p);
      else if (e.isFile()) {
        try { newest = Math.max(newest, fs.statSync(p).mtimeMs); } catch { /* skip */ }
      }
    }
  }
  return newest;
}

function snapshotTs(d = new Date()) {
  return d.toISOString().replace(/[:.]/g, '-').replace(/\.\d+-/, '-').replace(/-00:00Z$|Z$/, 'Z');
}

function localSaveState(cfg, gameId) {
  const game = cfg.games?.[gameId];
  if (!game) throw new GamelibError(`game '${gameId}' is not configured locally`);
  const tag = osTag();
  const dirs = (game.saveDirs && game.saveDirs[tag]) || [];
  const resolved = [];
  const missing = [];
  for (const d of dirs) {
    const r = resolveDir(d);
    if (r) resolved.push(r);
    else missing.push(d);
  }
  return {
    dirs: [...new Set(resolved)], missing, dirty: !missing.length && dirs.length > 0,
    newestLocal: Math.max(0, ...resolved.map((d) => newestFileMtime(d))),
  };
}

function installPath(cfg, gameId) {
  const game = cfg.games?.[gameId];
  const p = game?.install?.[osTag()];
  return p ? expandPath(p) : null;
}

function isInstalled(cfg, gameId) {
  const p = installPath(cfg, gameId);
  if (!p) return false;
  try { return fs.existsSync(path.join(p, '.gamelib.json')); } catch { return false; }
}

async function gameStatus(cfg, gameId, lib) {
  const id = validate(gameId);
  const meta = lib?.games?.[id] || null;
  const local = localSaveState(cfg, id);
  const cloud = await latestSnapshotMeta(cfg, id);
  const installed = isInstalled(cfg, id);

  let saveState = 'none';
  if (!local.missing.length && local.dirs.length) {
    if (!cloud) saveState = 'localOnly';
    else if (local.newestLocal === 0) saveState = 'synced';
    else if (local.newestLocal > (cloud.pushedLocalMtime || 0) + SAVE_CLOCK_TOLERANCE_MS) saveState = 'localNewer';
    else if (local.newestLocal + SAVE_CLOCK_TOLERANCE_MS < (cloud.pushedLocalMtime || 0)) saveState = 'serverNewer';
    else saveState = 'synced';
  }

  return {
    id,
    name: meta?.name || id,
    platforms: meta?.platforms || {},
    updatedAt: meta?.updatedAt || null,
    installed,
    installPath: installPath(cfg, id),
    saveState,
    cloudTs: cloud?.ts || null,
    cloudPushedFrom: cloud?.machine || null,
    cloudAt: cloud?.when || null,
    saveCount: cloud ? (await listSnapshots(cfg, id)).length : 0,
    saveDirs: local.dirs,
    missingSaveDirs: local.missing,
    newestLocal: local.newestLocal ? new Date(local.newestLocal).toISOString() : null,
    error: null,
  };
}

// --- public API --------------------------------------------------------------

async function status(cfg) {
  const lib = await readLibrary(cfg);
  const ids = new Set([...Object.keys(lib.games || {}), ...Object.keys(cfg.games || {})]);
  const games = [];
  for (const id of ids) {
    try { games.push(await gameStatus(cfg, id, lib)); }
    catch (e) { games.push({ id, name: id, error: e.message, installed: false, saveState: 'none' }); }
  }
  return {
    server: cfg.server,
    machine: cfg.machine || os.hostname(),
    games: games.sort((a, b) => a.name.localeCompare(b.name)),
  };
}

async function savePush(cfg, gameId) {
  const id = validate(gameId);
  const local = localSaveState(cfg, id);
  if (local.missing.length) throw new GamelibError(`save dirs missing locally: ${local.missing.join(', ')}`);
  assertCleanSaveDirs(local.dirs);
  const ts = snapshotTs();
  const base = `saves/${id}/${ts}`;
  const meta = {
    game: id, machine: cfg.machine || os.hostname(), os: osTag(),
    when: new Date().toISOString(),
    pushedLocalMtime: local.newestLocal || Date.now(),
    dirs: local.dirs,
  };
  const tmp = path.join(os.tmpdir(), `gamelib-save-${id}-${ts}.tar.gz`);
  try {
    // Build the archive from the union of save dirs (dereferenced).
    const flags = '-czhf';
    await new Promise((resolve, reject) => {
      const names = local.dirs.map((d) => path.basename(d));
      const parents = [...new Set(local.dirs.map((d) => path.dirname(d)))];
      const args = [flags, tmp, ...parents.flatMap((p) => ['-C', p, ...names.filter((n) => local.dirs.some((d) => path.dirname(d) === p && path.basename(d) === n))])];
      const tar = spawn('tar', args, { stdio: ['ignore', 'pipe', 'pipe'] });
      let err = '';
      tar.stderr.on('data', (d) => (err += d));
      tar.on('close', (c) => (c === 0 ? resolve() : reject(new GamelibError(`tar failed: ${err.trim()}`))));
    });
    await transport.uploadFile(cfg, `/api/${base}/saves.tar.gz`, tmp);
    await transport.api(cfg, 'PUT', `/api/${base}/meta.json`, { body: JSON.stringify(meta, null, 2) });
    const pruned = await pruneSnapshots(cfg, id);
    return { snapshot: ts, pruned };
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

async function savePull(cfg, gameId, { backupLocal = true } = {}) {
  const id = validate(gameId);
  const local = localSaveState(cfg, id);
  // Fresh machines may not have the save folders yet — create them so a pull
  // can land, instead of silently skipping (which produced "save doesn't appear").
  for (const miss of local.missing) {
    try { fs.mkdirSync(expandPath(miss), { recursive: true }); }
    catch (e) { throw new GamelibError(`cannot create save dir ${miss}: ${e.message}`); }
  }
  const cloud = await latestSnapshotMeta(cfg, id);
  if (!cloud) throw new GamelibError(`no cloud saves for '${id}' yet`);
  assertCleanSaveDirs([...local.dirs, ...local.missing.map((m) => expandPath(m))]);

  // If local progress looks newer, preserve it as a snapshot — but restore
  // the PRE-backup latest afterwards, so a backup push never becomes the
  // "newest" we pull back (that hid cloud saves on other machines).
  const target = cloud;
  if (backupLocal && local.newestLocal > (cloud.pushedLocalMtime || 0) + SAVE_CLOCK_TOLERANCE_MS) {
    await savePush(cfg, id); // never lose unsynced local progress
  }

  const tmp = path.join(os.tmpdir(), `gamelib-save-${id}-${target.ts}.tar.gz`);
  try {
    await transport.downloadFile(cfg, `/api/saves/${id}/${target.ts}/saves.tar.gz`, tmp);
    for (const d of [...local.dirs, ...local.missing.map((m) => expandPath(m))]) {
      const dest = resolveDir(d);
      if (!dest) throw new GamelibError(`save dir unavailable: ${d}`);
      await new Promise((resolve, reject) => {
        const tar = spawn('tar', ['-xzf', tmp, '--strip-components=1', '-C', dest], { stdio: ['ignore', 'pipe', 'pipe'] });
        let err = '';
        tar.stderr.on('data', (x) => (err += x));
        tar.on('close', (c) => (c === 0 ? resolve() : reject(new GamelibError(`extract failed: ${err.trim()}`))));
      });
    }
  } finally {
    fs.rmSync(tmp, { force: true });
  }
  return { snapshot: target.ts, from: target.machine };
}

async function publishGame(cfg, gameId, dir, { name, os } = {}) {
  const id = validate(gameId);
  const tag = ['linux', 'windows', 'darwin'].includes(os) ? os : osTag();
  const src = resolveDir(dir);
  if (!src) throw new GamelibError(`publish source not found: ${dir}`);
  const tmp = path.join(os.tmpdir(), `gamelib-publish-${id}-${tag}.tar`);
  try {
    await new Promise((resolve, reject) => {
      const parent = path.dirname(src);
      const namePart = path.basename(src);
      const tar = spawn('tar', ['-chf', tmp, '-C', parent, namePart], { stdio: ['ignore', 'pipe', 'pipe'] });
      let err = '';
      tar.stderr.on('data', (d) => (err += d));
      tar.on('close', (c) => (c === 0 ? resolve() : reject(new GamelibError(`tar failed: ${err.trim()}`))));
    });
    await transport.uploadFile(cfg, `/api/games/${id}/${tag}.tar`, tmp);
  } finally {
    fs.rmSync(tmp, { force: true });
  }
  const lib = await readLibrary(cfg);
  lib.games = lib.games || {};
  const entry = lib.games[id] || { platforms: {} };
  entry.name = name || entry.name || id;
  entry.platforms = entry.platforms || {};
  entry.platforms[tag] = { folder: path.basename(src), publishedAt: new Date().toISOString() };
  entry.updatedAt = new Date().toISOString();
  lib.games[id] = entry;
  await writeLibrary(cfg, lib);
  return { id, os: tag };
}

async function installGame(cfg, gameId) {
  const id = validate(gameId);
  const tag = osTag();
  const dest = installPath(cfg, id);
  if (!dest) throw new GamelibError(`no install path configured for '${id}' on ${tag}`);
  fs.mkdirSync(dest, { recursive: true });
  await new Promise((resolve, reject) => {
    const tar = spawn('tar', ['-xf', '-', '--strip-components=1', '-C', dest], { stdio: ['pipe', 'pipe', 'pipe'] });
    let err = '';
    tar.stderr.on('data', (d) => (err += d));
    transport.downloadTo(cfg, `/api/games/${id}/${tag}.tar`, tar)
      .then(() => tar.on('close', (c) => (c === 0 ? resolve() : reject(new GamelibError(`extract failed: ${err.trim()}`)))))
      .catch(reject);
  });
  fs.writeFileSync(path.join(dest, '.gamelib.json'),
    JSON.stringify({ game: id, os: tag, installedAt: new Date().toISOString() }, null, 2));
  return { id, dest };
}

async function play(cfg, gameId, { onEvent } = {}) {
  const id = validate(gameId);
  const game = cfg.games?.[id];
  const tag = osTag();
  const dest = installPath(cfg, id);
  const cmd = game?.launch?.[tag];
  if (!dest || !cmd) throw new GamelibError(`game '${id}' has no launch config for ${tag}`);
  if (!fs.existsSync(dest)) throw new GamelibError(`not installed (${dest})`);

  const emit = (msg) => onEvent && onEvent({ phase: 'sync', message: msg });

  emit('pulling latest saves…');
  try { await savePull(cfg, id); emit('saves up to date'); }
  catch (e) { emit(`cloud pull skipped: ${e.message}`); }

  emit('launching game…');
  const child = process.platform === 'win32'
    ? spawn('cmd.exe', ['/d', '/s', '/c', cmd], { cwd: dest, stdio: 'ignore', detached: true })
    : spawn('sh', ['-c', cmd], { cwd: dest, stdio: 'ignore', detached: true });
  onEvent && onEvent({ phase: 'playing', pid: child.pid });
  await new Promise((resolve, reject) => {
    child.once('error', (e) => reject(new GamelibError(`could not launch: ${e.message}`)));
    child.once('exit', resolve);
  });
  child.unref();

  emit('pushing saves…');
  try {
    const r = await savePush(cfg, id);
    emit(`saves pushed as ${r.snapshot}`);
    return { pushed: r.snapshot };
  } catch (e) {
    emit(`save push failed: ${e.message}`);
    return { pushed: null, error: e.message };
  }
}

function openSaveFolder(cfg, gameId) {
  const local = localSaveState(cfg, gameId);
  if (!local.dirs.length) throw new GamelibError(`no save dirs for '${gameId}' on this machine`);
  const dir = local.dirs[0];
  const { execFile } = require('node:child_process');
  if (process.platform === 'win32') execFile('explorer.exe', [dir]);
  else execFile('xdg-open', [dir]);
  return dir;
}

module.exports = {
  GamelibError, GAME_ID_RE, osTag, configDir, defaultConfigPath,
  loadConfig, saveConfig, expandPath, resolveDir,
  readLibrary, writeLibrary, status, savePush, savePull,
  publishGame, installGame, play, openSaveFolder, snapshotTs,
};
