'use strict';
// Gamelib engine — Steam-like game library + cloud saves over plain SSH.
// Pure Node (no Electron imports) so the CLI and the GUI share this code path.
//
// Transport: system `ssh` + `tar`/`cat` streams. On Windows the OpenSSH client
// and bsdtar ship with the OS, so no extra installs are needed anywhere.
//
// Server layout (~/gamelib on the remote):
//   library.json                  game registry (name, platforms, updatedAt)
//   games/<id>/<osTag>.tar        published game payload per platform
//   saves/<id>/<timestamp>/       save snapshots: saves.tar.gz + meta.json
//
// Everything on the wire is driven by validated ids only (GAME_ID_RE), so the
// remote commands are fixed templates with no user-input interpolation.

const { spawn, execFile } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const GAME_ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/;
const SNAPSHOT_LIMIT = 20;            // snapshots kept per game
const SAVE_CLOCK_TOLERANCE_MS = 120_000; // cross-machine clock tolerance

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
    return { server: { host: '', user: '', port: 22 }, machine: os.hostname(), games: {} };
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

// Real path of a (possibly symlinked, e.g. USB-stick) directory.
function resolveDir(p) {
  const expanded = expandPath(p);
  try {
    return fs.realpathSync(expanded, { encoding: 'utf8' });
  } catch {
    return null;
  }
}

function sshArgs(cfg) {
  const { host, user, port } = cfg.server;
  const target = user ? `${user}@${host}` : host;
  const args = ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15', '-o', 'StrictHostKeyChecking=accept-new'];
  if (port && port !== 22) args.push('-p', String(port));
  args.push(target);
  return args;
}

function remoteBase(cfg) {
  return `gamelib`;
}

function validate(gameId) {
  if (!GAME_ID_RE.test(gameId)) throw new GamelibError(`invalid game id: ${gameId}`);
  return gameId;
}

// --- ssh helpers -----------------------------------------------------------

function runSSH(cfg, remoteArgs, { input } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn('ssh', [...sshArgs(cfg), ...remoteArgs], { stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '', err = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('error', (e) => reject(new GamelibError(`ssh not available: ${e.message}`)));
    child.on('close', (code) => resolve({ code, stdout: out, stderr: err }));
    if (input != null) child.stdin.end(input);
    else child.stdin.end();
  });
}

async function ensureServer(cfg) {
  const base = remoteBase(cfg);
  const mk = await runSSH(cfg, [`mkdir -p ${base}/games ${base}/saves ${base}/meta`]);
  if (mk.code !== 0) throw new GamelibError(`server mkdir failed: ${mk.stderr || mk.stdout}`);
  const has = await runSSH(cfg, [`test -f ${base}/library.json && echo yes || echo no`]);
  if (has.stdout.trim() !== 'yes') {
    const seed = JSON.stringify({ version: 1, games: {} });
    const b64 = Buffer.from(seed).toString('base64');
    const w = await runSSH(cfg, [`echo ${b64} | base64 -d > ${base}/library.json`]);
    if (w.code !== 0) throw new GamelibError(`could not seed library.json: ${w.stderr}`);
  }
}

async function readLibrary(cfg) {
  await ensureServer(cfg);
  const res = await runSSH(cfg, [`cat ${remoteBase(cfg)}/library.json`]);
  if (res.code !== 0) throw new GamelibError(`library read failed: ${res.stderr}`);
  try {
    return JSON.parse(res.stdout);
  } catch {
    throw new GamelibError('library.json on server is corrupt');
  }
}

async function writeLibrary(cfg, lib) {
  const b64 = Buffer.from(JSON.stringify(lib, null, 2)).toString('base64');
  const res = await runSSH(cfg, [`echo ${b64} | base64 -d > ${remoteBase(cfg)}/library.json`]);
  if (res.code !== 0) throw new GamelibError(`library write failed: ${res.stderr}`);
}

// --- streams ---------------------------------------------------------------

function pushTar(cfg, localPath, remoteFile, { compress }) {
  const src = resolveDir(localPath);
  if (!src) throw new GamelibError(`local path not found: ${localPath}`);
  const parent = path.dirname(src);
  const name = path.basename(src);
  const flags = compress ? '-czhf' : '-chf';
  return new Promise((resolve, reject) => {
    const local = spawn('tar', [flags, '-', '-C', parent, name], { stdio: ['ignore', 'pipe', 'pipe'] });
    const remote = spawn('ssh', [...sshArgs(cfg), `mkdir -p ${remoteBase(cfg)}/${remoteFile.replace(/\/[^/]+$/, '')} && cat > ${remoteBase(cfg)}/${remoteFile}`],
      { stdio: ['pipe', 'pipe', 'pipe'] });
    let lerr = '', rerr = '';
    local.stderr.on('data', (d) => (lerr += d));
    remote.stderr.on('data', (d) => (rerr += d));
    local.stdout.pipe(remote.stdin);
    remote.on('error', (e) => reject(new GamelibError(`ssh error: ${e.message}`)));
    local.on('error', (e) => { remote.kill(); reject(new GamelibError(`tar error: ${e.message}`)); });
    let done = 0, rc = 0, msg = '';
    const finish = (code, err) => { rc = Math.max(rc, code); msg += err; if (++done === 2) (rc === 0 ? resolve() : reject(new GamelibError(`push failed: ${msg.trim() || 'unknown'}`))); };
    local.on('close', (c) => finish(c, lerr));
    remote.on('close', (c) => finish(c, rerr));
  });
}

function pullStream(cfg, sink, remoteCommand) {
  return new Promise((resolve, reject) => {
    const remote = spawn('ssh', [...sshArgs(cfg), remoteCommand], { stdio: ['pipe', 'pipe', 'pipe'] });
    let err = '', failed = null;
    remote.stderr.on('data', (d) => (err += d));
    remote.on('error', (e) => reject(new GamelibError(`ssh error: ${e.message}`)));
    remote.stdout.pipe(sink.stdin); // ssh stdout -> local tar stdin
    let done = 0;
    const finish = () => {
      if (++done === 2) {
        if (failed) reject(new GamelibError(`pull failed: ${failed}`));
        else resolve();
      }
    };
    remote.on('close', (code) => { if (code !== 0 && !failed) failed = err.trim() || `ssh exit ${code}`; finish(); });
    sink.on('error', (e) => { if (!failed) failed = e.message; remote.kill(); finish(); });
    sink.on('close', (code) => { if (code !== 0 && !failed) failed = `local exit ${code}`; finish(); });
  });
}

function pullTar(cfg, remoteTarArgs, destDir, { compress }) {
  const flags = compress ? '-xzf' : '-xf';
  const local = spawn('tar', [flags, '-', '--strip-components=1', '-C', destDir], { stdio: ['pipe', 'pipe', 'pipe'] });
  let lerr = '';
  local.stderr.on('data', (d) => (lerr += d));
  return pullStream(cfg, local, remoteTarArgs).catch((e) => {
    e.message += lerr.trim() ? ` (${lerr.trim()})` : '';
    throw e;
  });
}

function pullFile(cfg, remoteFile, localPath) {
  return new Promise((resolve, reject) => {
    fs.mkdirSync(path.dirname(localPath), { recursive: true });
    const remote = spawn('ssh', [...sshArgs(cfg), `cat ${remoteBase(cfg)}/${remoteFile}`], { stdio: ['pipe', 'pipe', 'pipe'] });
    const out = fs.createWriteStream(localPath);
    let err = '';
    remote.stderr.on('data', (d) => (err += d));
    remote.stdout.pipe(out);
    remote.on('close', (code) => (code === 0 ? resolve() : reject(new GamelibError(`download failed: ${err.trim()}`))));
  });
}

function writeRemoteFile(cfg, remoteFile, content) {
  const b64 = Buffer.from(String(content)).toString('base64');
  return runSSH(cfg, [`echo ${b64} | base64 -d > ${remoteBase(cfg)}/${remoteFile}`]);
}

// --- save snapshots ---------------------------------------------------------

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

async function listSnapshots(cfg, gameId) {
  const res = await runSSH(cfg, [`ls ${remoteBase(cfg)}/saves/` + validate(gameId) + ` 2>/dev/null || true`]);
  return res.stdout.split('\n').map((s) => s.trim()).filter((s) => /^[0-9TZ-]+$/.test(s)).sort().reverse();
}

async function latestSnapshotMeta(cfg, gameId) {
  const snaps = await listSnapshots(cfg, gameId);
  if (!snaps.length) return null;
  const res = await runSSH(cfg, [`cat ${remoteBase(cfg)}/saves/${validate(gameId)}/${snaps[0]}/meta.json 2>/dev/null || echo '{}'`]);
  try { return { ts: snaps[0], ...JSON.parse(res.stdout) }; } catch { return { ts: snaps[0] }; }
}

async function pruneSnapshots(cfg, gameId) {
  const snaps = await listSnapshots(cfg, gameId);
  const extra = snaps.slice(SNAPSHOT_LIMIT);
  for (const ts of extra) {
    await runSSH(cfg, [`rm -rf ${remoteBase(cfg)}/saves/${validate(gameId)}/${ts}`]);
  }
  if (extra.length) return extra.length;
  return 0;
}

// --- public API --------------------------------------------------------------

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
    dirs: resolved, missing, dirty: !missing.length && dirs.length > 0,
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

async function status(cfg) {
  await ensureServer(cfg);
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
    await new Promise((resolve, reject) => {
      // Stream the archive up, then write meta in the same connection run.
      const remote = spawn('ssh', [...sshArgs(cfg),
        `mkdir -p ${remoteBase(cfg)}/${base} && cat > ${remoteBase(cfg)}/${base}/saves.tar.gz`],
        { stdio: ['pipe', 'pipe', 'pipe'] });
      let err = '';
      remote.stderr.on('data', (d) => (err += d));
      fs.createReadStream(tmp).pipe(remote.stdin);
      remote.on('close', (c) => (c === 0 ? resolve() : reject(new GamelibError(`upload failed: ${err.trim()}`))));
    });
    await writeRemoteFile(cfg, `${base}/meta.json`, JSON.stringify(meta, null, 2));
    const pruned = await pruneSnapshots(cfg, id);
    return { snapshot: ts, pruned };
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

async function savePull(cfg, gameId, { backupLocal = true } = {}) {
  const id = validate(gameId);
  const local = localSaveState(cfg, id);
  if (local.missing.length) throw new GamelibError(`save dirs missing locally: ${local.missing.join(', ')}`);
  const cloud = await latestSnapshotMeta(cfg, id);
  if (!cloud) throw new GamelibError(`no cloud saves for '${id}' yet`);

  if (backupLocal && local.newestLocal > (cloud.pushedLocalMtime || 0) + SAVE_CLOCK_TOLERANCE_MS) {
    await savePush(cfg, id); // never lose unsynced local progress
  }

  const tmp = path.join(os.tmpdir(), `gamelib-save-${id}-${cloud.ts}.tar.gz`);
  try {
    await pullFile(cfg, `saves/${id}/${cloud.ts}/saves.tar.gz`, tmp);
    for (const d of local.dirs) {
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
  return { snapshot: cloud.ts, from: cloud.machine };
}

async function publishGame(cfg, gameId, dir, { name, os } = {}) {
  const id = validate(gameId);
  const tag = ['linux', 'windows', 'darwin'].includes(os) ? os : osTag();
  const src = resolveDir(dir);
  if (!src) throw new GamelibError(`publish source not found: ${dir}`);
  await pushTar(cfg, src, `games/${id}/${tag}.tar`, { compress: false });
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
  await pullTar(cfg, `cat ${remoteBase(cfg)}/games/${id}/${tag}.tar`, dest, { compress: false });
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
  if (process.platform === 'win32') execFile('explorer.exe', [dir]);
  else execFile('xdg-open', [dir]);
  return dir;
}

module.exports = {
  GamelibError, GAME_ID_RE, osTag, configDir, defaultConfigPath,
  loadConfig, saveConfig, expandPath, resolveDir,
  ensureServer, readLibrary, writeLibrary, status, savePush, savePull,
  publishGame, installGame, play, openSaveFolder, snapshotTs,
};
