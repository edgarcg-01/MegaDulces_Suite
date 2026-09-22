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
    /**
     * ⚠️ `platform-core` hace fail-fast de `JWT_SECRET` AL IMPORTARSE (`[AUTHZ-HARD]`), así que
     * cualquier spec que toque un controller de esta librería muere antes de la primera
     * aserción — no por un defecto del código, sino porque el runner no trae entorno. Se le da
     * un secreto de prueba, que NO relaja la compuerta: sigue reventando en un arranque real
     * sin él. Es el mismo motivo por el que `api:test` está rojo en CI (falta esta línea allá).
     */
    env: { JWT_SECRET: 'secreto-solo-para-pruebas-con-32-bytes-o-mas-de-largo' },
    coverage: {
      provider: 'v8',
      reportsDirectory: '../../coverage/libs/commercial',
    },
  },
});
