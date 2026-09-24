import { defineConfig } from 'vitest/config';
import { aliasDeTsconfig, raizCanonica } from '../../vitest.shared';

/**
 * `[COT.1b]` Pruebas de `ui-web` con Vitest.
 *
 * La existencia de ESTE archivo es lo que crea el target `test` del proyecto (plugin
 * `@nx/vitest`, ver el comentario de `nx.json`). Antes de esto `ui-web` solo tenia `lint`
 * inferido, asi que mover aca `qty-units.spec.ts` —sus 11 candados— habria convertido una
 * suite viva en pruebas huerfanas: el defecto que la Fase VP conto 21 veces en el repo.
 *
 * La resolucion de los alias @megadulces/* vive en `vitest.shared.ts`, con las tres trampas
 * medidas que la hacen no-trivial. No copiar esa configuracion aca.
 *
 * ⚠️ `passWithNoTests` queda en false a proposito, al reves que en `contracts`: esta libreria
 * estrena el target JUSTO para correr una suite concreta. Si un dia el `include` deja de
 * encontrarla, tiene que ponerse rojo — un runner que pasa sin medir nada se lee igual que
 * un runner que midio y salio bien.
 */
export default defineConfig({
  // La caja de la letra de unidad importa en Windows: ver raizCanonica() en vitest.shared.ts.
  root: raizCanonica(__dirname),
  plugins: [aliasDeTsconfig(__dirname)],
  test: {
    name: 'ui-web',
    /**
     * `jsdom`, no `node`: `number-wheel-guard.spec.ts` ya vivia aca y usa `document`.
     * ⚠️ Ese spec NUNCA habia corrido —la libreria no tenia target— asi que era una de las
     * pruebas huerfanas que la Fase VP conto. Esta config es la primera vez que se ejecuta.
     * `qty-units.spec.ts` es aritmetica pura y corre igual en los dos entornos.
     */
    environment: 'jsdom',
    globals: true,
    include: ['src/**/*.spec.ts'],
    passWithNoTests: false,
    coverage: {
      provider: 'v8',
      reportsDirectory: '../../coverage/libs/ui-web',
    },
  },
});
