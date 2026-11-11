import { defineConfig, devices } from '@playwright/test';

/**
 * Anexo CE de la Fase WMS — el proceso de **entrada con caducidad**, recorrido en un navegador real
 * contra PRODUCCIÓN (`docs/IMPLEMENTACION/FASES/FASE_WMS_ANEXO_CADUCIDAD_EN_ENTRADA.md`).
 *
 * ⚠️ Corre contra prod a propósito (regla 3 de CLAUDE.md: nada de levantar el backend local), y por eso
 * es **de sólo lectura**: toda escritura (POST/PATCH/PUT/DELETE) se aborta en el navegador y hace fallar
 * la prueba. No abre vales ni captura fechas: eso escribe existencia.
 *
 * Sirve dos veces: HOY retrata el proceso como está (el «antes») y, desplegado el anexo, verifica el
 * «después». Cada recorrido deja su captura en `.resultados/capturas/` para revisarla a ojo.
 *
 * Sesión: `MD_TOKEN_FILE` = ruta a un archivo con el JWT de un usuario real (ideal: un almacenista, para
 * ver lo que él ve). Sin él, todo sale NO MEDIDO. Nunca va en el repo ni en una variable impresa.
 *
 *   MD_TOKEN_FILE=<ruta> npx playwright test -c e2e/anden-caducidad/playwright.config.ts
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
    ...devices['Desktop Chrome'],
    baseURL: process.env.E2E_BASE_URL || 'https://megadulcessuite.com',
    viewport: { width: 1366, height: 768 },
    trace: 'retain-on-failure',
    // ⛔⛔ Lo que pasa por el service worker (ngsw) NO lo ve `page.route`: sin esto la red de seguridad
    // tiene un agujero (medido el 2026-11-04 en la suite de comisiones: un POST salió a prod).
    serviceWorkers: 'block',
  },
  projects: [{ name: 'chromium' }],
});
