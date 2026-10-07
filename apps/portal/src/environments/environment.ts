// Ambiente DEV (default para `ng serve`).
// En build de producción Angular reemplaza este archivo por environment.prod.ts
// vía `fileReplacements` en apps/portal/project.json (config `production`) — así
// el flag `production` se resuelve en BUILD-TIME, no adivinando por hostname.
// ⚠️ Hasta 2026-06-25 NO había fileReplacements → prod shippeaba este archivo
// (production:false + apiUrl localhost) → SW inerte y API rota. Ya corregido.
export const environment = {
  production: false,
  // apiUrl RELATIVO también en dev: el dev-server proxya `/api` y el WebSocket al
  // backend (ver apps/portal/proxy.conf.json) → mismo origen que prod → CERO CORS
  // en local. Antes era 'http://localhost:3334/api' (absoluto) → toda request era
  // cross-origin y chocaba con el `origin:'*' + credentials:true` del backend.
  apiUrl: '/api',
  envName: 'local' as 'local' | 'preview' | 'production',
  release: 'portal@1.0.0',
  telemetry: { sampleRate: 1 }, // 1 = 100% de sesiones en dev
};
