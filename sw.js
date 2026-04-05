/* ============================================================
   sw.js – AccessNYC Service Worker
   Strategy:
     • MapLibre vector tiles → Cache Storage (cache-first)
     • App shell (HTML/CSS/JS)  → Cache Storage (network-first)
   ============================================================ */

const CACHE_VERSION = 'v1';
const TILE_CACHE    = `accessnyc-tiles-${CACHE_VERSION}`;
const SHELL_CACHE   = `accessnyc-shell-${CACHE_VERSION}`;

const SHELL_URLS = [
  '/NYC4EVERYONE/',
  '/NYC4EVERYONE/index.html',
  '/NYC4EVERYONE/assets/css/main.css',
  '/NYC4EVERYONE/assets/js/main.js',
  '/NYC4EVERYONE/manifest.json',
];

/* ── Install ──────────────────────────────────────────────── */
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE).then((cache) => cache.addAll(SHELL_URLS))
  );
  self.skipWaiting();
});

/* ── Activate ─────────────────────────────────────────────── */
self.addEventListener('activate', (event) => {
  const keep = new Set([TILE_CACHE, SHELL_CACHE]);
  event.waitUntil(
    caches.keys().then((names) =>
      Promise.all(
        names
          .filter((n) => !keep.has(n))
          .map((n) => caches.delete(n))
      )
    )
  );
  self.clients.claim();
});

/* ── Fetch ────────────────────────────────────────────────── */
self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);

  // Only handle HTTPS requests (security: reject plain HTTP)
  if (url.protocol !== 'https:' && url.hostname !== 'localhost') {
    return;
  }

  // Tile requests → cache-first
  if (isTileRequest(url)) {
    event.respondWith(cacheFirst(request, TILE_CACHE));
    return;
  }

  // App shell → network-first, fall back to cache
  event.respondWith(networkFirst(request, SHELL_CACHE));
});

/* ── Helpers ──────────────────────────────────────────────── */
function isTileRequest(url) {
  return (
    url.pathname.match(/\/tiles\//) !== null ||
    url.pathname.match(/\/\d+\/\d+\/\d+\.(png|pbf|mvt)$/) !== null
  );
}

async function cacheFirst(request, cacheName) {
  const cache    = await caches.open(cacheName);
  const cached   = await cache.match(request);
  if (cached) return cached;

  const response = await fetch(request);
  if (response.ok) {
    cache.put(request, response.clone());
  }
  return response;
}

async function networkFirst(request, cacheName) {
  const cache = await caches.open(cacheName);
  try {
    const response = await fetch(request);
    if (response.ok) {
      cache.put(request, response.clone());
    }
    return response;
  } catch {
    const cached = await cache.match(request);
    if (cached) return cached;
    return new Response('Offline – resource not cached', { status: 503 });
  }
}
