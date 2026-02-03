const CACHE_NAME = 'fsm-pwa-v36';
const STATIC_ASSETS = [
  './',
  'index.html',
  'app.html',
  'css/variables.css',
  'css/mobile.css',
  'css/components.css',
  'js/config.js',
  'js/odoo-api.js',
  'js/db.js',
  'js/auth.js',
  'js/gps.js',
  'js/photos.js',
  'js/jobs.js',
  'js/journal.js',
  'js/materials.js',
  'js/timetracking.js',
  'js/sync.js',
  'js/app.js',
  'manifest.json',
];

// Install — cache static assets
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(STATIC_ASSETS);
    })
  );
  self.skipWaiting();
});

// Activate — clean up old caches
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))
      );
    })
  );
  self.clients.claim();
});

// Fetch — cache-first for static assets, network-first for API calls
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // Don't cache API calls — let them go through normally
  if (event.request.method === 'POST' ||
      url.pathname.startsWith('/web/') ||
      url.pathname.startsWith('/jsonrpc')) {
    return;
  }

  // Static assets: cache-first
  event.respondWith(
    caches.match(event.request).then((cached) => {
      if (cached) return cached;

      return fetch(event.request).then((response) => {
        // Cache successful GET responses
        if (response.ok && event.request.method === 'GET') {
          const clone = response.clone();
          caches.open(CACHE_NAME).then((cache) => {
            cache.put(event.request, clone);
          });
        }
        return response;
      }).catch(() => {
        // Offline fallback for navigation requests
        if (event.request.mode === 'navigate') {
          return caches.match('index.html');
        }
      });
    })
  );
});
