const CACHE_NAME = 'trademarketing-offline-v1';
const STATIC_CACHE_NAME = 'trademarketing-static-v1';
const DYNAMIC_CACHE_NAME = 'trademarketing-dynamic-v1';

const URLs_TO_CACHE = [
  '/',
  '/index.html',
  '/assets/manifest.webmanifest',
  '/assets/icons/icon-192x192.png',
  '/assets/icons/icon-512x512.png',
  '/assets/icons/icon-144x144.png',
  '/assets/icons/icon-152x152.png',
  '/assets/icons/icon-72x72.png'
];

const API_ENDPOINTS = [
  '/api/catalogs/conceptos',
  '/api/catalogs/ubicaciones', 
  '/api/catalogs/niveles',
  '/api/planograms/brands',
  '/api/scoring/config',
  '/api/visitas/sincronizar'
];

// Instalación del Service Worker
self.addEventListener('install', event => {
  console.log('[SW] Instalando Service Worker...');
  
  event.waitUntil(
    caches.open(STATIC_CACHE_NAME)
      .then(cache => {
        console.log('[SW] Cacheando archivos estáticos');
        return cache.addAll(URLs_TO_CACHE);
      })
      .then(() => {
        console.log('[SW] Instalación completada');
        return self.skipWaiting();
      })
      .catch(error => {
        console.error('[SW] Error durante instalación:', error);
      })
  );
});

// Activación del Service Worker
self.addEventListener('activate', event => {
  console.log('[SW] Activando Service Worker...');
  
  event.waitUntil(
    caches.keys()
      .then(cacheNames => {
        return Promise.all(
          cacheNames.map(cacheName => {
            if (cacheName !== STATIC_CACHE_NAME && 
                cacheName !== DYNAMIC_CACHE_NAME && 
                cacheName !== CACHE_NAME) {
              console.log('[SW] Eliminando cache antiguo:', cacheName);
              return caches.delete(cacheName);
            }
          })
        );
      })
      .then(() => {
        console.log('[SW] Activación completada');
        return self.clients.claim();
      })
  );
});

// Estrategia de cache: Network First para API, Cache First para estáticos
self.addEventListener('fetch', event => {
  const { request } = event;
  const url = new URL(request.url);

  // Estrategia para endpoints de API
  if (API_ENDPOINTS.some(endpoint => url.pathname.includes(endpoint))) {
    event.respondWith(networkFirstStrategy(request));
    return;
  }

  // Estrategia para archivos estáticos
  if (request.destination === 'script' || 
      request.destination === 'style' || 
      request.destination === 'image' ||
      request.destination === 'manifest') {
    event.respondWith(cacheFirstStrategy(request));
    return;
  }

  // Estrategia para navegación (HTML)
  if (request.mode === 'navigate') {
    event.respondWith(navigationStrategy(request));
    return;
  }

  // Por defecto, intentar red pero fallback a cache
  event.respondWith(networkFirstStrategy(request));
});

// Network First Strategy (para APIs)
async function networkFirstStrategy(request) {
  try {
    console.log('[SW] Intentando red:', request.url);
    
    const networkResponse = await fetch(request);
    
    if (networkResponse.ok) {
      // Cachear respuesta exitosa
      const cache = await caches.open(DYNAMIC_CACHE_NAME);
      cache.put(request, networkResponse.clone());
      console.log('[SW] Respuesta cacheada desde red:', request.url);
    }
    
    return networkResponse;
    
  } catch (error) {
    console.log('[SW] Red falló, intentando cache:', request.url);
    
    const cachedResponse = await caches.match(request);
    
    if (cachedResponse) {
      console.log('[SW] Respuesta desde cache:', request.url);
      return cachedResponse;
    }
    
    // Para peticiones API, devolver respuesta personalizada offline
    if (API_ENDPOINTS.some(endpoint => new URL(request.url).pathname.includes(endpoint))) {
      console.log('[SW] Generando respuesta offline para API:', request.url);
      return createOfflineApiResponse(request);
    }
    
    // Para navegación, devolver página offline
    if (request.mode === 'navigate') {
      return new Response('<h1>Offline</h1><p>Estás desconectado. Los datos se sincronizarán cuando vuelvas a estar online.</p>', {
        status: 200,
        headers: { 'Content-Type': 'text/html' }
      });
    }
    
    throw error;
  }
}

// Cache First Strategy (para estáticos)
async function cacheFirstStrategy(request) {
  const cachedResponse = await caches.match(request);
  
  if (cachedResponse) {
    console.log('[SW] Sirviendo desde cache (estático):', request.url);
    return cachedResponse;
  }
  
  try {
    console.log('[SW] Cache miss, obteniendo desde red:', request.url);
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

// Navigation Strategy (para HTML)
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
    console.log('[SW] Navegación offline, sirviendo index.html');
    const cachedResponse = await caches.match('/index.html') || 
                          await caches.match('/');
    
    if (cachedResponse) {
      return cachedResponse;
    }
    
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

// Crear respuesta offline para APIs
function createOfflineApiResponse(request) {
  const url = new URL(request.url);
  
  // Respuestas específicas según el endpoint
  if (url.pathname.includes('/catalogs/')) {
    const catalogType = url.pathname.split('/').pop();
    return new Response(JSON.stringify({
      success: false,
      offline: true,
      message: `Datos de ${catalogType} no disponibles offline. Usa los datos cacheados.`,
      data: []
    }), {
      status: 200,
      headers: { 
        'Content-Type': 'application/json',
        'X-Offline-Mode': 'true'
      }
    });
  }
  
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
  
  // Respuesta genérica offline
  return new Response(JSON.stringify({
    success: false,
    offline: true,
    message: 'Sin conexión a internet. Intente más tarde.'
  }), {
    status: 503,
    headers: { 
      'Content-Type': 'application/json',
      'X-Offline-Mode': 'true'
    }
  });
}

// Background Sync
self.addEventListener('sync', event => {
  console.log('[SW] Evento de background sync:', event.tag);
  
  if (event.tag === 'sync-visitas') {
    event.waitUntil(syncVisitasPendientes());
  }
});

// Sincronizar visitas pendientes en background
async function syncVisitasPendientes() {
  try {
    console.log('[SW] Iniciando sync de visitas en background...');
    
    // Notificar a todos los clientes que inició la sincronización
    const clients = await self.clients.matchAll();
    clients.forEach(client => {
      client.postMessage({
        type: 'SYNC_STARTED',
        message: 'Iniciando sincronización en background...'
      });
    });
    
    // Aquí iría la lógica de sincronización real
    // Por ahora simulamos una espera
    await new Promise(resolve => setTimeout(resolve, 2000));
    
    // Notificar que la sincronización completó
    clients.forEach(client => {
      client.postMessage({
        type: 'SYNC_COMPLETED',
        message: 'Sincronización completada'
      });
    });
    
    console.log('[SW] Sync de visitas completado');
    
  } catch (error) {
    console.error('[SW] Error en sync de visitas:', error);
    
    // Notificar error
    const clients = await self.clients.matchAll();
    clients.forEach(client => {
      client.postMessage({
        type: 'SYNC_ERROR',
        message: 'Error en sincronización',
        error: error.message
      });
    });
  }
}

// Push Notifications (futuro)
self.addEventListener('push', event => {
  console.log('[SW] Evento push recibido:', event);
  
  const options = {
    body: event.data ? event.data.text() : 'Nueva notificación',
    icon: '/assets/icons/icon-192x192.png',
    badge: '/assets/icons/icon-72x72.png',
    vibrate: [100, 50, 100],
    data: {
      dateOfArrival: Date.now(),
      primaryKey: 1
    },
    actions: [
      {
        action: 'explore',
        title: 'Ver detalles',
        icon: '/assets/icons/icon-96x96.png'
      },
      {
        action: 'close',
        title: 'Cerrar',
        icon: '/assets/icons/icon-96x96.png'
      }
    ]
  };
  
  event.waitUntil(
    self.registration.showNotification('Trade Marketing', options)
  );
});

// Manejo de clic en notificaciones
self.addEventListener('notificationclick', event => {
  console.log('[SW] Notificación clickeada:', event.notification.data);
  
  event.notification.close();
  
  if (event.action === 'explore') {
    event.waitUntil(
      clients.openWindow('/dashboard')
    );
  }
});

// Manejo de mensajes desde la app
self.addEventListener('message', event => {
  console.log('[SW] Mensaje recibido:', event.data);
  
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
  
  if (event.data && event.data.type === 'FORCE_SYNC') {
    // Forzar sincronización inmediata
    syncVisitasPendientes();
  }
});

// Limpieza periódica de cache
self.addEventListener('periodicsync', event => {
  console.log('[SW] Sync periódico:', event.tag);
  
  if (event.tag === 'cleanup-cache') {
    event.waitUntil(cleanupCache());
  }
});

// Limpiar cache antiguo
async function cleanupCache() {
  try {
    const cacheNames = await caches.keys();
    const oldCaches = cacheNames.filter(name => 
      name !== STATIC_CACHE_NAME && 
      name !== DYNAMIC_CACHE_NAME
    );
    
    await Promise.all(
      oldCaches.map(name => {
        console.log('[SW] Eliminando cache antiguo:', name);
        return caches.delete(name);
      })
    );
    
    console.log('[SW] Limpieza de cache completada');
    
  } catch (error) {
    console.error('[SW] Error en limpieza de cache:', error);
  }
}
