'use strict';
// Update check against GitHub Releases + artifact download with progress.

const https = require('node:https');
const fs = require('node:fs');
const path = require('node:path');
const { GamelibError } = require('./engine');

const REPO = 'Mateooo93/gamelib';
const DEFAULT_SOURCE = `https://api.github.com/repos/${REPO}/releases/latest`;

function parseVersion(v) {
  const m = String(v || '').replace(/^v/, '').match(/^(\d+)\.(\d+)\.(\d+)/);
  return m ? m.slice(1).map(Number) : null;
}

function isNewer(latest, current) {
  const a = parseVersion(latest);
  const b = parseVersion(current);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] > b[i];
  }
  return false;
}

function pickAsset(assets, os = process.platform, arch = process.arch) {
  const norm = (s) => String(s).toLowerCase();
  if (os === 'win32') {
    return assets.find((a) => norm(a.name).includes('setup') && norm(a.name).endsWith('.exe'))
      || assets.find((a) => norm(a.name).endsWith('.exe'));
  }
  if (os === 'darwin') {
    const wantArm = arch === 'arm64';
    return assets.find((a) => norm(a.name).includes(wantArm ? 'arm64' : '.dmg') && norm(a.name).endsWith('.dmg') && wantArm ? true : !norm(a.name).includes('arm64'))
      || assets.find((a) => norm(a.name).endsWith('.dmg'));
  }
  // linux
  return assets.find((a) => norm(a.name).endsWith('.appimage'))
    || assets.find((a) => norm(a.name).endsWith('.tar.gz'));
}

function getJson(url, token) {
  return new Promise((resolve, reject) => {
    const headers = { 'User-Agent': 'gamelib-updater', Accept: 'application/vnd.github+json' };
    if (token) headers.Authorization = `Bearer ${token}`;
    https.get(url, { headers }, (res) => {
      if (res.statusCode === 302 || res.statusCode === 301) {
        res.resume();
        return getJson(res.headers.location, token).then(resolve, reject);
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new GamelibError(`update check failed (HTTP ${res.statusCode})`));
      }
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (d) => (body += d));
      res.on('end', () => {
        try { resolve(JSON.parse(body)); } catch (e) { reject(new GamelibError(`update check: bad response: ${e.message}`)); }
      });
    }).on('error', (e) => reject(new GamelibError(`update check failed: ${e.message}`)));
  });
}

async function checkUpdate(currentVersion, { source = DEFAULT_SOURCE, token } = {}) {
  const rel = await getJson(source, token);
  if (!rel || !rel.tag_name) return { available: false, latestVersion: null };
  const available = isNewer(rel.tag_name, currentVersion);
  if (!available) return { available: false, latestVersion: rel.tag_name };
  const asset = pickAsset(rel.assets || []) || null;
  return {
    available: true,
    latestVersion: rel.tag_name,
    name: rel.name || rel.tag_name,
    notes: (rel.body || '').slice(0, 1000),
    asset: asset ? { name: asset.name, size: asset.browser_download_url ? (asset.size || 0) : 0, url: asset.browser_download_url } : null,
    publishedAt: rel.published_at || null,
  };
}

function download(url, destDir, { onProgress, token } = {}) {
  fs.mkdirSync(destDir, { recursive: true });
  const fileName = decodeURIComponent(url.split('/').pop().split('?')[0]);
  const destPath = path.join(destDir, fileName);
  return new Promise((resolve, reject) => {
    const headers = { 'User-Agent': 'gamelib-updater' };
    if (token) headers.Authorization = `Bearer ${token}`;
    https.get(url, { headers }, (res) => {
      if (res.statusCode === 302 || res.statusCode === 301) {
        res.resume();
        return download(res.headers.location, destDir, { onProgress, token }).then(resolve, reject);
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new GamelibError(`download failed (HTTP ${res.statusCode})`));
      }
      const total = Number(res.headers['content-length']) || 0;
      let received = 0;
      const out = fs.createWriteStream(destPath);
      res.on('data', (d) => {
        received += d.length;
        if (onProgress) onProgress({ received, total });
      });
      res.pipe(out);
      out.on('finish', () => out.close(() => resolve(destPath)));
      out.on('error', (e) => reject(new GamelibError(`download failed: ${e.message}`)));
    }).on('error', (e) => reject(new GamelibError(`download failed: ${e.message}`)));
  });
}

module.exports = { checkUpdate, download, isNewer, pickAsset };
