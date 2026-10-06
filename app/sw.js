const CACHE = 'antmotors-v214';
// Dedicated photo bucket. Photo URLs are IMMUTABLE (filename = ms timestamp + random),
// so they can be cached forever. This bucket must SURVIVE version bumps: wiping it on
// every release (like the old activate() did) forced every device to re-download all
// covers (450KB x 29 cars = ~13MB) after each deploy — that was most of the "app opens
// slow, images slow" pain on Ghana mobile links.
// v2 (v1.2.115): the v1 bucket was poisoned — missing files (<name>_t.jpeg thumbs that
// don't exist yet) came back as opaque no-cors responses, which the old `resp.ok ||
// resp.type==='opaque'` check happily cached FOREVER, and iOS then showed question marks.
// v2 re-fetches with mode:'cors' (Storage sends access-control-allow-origin: *) so the
// true HTTP status is readable, and only real 200 images are stored.
const PHOTO_CACHE = 'antmotors-photos-v2';
const PHOTO_RE = /(^|\.)supabase\.co$/;
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
      Promise.all(keys.filter(k => k !== CACHE && k !== PHOTO_CACHE).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
  // Notify any open pages that a new service worker took over, so they can
  // reload and pick up the freshly-served index.html (fixes "stuck on old build").
  self.clients.matchAll({ includeUncontrolled: true }).then(cls =>
    cls.forEach(c => c.postMessage({ type: 'sw-updated', cache: CACHE }))
  );
});

// Keep the photo bucket bounded. Cache API keys() is insertion-ordered, so dropping
// the oldest entries approximates LRU well enough for ~10 photos per car.
async function trimPhotoCache(c, max){
  try{
    const keys = await c.keys();
    if(keys.length <= max) return;
    for(const k of keys.slice(0, keys.length - max)) await c.delete(k);
  }catch(e){}
}

self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  const url = new URL(e.request.url);
  // NEVER cache API responses. They are dynamic (sync /api/pull, per-car /api/car/:id/photos)
  // and the cache-first branch below used to serve a STALE copy of them — which is exactly why
  // deleted cars and photos kept "coming back on refresh": the app re-read an old cached pull
  // while the database was already correct. Returning here lets the browser hit the network.
  if (url.origin === self.location.origin && url.pathname.startsWith('/api/')) return;
  // Photos from Supabase Storage: cache-first forever in the dedicated bucket.
  // The HTTP cache only holds them for max-age=3600 and this bucket survives releases,
  // so a cover that was seen once never travels the wire again.
  // Re-fetch in CORS mode to read the real status: <img> requests are no-cors/opaque
  // (status 0 even for 404s), and caching those poisoned the v1 bucket with missing
  // files that iOS rendered as permanent question marks.
  if (PHOTO_RE.test(url.hostname) && url.pathname.indexOf('/storage/v1/') !== -1) {
    e.respondWith(
      caches.open(PHOTO_CACHE).then(c => c.match(e.request).then(hit => {
        if (hit) return hit;
        return fetch(url.href, { mode: 'cors', credentials: 'omit' }).then(resp => {
          if (resp && resp.ok && resp.status === 200) {
            try { c.put(e.request, resp.clone()); } catch(err) {}
            trimPhotoCache(c, 500);
            return resp;
          }
          // Missing file / error: serve a synthetic 404 (readable status), NOT cacheable.
          return new Response('', { status: 404, statusText: 'Not Found' });
        }).catch(() => fetch(e.request));
      }))
    );
    return;
  }
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
