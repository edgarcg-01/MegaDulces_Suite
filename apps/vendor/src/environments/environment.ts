import { Capacitor } from '@capacitor/core';

// Resolución de API por plataforma:
// - Nativo (Capacitor/Android): el WebView sirve desde http://localhost, así que
//   NO hay nginx ni ruta relativa; debe apuntar a la URL absoluta del backend.
// - Web local (localhost): conexión directa al backend de dev.
// - Web prod (nginx del contenedor): ruta relativa /api (mismo origen, sin CORS).

/**
 * ⛔ `[CT.8]` Esto decía `https://trademarketing-production-5084.up.railway.app/api`.
 *
 * **Producción se mudó a on-prem el 2026-09-22 y Railway dejó de ser producción**, así que
 * cualquier APK que se compilara desde este archivo salía hablándole a un backend que ya no es
 * el bueno. Hoy no cobró —medido el 2026-09-24: **0 sesiones con `Capacitor` y 0 con WebView**
 * en 60 días; los 18 accesos desde Android son Chrome y Samsung Browser, o sea la web— pero es
 * una bomba de tiempo: se dispara sola el día que alguien reconstruya el APK.
 *
 * ⚠️ Y el error de medición vale la pena dejarlo escrito: la primera consulta contó
 * `user_agent ILIKE '%android%'` y dio **18 supuestos usuarios nativos**. Chrome móvil también
 * dice `Android`. Lo que distingue a la app nativa es `Capacitor` o el marcador `; wv)` de
 * WebView — los dos en **cero**.
 *
 * La URL nueva está verificada contra el Caddy de `md`: `/api/health` responde **200**.
 */
const NATIVE_API_URL = 'https://vendedor.megadulcessuite.com/api';

const isNative = Capacitor.isNativePlatform();
const isLocalDev = !isNative && window.location.hostname === 'localhost';
/**
 * ⛔ `[CT.8]` El segundo defecto del mismo archivo, más callado que el primero: esto preguntaba
 * **sólo** por `railway.app`, así que servido desde `megadulcessuite.com` la app se declaraba
 * `preview` en vez de `production` — y `envName` viaja a la telemetría y a los reportes de error.
 * O sea que desde el corte, todo lo que reportaba esta app venía rotulado como entorno de prueba.
 */
const isProduction =
  isNative ||
  window.location.hostname.endsWith('megadulcessuite.com') ||
  window.location.hostname.includes('railway.app');

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
