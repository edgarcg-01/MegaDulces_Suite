import { randomUUID } from 'node:crypto';
import { defineConfig } from 'vitest/config';
import { aliasDeTsconfig, raizCanonica } from '../../vitest.shared';

/**
 * Pruebas de `logistics` con Vitest — estrenadas por EMB.12 («Nuevo embarque» desde Kepler).
 *
 * Mismo molde que `libs/finance/vitest.config.ts`: la existencia de ESTE archivo crea el target
 * `test` del proyecto (plugin `@nx/vitest`), y la resolución de alias vive en
 * `vitest.shared.ts`. Antes de EMB.12 la librería de logística no tenía ni una prueba.
 */
export default defineConfig({
  // La caja de la letra de unidad importa en Windows: ver raizCanonica() en vitest.shared.ts.
  root: raizCanonica(__dirname),
  plugins: [aliasDeTsconfig(__dirname)],
  test: {
    name: 'logistics',
    environment: 'node',
    globals: true,
    include: ['src/**/*.spec.ts'],
    passWithNoTests: true,
    // Importar un controller arrastra `@megadulces/platform-core`, que exige `JWT_SECRET` al
    // cargar el módulo. Va GENERADO por corrida (ver el porqué en libs/finance/vitest.config.ts).
    env: { JWT_SECRET: `pruebas-${randomUUID()}-${randomUUID()}` },
    coverage: {
      provider: 'v8',
      reportsDirectory: '../../coverage/libs/logistics',
    },
  },
});
