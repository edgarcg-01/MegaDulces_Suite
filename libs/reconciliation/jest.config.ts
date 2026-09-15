/**
 * Tests de `libs/reconciliation`.
 *
 * La libreria solo tenia `lint`. SM.35 agrega `test` porque la identidad del
 * cuadre de caja (`cash-cut-identity.ts`) es logica pura que decide si a una
 * cajera se le imputa un faltante: vivio escrita tres veces a mano, dos de ellas
 * mal, y ninguna prueba lo notaba. Corre TypeScript plano en Node: sin Nest, sin
 * DB. El cruce contra datos reales sigue en
 * `database/tests/test-newdb-arqueo-cuadre.js`.
 */
export default {
  displayName: 'reconciliation',
  preset: '../../jest.preset.js',
  testEnvironment: 'node',
  coverageDirectory: '../../coverage/libs/reconciliation',
  transform: {
    '^.+\.[tj]s$': ['ts-jest', { tsconfig: '<rootDir>/tsconfig.spec.json' }],
  },
  moduleFileExtensions: ['ts', 'js', 'html'],
};
