const CACHE_NAME = 'trademarketing-offline-v1';
const STATIC_CACHE_NAME = 'trademarketing-static-v1';
const DYNAMIC_CACHE_NAME = 'trademarketing-dynamic-v1';

const API_CACHE_CONFIG = {
  maxEntries: 100,
  maxAgeMs: 60 * 60 * 1000,
  timeoutMs: 10000
};

const URLs_TO_CACHE = [
  '/',
  '/index.html',
  '/favicon.ico',
  '/assets/manifest.webmanifest',
  '/assets/icons/icon-192x192.png',
  '/assets/icons/icon-512x512.png',
  '/assets/icons/icon-144x144.png',
  '/assets/icons/icon-152x152.png',
  '/assets/icons/icon-72x72.png'
];

self.addEventListener('install', event => {
  console.log('[SW] Instalando Service Worker...');
  event.waitUntil(
    (async () => {
      const cache = await caches.open(STATIC_CACHE_NAME);
      await Promise.allSettled(
        URLs_TO_CACHE.map(url =>
          cache.add(url).catch(err => console.warn('[SW] No se pudo cachear:', url, err.message))
        )
      );
      await cacheScriptsAndStyles();
      console.log('[SW] Instalación completada');
      return self.skipWaiting();
    })()
  );
});

self.addEventListener('activate', event => {
  console.log('[SW] Activando Service Worker...');
  event.waitUntil(
    (async () => {
      const cacheNames = await caches.keys();
      await Promise.all(
        cacheNames.map(name => {
          if (name !== STATIC_CACHE_NAME && name !== DYNAMIC_CACHE_NAME) {
            console.log('[SW] Eliminando cache antiguo:', name);
            return caches.delete(name);
          }
        })
      );
      console.log('[SW] Activación completada');
      return self.clients.claim();
    })()
  );
});

self.addEventListener('fetch', event => {
  const { request } = event;
  const url = new URL(request.url);

  if (url.pathname.startsWith('/api/')) {
    event.respondWith(apiNetworkFirstStrategy(request));
    return;
  }

  if (
    request.destination === 'script' ||
    request.destination === 'style' ||
    request.destination === 'image' ||
    request.destination === 'font' ||
    request.destination === 'manifest'
  ) {
    event.respondWith(cacheFirstStrategy(request));
    return;
  }

  if (request.mode === 'navigate') {
    event.respondWith(navigationStrategy(request));
    return;
  }

  event.respondWith(networkFirstStrategy(request));
});

async function cacheScriptsAndStyles() {
  try {
    const staticCache = await caches.open(STATIC_CACHE_NAME);
    const indexResponse = await staticCache.match('/index.html');
    if (!indexResponse) return;

    const html = await indexResponse.text();
    const resourceUrls = [];
    const scriptRegex = /<script[^>]+src=["']([^"']+)["']/g;
    const styleRegex = /<link[^>]+href=["']([^"']+\.css[^"']*)["']/g;
    let match;

    while ((match = scriptRegex.exec(html)) !== null) {
      const url = match[1];
      if (!url.startsWith('http') || url.includes(self.location.host)) {
        resourceUrls.push(url);
      }
    }
    while ((match = styleRegex.exec(html)) !== null) {
      const url = match[1];
      if (!url.startsWith('http') || url.includes(self.location.host)) {
        resourceUrls.push(url);
      }
    }

    await Promise.allSettled(
      resourceUrls.map(url =>
        staticCache.add(url).catch(err => console.warn('[SW] No se pudo cachear recurso:', url, err.message))
      )
    );
    console.log('[SW] Recursos JS/CSS cacheados:', resourceUrls.length);
  } catch (error) {
    console.error('[SW] Error cacheando scripts y estilos:', error);
  }
}

async function apiNetworkFirstStrategy(request) {
  const timeoutPromise = new Promise((_, reject) =>
    setTimeout(() => reject(new Error('API timeout')), API_CACHE_CONFIG.timeoutMs)
  );

  try {
    const networkResponse = await Promise.race([
      fetch(request.clone()),
      timeoutPromise
    ]);

    if (networkResponse.ok) {
      const cache = await caches.open(DYNAMIC_CACHE_NAME);
      const responseToCache = networkResponse.clone();
      const headers = new Headers(responseToCache.headers);
      headers.set('X-Cache-Timestamp', Date.now().toString());
      const responseWithMeta = new Response(responseToCache.body, {
        status: responseToCache.status,
        statusText: responseToCache.statusText,
        headers
      });
      await cache.put(request, responseWithMeta);
      await enforceMaxEntries(cache, API_CACHE_CONFIG.maxEntries);
    }

    return networkResponse;
  } catch (error) {
    const cache = await caches.open(DYNAMIC_CACHE_NAME);
    const cachedResponse = await cache.match(request);

    if (cachedResponse) {
      const cachedTime = parseInt(cachedResponse.headers.get('X-Cache-Timestamp') || '0');
      if (Date.now() - cachedTime < API_CACHE_CONFIG.maxAgeMs) {
        console.log('[SW] Respuesta API desde cache:', request.url);
        return cachedResponse;
      }
      cache.delete(request);
    }

    return createOfflineApiResponse(request);
  }
}

async function networkFirstStrategy(request) {
  try {
    const networkResponse = await fetch(request);
    if (networkResponse.ok) {
      const cache = await caches.open(DYNAMIC_CACHE_NAME);
      cache.put(request, networkResponse.clone());
    }
    return networkResponse;
  } catch (error) {
    const cachedResponse = await caches.match(request);
    if (cachedResponse) return cachedResponse;

    if (request.mode === 'navigate') {
      return new Response('<h1>Offline</h1><p>Estás desconectado.</p>', {
        status: 200,
        headers: { 'Content-Type': 'text/html' }
      });
    }

    throw error;
  }
}

async function cacheFirstStrategy(request) {
  const cachedResponse = await caches.match(request);
  if (cachedResponse) return cachedResponse;

  try {
    const networkResponse = await fetch(request);
    if (networkResponse.ok) {
      const cache = await caches.open(STATIC_CACHE_NAME);
      cache.put(request, networkResponse.clone());
    }
    return networkResponse;
  } catch (error) {
    console.error('[SW] Error obteniendo recurso estático:', request.url, error);
    throw error;
  }
}

async function navigationStrategy(request) {
  try {
    const networkResponse = await fetch(request);
    if (networkResponse.ok) {
      const cache = await caches.open(DYNAMIC_CACHE_NAME);
      cache.put(request, networkResponse.clone());
      return networkResponse;
    }
    throw new Error('Respuesta de red no ok');
  } catch (error) {
    const cachedResponse = await caches.match('/index.html') || await caches.match('/');
    if (cachedResponse) return cachedResponse;

    return new Response(`
      <!DOCTYPE html>
      <html>
      <head>
        <title>Trade Marketing - Offline</title>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <style>
          body { font-family: Arial, sans-serif; text-align: center; padding: 50px; }
          .offline-icon { font-size: 48px; margin-bottom: 20px; }
          .message { color: #666; margin: 20px 0; }
          .btn { background: #1976d2; color: white; padding: 10px 20px; border: none; border-radius: 4px; cursor: pointer; }
        </style>
      </head>
      <body>
        <div class="offline-icon">📱</div>
        <h1>Modo Offline</h1>
        <p class="message">Estás desconectado de internet.</p>
        <p class="message">Puedes continuar usando la aplicación con los datos almacenados.</p>
        <p class="message">Los cambios se sincronizarán automáticamente cuando vuelvas a estar online.</p>
        <button class="btn" onclick="window.location.reload()">Reintentar</button>
      </body>
      </html>
    `, {
      status: 200,
      headers: { 'Content-Type': 'text/html' }
    });
  }
}

async function enforceMaxEntries(cache, maxEntries) {
  const requests = await cache.keys();
  if (requests.length <= maxEntries) return;

  const entries = await Promise.all(
    requests.map(async req => {
      const res = await cache.match(req);
      return {
        request: req,
        timestamp: parseInt(res?.headers.get('X-Cache-Timestamp') || '0')
      };
    })
  );

  entries.sort((a, b) => a.timestamp - b.timestamp);
  const toDelete = entries.slice(0, entries.length - maxEntries);
  await Promise.all(toDelete.map(entry => cache.delete(entry.request)));
}

function createOfflineApiResponse(request) {
  const url = new URL(request.url);

  if (url.pathname.includes('/visitas/sincronizar')) {
    return new Response(JSON.stringify({
      success: false,
      offline: true,
      message: 'Sin conexión. La visita se guardará localmente y se sincronizará cuando haya conexión.',
      queued: true
    }), {
      status: 503,
      headers: {
        'Content-Type': 'application/json',
        'X-Offline-Mode': 'true',
        'Retry-After': '60'
      }
    });
  }

  return new Response(JSON.stringify({
    success: false,
    offline: true,
    message: 'Sin conexión a internet. Intente más tarde.',
    data: []
  }), {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
      'X-Offline-Mode': 'true'
    }
  });
}

self.addEventListener('sync', event => {
  console.log('[SW] Evento de background sync:', event.tag);
  if (event.tag === 'sync-visitas') {
    event.waitUntil(syncVisitasPendientes());
  }
});

async function syncVisitasPendientes() {
  try {
    console.log('[SW] Iniciando sync de visitas en background...');
    const clients = await self.clients.matchAll();
    clients.forEach(client => {
      client.postMessage({ type: 'SYNC_STARTED', message: 'Iniciando sincronización en background...' });
    });
    await new Promise(resolve => setTimeout(resolve, 2000));
    clients.forEach(client => {
      client.postMessage({ type: 'SYNC_COMPLETED', message: 'Sincronización completada' });
    });
    console.log('[SW] Sync de visitas completado');
  } catch (error) {
    console.error('[SW] Error en sync de visitas:', error);
    const clients = await self.clients.matchAll();
    clients.forEach(client => {
      client.postMessage({ type: 'SYNC_ERROR', message: 'Error en sincronización', error: error.message });
    });
  }
}

self.addEventListener('push', event => {
  const options = {
    body: event.data ? event.data.text() : 'Nueva notificación',
    icon: '/assets/icons/icon-192x192.png',
    badge: '/assets/icons/icon-72x72.png',
    vibrate: [100, 50, 100],
    data: { dateOfArrival: Date.now(), primaryKey: 1 },
    actions: [
      { action: 'explore', title: 'Ver detalles', icon: '/assets/icons/icon-96x96.png' },
      { action: 'close', title: 'Cerrar', icon: '/assets/icons/icon-96x96.png' }
    ]
  };
  event.waitUntil(self.registration.showNotification('Trade Marketing', options));
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  if (event.action === 'explore') {
    event.waitUntil(clients.openWindow('/dashboard'));
  }
});

self.addEventListener('message', event => {
  if (event.data?.type === 'SKIP_WAITING') self.skipWaiting();
  if (event.data?.type === 'FORCE_SYNC') syncVisitasPendientes();
});

self.addEventListener('periodicsync', event => {
  if (event.tag === 'cleanup-cache') {
    event.waitUntil(cleanupCache());
  }
});

async function cleanupCache() {
  try {
    const cacheNames = await caches.keys();
    const oldCaches = cacheNames.filter(name =>
      name !== STATIC_CACHE_NAME && name !== DYNAMIC_CACHE_NAME
    );
    await Promise.all(oldCaches.map(name => caches.delete(name)));
    console.log('[SW] Limpieza de cache completada');
  } catch (error) {
    console.error('[SW] Error en limpieza de cache:', error);
  }
}
