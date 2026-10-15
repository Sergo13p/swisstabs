// Логика панели быстрого доступа.

import {
  loadState,
  saveState,
  addTile,
  updateTile,
  removeTile,
  visibleTiles,
  reorderTiles,
  seedFromBookmarks,
  hostname,
  normalizeUrl,
} from './lib/store.js';
import { syncNow, isConfigured } from './lib/sync.js';
import { thumbKey, buildSearchUrl } from './lib/util.js';
import { THUMB_INDEX } from './lib/thumbs.js';

const $ = (s) => document.querySelector(s);

const grid = $('#grid');
const empty = $('#empty');
const search = $('#search');
const syncBtn = $('#sync-btn');
const syncDot = $('#sync-dot');
const syncText = $('#sync-text');
const setupHint = $('#setup-hint');
const dialog = $('#edit-dialog');
const form = $('#edit-form');
const fTitle = $('#f-title');
const fUrl = $('#f-url');
const deleteBtn = $('#delete-btn');
const dialogTitle = $('#dialog-title');
const toast = $('#toast');
const webSearch = $('#web-search');
const wsForm = $('#web-search-form');
const engineBtns = [...document.querySelectorAll('.engine-btn')];
const aiProvider = $('#ai-provider');
const thumbsBtn = $('#thumbs-btn');
const thumbsHint = $('#thumbs-hint');

let state = await loadState();
if (!state.seeded) state = await seedFromBookmarks(state);

let editingId = null;
let dragId = null;
let toastTimer = null;

// ---------------- Отрисовка ----------------

function faviconSrc(url) {
  try {
    const p = new URL(chrome.runtime.getURL('/_favicon/'));
    p.searchParams.set('pageUrl', url);
    p.searchParams.set('size', '64');
    return p.href;
  } catch {
    return '';
  }
}

function tileBody(url, titleText) {
  const img = document.createElement('img');
  img.className = 'favicon';
  img.alt = '';
  img.loading = 'lazy';
  img.src = faviconSrc(url);
  img.onerror = () => {
    img.onerror = null;
    img.src = 'https://www.google.com/s2/favicons?sz=64&domain=' + encodeURIComponent(hostname(url));
  };

  const title = document.createElement('span');
  title.className = 'title';
  title.textContent = titleText;

  const host = document.createElement('span');
  host.className = 'host';
  host.textContent = hostname(url);

  return [img, title, host];
}

// ---- Превью страниц ----

const thumbCache = new Map(); // storageKey -> record | null

function hovercardEl(title, url) {
  const card = document.createElement('div');
  card.className = 'hovercard';

  const meta = document.createElement('div');
  meta.className = 'hc-meta';

  const t = document.createElement('div');
  t.className = 'hc-title';
  t.textContent = title || hostname(url);

  const h = document.createElement('div');
  h.className = 'hc-host';
  h.textContent = hostname(url);

  meta.append(t, h);
  card.append(meta);
  return card;
}

function setThumb(wrap, dataUrl) {
  wrap.classList.add('has-thumb');
  wrap.style.setProperty('--thumb', `url("${dataUrl}")`);
}

function clearThumb(wrap) {
  wrap.classList.remove('has-thumb');
  wrap.style.removeProperty('--thumb');
}

function attachThumb(wrap, url) {
  const key = 'thumb:' + thumbKey(url);
  wrap._thumbKey = key;

  const cached = thumbCache.get(key);
  if (cached !== undefined) {
    if (cached && cached.dataUrl) setThumb(wrap, cached.dataUrl);
    return;
  }
  chrome.storage.local
    .get(key)
    .then((got) => {
      const rec = got[key] || null;
      thumbCache.set(key, rec);
      if (rec && rec.dataUrl && document.contains(wrap)) setThumb(wrap, rec.dataUrl);
    })
    .catch(() => {});
}

function applyThumbChange(storageKey, rec) {
  thumbCache.set(storageKey, rec);
  for (const wrap of document.querySelectorAll('.tile-wrap')) {
    if (wrap._thumbKey !== storageKey) continue;
    if (rec && rec.dataUrl) setThumb(wrap, rec.dataUrl);
    else clearThumb(wrap);
  }
}

function tileEl(t) {
  const wrap = document.createElement('div');
  wrap.className = 'tile-wrap';
  wrap.dataset.id = t.id;

  const a = document.createElement('a');
  a.className = 'tile';
  a.href = t.url;
  a.target = '_blank';
  a.rel = 'noopener';
  a.title = t.url;

  const thumb = document.createElement('span');
  thumb.className = 'thumb';
  thumb.setAttribute('aria-hidden', 'true');
  a.append(thumb, ...tileBody(t.url, t.title));

  // Обычный клик — открыть в новой вкладке через API расширения,
  // ctrl/средняя кнопка — штатное поведение ссылки.
  a.addEventListener('click', (e) => {
    if (e.button === 0 && !e.ctrlKey && !e.metaKey && !e.shiftKey && !e.altKey) {
      e.preventDefault();
      chrome.tabs.create({ url: t.url });
    }
  });

  const actions = document.createElement('div');
  actions.className = 'tile-actions';

  const edit = document.createElement('button');
  edit.className = 'icon-btn';
  edit.type = 'button';
  edit.title = 'Изменить';
  edit.textContent = '✎';
  edit.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    openDialog(t);
  });

  const del = document.createElement('button');
  del.className = 'icon-btn del';
  del.type = 'button';
  del.title = 'Удалить';
  del.textContent = '✕';
  del.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    deleteTile(t.id);
  });

  actions.append(edit, del);
  wrap.append(a, actions, hovercardEl(t.title, t.url));
  attachThumb(wrap, t.url);

  // Перетаскивание для изменения порядка.
  a.draggable = true;
  a.addEventListener('dragstart', (e) => {
    dragId = t.id;
    wrap.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', t.id);
  });
  a.addEventListener('dragend', () => {
    dragId = null;
    document.querySelectorAll('.tile-wrap').forEach((el) => el.classList.remove('dragging', 'drop-target'));
  });
  wrap.addEventListener('dragover', (e) => {
    if (!dragId || dragId === t.id) return;
    e.preventDefault();
    wrap.classList.add('drop-target');
  });
  wrap.addEventListener('dragleave', () => wrap.classList.remove('drop-target'));
  wrap.addEventListener('drop', (e) => {
    e.preventDefault();
    wrap.classList.remove('drop-target');
    if (!dragId || dragId === t.id) return;
    const rect = a.getBoundingClientRect();
    const before = e.clientX < rect.left + rect.width / 2;
    commit(() => reorderTiles(state, dragId, t.id, before));
  });

  return wrap;
}

function showEmpty(msg, showAdd) {
  empty.querySelector('p').textContent = msg;
  $('#empty-add').hidden = !showAdd;
  empty.hidden = false;
}

function plural(n) {
  const n10 = n % 10;
  const n100 = n % 100;
  const word =
    n10 === 1 && n100 !== 11
      ? 'элемент'
      : n10 >= 2 && n10 <= 4 && (n100 < 10 || n100 >= 20)
        ? 'элемента'
        : 'элементов';
  return `${n} ${word}`;
}

// Плитка-папка: клик — перейти внутрь папки.
function folderTileEl(node) {
  const d = document.createElement('div');
  d.className = 'tile folder-tile';
  d.tabIndex = 0;
  d.setAttribute('role', 'button');
  d.title = 'Открыть папку «' + (node.title || 'Папка') + '»';

  const icon = document.createElement('span');
  icon.className = 'folder-big';
  icon.textContent = '📁';

  const title = document.createElement('span');
  title.className = 'title';
  title.textContent = node.title || 'Папка';

  const cnt = document.createElement('span');
  cnt.className = 'host';
  cnt.textContent = plural((node.children || []).length);

  d.append(icon, title, cnt);
  const go = () => selectFolder(node.id);
  d.addEventListener('click', go);
  d.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      go();
    }
  });
  return d;
}

// Плитка-закладка из дерева Chrome: открыть + «добавить в панель».
function bookmarkTileEl(node) {
  const wrap = document.createElement('div');
  wrap.className = 'tile-wrap';

  const a = document.createElement('a');
  a.className = 'tile';
  a.href = node.url;
  a.target = '_blank';
  a.rel = 'noopener';
  a.title = node.url;
  const thumb = document.createElement('span');
  thumb.className = 'thumb';
  thumb.setAttribute('aria-hidden', 'true');
  a.append(thumb, ...tileBody(node.url, node.title || hostname(node.url)));
  a.addEventListener('click', (e) => {
    if (e.button === 0 && !e.ctrlKey && !e.metaKey && !e.shiftKey && !e.altKey) {
      e.preventDefault();
      chrome.tabs.create({ url: node.url });
    }
  });

  const actions = document.createElement('div');
  actions.className = 'tile-actions';

  const add = document.createElement('button');
  add.className = 'icon-btn add';
  add.type = 'button';
  add.title = 'Добавить в панель быстрого доступа';
  add.textContent = '＋';
  add.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    addToPanel(node);
  });

  actions.append(add);
  wrap.append(a, actions, hovercardEl(node.title, node.url));
  attachThumb(wrap, node.url);
  return wrap;
}

async function addToPanel(node) {
  if (visibleTiles(state).some((t) => t.url === node.url)) {
    showToast('Уже есть в панели быстрого доступа');
    return;
  }
  await commit(() => addTile(state, { title: node.title, url: node.url }));
  showToast('Добавлено в панель ✓');
}

function fillFolderGrid() {
  const node = nodeById.get(selectedFolder);
  const kids = node.children || [];
  if (!kids.length) {
    showEmpty('Папка пуста', false);
    return;
  }
  empty.hidden = true;
  for (const child of kids) {
    grid.append(child.url !== undefined ? bookmarkTileEl(child) : folderTileEl(child));
  }
}

function fillTiles(q) {
  const tiles = visibleTiles(state).filter(
    (t) => !q || t.title.toLowerCase().includes(q) || t.url.toLowerCase().includes(q) || hostname(t.url).includes(q)
  );
  if (!tiles.length) {
    showEmpty(q ? 'Ничего не найдено' : 'Пока нет закладок', !q);
    return;
  }
  empty.hidden = true;
  for (const t of tiles) grid.append(tileEl(t));
}

function render() {
  const q = search.value.trim().toLowerCase();

  let mode = 'tiles';
  if (q) mode = 'search';
  else {
    const sel = selectedFolder ? nodeById.get(selectedFolder) : null;
    if (sel && sel.url === undefined) mode = 'folder';
    else selectedFolder = null; // папку удалили в Chrome — выходим из режима
  }

  renderFolderBar(mode === 'folder');
  grid.textContent = '';

  if (mode === 'folder') fillFolderGrid();
  else fillTiles(q);

  renderTree();
}

// ---------------- Сохранение ----------------

async function commit(mutate) {
  mutate(state);
  await saveState(state);
  render();
  chrome.runtime.sendMessage({ type: 'sync-soon' }).catch(() => {});
}

async function deleteTile(id) {
  const t = state.tiles[id];
  if (!t) return;
  if (!confirm(`Удалить «${t.title}» из панели?`)) return;
  await commit(() => removeTile(state, id));
  showToast('Закладка удалена');
}

// ---------------- Диалог добавления/редактирования ----------------

function openDialog(tile) {
  editingId = tile ? tile.id : null;
  dialogTitle.textContent = tile ? 'Изменить закладку' : 'Новая закладка';
  fTitle.value = tile ? tile.title : '';
  fUrl.value = tile ? tile.url : '';
  deleteBtn.hidden = !tile;
  dialog.showModal();
  (tile ? fTitle : fUrl).focus();
}

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const url = normalizeUrl(fUrl.value);
  if (!url) return;
  try {
    if (editingId) {
      await commit(() => updateTile(state, editingId, { title: fTitle.value, url }));
    } else {
      await commit(() => addTile(state, { title: fTitle.value, url }));
    }
  } catch (err) {
    showToast(String(err.message || err));
    return;
  }
  dialog.close();
});

$('#cancel-btn').addEventListener('click', () => dialog.close());
deleteBtn.addEventListener('click', async () => {
  const id = editingId;
  dialog.close();
  if (id) await deleteTile(id);
});

$('#add-btn').addEventListener('click', () => openDialog(null));
$('#empty-add').addEventListener('click', () => openDialog(null));

// ---------------- Поиск и горячие клавиши ----------------

search.addEventListener('input', render);

document.addEventListener('keydown', (e) => {
  const inInput = /^(INPUT|TEXTAREA)$/.test(document.activeElement.tagName);
  if (e.key === '/' && !inInput) {
    e.preventDefault();
    search.focus();
  } else if (e.key === 'g' && !inInput && !e.ctrlKey && !e.metaKey && !e.altKey) {
    e.preventDefault();
    webSearch.focus();
  } else if (e.key === 'n' && !inInput && !e.ctrlKey && !e.metaKey && !e.altKey) {
    e.preventDefault();
    openDialog(null);
  } else if (e.key === 'Escape' && document.activeElement === search && search.value) {
    search.value = '';
    render();
  }
});

// ---------------- Синхронизация ----------------

function showToast(msg) {
  toast.textContent = msg;
  toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (toast.hidden = true), 4000);
}

function renderSyncStatus() {
  const configured = isConfigured();
  setupHint.hidden = configured;
  syncBtn.disabled = false;

  chrome.storage.local.get('lastSync').then(({ lastSync }) => {
    if (!configured) {
      syncDot.className = 'sync-dot';
      syncText.textContent = 'Синхронизация не настроена';
      return;
    }
    if (!lastSync) {
      syncDot.className = 'sync-dot';
      syncText.textContent = 'Синхронизироваться';
      return;
    }
    if (lastSync.ok) {
      syncDot.className = 'sync-dot ok';
      const time = new Date(lastSync.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      syncText.textContent = 'Синхр. ' + time;
    } else {
      syncDot.className = 'sync-dot err';
      syncText.textContent = 'Ошибка синхронизации';
      syncBtn.title = lastSync.error || '';
    }
  });
}

syncBtn.addEventListener('click', async () => {
  if (!isConfigured()) {
    showToast('Сначала настройте Google API: см. README.md');
    return;
  }
  syncDot.className = 'sync-dot busy';
  syncText.textContent = 'Синхронизация…';
  const res = await syncNow({ interactive: true });
  if (res.ok) {
    showToast('Синхронизировано с Google Drive ✓');
  } else {
    showToast(res.error || 'Не удалось синхронизировать');
  }
  renderSyncStatus();
});

// ---------------- Поиск в интернете (Google / ИИ) ----------------

const WS_KEY = 'webSearch';
let wsSettings = { mode: 'google', provider: 'google-ai', v: 2 };

function applyWsSettings() {
  engineBtns.forEach((b) => b.classList.toggle('active', b.dataset.engine === wsSettings.mode));
  aiProvider.hidden = wsSettings.mode !== 'ai';
  aiProvider.value = wsSettings.provider;
  if (aiProvider.value !== wsSettings.provider) {
    // сохранённого сервиса больше нет в списке — берём первый доступный
    wsSettings.provider = aiProvider.value || 'google-ai';
  }
  if (wsSettings.mode !== 'ai') {
    webSearch.placeholder = 'Поиск в интернете…  (G)';
  } else {
    webSearch.placeholder =
      wsSettings.provider === 'google-ai' ? 'Спросить ИИ Google…  (G)' : 'Спросить ИИ…  (G)';
  }
}

function saveWsSettings() {
  chrome.storage.local.set({ [WS_KEY]: wsSettings }).catch(() => {});
}

async function loadWsSettings() {
  try {
    const got = await chrome.storage.local.get(WS_KEY);
    const stored = got[WS_KEY];
    if (stored) {
      // Миграция старых настроек: тогда ИИ по умолчанию был Perplexity,
      // теперь — Google AI (переключаем только если это был старый дефолт).
      if (!stored.v && stored.provider === 'perplexity') stored.provider = 'google-ai';
      wsSettings = { ...wsSettings, ...stored, v: 2 };
    }
  } catch {
    // используем значения по умолчанию
  }
  applyWsSettings();
}

engineBtns.forEach((b) =>
  b.addEventListener('click', () => {
    wsSettings.mode = b.dataset.engine;
    saveWsSettings();
    applyWsSettings();
    webSearch.focus();
  })
);

aiProvider.addEventListener('change', () => {
  wsSettings.provider = aiProvider.value;
  saveWsSettings();
  applyWsSettings();
});

wsForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const q = webSearch.value.trim();
  if (!q) return;
  chrome.tabs.create({ url: buildSearchUrl(wsSettings, q) });
  webSearch.value = '';
});

// ---------------- Превью страниц: кнопка разрешения ----------------

const CAPTURE_ORIGINS = ['<all_urls>'];
let thumbsOn = false;

async function refreshThumbsBtn() {
  try {
    thumbsOn = await chrome.permissions.contains({ origins: CAPTURE_ORIGINS });
  } catch {
    thumbsOn = false;
  }

  let count = 0;
  let status = null;
  try {
    const got = await chrome.storage.local.get([THUMB_INDEX, 'thumbStatus']);
    count = Object.keys(got[THUMB_INDEX] || {}).length;
    status = got.thumbStatus || null;
  } catch {
    // ignore
  }

  thumbsBtn.classList.toggle('active', thumbsOn);
  thumbsBtn.textContent = thumbsOn
    ? count
      ? `👁 Превью: ${count}`
      : '👁 Превью: вкл'
    : '👁 Превью';

  const lines = [];
  if (!thumbsOn) {
    lines.push(
      'Превью выключены: клик — включить. Если Chrome откажет — chrome://extensions → ' +
        'SwissTabs → Подробности → Доступ к сайтам → «Разрешить на всех сайтах»'
    );
  } else {
    lines.push(
      count
        ? `Собрано миниатюр: ${count}. Превью снимается при посещении сайта (окно в фокусе).`
        : 'Пока нет миниатюр: откройте нужные сайты — превью снимется через ~2 секунды после загрузки страницы.'
    );
    if (status) {
      const time = status.at ? new Date(status.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '';
      lines.push(
        status.ok
          ? `Последний снимок${time ? ' в ' + time : ''}: ${status.url || ''}`
          : `Ошибка снимка${time ? ' в ' + time : ''}: ${status.error || 'неизвестно'}`
      );
    }
  }
  thumbsBtn.title = lines.join('\n');

  // Видимая строка состояния (не только подсказка на кнопке)
  if (!thumbsOn) {
    thumbsHint.hidden = false;
    thumbsHint.textContent =
      'Превью выключены: доступ к сайтам не выдан. Нажмите 👁 «Превью» в шапке — после перезагрузки расширения доступ выдаётся автоматически.';
  } else if (status && !status.ok) {
    thumbsHint.hidden = false;
    thumbsHint.textContent =
      'Ошибка снятия превью: ' + (status.error || 'неизвестно') + ' — подробности при наведении на кнопку 👁.';
  } else if (count === 0) {
    thumbsHint.hidden = false;
    thumbsHint.textContent =
      'Превью включены, но миниатюр пока нет: откройте сайт из панели (клик по плитке), подождите ~3 секунды с открытым окном Chrome — и вернитесь на панель.';
  } else {
    thumbsHint.hidden = true;
    thumbsHint.textContent = '';
  }
}

thumbsBtn.addEventListener('click', async () => {
  if (thumbsOn) {
    let removed = false;
    try {
      removed = await chrome.permissions.remove({ origins: CAPTURE_ORIGINS });
    } catch {
      removed = false;
    }
    if (removed) {
      showToast('Превью выключены');
    } else {
      showToast(
        'Доступ к сайтам закреплён в манифесте — снимается на chrome://extensions → Подробности → Доступ к сайтам'
      );
    }
  } else {
    let granted = false;
    let err = '';
    try {
      granted = await chrome.permissions.request({ origins: CAPTURE_ORIGINS });
    } catch (e) {
      err = e && e.message ? e.message : String(e);
    }
    if (granted) {
      showToast('Превью включены — скриншоты будут собираться при посещении сайтов');
    } else if (err) {
      console.error('[SwissTabs] permissions.request:', err);
      showToast('Chrome отклонил разрешение: ' + err);
    } else {
      showToast(
        'Разрешение не выдано. Включите его: chrome://extensions → SwissTabs → Подробности → Доступ к сайтам → «Разрешить на всех сайтах»'
      );
    }
  }
  await refreshThumbsBtn();
});

chrome.permissions.onAdded.addListener(refreshThumbsBtn);
chrome.permissions.onRemoved.addListener(refreshThumbsBtn);

// ---------------- Реакция на изменения из других вкладок/фонового воркера ----------------

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (changes.state) {
    state = changes.state.newValue || state;
    render();
  }
  if (changes.lastSync) renderSyncStatus();
  if (changes[THUMB_INDEX] || changes.thumbStatus) refreshThumbsBtn();
  for (const [key, ch] of Object.entries(changes)) {
    if (key.startsWith('thumb:')) applyThumbChange(key, ch.newValue || null);
  }
});

// ---------------- Дерево закладок Chrome (боковая панель) ----------------

const sidebar = $('#sidebar');
const treeEl = $('#tree');
const sidebarToggle = $('#sidebar-toggle');

const EXPANDED_KEY = 'expandedFolders';
let treeRoot = null;
let expanded = new Set();
let treeTimer = null;

// Режим «содержимое папки» справа
let selectedFolder = null;
const nodeById = new Map();
const parentOf = new Map();

const folderBar = $('#folder-bar');
const breadcrumbs = $('#breadcrumbs');

function indexTree(root) {
  nodeById.clear();
  parentOf.clear();
  if (!root) return;
  (function walk(n, parent) {
    nodeById.set(n.id, n);
    parentOf.set(n.id, parent ? parent.id : null);
    for (const c of n.children || []) walk(c, n);
  })(root, null);
}

function saveExpanded() {
  chrome.storage.local.set({ [EXPANDED_KEY]: [...expanded] }).catch(() => {});
}

// Выбор папки: раскрываем её в дереве и показываем содержимое справа.
function selectFolder(id) {
  selectedFolder = id;
  if (!expanded.has(id)) {
    expanded.add(id);
    saveExpanded();
  }
  render();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function renderFolderBar(visible) {
  folderBar.hidden = !visible;
  if (!visible) return;

  breadcrumbs.textContent = '';
  const path = [];
  let id = selectedFolder;
  while (id && nodeById.has(id) && id !== treeRoot?.id) {
    path.unshift(id);
    id = parentOf.get(id);
  }

  path.forEach((pid, i) => {
    if (i) {
      const sep = document.createElement('span');
      sep.className = 'crumb-sep';
      sep.textContent = '›';
      breadcrumbs.append(sep);
    }
    const node = nodeById.get(pid);
    const last = i === path.length - 1;
    if (last) {
      const span = document.createElement('span');
      span.className = 'crumb current';
      span.textContent = node.title || 'Папка';
      breadcrumbs.append(span);
    } else {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'crumb';
      btn.textContent = node.title || 'Папка';
      btn.title = 'Перейти в «' + (node.title || 'Папка') + '»';
      btn.addEventListener('click', () => selectFolder(pid));
      breadcrumbs.append(btn);
    }
  });
}

$('#folder-close').addEventListener('click', () => {
  selectedFolder = null;
  render();
});

function treeFavicon(img, url) {
  img.onerror = () => {
    img.onerror = null;
    img.src = 'https://www.google.com/s2/favicons?sz=32&domain=' + encodeURIComponent(hostname(url));
  };
}

function bookmarkRow(node) {
  const a = document.createElement('a');
  a.className = 'tree-row';
  a.href = node.url;
  a.target = '_blank';
  a.rel = 'noopener';
  a.title = (node.title || node.url) + '\n' + node.url;

  const twist = document.createElement('span');
  twist.className = 'twist leaf';
  twist.textContent = '▸';

  const img = document.createElement('img');
  img.alt = '';
  img.loading = 'lazy';
  img.src = faviconSrc(node.url);
  treeFavicon(img, node.url);

  const title = document.createElement('span');
  title.className = 'node-title';
  title.textContent = node.title || hostname(node.url) || node.url;

  a.append(twist, img, title);
  a.addEventListener('click', (e) => {
    if (e.button === 0 && !e.ctrlKey && !e.metaKey && !e.shiftKey && !e.altKey) {
      e.preventDefault();
      chrome.tabs.create({ url: node.url });
    }
  });
  return a;
}

function folderRow(node, count) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'tree-row folder';
  btn.title = node.title + (count ? ` (${count})` : '');

  const twist = document.createElement('span');
  twist.className = 'twist';
  twist.textContent = '▸';

  const icon = document.createElement('span');
  icon.className = 'folder-icon';
  icon.textContent = '📁';

  const title = document.createElement('span');
  title.className = 'node-title';
  title.textContent = node.title || 'Папка';

  const cnt = document.createElement('span');
  cnt.className = 'count';
  cnt.textContent = count || '';

  btn.append(twist, icon, title, cnt);
  return btn;
}

function renderTreeNode(node, q) {
  if (node.url !== undefined) {
    if (q && !(node.title.toLowerCase().includes(q) || node.url.toLowerCase().includes(q))) return null;
    const li = document.createElement('li');
    li.append(bookmarkRow(node));
    return li;
  }

  const childEls = (node.children || []).map((c) => renderTreeNode(c, q)).filter(Boolean);
  const selfMatch = q && node.title.toLowerCase().includes(q);
  if (q && !selfMatch && childEls.length === 0) return null;

  const li = document.createElement('li');
  const row = folderRow(node, (node.children || []).length);
  const hasKids = (node.children || []).length > 0;
  if (node.id === selectedFolder) row.classList.add('selected');

  if (hasKids) {
    const open = q ? true : expanded.has(node.id);
    row.querySelector('.twist').classList.toggle('open', open);
    row.addEventListener('click', () => {
      toggleFolder(node.id);
      selectedFolder = node.id;
      render();
    });
    if (open && childEls.length) {
      const ul = document.createElement('ul');
      ul.className = 'tree-list';
      childEls.forEach((el) => ul.append(el));
      li.append(row, ul);
    } else {
      li.append(row);
    }
  } else {
    row.querySelector('.twist').classList.add('leaf');
    row.addEventListener('click', () => {
      selectedFolder = node.id;
      render();
    });
    li.append(row);
  }
  return li;
}

function renderTree() {
  treeEl.textContent = '';
  if (!treeRoot) return;
  const q = search.value.trim().toLowerCase();
  const ul = document.createElement('ul');
  ul.className = 'tree-list';
  for (const node of treeRoot.children || []) {
    const el = renderTreeNode(node, q);
    if (el) ul.append(el);
  }
  if (!ul.children.length) {
    const msg = document.createElement('div');
    msg.className = 'tree-empty';
    msg.textContent = q ? 'Ничего не найдено' : 'Закладок нет';
    treeEl.append(msg);
    return;
  }
  treeEl.append(ul);
}

function toggleFolder(id) {
  if (expanded.has(id)) expanded.delete(id);
  else expanded.add(id);
  saveExpanded();
}

async function refreshTree(expandDefaults = false) {
  try {
    const [root] = await chrome.bookmarks.getTree();
    treeRoot = root || null;
  } catch (e) {
    console.warn('[SwissTabs] tree:', e);
    treeRoot = null;
  }
  indexTree(treeRoot);
  if (expandDefaults) {
    for (const c of treeRoot?.children || []) if (!c.url) expanded.add(c.id);
  }
  render();
}

function scheduleTreeRefresh() {
  clearTimeout(treeTimer);
  treeTimer = setTimeout(() => refreshTree(), 200);
}

async function initSidebar() {
  const ui = await chrome.storage.local.get([EXPANDED_KEY, 'sidebarCollapsed']);
  if (ui.sidebarCollapsed) sidebar.classList.add('collapsed');
  const hadSaved = Array.isArray(ui[EXPANDED_KEY]);
  if (hadSaved) expanded = new Set(ui[EXPANDED_KEY]);
  await refreshTree(!hadSaved);

  for (const ev of ['onCreated', 'onChanged', 'onRemoved', 'onMoved', 'onChildrenChanged', 'onImportEnded']) {
    chrome.bookmarks[ev]?.addListener(scheduleTreeRefresh);
  }
}

sidebarToggle.addEventListener('click', () => {
  const collapsed = sidebar.classList.toggle('collapsed');
  chrome.storage.local.set({ sidebarCollapsed: collapsed }).catch(() => {});
  sidebarToggle.title = collapsed ? 'Развернуть боковую панель' : 'Свернуть боковую панель';
});

// Возврат на вкладку панели: перерисовываем (события storage могли прийти в фоне)
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) {
    render();
    refreshThumbsBtn();
  }
});

// ---------------- Старт ----------------

await initSidebar();
await loadWsSettings();
refreshThumbsBtn();
render();
renderSyncStatus();
syncNow({ interactive: false }).then((res) => {
  if (res.ok) renderSyncStatus();
});
