import { defineConfig, devices } from '@playwright/test';

/**
 * `[LC.18.3]` — e2e de «Movimientos no asociados» contra PRODUCCIÓN, con navegador real.
 *
 * ⚠️ Corre contra prod a propósito: la pantalla sólo tiene sentido con los CFDI, las pólizas de
 * ContPAQi y el histórico del libro reales, y no hay un entorno que los tenga (regla 3 de
 * CLAUDE.md: nada de levantar el backend local). Por eso el default es **sólo lectura**; lo que
 * escribe se pide explícito con `E2E_ESCRIBIR=1` y sólo toca el mes `E2E_MES_ESCRITURA`.
 *
 * Sesión: `MD_TOKEN_FILE` = ruta a un archivo con el JWT de un usuario con
 * `FISCAL_PURCHASE_BOOK_GESTIONAR`. Nunca va en el repo ni en una variable impresa.
 *
 *   MD_TOKEN_FILE=<ruta> npx playwright test -c e2e/libro-compras/playwright.config.ts
 *   E2E_ESCRIBIR=1 MD_TOKEN_FILE=<ruta> npx playwright test -c e2e/libro-compras/playwright.config.ts
 */
export default defineConfig({
  testDir: __dirname,
  testMatch: /.*\.e2e\.ts$/,
  outputDir: `${__dirname}/.resultados`,
  // En serie: el bloque que escribe mueve el trámite de un mes y los de lectura lo miran.
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: 0,
  timeout: 60_000,
  reporter: [['list']],
  use: {
    ...devices['Desktop Chrome'],
    baseURL: process.env.E2E_BASE_URL || 'https://megadulcessuite.com',
    viewport: { width: 1366, height: 768 },
    trace: 'retain-on-failure',
  },
  projects: [{ name: 'chromium' }],
});
