// Общие утилиты: ключ превью и построение URL поиска.

// Ключ миниатюры: адрес без #hash и с / на конце пути.
export function thumbKey(url) {
  try {
    const u = new URL(url);
    u.hash = '';
    if (u.pathname.length > 1 && u.pathname.endsWith('/')) {
      u.pathname = u.pathname.slice(0, -1);
    }
    return u.origin + u.pathname + u.search;
  } catch {
    return url;
  }
}

// Построение URL поискового запроса: обычный Google или ИИ-сервис.
export function buildSearchUrl({ mode, provider }, query) {
  const q = encodeURIComponent(query);
  if (mode === 'ai') {
    switch (provider) {
      case 'chatgpt':
        return 'https://chatgpt.com/?q=' + q;
      case 'claude':
        return 'https://claude.ai/new?q=' + q;
      case 'perplexity':
        return 'https://www.perplexity.ai/search?q=' + q;
      case 'google-ai':
      default:
        // Google AI Mode: если Google перестанет понимать параметр —
        // откроется обычный поиск Google, но не чужой сервис.
        return 'https://www.google.com/search?q=' + q + '&udm=50';
    }
  }
  return 'https://www.google.com/search?q=' + q;
}

export const SEARCH_MODES = ['google', 'ai'];
export const AI_PROVIDERS = ['google-ai', 'perplexity', 'chatgpt', 'claude'];
