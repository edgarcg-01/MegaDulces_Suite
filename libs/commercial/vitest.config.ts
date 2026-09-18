import { defineConfig } from 'vitest/config';
import { aliasDeTsconfig, raizCanonica } from '../../vitest.shared';

/**
 * Pruebas de `commercial` con Vitest.
 *
 * ⚠️ Esta librería tenía **4 specs y ningún target `test`** desde antes (expiry-voice-match,
 * receiving-claim, receiving-origin, anexo-venta): estaban escritos y no los corría nadie — el
 * patrón de "pruebas huérfanas" que la Fase VP ya había medido en el repo. La existencia de ESTE
 * archivo es lo que crea el target (plugin `@nx/vitest`), así que con él los 4 vuelven al runner.
 *
 * La resolución de los alias `@megadulces/*` vive en `vitest.shared.ts`: no copiarla acá.
 */
export default defineConfig({
  root: raizCanonica(__dirname),
  plugins: [aliasDeTsconfig(__dirname)],
  test: {
    name: 'commercial',
    environment: 'node',
    globals: true,
    include: ['src/**/*.spec.ts'],
    passWithNoTests: true,
    coverage: {
      provider: 'v8',
      reportsDirectory: '../../coverage/libs/commercial',
    },
  },
});
