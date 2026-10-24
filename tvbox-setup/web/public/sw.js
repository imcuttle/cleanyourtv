// Minimal service worker: makes the page installable and shows the app shell offline.
// Only same-origin static shell files are cached; /api, /hls, /img, /dl, /media always go to the network.
const CACHE = 'tvbox-shell-v2';
const SHELL = ['./', 'style.css', 'app.js', 'feed.js', 'vendor/hls.min.js', 'icon.svg', 'icons/icon-192.png'];
self.addEventListener('install', e => { e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).catch(() => {})); self.skipWaiting(); });
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const r = e.request, u = new URL(r.url);
  if (r.method !== 'GET' || u.origin !== location.origin) return;
  if (/^\/(api|hls|img|dl|media)\//.test(u.pathname) || r.headers.has('range')) return;
  // network first, fall back to cache (static files are served with ETag, so this stays fresh)
  e.respondWith(fetch(r).then(res => {
    if (res.ok) { const cp = res.clone(); caches.open(CACHE).then(c => c.put(r, cp)); }
    return res;
  }).catch(() => caches.match(r, { ignoreSearch: true }).then(m => m || (r.mode === 'navigate' ? caches.match('./') : Response.error()))));
});
