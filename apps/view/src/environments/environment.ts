// Detectar ambiente automáticamente
// - Local (localhost): conexión directa al backend
// - Producción (Railway u otro): usa ruta relativa /api (Nginx hace proxy)

const isLocalDev = window.location.hostname === 'localhost';
const isProduction = window.location.hostname.includes('railway.app') || window.location.hostname.includes('up.railway.app');

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
