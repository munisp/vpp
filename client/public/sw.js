// Service Worker for VPP Consumer Platform PWA
const CACHE_NAME = 'vpp-platform-v1';
const RUNTIME_CACHE = 'vpp-runtime-v1';
const API_CACHE = 'vpp-api-v1';

// Assets to cache on install
const PRECACHE_ASSETS = [
  '/',
  '/index.html',
  '/manifest.json',
  '/icons/icon-192x192.png',
  '/icons/icon-512x512.png',
];

// Install event - cache critical assets
self.addEventListener('install', (event) => {
  console.log('[ServiceWorker] Install');
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      console.log('[ServiceWorker] Precaching app shell');
      return cache.addAll(PRECACHE_ASSETS);
    }).then(() => {
      return self.skipWaiting();
    })
  );
});

// Activate event - clean up old caches
self.addEventListener('activate', (event) => {
  console.log('[ServiceWorker] Activate');
  const currentCaches = [CACHE_NAME, RUNTIME_CACHE, API_CACHE];
  event.waitUntil(
    caches.keys().then((cacheNames) => {
      return Promise.all(
        cacheNames.map((cacheName) => {
          if (!currentCaches.includes(cacheName)) {
            console.log('[ServiceWorker] Deleting old cache:', cacheName);
            return caches.delete(cacheName);
          }
        })
      );
    }).then(() => {
      return self.clients.claim();
    })
  );
});

// Fetch event - network first, then cache
self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);

  // Skip cross-origin requests
  if (url.origin !== location.origin) {
    return;
  }

  // API requests - network first, cache fallback
  if (url.pathname.startsWith('/api/')) {
    event.respondWith(
      fetch(request)
        .then((response) => {
          // Clone the response before caching
          const responseClone = response.clone();
          caches.open(API_CACHE).then((cache) => {
            cache.put(request, responseClone);
          });
          return response;
        })
        .catch(() => {
          // Return cached API response if available
          return caches.match(request);
        })
    );
    return;
  }

  // Static assets - cache first, network fallback
  event.respondWith(
    caches.match(request).then((cachedResponse) => {
      if (cachedResponse) {
        return cachedResponse;
      }

      return fetch(request).then((response) => {
        // Don't cache non-successful responses
        if (!response || response.status !== 200 || response.type !== 'basic') {
          return response;
        }

        const responseClone = response.clone();
        caches.open(RUNTIME_CACHE).then((cache) => {
          cache.put(request, responseClone);
        });

        return response;
      });
    })
  );
});

// Background sync for offline actions
self.addEventListener('sync', (event) => {
  console.log('[ServiceWorker] Background sync:', event.tag);
  
  if (event.tag === 'sync-telemetry') {
    event.waitUntil(syncTelemetryData());
  } else if (event.tag === 'sync-trades') {
    event.waitUntil(syncTradeData());
  }
});

// Push notification handler
self.addEventListener('push', (event) => {
  console.log('[ServiceWorker] Push received');
  
  let data = {};
  if (event.data) {
    data = event.data.json();
  }

  const title = data.title || 'VPP Platform';
  const options = {
    body: data.body || 'You have a new notification',
    icon: '/icons/icon-192x192.png',
    badge: '/icons/icon-72x72.png',
    data: data.data || {},
    actions: data.actions || [],
    tag: data.tag || 'default',
    requireInteraction: data.requireInteraction || false,
  };

  event.waitUntil(
    self.registration.showNotification(title, options)
  );
});

// Notification click handler
self.addEventListener('notificationclick', (event) => {
  console.log('[ServiceWorker] Notification click:', event.notification.tag);
  event.notification.close();

  const urlToOpen = event.notification.data?.url || '/';

  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
      // Check if there's already a window open
      for (const client of clientList) {
        if (client.url === urlToOpen && 'focus' in client) {
          return client.focus();
        }
      }
      // Open a new window if none exists
      if (clients.openWindow) {
        return clients.openWindow(urlToOpen);
      }
    })
  );
});

// Helper functions for background sync
async function syncTelemetryData() {
  try {
    // Get pending telemetry data from IndexedDB
    const db = await openDB();
    const pendingData = await getPendingTelemetry(db);
    
    if (pendingData.length === 0) {
      return;
    }

    // Send to server
    const response = await fetch('/api/trpc/telemetry.bulkCreate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(pendingData),
    });

    if (response.ok) {
      // Clear synced data from IndexedDB
      await clearPendingTelemetry(db);
      console.log('[ServiceWorker] Telemetry data synced');
    }
  } catch (error) {
    console.error('[ServiceWorker] Failed to sync telemetry:', error);
    throw error; // Retry sync
  }
}

async function syncTradeData() {
  try {
    const db = await openDB();
    const pendingTrades = await getPendingTrades(db);
    
    if (pendingTrades.length === 0) {
      return;
    }

    for (const trade of pendingTrades) {
      const response = await fetch('/api/trpc/trading.createTrade', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(trade),
      });

      if (response.ok) {
        await removePendingTrade(db, trade.id);
      }
    }
    
    console.log('[ServiceWorker] Trade data synced');
  } catch (error) {
    console.error('[ServiceWorker] Failed to sync trades:', error);
    throw error;
  }
}

// IndexedDB helpers (simplified - actual implementation would be more robust)
async function openDB() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('vpp-offline-db', 1);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve(request.result);
    request.onupgradeneeded = (event) => {
      const db = event.target.result;
      if (!db.objectStoreNames.contains('telemetry')) {
        db.createObjectStore('telemetry', { keyPath: 'id', autoIncrement: true });
      }
      if (!db.objectStoreNames.contains('trades')) {
        db.createObjectStore('trades', { keyPath: 'id', autoIncrement: true });
      }
    };
  });
}

async function getPendingTelemetry(db) {
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(['telemetry'], 'readonly');
    const store = transaction.objectStore('telemetry');
    const request = store.getAll();
    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve(request.result);
  });
}

async function clearPendingTelemetry(db) {
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(['telemetry'], 'readwrite');
    const store = transaction.objectStore('telemetry');
    const request = store.clear();
    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve();
  });
}

async function getPendingTrades(db) {
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(['trades'], 'readonly');
    const store = transaction.objectStore('trades');
    const request = store.getAll();
    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve(request.result);
  });
}

async function removePendingTrade(db, id) {
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(['trades'], 'readwrite');
    const store = transaction.objectStore('trades');
    const request = store.delete(id);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve();
  });
}
