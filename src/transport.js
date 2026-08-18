'use strict';
// Gamelib client transport — HTTPS to the gamelib daemon.
// Auth: Authorization: Bearer <server.password>
// Trust: the daemon's self-signed cert is pinned via server-cert.pem next
// to the config (set up by the deploy step), so the connection is
// authenticated AND encrypted without a public CA.

const https = require('node:https');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

class TransportError extends Error {}
const configDir = () => process.platform === 'win32'
  ? path.join(process.env.APPDATA || os.homedir(), 'gamelib')
  : path.join(os.homedir(), '.config', 'gamelib');

function certPath() {
  return path.join(configDir(), 'server-cert.pem');
}

function baseUrl(cfg) {
  const s = cfg.server || {};
  return `https://${s.host}:${s.port || 8443}`;
}

function request(cfg, method, apiPath, { body } = {}) {
  const s = cfg.server || {};
  if (!s.host) return Promise.reject(new TransportError('no server configured — fill Settings'));
  if (!s.password) return Promise.reject(new TransportError('no server password configured — fill Settings'));
  const url = new URL(baseUrl(cfg) + apiPath);
  const ca = fs.existsSync(certPath()) ? fs.readFileSync(certPath()) : null;
  if (!ca) return Promise.reject(new TransportError(`server certificate not found at ${certPath()} — run the server setup first`));

  const payload = body != null ? Buffer.from(String(body)) : null;
  return new Promise((resolve, reject) => {
    const req = https.request(url, {
      method,
      ca,
      headers: {
        Authorization: `Bearer ${s.password}`,
        'User-Agent': 'gamelib-client',
        ...(payload ? { 'Content-Length': payload.length } : {}),
      },
    });
    req.on('error', (e) => reject(new TransportError(`server unreachable (${url.host}): ${e.message}`)));
    req.on('response', (res) => resolve({
      status: res.statusCode,
      headers: res.headers,
      stream: res,
      json() {
        return new Promise((resolveJson, rejectJson) => {
          const chunks = [];
          res.on('data', (c) => chunks.push(c));
          res.on('end', () => {
            const text = Buffer.concat(chunks).toString('utf8');
            try { resolveJson(JSON.parse(text)); }
            catch (e) { rejectJson(new TransportError(`bad server response: ${text.slice(0, 200)}`)); }
          });
        });
      },
    }));
    if (payload) req.write(payload);
    req.end();
  });
}

async function api(cfg, method, apiPath, { json, body } = {}) {
  const r = await request(cfg, method, apiPath, { body });
  const data = json ? await r.json() : null;
  if (r.status >= 400) {
    const msg = data && data.error ? data.error : `HTTP ${r.status}`;
    throw new TransportError(msg);
  }
  return data;
}

function uploadFile(cfg, apiPath, filePath) {
  return new Promise((resolve, reject) => {
    const s = cfg.server || {};
    const url = new URL(baseUrl(cfg) + apiPath);
    const ca = fs.existsSync(certPath()) ? fs.readFileSync(certPath()) : null;
    if (!ca) return reject(new TransportError(`server certificate not found at ${certPath()} — run the server setup first`));
    let size = 0;
    try { size = fs.statSync(filePath).size; } catch (e) { return reject(new TransportError(`upload source missing: ${filePath}`)); }
    const req = https.request(url, {
      method: 'PUT',
      ca,
      headers: {
        Authorization: `Bearer ${s.password}`,
        'User-Agent': 'gamelib-client',
        'Content-Length': size,
      },
    });
    req.on('error', (e) => reject(new TransportError(`server unreachable (${url.host}): ${e.message}`)));
    req.on('response', (res) => {
      res.resume();
      res.on('end', () => (res.statusCode >= 400
        ? reject(new TransportError(`upload failed (HTTP ${res.statusCode})`))
        : resolve()));
    });
    fs.createReadStream(filePath).pipe(req);
  });
}

function downloadTo(cfg, apiPath, sink) {
  return new Promise((resolve, reject) => {
    request(cfg, 'GET', apiPath).then((r) => {
      if (r.status >= 400) {
        r.stream.resume();
        return reject(new TransportError(`download failed (HTTP ${r.status})`));
      }
      r.stream.pipe(sink.stdin);
      r.stream.on('error', (e) => { sink.kill(); reject(new TransportError(`download failed: ${e.message}`)); });
      r.stream.on('end', () => sink.stdin.end());
      r.stream.on('close', () => resolve());
    }).catch(reject);
  });
}

function downloadFile(cfg, apiPath, localPath) {
  return new Promise((resolve, reject) => {
    request(cfg, 'GET', apiPath).then((r) => {
      if (r.status >= 400) {
        r.stream.resume();
        return reject(new TransportError(`download failed (HTTP ${r.status})`));
      }
      fs.mkdirSync(path.dirname(localPath), { recursive: true });
      const out = fs.createWriteStream(localPath);
      r.stream.pipe(out);
      r.stream.on('error', (e) => reject(new TransportError(`download failed: ${e.message}`)));
      out.on('error', (e) => reject(new TransportError(`download failed: ${e.message}`)));
      out.on('finish', () => out.close(() => resolve()));
    }).catch(reject);
  });
}

module.exports = { api, uploadFile, downloadTo, downloadFile, certPath };
