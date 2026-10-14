// Offscreen-документ: сжимает скриншот страницы в компактную миниатюру.
// Service worker не имеет доступа к canvas, поэтому обработка идёт здесь.

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || msg.type !== 'make-thumb') return;

  (async () => {
    try {
      const dataUrl = await resize(msg.src, msg.maxWidth || 480, msg.quality || 0.62);
      sendResponse({ ok: true, dataUrl });
    } catch (e) {
      sendResponse({ ok: false, error: String(e && e.message ? e.message : e) });
    }
  })();

  return true; // асинхронный ответ
});

function resize(src, maxWidth, quality) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      try {
        const scale = Math.min(1, maxWidth / img.width);
        const w = Math.max(1, Math.round(img.width * scale));
        const h = Math.max(1, Math.round(img.height * scale));

        const canvas = document.createElement('canvas');
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0, w, h);

        let out = canvas.toDataURL('image/webp', quality);
        if (!out.startsWith('data:image/webp')) {
          out = canvas.toDataURL('image/jpeg', quality);
        }
        resolve(out);
      } catch (e) {
        reject(e);
      }
    };
    img.onerror = () => reject(new Error('не удалось декодировать скриншот'));
    img.src = src;
  });
}
