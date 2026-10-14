// Фоновый воркер: импорт закладок при установке, меню, фоновая синхронизация.

import { loadState, seedFromBookmarks, addTile, visibleTiles, saveState } from './lib/store.js';
import { syncNow, isConfigured, isApplyingRemote } from './lib/sync.js';
import { saveThumb, isThumbFresh } from './lib/thumbs.js';

const PERIODIC = 'periodic-sync';
const DEBOUNCE = 'debounced-sync';
let debounceTimer = null;

function scheduleAlarms() {
  chrome.alarms.create(PERIODIC, { periodInMinutes: 15 });
}

async function doSync() {
  if (!isConfigured()) return;
  const res = await syncNow({ interactive: false });
  if (!res.ok && res.reason !== 'not-configured') console.warn('[TabsBook] sync:', res.error);
}

function syncSoon() {
  // Синхронизация через короткую задержку, чтобы не долбить API на каждой правке.
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    debounceTimer = null;
    doSync();
  }, 4000);
  chrome.alarms.create(DEBOUNCE, { delayInMinutes: 0.5 });
}

chrome.runtime.onInstalled.addListener(async () => {
  scheduleAlarms();
  try {
    const state = await loadState();
    await seedFromBookmarks(state);
  } catch (e) {
    console.warn('[TabsBook] seed:', e);
  }
  syncSoon();

  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: 'add-to-panel',
      title: 'Добавить в панель закладок',
      contexts: ['page', 'link'],
    });
  });
});

chrome.runtime.onStartup.addListener(() => {
  scheduleAlarms();
  syncSoon();
});

chrome.alarms.onAlarm.addListener((a) => {
  if (a.name === PERIODIC || a.name === DEBOUNCE) doSync();
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId !== 'add-to-panel') return;
  const url = info.linkUrl || info.pageUrl || (tab && tab.url);
  if (!url || !/^https?:/i.test(url)) return;
  try {
    const state = await loadState();
    const exists = visibleTiles(state).some((t) => t.url === url);
    if (!exists) {
      addTile(state, { url, title: info.linkText || (tab && tab.title) || '' });
      await saveState(state);
    }
    syncSoon();
  } catch (e) {
    console.warn('[TabsBook] context menu:', e);
  }
});

chrome.action.onClicked.addListener(() => {
  chrome.tabs.create({ url: chrome.runtime.getURL('panel.html') });
});

chrome.runtime.onMessage.addListener((msg) => {
  if (msg && msg.type === 'sync-soon') syncSoon();
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.state && !isApplyingRemote()) syncSoon();
});

// ---------------- Превью страниц (скриншоты) ----------------
//
// Превью собираются при посещении сайтов: когда страница загрузилась и окно
// в фокусе, снимаем её через captureVisibleTab, уменьшаем в offscreen-документе
// и кладём в хранилище. Для захвата нужно разрешение доступа к сайтам
// (optional_host_permissions) — его запрашивает кнопка «Превью» на панели.

const CAPTURE_ORIGINS = ['<all_urls>'];
const MIN_INTERVAL = 4000; // минимальный интервал между снимками

let lastCaptureAt = 0;
const captureTimers = new Map(); // windowId -> timeout

function hasCapturePermission() {
  return chrome.permissions.contains({ origins: CAPTURE_ORIGINS });
}

function scheduleCapture(tab, delay = 1500) {
  if (!tab || !tab.id || !tab.windowId) return;
  const prev = captureTimers.get(tab.windowId);
  if (prev) clearTimeout(prev);
  captureTimers.set(
    tab.windowId,
    setTimeout(() => {
      captureTimers.delete(tab.windowId);
      captureTab(tab.windowId, tab.id).catch((e) => console.warn('[TabsBook] capture:', e));
    }, delay)
  );
}

async function writeThumbStatus(patch) {
  try {
    const got = await chrome.storage.local.get('thumbStatus');
    await chrome.storage.local.set({ thumbStatus: { ...(got.thumbStatus || {}), ...patch, at: Date.now() } });
  } catch {
    // диагностика не должна ломать снятие превью
  }
}

async function captureTab(windowId, expectedTabId) {
  if (!(await hasCapturePermission())) return;

  // Снимать можно только видимую область сфокусированного окна.
  const win = await chrome.windows.get(windowId);
  if (!win || !win.focused) return;

  const [tab] = await chrome.tabs.query({ windowId, active: true });
  if (!tab || tab.id !== expectedTabId || !/^https?:/i.test(tab.url || '')) return;

  // Не долбим камеру: если скоро нельзя — пробуем чуть позже.
  const now = Date.now();
  if (now - lastCaptureAt < MIN_INTERVAL) {
    setTimeout(() => captureTab(windowId, expectedTabId).catch(() => {}), MIN_INTERVAL - (now - lastCaptureAt));
    return;
  }

  // Свежий снимок уже есть — не переснимаем.
  if (await isThumbFresh(tab.url)) return;

  try {
    const dataUrl = await chrome.tabs.captureVisibleTab(windowId, { format: 'png' });
    lastCaptureAt = Date.now();

    const thumb = await makeThumb(dataUrl);
    if (!thumb) {
      await writeThumbStatus({ ok: false, error: 'не удалось сжать скриншот', url: tab.url });
      return;
    }
    await saveThumb(tab.url, thumb);
    await writeThumbStatus({ ok: true, error: null, url: tab.url });
  } catch (e) {
    await writeThumbStatus({ ok: false, error: String(e && e.message ? e.message : e), url: tab.url });
  }
}

async function makeThumb(src) {
  try {
    await ensureOffscreen();
    const res = await chrome.runtime.sendMessage({ type: 'make-thumb', src, maxWidth: 480, quality: 0.62 });
    return res && res.ok ? res.dataUrl : null;
  } catch (e) {
    console.warn('[TabsBook] makeThumb:', e && e.message ? e.message : e);
    return null;
  }
}

async function ensureOffscreen() {
  const contexts = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
  if (contexts.length) return;
  try {
    await chrome.offscreen.createDocument({
      url: 'offscreen.html',
      reasons: ['BLOBS'],
      justification: 'Сжатие скриншотов страниц в миниатюры для превью закладок',
    });
  } catch (e) {
    // Документ уже создан параллельным вызовом — это нормально.
    if (!/single offscreen|already/i.test(String(e && e.message))) throw e;
  }
}

chrome.tabs.onUpdated.addListener((tabId, info, tab) => {
  if (info.status !== 'complete' || !tab || !tab.active) return;
  if (!/^https?:/i.test(tab.url || info.url || '')) return;
  scheduleCapture(tab, 1800);
});

chrome.tabs.onActivated.addListener(async (activeInfo) => {
  try {
    const tab = await chrome.tabs.get(activeInfo.tabId);
    if (tab && /^https?:/i.test(tab.url || '')) scheduleCapture(tab, 900);
  } catch {
    // вкладка закрылась — нечего снимать
  }
});

// Сразу снимаем текущую страницу, как только выдали разрешение.
chrome.permissions.onAdded.addListener(async (perm) => {
  if (!perm.origins || !perm.origins.includes('<all_urls>')) return;
  try {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (tab && /^https?:/i.test(tab.url || '')) scheduleCapture(tab, 400);
  } catch {
    // ignore
  }
});
