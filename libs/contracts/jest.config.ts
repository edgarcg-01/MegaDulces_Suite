/**
 * Tests de `libs/contracts`.
 *
 * La librería no tenía target de `test` —sólo `lint`—, y `authz-tree.ts` citaba desde su
 * header un `authz-tree.spec.ts` que nunca existió: la única verificación del árbol era
 * `scripts/check-authz-tree.js`, que leía los shims re-export de `apps/view` (una línea cada
 * uno), contaba 0 claves y pintaba verde. Un gate que compara dos nadas siempre concuerda.
 *
 * Acá corre TypeScript plano en Node: nada de Angular, nada de DB. Lo que se prueba son las
 * constantes y funciones puras del contrato (`suite-map.ts`) y su relación con el árbol.
 * La coherencia enum ↔ árbol ↔ etiquetas sigue en `database/tests/test-authz-route-coverage.js`
 * [2], que la lee del archivo canónico con piso (>100 claves).
 */
export default {
  displayName: 'contracts',
  preset: '../../jest.preset.js',
  testEnvironment: 'node',
  coverageDirectory: '../../coverage/libs/contracts',
  transform: {
    '^.+\\.[tj]s$': ['ts-jest', { tsconfig: '<rootDir>/tsconfig.spec.json' }],
  },
  moduleFileExtensions: ['ts', 'js', 'html'],
};
