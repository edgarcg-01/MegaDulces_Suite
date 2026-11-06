import { defineConfig, devices } from '@playwright/test';

/**
 * `[LE.6.19]` Caja General › Reposición en un navegador real, contra el front LOCAL.
 *
 * ── Correr ──────────────────────────────────────────────────────────────────
 *   npx playwright test -c e2e/caja-reposicion/playwright.config.ts
 *   (`E2E_BASE_URL` apunta a otro front; por omisión `http://localhost:4200`)
 *
 * ⛔ La API va SIMULADA ENTERA en el navegador (`page.route('**\/api/**')`). El backend local
 * de `:3334` se conecta con el `.env`, y `DATABASE_URL_NEW` apunta a PRODUCCIÓN: una petición
 * que se cuele escribe en prod. Por eso ninguna sale de la página — lo que la prueba no
 * contesta se aborta y se reclama en `afterEach` — y `serviceWorkers: 'block'`, porque
 * `page.route` no ve lo que pasa por el service worker (se coló un POST a prod el 2026-11-04).
 *
 * Lo que esto prueba: la pantalla real (el bundle de `nx serve`, con el árbol de hoy) contra
 * el contrato de `HojasDeGastos`. Lo que NO prueba: el endpoint — eso es la regla 13, contra
 * una base real, no aquí.
 */
export default defineConfig({
  testDir: __dirname,
  testMatch: /.*\.e2e\.ts$/,
  outputDir: `${__dirname}/.resultados`,
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: 0,
  timeout: 60_000,
  reporter: [['list']],
  use: {
    ...devices['Desktop Chrome'],
    baseURL: process.env.E2E_BASE_URL || 'http://localhost:4200',
    viewport: { width: 1366, height: 768 },
    trace: 'retain-on-failure',
    serviceWorkers: 'block',
  },
  projects: [{ name: 'chromium' }],
});
