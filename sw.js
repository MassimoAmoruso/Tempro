// Service worker: rende l'app utilizzabile offline.
// Ad ogni rilascio aggiornare VERSION per forzare il rinnovo della cache.
const VERSION = 'tempro-v11';   // aggiornare insieme a APP_VERSION in js/app.js
const ASSETS = [
  './',
  'index.html',
  'styles.css',
  'js/app.js',
  'js/engine.js',
  'js/storage.js',
  'js/recorder.js',
  'js/share.js',
  'js/report.js',
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

  e.respondWith(caches.open(VERSION).then(async cache => {
    // Font: cache prima (non cambiano). File dell'app: rete prima, così un aggiornamento
    // si vede subito; senza rete si usa la copia in cache.
    if (!sameOrigin) {
      const cached = await cache.match(request);
      if (cached) return cached;
    }
    try {
      const res = await fetch(request);
      if (res.ok || res.type === 'opaque') cache.put(request, res.clone());
      return res;
    } catch (err) {
      const cached = await cache.match(request, { ignoreSearch: sameOrigin });
      if (cached) return cached;
      throw err;
    }
  }));
});
