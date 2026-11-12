import { randomUUID } from 'node:crypto';
import { defineConfig } from 'vitest/config';
import { aliasDeTsconfig, raizCanonica } from '../../vitest.shared';

/**
 * Pruebas de `fiscal` con Vitest — estrenadas por `[PGP.110b]` (2026-11-11).
 *
 * La existencia de ESTE archivo es lo que crea el target `test` del proyecto (plugin
 * `@nx/vitest`, ver el comentario de `nx.json`). Hasta aquí `libs/fiscal` tenía 0 specs: la
 * ingesta de la descarga masiva del SAT perdió 16,195 de 16,845 CFDI el 27-oct por una llave
 * repetida que ninguna prueba ejercía.
 *
 * Misma configuración que `libs/finance/vitest.config.ts` (los alias viven en `vitest.shared.ts`).
 */
export default defineConfig({
  // La caja de la letra de unidad importa en Windows: ver raizCanonica() en vitest.shared.ts.
  root: raizCanonica(__dirname),
  plugins: [aliasDeTsconfig(__dirname)],
  test: {
    name: 'fiscal',
    environment: 'node',
    globals: true,
    include: ['src/**/*.spec.ts'],
    passWithNoTests: true,
    // `[GX.26]`/`[GX.32]` Un secreto SOLO para las pruebas, GENERADO en cada corrida: importar un
    // controller arrastra `TenantModule`, que exige `JWT_SECRET` al cargar (ver libs/finance).
    env: { JWT_SECRET: `pruebas-${randomUUID()}-${randomUUID()}` },
    coverage: {
      provider: 'v8',
      reportsDirectory: '../../coverage/libs/fiscal',
    },
  },
});
