#!/usr/bin/env node
'use strict';
// Gamelib server daemon — serves the ~/gamelib tree over HTTPS with
// password auth (Authorization: Bearer <password>). Zero dependencies.
//
// Config: ~/.gamelib-server/config.json
//   { "port": 8443, "password": "...", "dataDir": "/home/opc/gamelib",
//     "key": "/home/opc/.gamelib-server/key.pem",
//     "cert": "/home/opc/.gamelib-server/cert.pem" }

const https = require('node:https');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const CONFIG_PATH = path.join(process.env.HOME || '/home/opc', '.gamelib-server', 'config.json');

function loadConfig() {
  const def = {
    port: 8443,
    dataDir: path.join(process.env.HOME || '/home/opc', 'gamelib'),
    key: path.join(process.env.HOME || '/home/opc', '.gamelib-server', 'key.pem'),
    cert: path.join(process.env.HOME || '/home/opc', '.gamelib-server', 'cert.pem'),
  };
  try { return { ...def, ...JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')) }; }
  catch { return def; }
}

const config = loadConfig();
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const TS_RE = /^[0-9A-Za-z][0-9A-Za-z._-]{0,63}$/;
const TAG_RE = /^[A-Za-z0-9_.-]{1,48}$/;
const SNAPSHOT_LIMIT = 20;

function ensureLayout() {
  for (const d of ['games', 'saves', 'meta']) {
    fs.mkdirSync(path.join(config.dataDir, d), { recursive: true });
  }
  const lib = path.join(config.dataDir, 'library.json');
  if (!fs.existsSync(lib)) {
    fs.writeFileSync(lib, JSON.stringify({ version: 1, games: {} }, null, 2));
  }
}

function authOk(req) {
  const h = req.headers.authorization || '';
  const m = h.match(/^Bearer\s+(.+)$/);
  if (!m) return false;
  const a = Buffer.from(m[1]);
  const b = Buffer.from(String(config.password));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function send(res, code, body) {
  const payload = typeof body === 'string' ? body : JSON.stringify(body);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(payload) });
  res.end(payload);
}

function notFound(res) { send(res, 404, { error: 'not found' }); }
function bad(res, msg) { send(res, 400, { error: msg || 'bad request' }); }

function streamPut(req, res, target) {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const tmp = target + '.tmp.' + process.pid;
  const out = fs.createWriteStream(tmp);
  req.pipe(out);
  out.on('finish', () => fs.renameSync(tmp, target));
  out.on('error', (e) => { fs.rmSync(tmp, { force: true }); send(res, 500, { error: e.message }); });
  req.on('error', (e) => { fs.rmSync(tmp, { force: true }); send(res, 500, { error: e.message }); });
  req.on('end', () => {
    if (!res.headersSent) send(res, 200, { ok: true });
  });
}

function streamGet(req, res, file, { download = false } = {}) {
  if (!fs.existsSync(file)) return notFound(res);
  const headers = { 'Content-Type': 'application/octet-stream' };
  if (download) headers['Content-Disposition'] = `attachment; filename="${path.basename(file)}"`;
  res.writeHead(200, headers);
  fs.createReadStream(file).pipe(res);
}

function handle(req, res) {
  const url = req.url.split('?')[0];
  const parts = url.split('/').filter(Boolean); // [api, ...]
  if (parts[0] !== 'api') return notFound(res);
  if (!authOk(req)) return send(res, 401, { error: 'unauthorized — send Authorization: Bearer <password>' });

  // GET /api/ping
  if (parts.length === 2 && parts[1] === 'ping') return send(res, 200, { ok: true, version: '0.2.0' });

  // library
  if (parts.length === 2 && parts[1] === 'library') {
    const file = path.join(config.dataDir, 'library.json');
    if (req.method === 'GET') {
      if (!fs.existsSync(file)) return send(res, 200, { version: 1, games: {} });
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      return fs.createReadStream(file).pipe(res);
    }
    if (req.method === 'PUT') {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        try {
          JSON.parse(Buffer.concat(chunks).toString('utf8')); // validate
          const tmp = file + '.tmp';
          fs.writeFileSync(tmp, Buffer.concat(chunks));
          fs.renameSync(tmp, file);
          send(res, 200, { ok: true });
        } catch (e) { bad(res, 'invalid library json: ' + e.message); }
      });
      return;
    }
  }

  // games/:id/:tag.tar
  if (parts.length === 4 && parts[1] === 'games' && ID_RE.test(parts[2]) && TAG_RE.test(parts[3]) && parts[3].endsWith('.tar')) {
    const file = path.join(config.dataDir, 'games', parts[2], parts[3]);
    if (req.method === 'GET') return streamGet(req, res, file, { download: true });
    if (req.method === 'PUT') return streamPut(req, res, file);
    return send(res, 405, { error: 'method not allowed' });
  }

  // saves/:id
  if (parts.length === 3 && parts[1] === 'saves' && ID_RE.test(parts[2])) {
    if (req.method === 'GET') {
      const dir = path.join(config.dataDir, 'saves', parts[2]);
      let snaps = [];
      try { snaps = fs.readdirSync(dir).filter((n) => TS_RE.test(n)).sort().reverse(); } catch { /* no dir yet */ }
      return send(res, 200, { snapshots: snaps });
    }
  }

  // saves/:id/:ts/* and DELETE snapshot
  if (parts.length >= 4 && parts[1] === 'saves' && ID_RE.test(parts[2]) && TS_RE.test(parts[3])) {
    const base = path.join(config.dataDir, 'saves', parts[2], parts[3]);
    if (parts.length === 4 && req.method === 'DELETE') {
      fs.rmSync(base, { recursive: true, force: true });
      return send(res, 200, { ok: true });
    }
    if (parts.length === 5 && parts[4] === 'meta.json') {
      const file = path.join(base, 'meta.json');
      if (req.method === 'GET') return streamGet(req, res, file);
      if (req.method === 'PUT') return streamPut(req, res, file);
    }
    if (parts.length === 5 && parts[4] === 'saves.tar.gz') {
      const file = path.join(base, 'saves.tar.gz');
      if (req.method === 'GET') return streamGet(req, res, file, { download: true });
      if (req.method === 'PUT') return streamPut(req, res, file);
    }
  }

  return notFound(res);
}

function prune() {
  // keep most recent SNAPSHOT_LIMIT per game
  const savesDir = path.join(config.dataDir, 'saves');
  let games = [];
  try { games = fs.readdirSync(savesDir); } catch { return; }
  for (const g of games) {
    if (!ID_RE.test(g)) continue;
    const dir = path.join(savesDir, g);
    let snaps = [];
    try { snaps = fs.readdirSync(dir).filter((n) => TS_RE.test(n)).sort().reverse(); } catch { continue; }
    for (const extra of snaps.slice(SNAPSHOT_LIMIT)) {
      fs.rmSync(path.join(dir, extra), { recursive: true, force: true });
      console.log(`pruned ${g}/${extra}`);
    }
  }
}

ensureLayout();
prune();

let server;
if (fs.existsSync(config.key) && fs.existsSync(config.cert)) {
  server = https.createServer({ key: fs.readFileSync(config.key), cert: fs.readFileSync(config.cert) }, handle);
  console.log('https mode');
} else {
  server = http.createServer(handle);
  console.log('WARNING: no cert/key — serving PLAINTEXT HTTP. Generate certs with openssl.');
}

server.listen(config.port, () => {
  console.log(`gamelib server listening on port ${config.port} (data: ${config.dataDir})`);
});

setInterval(prune, 60 * 60 * 1000).unref();
