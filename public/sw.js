// CulinaRPG — service worker : app shell hors ligne, API en réseau (cache hors-ligne Pro).
const VERSION = 'culinarpg-v3';
const OFFLINE_CACHE = 'culinarpg-offline-v1';
const SHELL = ['/', '/app.js', '/manifest.webmanifest', '/icons/icon.svg', '/icons/icon-192.png'];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys.filter((k) => k !== VERSION && k !== OFFLINE_CACHE && k !== `${VERSION}-ext`).map((k) => caches.delete(k)),
      ))
      .then(() => self.clients.claim()),
  );
});

// Message de l'app pour mettre en cache des ressources hors-ligne (Pro)
self.addEventListener('message', (event) => {
  if (event.data?.type !== 'CACHE_OFFLINE_DATA') return;
  const urls = event.data.urls || [];
  const client = event.source;
  event.waitUntil(
    caches.open(OFFLINE_CACHE).then(async (cache) => {
      let cached = 0;
      for (const url of urls) {
        try {
          const res = await fetch(url, { credentials: 'same-origin' });
          if (res.ok) { await cache.put(url, res); cached++; }
        } catch { /* ignore */ }
      }
      client?.postMessage({ type: 'CACHE_OFFLINE_DONE', count: cached });
    }),
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);
  if (request.method !== 'GET') return;

  // API GET : réseau d'abord, cache hors-ligne Pro en secours
  if (url.pathname.startsWith('/api/')) {
    event.respondWith(
      fetch(request).catch(() =>
        caches.open(OFFLINE_CACHE).then((c) => c.match(request)).then((r) => r || Response.error()),
      ),
    );
    return;
  }

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
