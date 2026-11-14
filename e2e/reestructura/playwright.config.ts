import { defineConfig, devices } from '@playwright/test';

/**
 * `[GP.RF]` Auditoría de interfaces de la Fase GP, paso por paso, con navegador real.
 * El registro vive en `docs/IMPLEMENTACION/FASES/FASE_GP_AUDITORIA_INTERFACES.md`.
 *
 * ⚠️ Corre contra PRODUCCIÓN (regla 3 de CLAUDE.md: nada de levantar el backend local) y es de
 * **SÓLO LECTURA**: toda petición a la API que no sea GET se aborta en el navegador, incluida la
 * telemetría de uso (la auditoría no debe contarse como uso). El blindaje tiene su propia prueba.
 *
 * Sesión: `MD_TOKEN_FILE` = ruta a un archivo con el JWT de un usuario (el `auth_token` de su
 * navegador). Nunca va en el repo ni en una variable impresa. Sin él, el recorrido sale NO MEDIDO
 * y sólo corren el control del instrumento y el blindaje.
 *
 *   npx playwright test -c e2e/reestructura/playwright.config.ts
 *   MD_TOKEN_FILE=<ruta> npx playwright test -c e2e/reestructura/playwright.config.ts
 */
export default defineConfig({
  testDir: __dirname,
  testMatch: /.*\.e2e\.ts$/,
  outputDir: `${__dirname}/.resultados/trazas`,
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: 0,
  timeout: 90_000,
  reporter: [['list']],
  use: {
    ...devices['Desktop Chrome'],
    baseURL: process.env.E2E_BASE_URL || 'https://megadulcessuite.com',
    // El piso de una laptop de oficina (mismo supuesto que e2e/ventanilla: NO medido en la flota).
    viewport: { width: 1366, height: 768 },
    trace: 'retain-on-failure',
    // ⛔ Sin esto lo que atiende el service worker (ngsw) no pasa por page.route y una escritura
    // puede salir a prod (medido el 2026-11-04 en e2e/comisiones).
    serviceWorkers: 'block',
  },
  projects: [{ name: 'chromium' }],
});
