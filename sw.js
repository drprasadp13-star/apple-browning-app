// Service worker: versioned precache, cache-first. Bump VERSION on every release so phones fetch the new files.
const VERSION = '1.0.0';
const CACHE = `apple-browning-${VERSION}`;
const FILES = ['./', 'index.html', 'styles.css', 'app.js', 'worker.js', 'engine.js', 'model.json', 'manifest.webmanifest',
               'icons/icon-192.png', 'icons/icon-512.png', 'icons/icon-maskable-512.png'];
self.addEventListener('install', e => { e.waitUntil(caches.open(CACHE).then(c => c.addAll(FILES)).then(() => self.skipWaiting())); });
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k.startsWith('apple-browning-') && k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  e.respondWith(caches.match(e.request, { ignoreSearch: true }).then(hit => hit || fetch(e.request)));
});
