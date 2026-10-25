// Minimal service worker: makes the page installable and shows the app shell offline.
// Only same-origin static shell files are cached; /api, /hls, /img, /dl, /media always go to the network.
const CACHE = 'tvbox-shell-v4';
const SHELL = ['./', 'style.css', 'app.js', 'feed.js', 'vendor/hls.min.js', 'icon.svg', 'icons/icon-192.png'];
// The server writes the login state into <html data-auth> of the entry page. Cache it without that attribute,
// so an offline copy never claims a state it can't know (the page then verifies by itself).
async function put(cache, req, res) {
  if (/text\/html/.test(res.headers.get('content-type') || '')) {
    const t = (await res.text()).replace(/ data-auth="[^"]*"/, '');
    res = new Response(t, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
  }
  return cache.put(req, res);
}
self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => Promise.all(SHELL.map(u => fetch(u).then(r => r.ok && put(c, u, r)).catch(() => {})))));
  self.skipWaiting();
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const r = e.request, u = new URL(r.url);
  if (r.method !== 'GET' || u.origin !== location.origin) return;
  if (/^\/(api|hls|img|dl|media)\//.test(u.pathname) || r.headers.has('range')) return;
  // network first, fall back to cache (static files are served with ETag, so this stays fresh)
  e.respondWith(fetch(r).then(res => {
    if (res.ok) { const cp = res.clone(); caches.open(CACHE).then(c => put(c, r, cp)); }
    return res;
  }).catch(() => caches.match(r, { ignoreSearch: true }).then(m => m || (r.mode === 'navigate' ? caches.match('./') : Response.error()))));
});
