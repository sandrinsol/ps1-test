// Service worker for the play page: makes it installable and lets it run offline.
// Pages are fetched network-first (a new deploy shows up at once, the cache is
// the offline fallback); everything else is served from the cache and refreshed
// in the background (stale-while-revalidate), so the emulator, its core and the
// demo load instantly and work without a connection after the first visit.

const CACHE = 'ps1-play-v1';
const PRECACHE = [
  './', 'index.html', 'manifest.webmanifest', 'web/memcard.js', 'web/icon-192.png', 'web/icon-512.png',
  'data/loader.js', 'data/emulator.min.js', 'data/emulator.min.css', 'data/version.json',
  'data/cores/pcsx_rearmed-wasm.data', 'data/bios/openbios.bin', 'demo/demo.bin',
];

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    // One missing file shouldn't stop the install: cache what's there.
    await Promise.all(PRECACHE.map((u) => cache.add(u).catch(() => {})));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    for (const k of await caches.keys()) if (k !== CACHE) await caches.delete(k);
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== location.origin || req.headers.has('range')) return;
  if (req.mode === 'navigate') {
    event.respondWith((async () => {
      try {
        const res = await fetch(req);
        if (res.ok) (await caches.open(CACHE)).put(req, res.clone());
        return res;
      } catch {
        return (await caches.match(req)) ?? (await caches.match('index.html')) ?? Response.error();
      }
    })());
    return;
  }
  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const hit = await cache.match(req, { ignoreSearch: true });
    const refresh = fetch(req).then((res) => { if (res.ok) cache.put(req, res.clone()); return res; }).catch(() => null);
    if (hit) { event.waitUntil(refresh); return hit; }
    return (await refresh) ?? Response.error();
  })());
});
