const CACHE = 'antmotors-v129';
const STATIC = ['./', './manifest.webmanifest', './icon-192.png', './icon-512.png', './icon.svg'];

// Allow the page to force this worker to take over immediately (used by the
// controllerchange/update logic in index.html so an old build never sticks).
self.addEventListener('message', e => { if(e.data && e.data.type==='skipWaiting') self.skipWaiting(); });

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(STATIC)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
  // Notify any open pages that a new service worker took over, so they can
  // reload and pick up the freshly-served index.html (fixes "stuck on old build").
  self.clients.matchAll({ includeUncontrolled: true }).then(cls =>
    cls.forEach(c => c.postMessage({ type: 'sw-updated', cache: CACHE }))
  );
});

self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  const url = new URL(e.request.url);
  const isNav = url.origin === self.location.origin &&
    (url.pathname.endsWith('/') || url.pathname.endsWith('index.html'));
  if (isNav) {
    // Navigation: always hit network, never cache. Forces fresh index.html every load.
    e.respondWith(
      fetch(e.request, { cache: 'no-cache' }).catch(() => caches.match('./index.html'))
    );
    return;
  }
  // Cache-first for static assets (icons, manifest).
  e.respondWith(
    caches.match(e.request).then(r => r || fetch(e.request).then(resp => {
      const cp = resp.clone();
      caches.open(CACHE).then(c => c.put(e.request, cp));
      return resp;
    }).catch(() => caches.match('./index.html')))
  );
});
