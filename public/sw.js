// Service worker for the LiveStream installable app.
// Caches ONLY the static app shell (HTML/CSS/JS/icons) so the app opens fast
// and the shell still loads offline. It NEVER caches API responses or the
// age-verification state: every /api/* request always goes to the network, so
// live streams, chat, orders, visitor counts and the 18+ gate always see
// fresh server state. WebRTC signalling also runs over /api/* and is never
// intercepted by the cache.
const CACHE_NAME = 'livestream-shell-v3';
const SHELL = [
  '/',
 '/index.html',
  '/studio.html',
  '/room.html',
  '/replay.html',
  '/dashboard.html',
  '/admin.html',
  '/terms.html',
  '/privacy.html',
  '/sales-policy.html',
  '/style.css',
  '/app.js',
  '/manifest.json',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/icon-maskable-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  // Only handle same-origin GET requests for static assets.
  if (event.request.method !== 'GET' || url.origin !== self.location.origin) return;
  // API calls, age verification and live signalling always go to the network.
  if (url.pathname.startsWith('/api/')) return;
  event.respondWith(
    caches.match(event.request).then((cached) => {
      if (cached) {
        // Stale-while-revalidate: serve the shell instantly, refresh it in
        // the background so the next launch has the latest version.
        event.waitUntil(
          fetch(event.request).then((fresh) => {
            if (fresh && fresh.ok) caches.open(CACHE_NAME).then((c) => c.put(event.request, fresh));
          }).catch(() => {})
        );
        return cached;
      }
      return fetch(event.request).then((response) => {
        if (response && response.ok) {
          const copy = response.clone();
          caches.open(CACHE_NAME).then((c) => c.put(event.request, copy));
        }
        return response;
      });
    }).catch(() => caches.match('/index.html'))
  );
});
