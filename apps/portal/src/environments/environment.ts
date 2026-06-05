// Detectar ambiente automáticamente
// - Local (localhost): conexión directa al backend
// - Producción (Railway u otro): usa ruta relativa /api (Nginx hace proxy)

const isLocalDev = window.location.hostname === 'localhost';
const isProduction = window.location.hostname.includes('railway.app') || window.location.hostname.includes('up.railway.app');

export const environment = {
  production: isProduction,
  apiUrl: isLocalDev ? 'http://localhost:3334/api' : '/api', // Conexión directa en local
  envName: isLocalDev ? 'local' : (isProduction ? 'production' : 'preview')
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
