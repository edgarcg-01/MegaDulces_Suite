// Ambiente DEV (default para `ng serve`).
// En build de producción (`build:prod`) Angular reemplaza este archivo por
// environment.prod.ts vía `fileReplacements` en angular.json — así el flag
// `production` se resuelve en BUILD-TIME, no adivinando por hostname en runtime
// (lo anterior rompía en dominios custom como pedidos.megadulces.com, donde
// Angular terminaba corriendo en modo dev en producción).
export const environment = {
  production: false,
  apiUrl: 'http://localhost:3334/api', // backend local directo
  envName: 'local' as 'local' | 'preview' | 'production',
  release: 'portal@1.0.0',
  telemetry: { sampleRate: 1 }, // 1 = 100% de sesiones en dev
};
