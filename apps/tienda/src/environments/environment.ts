// Ambiente DEV (default para `ng serve`). Reemplazado por environment.prod.ts
// en build de producción vía `fileReplacements` (apps/tienda/project.json).
//
// apiUrl relativo también en dev: el dev-server proxya `/api` al backend real
// de catalogo-kp (ver apps/tienda/proxy.conf.json) — mismo origen que en
// producción (donde catalogo-kp sirve este app y su API desde el mismo
// proceso), cero CORS.
export const environment = {
  production: false,
  apiUrl: '/api',
};
