import { Capacitor } from '@capacitor/core';

// Resolución de API por plataforma:
// - Nativo (Capacitor/Android): el WebView sirve desde http://localhost, así que
//   NO hay nginx ni ruta relativa; debe apuntar a la URL absoluta del backend.
// - Web local (localhost): conexión directa al backend de dev.
// - Web prod (Railway/nginx): ruta relativa /api (mismo origen, sin CORS).

const NATIVE_API_URL = 'https://trademarketing-production-5084.up.railway.app/api';

const isNative = Capacitor.isNativePlatform();
const isLocalDev = !isNative && window.location.hostname === 'localhost';
const isProduction =
  isNative ||
  window.location.hostname.includes('railway.app') ||
  window.location.hostname.includes('up.railway.app');

export const environment = {
  production: isProduction,
  apiUrl: isNative ? NATIVE_API_URL : isLocalDev ? 'http://localhost:3334/api' : '/api',
  envName: isNative ? 'native' : isLocalDev ? 'local' : isProduction ? 'production' : 'preview',
  // Token PÚBLICO de Mapbox (pk.) — seguro en el bundle; restringido por URL en el panel.
  // Se usa solo para la imagen estática de la ruta del repartidor (Static Images API).
  mapbox: {
    token:
      'pk.eyJ1IjoiZWRnYXJjb3J0ZXMiLCJhIjoiY21xcXozZGZmMG83ajJxb3J3dm9peGV2MiJ9.TIuARDs-fthAXVg-NZxuOQ',
  },
};

console.log('[Environment] Debug info:', {
  platform: Capacitor.getPlatform(),
  isNative,
  isLocalDev,
  isProduction,
  apiUrl: environment.apiUrl,
  envName: environment.envName,
});
