// Detectar ambiente automáticamente
// - Local (localhost:4200): usa proxy Nx (/api -> localhost:3334)
// - Browser Preview (127.0.0.1:xxxx): usa URL de Railway directamente
// - Producción (Railway): se configura manualmente en el build

const isLocalDev = window.location.hostname === 'localhost' && window.location.port === '4200';
const RAILWAY_API_URL = 'https://glorious-potato-5g4jxjw6vxj2vvrx-3334.app.github.dev/api'; // Cambiar por tu URL de Railway

export const environment = {
  production: false,
  apiUrl: isLocalDev ? '/api' : RAILWAY_API_URL,
  envName: isLocalDev ? 'local' : 'preview'
};
