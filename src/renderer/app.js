'use strict';
/* Gamelib renderer — Steam-ish library UI over the engine IPC bridge. */

const api = window.gamelib;
if (!api) throw new Error('gamelib bridge missing');

const $ = (sel) => document.querySelector(sel);
const state = { cfg: null, status: null, view: 'library', busy: new Set(), editingId: null };

const SAVE_TEXT = {
  none: 'no cloud saves',
  localOnly: 'local saves, never uploaded',
  synced: 'cloud synced',
  localNewer: 'local newer — push',
  serverNewer: 'server newer — pull',
};
const SAVE_CLASS = {
  none: 'none', localOnly: 'localOnly', synced: 'synced',
  localNewer: 'localNewer', serverNewer: 'serverNewer',
};

/* ---------- toasts ---------- */

function toast(title, message, kind = '') {
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.innerHTML = `<div class="t-title"></div><div></div>`;
  el.querySelector('.t-title').textContent = title;
  el.querySelector('div:last-child').textContent = message || '';
  $('#toasts').appendChild(el);
  setTimeout(() => el.remove(), 5000);
}

/* ---------- status / refresh ---------- */

async function refresh(quiet = false) {
  if (!quiet) setConnBusy();
  try {
    const r = await api.status();
    if (!r.ok) { setConn(false); if (!quiet) toast('Connection failed', r.error, 'error'); return; }
    state.status = r;
    setConn(true, r);
    renderLibrary();
    fillSettings();
  } catch (e) {
    setConn(false);
    if (!quiet) toast('Connection failed', e.message, 'error');
  }
}

function setConn(on, status) {
  const chip = $('#conn-chip');
  chip.className = `conn-chip ${on ? 'on' : 'off'}`;
  $('#conn-text').textContent = on
    ? `connected · ${status.server.host}:${status.server.port || 8443}`
    : 'offline';
}
function setConnBusy() {
  $('#conn-chip').className = 'conn-chip off';
  $('#conn-text').textContent = 'connecting…';
}

/* ---------- library ---------- */

function saveStateChip(g) {
  if (g.error) {
    return `<span class="save-state error" title="${escapeHtml(g.error)}">save dir problem</span>`;
  }
  if (g.missingSaveDirs && g.missingSaveDirs.length) {
    return `<span class="save-state error" title="Missing: ${escapeHtml(g.missingSaveDirs.join(', '))}">save dirs unavailable</span>`;
  }
  return `<span class="save-state ${SAVE_CLASS[g.saveState]}">${SAVE_TEXT[g.saveState] || g.saveState}</span>`;
}

function fmtTs(ts) {
  if (!ts) return '';
  return ts.replace(/^(\d{4}-\d{2}-\d{2})T(\d{2}-\d{2}-\d{2})/, '$1 $2');
}

function renderLibrary() {
  const grid = $('#game-grid');
  const games = state.status?.games || [];
  $('#empty-hint').classList.toggle('hidden', games.length > 0);
  $('#lib-sub').textContent = state.status
    ? `${games.length} game${games.length === 1 ? '' : 's'} · machine “${state.status.machine}”`
    : '';

  const cards = games.map((g) => {
    const busy = state.busy.has(g.id);
    const isWin = g.platforms && g.platforms.windows;
    const isLin = g.platforms && g.platforms.linux;
    const chips = `<div class="chips">${isLin ? '<span class="chip on">linux</span>' : ''}${isWin ? '<span class="chip on">windows</span>' : ''}<span class="chip">${escapeHtml(g.id)}</span></div>`;
    const installInfo = g.installed
      ? `<span class="card-stats"><b>Installed</b> ${escapeHtml(g.installPath)}</span>`
      : `<span class="card-stats">Not installed on this machine</span>`;
    const cloudInfo = g.cloudTs
      ? `<span class="card-stats"><b>Latest cloud</b> ${fmtTs(g.cloudTs)}${g.cloudPushedFrom ? ` · from ${escapeHtml(g.cloudPushedFrom)}` : ''} · ${g.saveCount} snapshot${g.saveCount === 1 ? '' : 's'}</span>`
      : '';
    const saveFresh = g.newestLocal
      ? `<span class="card-stats">Local newest save: ${escapeHtml(g.newestLocal.slice(0, 16).replace('T', ' '))}</span>`
      : '';
    const actions = `
      <div class="card-actions">
        <button class="btn play" data-act="play" data-id="${g.id}" ${!g.installed || busy ? 'disabled' : ''}>▶ Play</button>
        <button class="btn" data-act="install" data-id="${g.id}" ${busy ? 'disabled' : ''}>${g.installed ? 'Update' : 'Install'}</button>
        <button class="btn ghost" data-act="push" data-id="${g.id}" ${busy ? 'disabled' : ''} title="Upload local saves as a new snapshot">↑ Push</button>
        <button class="btn ghost" data-act="pull" data-id="${g.id}" ${busy ? 'disabled' : ''} title="Restore latest cloud snapshot">↓ Pull</button>
        <span class="spacer"></span>
        <button class="btn ghost" data-act="folder" data-id="${g.id}" ${busy ? 'disabled' : ''} title="Open save folder">📁</button>
        ${busy ? '<span class="spinner"></span>' : ''}
      </div>`;
    const warn = g.missingSaveDirs && g.missingSaveDirs.length
      ? `<div class="warn">⚠ save dirs missing locally (${escapeHtml(g.missingSaveDirs.map((d) => d.split('/').pop().split('\\').pop()).join(', '))})</div>` : '';
    return `<div class="card" data-game="${g.id}">
      <div class="card-head">
        <div>
          <h3>${escapeHtml(g.name)}</h3>
          <div class="id-tag">${escapeHtml(g.id)}</div>
          ${chips}
        </div>
        ${saveStateChip(g)}
      </div>
      <div style="display:flex;flex-direction:column;gap:4px">${installInfo}${cloudInfo}${saveFresh}${warn}</div>
      ${actions}
    </div>`;
  });
  grid.innerHTML = cards.join('');
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/* ---------- game actions ---------- */

async function runOp(game, fn, doneMsg) {
  state.busy.add(game);
  renderLibrary();
  try {
    const r = await fn();
    if (!r.ok) toast('Action failed', r.error, 'error');
    else if (doneMsg) toast(doneMsg, '', 'ok');
  } catch (e) {
    toast('Action failed', e.message, 'error');
  } finally {
    state.busy.delete(game);
    await refresh(true);
  }
}

$('#game-grid').addEventListener('click', (ev) => {
  const btn = ev.target.closest('button[data-act]');
  if (!btn) return;
  const { act, id } = btn.dataset;
  switch (act) {
    case 'play': return runOp(id, () => api.play(id), 'Session ended — saves pushed');
    case 'install': return runOp(id, () => api.install(id), 'Installed / updated');
    case 'push': return runOp(id, () => api.savePush(id), 'Saves pushed');
    case 'pull': return runOp(id, () => api.savePull(id), 'Saves restored');
    case 'folder': return runOp(id, () => api.openSaves(id));
  }
});

/* ---------- add / edit game ---------- */

function openGameModal(id = null) {
  state.editingId = id;
  $('#modal-title').textContent = id ? `Edit ${id}` : 'Add game';
  $('#gf-id').value = id || '';
  $('#gf-id').disabled = !!id;
  const cfg = state.cfg;
  if (id && cfg.games[id]) {
    const g = cfg.games[id];
    $('#gf-name').value = g.name || '';
    $('#gf-folder').value = g.install?.[osName()] || '';
    $('#gf-launch').value = g.launch?.[osName()] || '';
    $('#gf-saves').value = (g.saveDirs?.[osName()] || []).join('\n');
  } else {
    $('#gf-name').value = ''; $('#gf-folder').value = ''; $('#gf-launch').value = ''; $('#gf-saves').value = '';
  }
  $('#modal-bg').classList.remove('hidden');
  $('#gf-id').focus();
}
function osName() {
  return state.cfg?.os === 'win32' ? 'windows' : state.cfg?.os || 'linux';
}
function closeModal() { $('#modal-bg').classList.add('hidden'); }

$('#btn-addgame').addEventListener('click', () => openGameModal(null));
$('#gf-cancel').addEventListener('click', closeModal);
$('#modal-bg').addEventListener('click', (ev) => { if (ev.target.id === 'modal-bg') closeModal(); });
$('#gf-pick').addEventListener('click', async () => {
  const r = await api.pickFolder('Choose the game folder');
  if (r.ok && r.path) $('#gf-folder').value = r.path;
});

$('#game-form').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const id = $('#gf-id').value.trim();
  const payload = {
    id,
    name: $('#gf-name').value.trim() || undefined,
    folder: $('#gf-folder').value.trim() || undefined,
    launch: $('#gf-launch').value.trim() || undefined,
    saveDirs: $('#gf-saves').value,
  };
  closeModal();
  await runOp(id, () => api.gameSave(payload), `Saved “${id}”`);
  state.cfg = (await api.cfgGet()).cfg; // refresh cached config
});

/* ---------- settings ---------- */

function fillSettings() {
  const cfg = state.cfg;
  if (!cfg) return;
  $('#set-host').value = cfg.server.host || '';
  $('#set-password').value = cfg.server.password || '';
  $('#set-port').value = cfg.server.port || 8443;
  $('#set-machine').value = cfg.machine || '';
  $('#set-ghtoken').value = cfg.githubToken || '';
  $('#cfg-path').textContent = state.configPath || '';
}

$('#settings-form').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const r = await api.cfgSave({
    server: {
      host: $('#set-host').value.trim(),
      password: $('#set-password').value,
      port: Number($('#set-port').value) || 8443,
    },
    machine: $('#set-machine').value.trim(),
    githubToken: $('#set-ghtoken').value.trim() || undefined,
  });
  if (!r.ok) return toast('Could not save', r.error, 'error');
  state.cfg = r.cfg;
  toast('Settings saved', 'Reconnecting…', 'ok');
  await refresh(false);
});

/* ---------- navigation / events ---------- */

document.querySelectorAll('.nav-item').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.nav-item').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    const view = btn.dataset.view;
    $('#view-library').classList.toggle('hidden', view !== 'library');
    $('#view-settings').classList.toggle('hidden', view !== 'settings');
    if (view === 'settings') fillSettings();
  });
});

$('#btn-refresh').addEventListener('click', () => refresh(false));

/* ---------- update button ---------- */

let updateInfo = null;
let updateDownloading = false;

async function checkForUpdate(quiet = false) {
  try {
    const r = await api.updateCheck();
    updateInfo = r.ok ? r : null;
  } catch (_) {
    updateInfo = null;
  }
  const btn = $('#btn-update');
  if (updateInfo && updateInfo.available && !updateDownloading) {
    btn.textContent = `⬆ Update ${updateInfo.latestVersion.replace(/^v/, '')}`;
    btn.classList.remove('hidden');
  } else {
    btn.classList.add('hidden');
  }
}

$('#btn-update').addEventListener('click', async () => {
  if (!updateInfo || updateDownloading) return;
  const asset = updateInfo.asset;
  if (!asset) return toast('Update', 'No installer asset found for this platform.', 'error');
  if (!confirm(`Gamelib ${updateInfo.latestVersion.replace(/^v/, '')} is available.\n\nDownload and open the installer in your Downloads folder?`)) return;
  updateDownloading = true;
  const btn = $('#btn-update');
  btn.disabled = true;
  btn.textContent = 'Downloading…';
  try {
    const r = await api.updateDownload(asset.url);
    if (!r.ok) throw new Error(r.error);
    btn.textContent = `Saved to Downloads`;
    toast('Update downloaded', r.file, 'ok');
    api.updateReveal(r.file);
  } catch (e) {
    toast('Update download failed', e.message, 'error');
    btn.textContent = `⬆ Update ${updateInfo.latestVersion.replace(/^v/, '')}`;
  } finally {
    updateDownloading = false;
    btn.disabled = false;
    setTimeout(() => { if (!updateDownloading) btn.classList.add('hidden'); }, 2500);
  }
});

api.onUpdateProgress((p) => {
  const btn = $('#btn-update');
  if (updateDownloading && p.total) {
    const pct = Math.round((p.received / p.total) * 100);
    btn.textContent = `Downloading… ${pct}%`;
  }
});

api.onEvent((ev) => {
  if (ev.phase === 'playing') toast(`${ev.id} launched`, 'Sync on exit — close the game when done.');
  else if (ev.message) toast(`${ev.id}`, ev.message);
});

/* ---------- boot ---------- */

(async function boot() {
  try {
    const r = await api.cfgGet();
    state.cfg = r.cfg;
    state.configPath = r.configPath;
    fillSettings();
    await refresh(true);
  } catch (e) {
    toast('Startup failed', e.message, 'error');
  }
  checkForUpdate(true);
})();
