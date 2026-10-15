// Синхронизация состояния панели с Google Drive (пространство appData —
// приватное хранилище приложения, видимое только вашей учётке Google).

import { loadState, saveState, mergeStates, sameContent } from './store.js';

const FILE_NAME = 'swisstabs-sync.json';
const DRIVE = 'https://www.googleapis.com/drive/v3';
const UPLOAD = 'https://www.googleapis.com/upload/drive/v3';

let applyingRemote = false;
export function isApplyingRemote() {
  return applyingRemote;
}

export function getClientId() {
  try {
    return (chrome.runtime.getManifest().oauth2 || {}).client_id || '';
  } catch {
    return '';
  }
}

export function isConfigured() {
  const id = getClientId();
  return (
    /^[a-z0-9-]{6,}\.apps\.googleusercontent\.com$/i.test(id) &&
    !id.includes('YOUR_CLIENT_ID')
  );
}

// ---------------- Google auth ----------------

class AuthError extends Error {}

function getToken(interactive) {
  return new Promise((resolve, reject) => {
    chrome.identity.getAuthToken({ interactive }, (token) => {
      const err = chrome.runtime.lastError;
      if (err || !token) reject(new AuthError(err ? err.message : 'Не удалось получить токен'));
      else resolve(token);
    });
  });
}

function dropToken(token) {
  return new Promise((resolve) => {
    chrome.identity.removeCachedAuthToken({ token }, resolve);
  });
}

async function fetchWithToken(url, opts, interactive) {
  let token = await getToken(interactive);
  let res = await fetch(url, {
    ...opts,
    headers: { ...(opts.headers || {}), Authorization: 'Bearer ' + token },
  });
  if (res.status === 401) {
    await dropToken(token);
    token = await getToken(interactive);
    res = await fetch(url, {
      ...opts,
      headers: { ...(opts.headers || {}), Authorization: 'Bearer ' + token },
    });
  }
  return res;
}

async function api(url, opts = {}, interactive = false) {
  let res;
  try {
    res = await fetchWithToken(url, opts, interactive);
  } catch (e) {
    if (e instanceof AuthError) throw e;
    throw new Error('Нет сети: ' + (e.message || e));
  }
  if (!res.ok) {
    if (res.status === 401 || res.status === 403) {
      throw new AuthError('Google отклонил доступ (' + res.status + ')');
    }
    const text = await res.text().catch(() => '');
    throw new Error('Ошибка Google Drive ' + res.status + (text ? ': ' + text.slice(0, 200) : ''));
  }
  return res;
}

// ---------------- Drive: файл состояния ----------------

async function findFile() {
  const q = encodeURIComponent(`name='${FILE_NAME}'`);
  const res = await api(`${DRIVE}/files?spaces=appDataFolder&fields=files(id)&q=${q}`);
  const data = await res.json();
  return data.files && data.files.length ? data.files[0].id : null;
}

async function pull() {
  const fileId = await findFile();
  if (!fileId) return null;
  const res = await api(`${DRIVE}/files/${fileId}?alt=media`);
  try {
    return await res.json();
  } catch {
    return null; // битый файл — перезапишем своим
  }
}

async function push(state, interactive) {
  const data = JSON.stringify({
    version: 1,
    seeded: !!state.seeded,
    updatedAt: state.updatedAt || 0,
    tiles: state.tiles || {},
  });

  const fileId = await findFile();
  if (fileId) {
    await api(`${UPLOAD}/files/${fileId}?uploadType=media`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: data,
    }, interactive);
    return;
  }

  const boundary = '-------swisstabs' + Date.now().toString(36);
  const meta = JSON.stringify({
    name: FILE_NAME,
    spaces: ['appDataFolder'],
    mimeType: 'application/json',
  });
  const body =
    `--${boundary}\r\n` +
    `Content-Type: application/json; charset=UTF-8\r\n\r\n${meta}\r\n` +
    `--${boundary}\r\n` +
    `Content-Type: application/json\r\n\r\n${data}\r\n` +
    `--${boundary}--`;
  await api(`${UPLOAD}/files?uploadType=multipart`, {
    method: 'POST',
    headers: { 'Content-Type': `multipart/related; boundary=${boundary}` },
    body,
  }, interactive);
}

// ---------------- Публичный API ----------------

export async function syncNow({ interactive = false } = {}) {
  if (!isConfigured()) {
    return { ok: false, reason: 'not-configured' };
  }
  try {
    const local = await loadState();
    const remote = await pull();

    if (!remote) {
      await push(local, interactive);
      await markSync({ ok: true });
      return { ok: true, pushed: true };
    }

    const merged = mergeStates(local, remote);
    const localDiffers = !sameContent(merged, local);
    const remoteDiffers = !sameContent(merged, remote);

    if (localDiffers) {
      applyingRemote = true;
      try {
        await saveState(merged);
      } finally {
        applyingRemote = false;
      }
    }
    if (remoteDiffers) {
      await push(merged, interactive);
    }

    await markSync({ ok: true });
    return { ok: true, changed: localDiffers || remoteDiffers };
  } catch (e) {
    const error = friendlyError(e);
    await markSync({ ok: false, error });
    return { ok: false, error };
  }
}

async function markSync(info) {
  await chrome.storage.local.set({ lastSync: { at: Date.now(), ...info } });
}

function friendlyError(e) {
  const m = String(e && e.message ? e.message : e);
  if (e instanceof AuthError || /OAuth2|token|invalid_client|auth/i.test(m)) {
    if (/invalid_client|not a valid/i.test(m)) {
      return 'Неверный client_id в manifest.json — проверьте настройку (см. README.md)';
    }
    if (/single origin|origin/i.test(m)) {
      return 'ID расширения не совпадает с указанным в Google Cloud (см. README.md)';
    }
    return 'Проблема авторизации Google: ' + m;
  }
  return m;
}
