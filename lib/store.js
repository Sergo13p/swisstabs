// Хранилище состояния панели: плитки (закладки), импорт из Chrome, слияние версий.

const KEY = 'state';

export function emptyState() {
  return { version: 1, seeded: false, updatedAt: 0, tiles: {} };
}

export async function loadState() {
  const got = await chrome.storage.local.get(KEY);
  return got[KEY] || emptyState();
}

export async function saveState(state, { touch = true } = {}) {
  if (touch) state.updatedAt = Date.now();
  await chrome.storage.local.set({ [KEY]: state });
  return state;
}

export function normalizeUrl(raw) {
  const s = (raw || '').trim();
  if (!s) return '';
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) return s;
  if (/^localhost(:\d+)?([/?#].*)?$/i.test(s)) return 'http://' + s;
  if (/^[\w-]+(\.[\w-]+)+(:\d+)?([/?#].*)?$/.test(s)) return 'https://' + s;
  return 'https://www.google.com/search?q=' + encodeURIComponent(s);
}

export function hostname(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

function makeTile({ title, url, order }) {
  return { id: crypto.randomUUID(), title, url, order, updatedAt: Date.now() };
}

export function addTile(state, { title, url }) {
  const url2 = normalizeUrl(url);
  if (!url2) throw new Error('Пустой адрес');
  const orders = Object.values(state.tiles).map((t) => t.order ?? 0);
  const order = orders.length ? Math.max(...orders) + 1 : 0;
  const tile = makeTile({ title: (title || '').trim() || hostname(url2) || url2, url: url2, order });
  state.tiles[tile.id] = tile;
  return tile;
}

export function updateTile(state, id, patch) {
  const t = state.tiles[id];
  if (!t) return null;
  if (patch.url !== undefined) {
    patch = { ...patch, url: normalizeUrl(patch.url) };
  }
  if (patch.title !== undefined) patch.title = (patch.title || '').trim() || hostname(patch.url || t.url) || t.title;
  Object.assign(t, patch, { updatedAt: Date.now() });
  return t;
}

export function removeTile(state, id) {
  const t = state.tiles[id];
  if (!t) return;
  // Надгробие (tombstone): помечаем удалённой, чтобы слияние разнесло удаление по всем устройствам.
  state.tiles[id] = { ...t, deleted: true, updatedAt: Date.now() };
}

export function visibleTiles(state) {
  return Object.values(state.tiles)
    .filter((t) => !t.deleted && t.url)
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0) || a.title.localeCompare(b.title));
}

export function reorderTiles(state, fromId, toId, before) {
  const list = visibleTiles(state);
  const from = list.findIndex((t) => t.id === fromId);
  if (from < 0) return;
  const [moved] = list.splice(from, 1);
  let to = list.findIndex((t) => t.id === toId);
  if (to < 0) to = list.length;
  else if (!before) to += 1;
  list.splice(to, 0, moved);
  list.forEach((t, i) => {
    const tile = state.tiles[t.id];
    if (tile.order !== i) {
      tile.order = i;
      tile.updatedAt = Date.now();
    }
  });
}

// Первый запуск: переносим все обычные закладки Chrome в плитки панели.
export async function seedFromBookmarks(state) {
  if (state.seeded) return state;
  const tree = await chrome.bookmarks.getTree();
  const flat = [];
  (function walk(nodes) {
    for (const n of nodes || []) {
      if (n.url) flat.push(n);
      else if (n.children) walk(n.children);
    }
  })(tree);

  const have = new Set(Object.values(state.tiles).map((t) => t.url));
  let order = Object.keys(state.tiles).length
    ? Math.max(...Object.values(state.tiles).map((t) => t.order ?? 0)) + 1
    : 0;
  for (const n of flat) {
    if (!/^https?:/i.test(n.url) || have.has(n.url)) continue;
    const tile = makeTile({
      title: n.title || hostname(n.url) || n.url,
      url: n.url,
      order: order++,
    });
    state.tiles[tile.id] = tile;
    have.add(n.url);
  }
  state.seeded = true;
  await saveState(state);
  return state;
}

// ---- Слияние двух версий состояния (последняя запись по каждой плитке побеждает) ----

function normTile(t) {
  return JSON.stringify({
    id: t.id,
    title: t.title || '',
    url: t.url || '',
    order: t.order ?? 0,
    updatedAt: t.updatedAt || 0,
    deleted: !!t.deleted,
  });
}

// Каноническое представление без updatedAt состояния — для сравнения «было ли изменение».
export function sameContent(a, b) {
  if (a.seeded !== b.seeded) return false;
  const ka = Object.keys(a.tiles || {}).sort();
  const kb = Object.keys(b.tiles || {}).sort();
  if (ka.length !== kb.length) return false;
  for (let i = 0; i < ka.length; i++) {
    if (ka[i] !== kb[i]) return false;
    if (normTile(a.tiles[ka[i]]) !== normTile(b.tiles[kb[i]])) return false;
  }
  return true;
}

export function mergeStates(local, remote) {
  const tiles = { ...(local.tiles || {}) };
  const ids = new Set([...Object.keys(tiles), ...Object.keys(remote.tiles || {})]);
  for (const id of ids) {
    const a = tiles[id];
    const b = (remote.tiles || {})[id];
    if (!a) tiles[id] = b;
    else if (!b) tiles[id] = a;
    else tiles[id] = (a.updatedAt || 0) >= (b.updatedAt || 0) ? a : b;
  }
  return {
    version: 1,
    seeded: !!(local.seeded || remote.seeded),
    updatedAt: Math.max(local.updatedAt || 0, remote.updatedAt || 0),
    tiles,
  };
}
