import { defineConfig, devices } from '@playwright/test';

/**
 * `[CC.20.1]`–`[CC.20.2]` El enlace del cliente y el botón de Cartera en un navegador real, contra el front LOCAL.
 *
 * ── Correr ──────────────────────────────────────────────────────────────────
 *   npx playwright test -c e2e/deposito-cliente/playwright.config.ts
 *   (`E2E_BASE_URL` apunta a otro front; por omisión `http://localhost:4200`)
 *
 * ⛔ La API va SIMULADA ENTERA en el navegador (`page.route('**\/api/**')`): lo que la prueba no contesta se aborta y
 * se reclama en `afterEach`, y `serviceWorkers: 'block'` porque `page.route` no ve lo que pasa por el service worker.
 * El backend local apunta a PRODUCCIÓN: ningún byte sale de la página.
 *
 * Dos aparatos: el celular del cliente (la página pública) y la computadora de Cobranza (Cartera).
 */
export default defineConfig({
  testDir: __dirname,
  testMatch: /.*\.e2e\.ts$/,
  outputDir: `${__dirname}/.resultados`,
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: 0,
  timeout: 90_000,
  reporter: [['list']],
  use: {
    baseURL: process.env.E2E_BASE_URL || 'http://localhost:4200',
    trace: 'retain-on-failure',
    serviceWorkers: 'block',
  },
  projects: [
    { name: 'celular', testMatch: /cliente\.e2e\.ts$/, use: { ...devices['Pixel 7'], serviceWorkers: 'block' } },
    { name: 'cobranza', testMatch: /cartera\.e2e\.ts$/, use: { ...devices['Desktop Chrome'], viewport: { width: 1366, height: 768 }, serviceWorkers: 'block' } },
  ],
});
