const CACHE = 'agri-connect-v1';
const URLS = [
  '/',
  '/login',
  '/register',
  '/farmer.html',
  '/organisation.html',
  '/consumer.html',
  '/admin.html',
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
  e.respondWith(
    caches.match(e.request).then(function(r) {
      return r || fetch(e.request).then(function(res) {
        if (res && res.ok && res.type === 'basic') {
          const clone = res.clone();
          caches.open(CACHE).then(function(cache) { cache.put(e.request, clone); });
        }
        return res;
      }).catch(function() {
        return caches.match('/');
      });
    })
  );
});
