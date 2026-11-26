import { defineConfig, devices } from '@playwright/test';

/**
 * Suite e2e de **Inventario físico**, contra el componente REAL.
 *
 * ── Correr ──────────────────────────────────────────────────────────────────
 *   npx playwright test -c e2e/inventario-fisico/playwright.config.ts
 *
 * ── ⛔ Contra qué apunta, y por qué es seguro ───────────────────────────────
 * Apunta al **bundle estático de producción** (`http://192.168.0.222:30080`), que es público —
 * cualquier navegador que abre la suite lo descarga— y **simula TODAS las llamadas a `/api`**
 * dentro del navegador (`apoyo/servidor-falso.ts`). O sea:
 *
 *   · corre el **código real** del componente, no una réplica a mano;
 *   · **no hace falta ninguna credencial**: la sesión se fabrica en `localStorage`, porque el
 *     front **decodifica** el JWT y no lo verifica (verificarlo es trabajo del servidor);
 *   · **nada llega a producción**: cada petición a `/api` se contesta desde el navegador con
 *     `route.fulfill()`, que **no sale a la red**, y el interceptor **aborta y marca la prueba
 *     en rojo** si algo que no sea GET intenta escaparse.
 *
 * ⚠️ Esto **no reemplaza** el bloque `[B]` del plan de pruebas: con la API simulada no se prueba
 * ni un guard del servidor, ni un 403 real, ni el tiempo de una reconciliación. Cubre lo que el
 * plan marca `[C]`: errores humanos y de diseño, y los estados que hoy no existen en la base
 * (un folio a medias, un 500, la red caída). Lo `[B]` espera a **D-PW1**.
 *
 * ⛔ No se usa `webServer` con `nx serve view`: levantar el front o el back en local está
 * prohibido (regla 3), y el config de `e2e/caja-general` ya dejó sentado ese criterio.
 *
 * ── Por qué navegador real y no jsdom ───────────────────────────────────────
 * Lo mismo que midió la suite de Caja General: `ArrowDown` sobre un `input[type=number]` con 34
 * da **34 en jsdom** y **33 en Chrome**. Una prueba en jsdom que afirme «el valor quedó intacto»
 * pasa exista o no el `preventDefault()`, y acá eso corrompe un conteo.
 */

/** El origen del bundle. Se puede apuntar a otro (una pila de CI, el día que exista). */
export const SUITE_URL = process.env.SUITE_URL || 'http://192.168.0.222:30080';

export default defineConfig({
  testDir: __dirname,
  testMatch: /.*\.e2e\.ts$/,
  outputDir: `${__dirname}/.resultados`,
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: 0,
  reporter: [['list']],
  use: {
    ...devices['Desktop Chrome'],
    baseURL: SUITE_URL,
    // ⚠️ El piso razonable de una máquina de oficina. Medido el 2026-11-25: los 11 almacenistas
    // que cuentan entran **6 desde Windows**, 1 desde Android y 4 nunca entraron. O sea que el
    // contador NO está en un teléfono, y las pruebas van con teclado y a esta resolución.
    viewport: { width: 1366, height: 768 },
    // ⛔ El service worker de la suite (`ngsw`) serviría respuestas de su caché y taparía los
    // mocks: una prueba del estado de error pasaría en verde leyendo una lista vieja del disco.
    serviceWorkers: 'block',
    // ⚠️ **Sin esto la pantalla queda en blanco, con título y todo** (medido el 2026-11-25).
    // El servidor manda `Content-Security-Policy: … upgrade-insecure-requests`, así que el
    // navegador vuelve a pedir CADA script por **https** al puerto 30080, que habla HTTP
    // plano → `ERR_SSL_PROTOCOL_ERROR`. No se arregla reescribiendo la cabecera: fabricar el
    // documento con `route.fulfill()` lo reclasifica como contexto no seguro y Chrome bloquea
    // los scripts por acceso a red privada. `bypassCSP` apaga la política en el navegador de
    // prueba, sin tocar nada del servidor.
    bypassCSP: true,
    trace: 'retain-on-failure',
  },
  // El `use` del proyecto GANA sobre el global: volver a expandir `devices['Desktop Chrome']`
  // acá restauraría su viewport de 1280x720 y pisaría el de arriba en silencio.
  projects: [{ name: 'chromium' }],
});
