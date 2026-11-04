import { defineConfig, devices } from '@playwright/test';

/**
 * `[RD.103.5]` — e2e del tabulador por familia y del alta en «Quién cobra», contra PRODUCCIÓN,
 * con navegador real.
 *
 * ⚠️ Corre contra prod a propósito (regla 3 de CLAUDE.md: nada de levantar el backend local), y
 * por eso es **de sólo lectura**: estrenar una versión del tabulador CIERRA la vigente y dar de
 * alta una ruta la pone a cobrar, así que esos dos `POST` se interceptan en el navegador y se
 * verifica el cuerpo que la pantalla manda — nunca llegan al servidor. Cualquier otra escritura
 * se aborta y hace fallar la prueba (red de seguridad en `tabulador-vecinal.e2e.ts`).
 *
 * Sesión: `MD_TOKEN_FILE` = ruta a un archivo con el JWT de un usuario con
 * `COMMERCIAL_COMMISSIONS_GESTIONAR` (sin él, las pruebas que editan salen NO MEDIDO). Nunca va
 * en el repo ni en una variable impresa.
 *
 *   MD_TOKEN_FILE=<ruta> npx playwright test -c e2e/comisiones/playwright.config.ts
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
    baseURL: process.env.E2E_BASE_URL || 'https://megadulcessuite.com',
    viewport: { width: 1366, height: 768 },
    trace: 'retain-on-failure',
  },
  projects: [{ name: 'chromium' }],
});
