/* =========================================================================
   Service Worker — 台灣趣旅行（互動原型）
   目的：快取 App 本身的檔案（HTML/manifest/圖示），讓已開過的頁面在離線或
   訊號不佳時仍可開啟。地圖圖磚、OSRM 路線查詢等外部服務一律直接連網路，
   不攔截、不快取（離線時地圖與道路路線本來就無法使用，這是預期行為）。
   ========================================================================= */
const CACHE_NAME = 'twtrip-shell-v1';
const APP_SHELL = [
  './',
  './index.html',
  './index_3.html',
  './manifest.json',
  './icons/icon-192.png',
  './icons/icon-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(APP_SHELL))
      .catch((err) => console.warn('SW install cache 失敗（可忽略，不影響正常上線使用）：', err))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  // 跨網域資源（地圖圖磚 tile.openstreetmap.org、OSRM 路線查詢等）一律略過，不進 Service Worker 快取邏輯
  if (url.origin !== self.location.origin) return;

  // Stale-while-revalidate：先回應快取（若有）讓開啟速度快，同時背景更新快取
  event.respondWith(
    caches.match(req).then((cached) => {
      const networkFetch = fetch(req)
        .then((res) => {
          if (res && res.ok) {
            const copy = res.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(req, copy));
          }
          return res;
        })
        .catch(() => cached);
      return cached || networkFetch;
    })
  );
});
