// Detectar ambiente automáticamente
// - Local (localhost): conexión directa al backend
// - Producción (on-prem `md`, tras Caddy/nginx): ruta relativa /api

const isLocalDev = window.location.hostname === 'localhost';
/**
 * ⛔ `[CT.8]` Esto preguntaba **sólo** por `railway.app`. Producción se mudó a on-prem el
 * 2026-09-22 y se sirve desde `megadulcessuite.com`, así que desde ese día **la app principal
 * —la que usan los 75 usuarios activos— se declaraba `preview`, no `production`**.
 *
 * No es cosmético: `envName` viaja a la telemetría y al reporte de errores, así que todo lo que
 * esta app reportó desde el corte quedó rotulado como entorno de prueba — y lo que se lee como
 * prueba es lo que nadie mira. Es la misma familia que el resto de los hallazgos de hoy: algo
 * que responde, no falla, y dice lo que no es.
 *
 * `endsWith` y no `includes`: con `includes`, un host como `megadulcessuite.com.algo-ajeno.net`
 * se haría pasar por producción. Se conserva `railway.app` mientras quede algo sirviendo ahí.
 */
const isProduction =
  window.location.hostname.endsWith('megadulcessuite.com') ||
  window.location.hostname.includes('railway.app');

export const environment = {
  production: isProduction,
  apiUrl: isLocalDev ? 'http://localhost:3334/api' : '/api', // Conexión directa en local
  envName: isLocalDev ? 'local' : (isProduction ? 'production' : 'preview'),
  // Mapbox: token PÚBLICO (pk.) — seguro en el bundle por diseño. Restringir por
  // URL en el panel de Mapbox (Account → Tokens) para que nadie use tu cuota.
  // Sin token → el mapa cae a OpenStreetMap (no rompe dev).
  mapbox: {
    token: 'pk.eyJ1IjoiZWRnYXJjb3J0ZXMiLCJhIjoiY21xcXozZGZmMG83ajJxb3J3dm9peGV2MiJ9.TIuARDs-fthAXVg-NZxuOQ',
    // Estilos propios "Mercado" (Mapbox Studio, cuenta edgarcortes). Formato
    // 'usuario/styleId'. Validados HTTP 200 con el token público (styles:read).
    styleLight: 'edgarcortes/cmqra5rw4001201rzf98pcd00', // "Streets" (tema claro)
    styleDark: 'edgarcortes/cmqra591r001101rzdop23b4i', // "Dark 2D" (tema oscuro)
    styleSatellite: 'mapbox/satellite-streets-v12',
  },
  // PrimeUI: license key de cliente (tier community/dev) para PrimeNG 22+.
  // Va al bundle por diseño (se verifica client-side). PrimeNG <=21 es MIT y la
  // ignora; recién con primeng@22 se pasa a providePrimeNG({ license }) para
  // silenciar el banner "invalid primeui license" (solo aparece en prod).
  primeui: {
    license: 'eyJpZCI6ImZiNDJlODllLTU1MDktNGExYy1iNjM3LTg1MmI3MDkwMmY4ZSIsInByb2R1Y3QiOiJwcmltZXVpIiwidGllciI6ImNvbW11bml0eSIsInR5cGUiOiJkZXYiLCJpYXQiOjE3ODUzNjQxMDIsImV4cCI6MTgxNjkwMDEwMn0.7e5-4WbCFb7qYfs15Y4P471RfDf0mNqncOetfI_JwmQLHfpfYTINngD9SsYybbdvNj9kfCXHfjZQkcim1VUnBQ',
  },
};

// Debug logging
console.log('[Environment] Debug info:', {
  hostname: window.location.hostname,
  port: window.location.port,
  isLocalDev,
  isProduction,
  apiUrl: environment.apiUrl,
  envName: environment.envName
});
