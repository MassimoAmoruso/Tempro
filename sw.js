// Service worker: rende l'app utilizzabile offline.
// Ad ogni rilascio aggiornare VERSION per forzare il rinnovo della cache.
const VERSION = 'tempro-v3';
const ASSETS = [
  './',
  'index.html',
  'styles.css',
  'js/app.js',
  'js/engine.js',
  'js/storage.js',
  'manifest.webmanifest',
  'icons/icon.svg',
  'icons/icon-180.png',
  'icons/icon-192.png',
  'icons/icon-512.png',
];
const FONT_HOSTS = ['fonts.googleapis.com', 'fonts.gstatic.com'];

self.addEventListener('install', e => {
  // Un file mancante non deve bloccare l'installazione: si mette in cache ciò che c'è.
  e.waitUntil(
    caches.open(VERSION)
      .then(c => Promise.allSettled(ASSETS.map(a => c.add(a))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== VERSION).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const { request } = e;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  const sameOrigin = url.origin === self.location.origin;
  if (!sameOrigin && !FONT_HOSTS.includes(url.hostname)) return;   // immagini/video esterni: rete

  // Cache prima, aggiornamento in background (stale-while-revalidate).
  e.respondWith(caches.open(VERSION).then(async cache => {
    const cached = await cache.match(request, { ignoreSearch: sameOrigin });
    const network = fetch(request)
      .then(res => { if (res.ok || res.type === 'opaque') cache.put(request, res.clone()); return res; })
      .catch(() => cached);
    return cached || network;
  }));
});
