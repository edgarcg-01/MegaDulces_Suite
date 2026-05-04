// Detectar ambiente automáticamente
// - Local (localhost:4204): usa proxy Nx (/api -> localhost:3334)
// - Producción (Railway): usa ruta relativa /api (Nginx hace proxy)

const isLocalDev = window.location.hostname === 'localhost' && window.location.port === '4204';
const isProduction = window.location.hostname.includes('railway.app') || window.location.hostname.includes('up.railway.app');

export const environment = {
  production: isProduction,
  apiUrl: isLocalDev ? '/api' : '/api', // En Railway Nginx hace proxy a la API
  envName: isLocalDev ? 'local' : (isProduction ? 'production' : 'preview')
};
