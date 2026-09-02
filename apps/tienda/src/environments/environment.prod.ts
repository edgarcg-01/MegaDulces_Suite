// Ambiente PRODUCCIÓN. catalogo-kp sirve este build estático y su API desde
// el mismo proceso NestJS (apps/catalogo-kp/src/main.ts) — mismo origen,
// sin CORS nuevo, sin exposición pública nueva (ver FASE_CV, principio P1).
export const environment = {
  production: true,
  apiUrl: '/api',
};
