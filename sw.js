const CACHE = 'agri-connect-v4';
const URLS = [
  '/',
  '/login',
  '/register',
  '/wallet-callback.html',
  '/manifest.json',
  '/socket.io/socket.io.js',
];

self.addEventListener('install', function(e) {
  e.waitUntil(
    caches.open(CACHE).then(function(cache) {
      return cache.addAll(URLS).catch(function(err) {
        console.warn('[SW] Cache addAll failed, skipping install:', err);
      });
    })
  );
  self.skipWaiting();
});

self.addEventListener('activate', function(e) {
  e.waitUntil(
    caches.keys().then(function(keys) {
      return Promise.all(keys.filter(function(k) { return k !== CACHE; }).map(function(k) { return caches.delete(k); }));
    })
  );
  self.clients.claim();
});

self.addEventListener('fetch', function(e) {
  if (e.request.method !== 'GET') return;

  const url = new URL(e.request.url);

  // API requests: always network-only, never cache
  if (url.pathname.startsWith('/api/')) {
    e.respondWith(fetch(e.request));
    return;
  }

  // HTML pages: network-first (always fetch fresh, fall back to cache offline)
  if (url.pathname.endsWith('.html') || url.pathname === '/') {
    e.respondWith(
      fetch(e.request).then(function(res) {
        if (res && res.ok) {
          const clone = res.clone();
          caches.open(CACHE).then(function(cache) { cache.put(e.request, clone); });
        }
        return res;
      }).catch(function() {
        return caches.match(e.request).then(function(cached) {
          return cached || caches.match('/');
        });
      })
    );
    return;
  }

  // Everything else: cache-first (static assets)
  e.respondWith(
    caches.match(e.request).then(function(r) {
      return r || fetch(e.request).then(function(res) {
        if (res && res.ok && res.type === 'basic') {
          const clone = res.clone();
          caches.open(CACHE).then(function(cache) { cache.put(e.request, clone); });
        }
        return res;
      }).catch(function() {
        if (url.pathname.startsWith('/socket.io/')) return new Response('', { status: 503 });
        return caches.match('/');
      });
    })
  );
});
