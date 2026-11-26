import { defineConfig, devices } from '@playwright/test';

/**
 * `[CB.62.4]` Comisiones de la terminal → Kepler, medido **contra PRODUCCIÓN** y de sólo lectura.
 *
 * ⛔ A diferencia de `e2e/solicitud-gasto` (API sintética), esta prueba mira **el dato real**: la pantalla que
 * la gente abre y el escritor que ya está desplegado. Por eso:
 *
 *   - la página queda **blindada**: ninguna petición que no sea `GET` sale del navegador;
 *   - la única escritura posible —`POST …/comisiones-kepler/generar`— **no la hace la página**: la hace el
 *     runner, a propósito, visible en el código, y sólo con `E2E_ESCRIBE_GENERAR=1`. Sin esa bandera la
 *     prueba la declara NO MEDIDA en vez de dibujarla en verde;
 *   - no hay credenciales acá: la sesión la abre una PERSONA con `e2e/reestructura/iniciar-sesion.js`, que
 *     guarda el token **fuera del repo** (el repo es público).
 *
 *   node e2e/reestructura/iniciar-sesion.js "$HOME/.md-token"
 *   MD_TOKEN_FILE="$HOME/.md-token" npx playwright test -c e2e/comisiones-kepler/playwright.config.ts
 *
 * Control negativo (regla 12), que debe salir ROJO:
 *   MD_TOKEN_FILE=… E2E_MUTANTE=esconde npx playwright test -c e2e/comisiones-kepler/playwright.config.ts
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
    // Con VENTANA por default, para verla a ojo (E2E_SIN_VENTANA=1 o CI la esconden).
    headless: !!process.env.CI || process.env.E2E_SIN_VENTANA === '1',
    launchOptions: { slowMo: Number(process.env.E2E_LENTO) || 0 },
    // ⛔ Sin esto lo que atiende el service worker (ngsw) no pasa por page.route y el blindaje no existe.
    serviceWorkers: 'block',
    locale: 'es-MX',
    timezoneId: 'America/Mexico_City',
  },
  projects: [{ name: 'chromium' }],
});
