// Хранение миниатюр страниц в chrome.storage.local:
// запись thumb:<ключ адреса> + индекс thumbIndex (ключ → время снимка) для LRU-обрезки.

import { thumbKey } from './util.js';

export const THUMB_PREFIX = 'thumb:';
export const THUMB_INDEX = 'thumbIndex';
export const MAX_THUMBS = 600;
export const FRESH_MS = 24 * 60 * 60 * 1000; // не переснимаем чаще раза в сутки

export function storageKeyFor(url) {
  return THUMB_PREFIX + thumbKey(url);
}

// Есть ли свежий снимок для адреса.
export async function isThumbFresh(url, now = Date.now()) {
  const got = await chrome.storage.local.get(THUMB_INDEX);
  const idx = got[THUMB_INDEX] || {};
  const at = idx[thumbKey(url)];
  return !!at && now - at < FRESH_MS;
}

export async function getThumb(url) {
  const got = await chrome.storage.local.get(storageKeyFor(url));
  return got[storageKeyFor(url)] || null;
}

export async function saveThumb(url, dataUrl) {
  const key = thumbKey(url);
  const storageKey = THUMB_PREFIX + key;
  const rec = { url, dataUrl, at: Date.now() };
  const got = await chrome.storage.local.get([THUMB_INDEX, storageKey]);
  const idx = got[THUMB_INDEX] || {};
  idx[key] = rec.at;

  try {
    await chrome.storage.local.set({ [storageKey]: rec, [THUMB_INDEX]: idx });
  } catch {
    // Квота: выбрасываем половину самых старых и пробуем снова.
    await trimThumbs(idx, Math.floor(MAX_THUMBS / 2));
    try {
      await chrome.storage.local.set({ [storageKey]: rec, [THUMB_INDEX]: idx });
    } catch (e) {
      console.warn('[SwissTabs] thumb quota:', e && e.message ? e.message : e);
      return false;
    }
  }

  if (Object.keys(idx).length > MAX_THUMBS) await trimThumbs(idx, MAX_THUMBS);
  return true;
}

// Оставляет target самых свежих записей, остальные удаляет.
export async function trimThumbs(idx, target) {
  const keys = Object.keys(idx).sort((a, b) => idx[a] - idx[b]);
  const excess = keys.length - target;
  if (excess <= 0) return idx;
  const toRemove = keys.slice(0, excess);
  for (const k of toRemove) delete idx[k];
  await chrome.storage.local.remove(toRemove.map((k) => THUMB_PREFIX + k));
  await chrome.storage.local.set({ [THUMB_INDEX]: idx });
  return idx;
}
