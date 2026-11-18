import { defineConfig, devices } from '@playwright/test';

/**
 * `[PGP.122]` La solicitud de gasto recorrida DESDE LA INTERFAZ: pedir → firmar (se escribe en Kepler) →
 * cancelar en Kepler (F3), con el frontend que sirve PRODUCCIÓN y una API SINTÉTICA.
 *
 * ⛔ Ninguna petición a la API sale del navegador: `api-sintetica.ts` contesta TODO lo de `/api/**` con datos
 * inventados (el repo es público) y aborta el socket. Ni prod ni el backend local (regla 3) ven esta prueba, y
 * Kepler tampoco: la escritura real es el canario de Zamora Centro (anexo §16.3), no esto.
 *
 *   npx playwright test -c e2e/solicitud-gasto/playwright.config.ts
 *   E2E_BASE_URL=http://localhost:4200 npx playwright test -c e2e/solicitud-gasto/playwright.config.ts   (frontend de este árbol)
 */
export default defineConfig({
  testDir: __dirname,
  testMatch: /.*\.e2e\.ts$/,
  outputDir: `${__dirname}/.resultados/trazas`,
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: 0,
  timeout: 120_000,
  reporter: [['list']],
  use: {
    ...devices['Desktop Chrome'],
    baseURL: process.env.E2E_BASE_URL || 'https://megadulcessuite.com',
    viewport: { width: 1366, height: 768 },
    trace: 'retain-on-failure',
    // ⛔ Sin esto lo que atiende el service worker (ngsw) no pasa por page.route y una escritura puede salir a prod.
    serviceWorkers: 'block',
  },
  projects: [{ name: 'chromium' }],
});
