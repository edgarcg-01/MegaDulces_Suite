import { defineConfig, devices } from '@playwright/test';

/**
 * `[CP.8.97]` — e2e de la entrega con el dictamen (`/contabilidad/contpaqi-puente`, paso 4) contra PRODUCCIÓN,
 * con navegador real.
 *
 * ⚠️ Corre contra prod a propósito, como `e2e/libro-compras`: el dictamen sólo dice algo con el catálogo de
 * ContPAQi, los CFDI y las pólizas que contabilidad ya capturó, y no hay un entorno que los tenga (regla 3 de
 * CLAUDE.md: nada de levantar el front ni el back en local). Es **sólo lectura**: toda petición a la API que no
 * sea GET se aborta y la prueba sale roja (la descarga del archivo es GET y no registra nada).
 *
 * Sesión: `MD_TOKEN_FILE` = ruta a un archivo con el JWT de un usuario con `FISCAL_CONTPAQI_BRIDGE_VER` (con
 * `_GESTIONAR` además corre la prueba de la descarga). Nunca va en el repo ni en una variable impresa.
 *
 *   MD_TOKEN_FILE=<ruta> npx playwright test -c e2e/contpaqi-puente/playwright.config.ts
 *   E2E_MES=2026-09 MD_TOKEN_FILE=<ruta> npx playwright test -c e2e/contpaqi-puente/playwright.config.ts
 *
 * ⬜ Sin cablear a Nx ni al CI, igual que las otras dos suites: el primer target `e2e` lo decide Edgar.
 */
export default defineConfig({
  testDir: __dirname,
  testMatch: /.*\.e2e\.ts$/,
  outputDir: `${__dirname}/.resultados`,
  // En serie y con un trabajador: el dictamen tarda segundos y se pide UNA vez para toda la suite.
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: 0,
  timeout: 90_000,
  reporter: [['list']],
  use: {
    ...devices['Desktop Chrome'],
    baseURL: process.env.E2E_BASE_URL || 'https://megadulcessuite.com',
    viewport: { width: 1366, height: 768 },
    trace: 'retain-on-failure',
    acceptDownloads: true,
  },
  projects: [{ name: 'chromium' }],
});
