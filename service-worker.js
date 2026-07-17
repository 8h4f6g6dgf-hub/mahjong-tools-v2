// v5.1.0: 正式Worker接続版を旧PWAキャッシュから分離するためキャッシュ世代を更新。
const SERVICE_WORKER_VERSION = '5.1.0';
const CACHE_NAME = 'mahjong-tools-v5.1.0';

const ASSETS_TO_CACHE = [
  './',
  './index.html',
  './manifest.json',
  './service-worker.js',
  './app.json'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(ASSETS_TO_CACHE))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((cacheNames) =>
      Promise.all(
        cacheNames
          .filter((cacheName) => cacheName !== CACHE_NAME)
          .map((cacheName) => caches.delete(cacheName))
      )
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;

  const requestUrl = new URL(event.request.url);

  // v4.6.2: 外部オリジンはキャッシュもSPAフォールバックも行わず、ブラウザ標準通信へ完全に委ねる。
  if (requestUrl.origin !== self.location.origin) return;

  // v4.6.2: 同一オリジンの診断通信もindex.htmlへ置換しない。respondWithを呼ばないことが重要。
  if (event.request.headers.get('X-Mahjong-Diagnostic') === '1') return;

  // v4.8.2: 旧Service Workerのキャッシュにindex/app設定が固定されないよう、コアファイルと画面遷移はネットワーク優先。
  const isCoreRequest = event.request.mode === 'navigate' || [
    '/index.html', '/app.json', '/manifest.json', '/service-worker.js'
  ].some((suffix) => requestUrl.pathname.endsWith(suffix));
  if (isCoreRequest) {
    event.respondWith(
      fetch(event.request, { cache: 'no-store' })
        .then((networkResponse) => {
          const responseClone = networkResponse.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, responseClone));
          return networkResponse;
        })
        .catch(() => caches.match(event.request).then((cachedResponse) => cachedResponse || caches.match('./index.html')))
    );
    return;
  }

  // Mトーナメントデータは常にネット優先。
  // GitHub上の mtournament.json を更新すれば、古いPWAキャッシュではなく最新データを取得する。
  if (requestUrl.pathname.endsWith('/mtournament.json')) {
    event.respondWith(
      fetch(event.request, { cache: 'no-store' })
        .then((networkResponse) => {
          const responseClone = networkResponse.clone();
          caches.open(CACHE_NAME).then((cache) => {
            cache.put(event.request, responseClone);
          });
          return networkResponse;
        })
        .catch(() => caches.match(event.request))
    );
    return;
  }

  // アプリ本体はキャッシュ優先で高速起動。
  event.respondWith(
    caches.match(event.request).then((cachedResponse) => {
      if (cachedResponse) return cachedResponse;
      return fetch(event.request)
        .then((networkResponse) => {
          const responseClone = networkResponse.clone();
          caches.open(CACHE_NAME).then((cache) => {
            cache.put(event.request, responseClone);
          });
          return networkResponse;
        })
        .catch(() => caches.match('./index.html'));
    })
  );
});
