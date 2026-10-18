// Service Worker:讓 App 在無網路時仍可開啟(C4)。
// 只快取程式與頁面資源;API 一律不經過快取,個案資料只存在 IndexedDB。
// 所有路徑都相對於 SW 所在的範圍(scope),因此放在網站根目錄或子路徑(如 GitHub Pages 的 /physio/)都能運作。
const CACHE = 'physio-shell-v2';
const SCOPE = self.registration.scope;
const at = (p) => new URL(p, SCOPE).href;

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE);
      await cache.addAll([SCOPE, at('manifest.webmanifest'), at('icon.svg'), at('icon-192.png'), at('apple-touch-icon.png')]);
      // 預先快取目前頁面引用的 assets/ 檔案(首次載入時它們早於 SW 生效)
      const html = await (await cache.match(SCOPE)).text();
      const assets = [...html.matchAll(/["'(]\.?\/?(assets\/[^"')\s]+)/g)].map((m) => at(m[1]));
      await cache.addAll([...new Set(assets)]);
    })().then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== self.location.origin || url.pathname.startsWith(new URL('api/', SCOPE).pathname)) return;

  event.respondWith(
    (async () => {
      const cache = await caches.open(CACHE);
      const key = req.mode === 'navigate' ? SCOPE : req;
      const cached = await cache.match(key);
      const network = fetch(req)
        .then((res) => {
          if (res.ok) cache.put(key, res.clone());
          return res;
        })
        .catch(() => null);
      if (cached) {
        event.waitUntil(network); // 背景更新
        return cached;
      }
      return (await network) ?? new Response('目前離線,且此頁面尚未快取', { status: 503, headers: { 'content-type': 'text/plain; charset=utf-8' } });
    })(),
  );
});
