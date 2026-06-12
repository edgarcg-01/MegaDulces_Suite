// Ambiente PRODUCCIÓN (y preview de Railway). Inyectado en build-time vía
// `fileReplacements` en angular.json cuando se compila con --configuration=production.
// apiUrl relativo: nginx del contenedor proxya /api → $API_UPSTREAM (mismo origen,
// sin CORS). Válido tanto en *.up.railway.app como en dominios custom.
export const environment = {
  production: true,
  apiUrl: '/api',
  envName: 'production' as 'local' | 'preview' | 'production',
  release: 'portal@1.0.0',
  telemetry: { sampleRate: 1 }, // bajar a 0.2–0.5 si el volumen crece
};
