import { defineConfig } from 'vitest/config';
import { aliasDeTsconfig, raizCanonica } from '../../vitest.shared';

/**
 * Pruebas de `finance` con Vitest — estrenadas por la Fase CG (ADR-070).
 *
 * La resolucion de los alias @megadulces/* vive en `vitest.shared.ts`, con las tres trampas
 * medidas que la hacen no-trivial. No copiar esa configuracion aca.
 *
 * La existencia de ESTE archivo es lo que crea el target `test` del proyecto (plugin
 * `@nx/vitest`, ver el comentario de `nx.json`). Antes de la Fase CG `libs/finance` no tenia
 * target de pruebas: 0 specs sobre la libreria que maneja el dinero.
 */
export default defineConfig({
  // La caja de la letra de unidad importa en Windows: ver raizCanonica() en vitest.shared.ts.
  root: raizCanonica(__dirname),
  plugins: [aliasDeTsconfig(__dirname)],
  test: {
    name: 'finance',
    environment: 'node',
    globals: true,
    include: ['src/**/*.spec.ts'],
    passWithNoTests: true,
    // `[GX.26]` Un secreto SOLO para las pruebas.
    //
    // Importar cualquier controller arrastra `@megadulces/platform-core`, y su
    // `TenantModule` exige `JWT_SECRET` **al cargar el modulo** (fail-fast a proposito: la
    // app no debe arrancar sin secreto de firma). Sin esto, un spec que monte un controller
    // no falla por lo que prueba -- falla antes de correr, en el import.
    //
    // No afloja nada: es un valor de proceso de prueba, no se firma nada real con el, y el
    // fail-fast de produccion queda intacto.
    env: { JWT_SECRET: 'secreto-de-pruebas-no-usar-fuera-de-vitest-0123456789' },
    coverage: {
      provider: 'v8',
      reportsDirectory: '../../coverage/libs/finance',
    },
  },
});
