import { defineConfig, devices } from '@playwright/test';

/**
 * Suite e2e de TECLADO para el prototipo de Caja General · paso ①.
 *
 * ── Correr ──────────────────────────────────────────────────────────────────
 *   npx playwright test -c e2e/caja-general/playwright.config.ts
 *
 * ⚠️ VIVE DENTRO DEL REPO A PROPÓSITO, y no es cosmético: fuera de él
 * `import { test } from '@playwright/test'` **no resuelve** —Node busca
 * `node_modules` subiendo desde el archivo, y desde `Downloads/` no llega a
 * ninguno—. La primera versión vivía afuera y sólo corría con `NODE_PATH=…`
 * puesto a mano; sin esa variable tiraba `Cannot find module '@playwright/test'`.
 * ⛔ La salida fácil habría sido enlazar `node_modules` en la carpeta de afuera:
 * **no se hace** — eso ya destruyó el `node_modules` del checkout compartido una
 * vez (ver `docs/GOTCHAS.md`). Se mueve el código a donde la resolución funciona.
 *
 * ── Por qué NO apunta a la app corriendo ────────────────────────────────────
 * `CLAUDE.md` prohíbe compilar o levantar el front/back en local, así que un
 * `webServer` con `nx serve view` no es una opción. El prototipo es un archivo
 * estático: se abre por `file://`, sin servidor, sin build, sin tocar Nx. Lo que
 * se prueba es el CONTRATO DE TECLADO que el componente real tiene que cumplir,
 * antes de que el componente exista.
 *
 * ── Por qué navegador real y no jsdom, MEDIDO el 2026-10-16 ─────────────────
 *     jsdom  · ArrowDown sobre input[type=number] con 34 → 34   (no pasa nada)
 *     Chrome · ArrowDown sobre input[type=number] con 34 → 33   (decrementa)
 * Las 288 pruebas que hoy cubren esta pantalla corren en jsdom, así que **no
 * pueden ver** el defecto que corrompe un conteo de efectivo: una prueba que
 * afirma «el valor quedó intacto» pasa exista o no el `preventDefault()`.
 *
 * ⬜ SIN CABLEAR A NX NI A CI a propósito: crear el primer target `e2e` del
 * monorepo toca la config, y eso es decisión de Edgar. Hoy se corre con `-c`.
 */
export default defineConfig({
  testDir: __dirname,
  testMatch: /.*\.e2e\.ts$/,
  // Sin esto las trazas de una prueba roja caen fuera de la carpeta.
  outputDir: `${__dirname}/.resultados`,
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: 0,
  reporter: [['list']],
  use: {
    ...devices['Desktop Chrome'],
    // El piso razonable de una laptop de oficina. ⚠️ NO está medido: el censo de la
    // flota (`public.users.last_login_user_agent`) trae navegador y SO de los 94
    // usuarios, pero NO viewport. Queda declarado como supuesto, no como hecho.
    viewport: { width: 1366, height: 768 },
    trace: 'retain-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
