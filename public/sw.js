// CulinaRPG — service worker : app shell hors ligne, API toujours en réseau.
const VERSION = 'culinarpg-v3';
const SHELL = ['/', '/app.js', '/manifest.webmanifest', '/icons/icon.svg', '/icons/icon-192.png'];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);
  if (request.method !== 'GET' || url.pathname.startsWith('/api/')) return;

  // Même origine : réseau d'abord (toujours la dernière version), cache en secours hors ligne
  if (url.origin === self.location.origin) {
    event.respondWith(
      fetch(request)
        .then((res) => {
          if (res.ok) { const copy = res.clone(); caches.open(VERSION).then((c) => c.put(request, copy)); }
          return res;
        })
        .catch(() => caches.match(request).then((r) => r || caches.match('/'))),
    );
    return;
  }

  // CDN (Tailwind, Lucide, polices, confettis) et photos : cache d'abord, rafraîchi en arrière-plan
  event.respondWith(
    caches.open(`${VERSION}-ext`).then(async (cache) => {
      const cached = await cache.match(request);
      const network = fetch(request).then((res) => {
        if (res.ok || res.type === 'opaque') cache.put(request, res.clone());
        return res;
      }).catch(() => cached);
      return cached || network;
    }),
  );
});
