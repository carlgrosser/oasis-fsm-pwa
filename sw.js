const CACHE_NAME = 'fsm-pwa-v80';
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
  'js/billing.js',
  'js/themes.js',
  'js/timetracking.js',
  'js/timeoff.js',
  'js/timesheet.js',
  'js/expenses.js',
  'js/sync.js',
  'js/helpdesk.js',
  'js/wrapup.js',
  'js/options.js',
  'js/documents.js',
  'js/driveinfo.js',
  'js/app.js',
  'manifest.json',
  'favicon.ico',
  'favicon-16x16.png',
  'favicon-32x32.png',
  'apple-touch-icon.png',
  'icon-192.png',
  'icon-512.png',
];

// Install — cache static assets.
// cache: 'reload' bypasses the browser HTTP cache so a new SW version can't
// precache a stale file (e.g. old app.js next to new app.html — that mix
// produced an empty, seemingly dead menu dropdown).
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(
        STATIC_ASSETS.map((url) => new Request(url, { cache: 'reload' }))
      );
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

// Background Sync — upload queued photos when connectivity is restored
self.addEventListener('sync', (event) => {
  if (event.tag === 'photo-upload') {
    event.waitUntil(_syncPhotos());
  }
});

async function _openPhotoDB() {
  return new Promise((resolve, reject) => {
    // Open without a version — always attaches to the current DB version,
    // avoiding VersionError when the app upgrades the schema.
    const req = indexedDB.open('fsm_pwa');
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function _getUnsyncedPhotos(db) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction('photos', 'readonly');
    const store = tx.objectStore('photos');
    const index = store.index('synced');
    const req = index.getAll(0);
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  });
}

async function _markPhotoSynced(db, photo) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction('photos', 'readwrite');
    const store = tx.objectStore('photos');
    photo.synced = 1;
    const req = store.put(photo);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

function _base64ToBlob(dataUrl) {
  const base64 = dataUrl.includes(',') ? dataUrl.split(',')[1] : dataUrl;
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes], { type: 'image/jpeg' });
}

async function _syncPhotos() {
  let db;
  try {
    db = await _openPhotoDB();
  } catch (e) {
    console.error('[SW] Could not open IDB for photo sync:', e);
    return;
  }

  const photos = await _getUnsyncedPhotos(db);
  if (!photos.length) return;

  const base = self.location.origin;

  for (const photo of photos) {
    try {
      // Newer records store data as a Blob; older ones as a base64 data URL
      const blob = photo.data instanceof Blob ? photo.data : _base64ToBlob(photo.data);
      const form = new FormData();
      form.append('order_id', photo.job_id);
      form.append('category', photo.category || '');
      form.append('file', blob, photo.filename || 'photo.jpg');

      const resp = await fetch(base + '/gdrive/upload_photo', {
        method: 'POST',
        body: form,
        credentials: 'include',
      });

      if (resp.ok) {
        const data = await resp.json();
        if (data.success) {
          photo.gdrive_file_id = data.gdrive_file_id || null;
          photo.gdrive_url = data.gdrive_url || null;
          await _markPhotoSynced(db, photo);
        }
      }
    } catch (e) {
      console.warn('[SW] Photo sync failed for', photo.temp_id, e);
      // Leave synced=0 so it retries on next sync event
    }
  }
}

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
