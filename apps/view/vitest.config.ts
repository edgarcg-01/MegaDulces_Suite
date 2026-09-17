import angular from '@analogjs/vite-plugin-angular';
import { defineConfig } from 'vitest/config';
import { aliasDeTsconfig, raizCanonica } from '../../vitest.shared';
import { resolve } from 'node:path';

/**
 * Pruebas de `view` (Angular) con Vitest, via `@analogjs/vite-plugin-angular`.
 *
 * ── Que se gano al salir de jest-preset-angular ────────────────────────────────────────────
 * Jest lee CommonJS, y media dependencia moderna del front ya solo publica ESM. Eso obligaba a
 * mantener un `transformIgnorePatterns` y un doble de `@primeui/license-manager` para que un
 * spec que importara CUALQUIER modulo de PrimeNG no reventara con "Unexpected token 'export'"
 * ANTES de arrancar. Vite resuelve ESM de forma nativa: ese andamio deja de ser necesario.
 *
 * ⚠️ El `tsconfig` que se le pasa al compilador de Angular es el de PRUEBAS. Si se le pasa el
 * de la app, los specs no entran al programa y los tipos de las pruebas no se revisan.
 *
 * La resolucion de los alias @megadulces/* vive en `vitest.shared.ts`, con las tres trampas
 * medidas que la hacen no-trivial. No copiar esa configuracion aca.
 */
export default defineConfig({
  // La caja de la letra de unidad importa en Windows: ver raizCanonica() en vitest.shared.ts.
  root: raizCanonica(__dirname),
  plugins: [angular({ tsconfig: resolve(raizCanonica(__dirname), 'tsconfig.spec.json') }), aliasDeTsconfig(__dirname)],
  resolve: {
    alias: {
      // `[CV.24]` Se conserva el doble de la licencia de PrimeNG. Bajo Vite ya NO hace falta
      // por el lado de ESM, pero el motivo de fondo sigue vigente: la licencia no es contrato
      // de producto (solo silencia un banner en prod) y no tiene por que correr en pruebas.
      '@primeui/license-manager': new URL('./src/testing/primeui-license-stub.ts', import.meta.url).pathname,
    },
  },
  test: {
    name: 'view',
    environment: 'jsdom',
    globals: true,
    setupFiles: ['src/test-setup.ts'],
    include: ['src/**/*.spec.ts'],
    passWithNoTests: true,
    // ⚠️ 20 s, no los 5 s que Vitest trae por default, y no es para tapar nada: con jest,
    // ts-jest compilaba cada archivo ANTES de correr; con Vitest la compilacion de Angular
    // ocurre por demanda y la paga la primera prueba de componente que la necesite.
    //
    // MEDIDO el 2026-09-17, ya con el bug de la letra de unidad resuelto y en paralelo:
    // con 5 s, 1 de cada 3 corridas se caia por "Test timed out in 5000ms" -- INTERMITENTE,
    // que es la peor forma de rojo porque ensena a reintentar en vez de a leer. Con 20 s,
    // 3 de 3 corridas identicas.
    //
    // Sigue siendo un tope util: una prueba que de verdad se cuelgue muere a los 20 s.
    testTimeout: 20_000,
    hookTimeout: 20_000,
    coverage: {
      provider: 'v8',
      reportsDirectory: '../../coverage/apps/view',
    },
  },
});
