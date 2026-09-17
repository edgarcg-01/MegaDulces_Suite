import { defineConfig } from 'vitest/config';
import swc from 'unplugin-swc';
import { aliasDeTsconfig, raizCanonica } from '../../vitest.shared';

/**
 * Pruebas de `api` (NestJS) con Vitest.
 *
 * ── Por que SWC y no el esbuild que Vitest trae ────────────────────────────────────────────
 * ⛔ esbuild NO implementa `emitDecoratorMetadata`, y la inyeccion de dependencias de NestJS
 * se apoya justamente en esa metadata (`design:paramtypes`) para resolver un constructor como
 * `constructor(@Inject(KNEX_CONNECTION) knex: Knex, jwt: JwtService)`. Sin ella, cualquier
 * `Test.createTestingModule(...).compile()` falla con un "Nest can't resolve dependencies"
 * que NO habla del verdadero problema. SWC si la emite, y ya estaba instalado: es el mismo
 * compilador que usa el `build` de este proyecto.
 *
 * ⚠️ Las opciones van INLINE a proposito, no via `.swcrc`. Ese archivo trae
 * `exclude: [".*\.spec\.ts$"]` -- correcto para el bundle de produccion, veneno aca: dejaria
 * los specs sin transformar.
 *
 * ── Limite declarado ──────────────────────────────────────────────────────────────────────
 * Esto corre la logica de NestJS en proceso, con dobles. Lo que toca Postgres se sigue
 * probando POR HTTP contra la API corriendo (ADR-044, `database/tests/`), porque un test que
 * reimplementa la consulta se pone verde con la ruta caida.
 *
 * La resolucion de los alias @megadulces/* vive en `vitest.shared.ts`, con las tres trampas
 * medidas que la hacen no-trivial. No copiar esa configuracion aca.
 */
export default defineConfig({
  // La caja de la letra de unidad importa en Windows: ver raizCanonica() en vitest.shared.ts.
  root: raizCanonica(__dirname),
  plugins: [
    aliasDeTsconfig(__dirname),
    swc.vite({
      // ⛔ Pasar las opciones inline NO alcanza: unplugin-swc encuentra y aplica igual el
      // .swcrc del proyecto, cuyo exclude deja fuera los .spec.ts. Medido: los 3 specs
      // fallaban con "cannot process file because it is ignored by .swcrc" y cero pruebas
      // corridas -- o sea, el target volvia a estar rojo por una razon distinta.
      swcrc: false,
      module: { type: 'es6' },
      jsc: {
        target: 'es2022',
        parser: { syntax: 'typescript', decorators: true, dynamicImport: true },
        transform: { legacyDecorator: true, decoratorMetadata: true },
        keepClassNames: true,
      },
    }),
  ],
  test: {
    name: 'api',
    environment: 'node',
    globals: true,
    setupFiles: ['src/test-setup.ts'],
    include: ['src/**/*.spec.ts'],
    passWithNoTests: true,
    coverage: {
      provider: 'v8',
      reportsDirectory: '../../coverage/apps/api',
    },
  },
});
