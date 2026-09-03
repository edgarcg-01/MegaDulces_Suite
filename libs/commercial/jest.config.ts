/**
 * Tests de `libs/commercial`.
 *
 * La librería no tenía target de `test` —sólo `lint`—, así que la lógica pura
 * del backend (clasificaciones, parsers, cálculos) no era verificable sin
 * levantar la API contra una base. Este config sólo corre specs de TypeScript
 * plano en Node: nada de Angular, nada de DB.
 *
 * Lo que SÍ se prueba acá son funciones puras y exportadas a propósito, como
 * `classifyReceivingOrigin`. Los servicios que tocan Postgres se siguen
 * verificando por HTTP con los smokes de `database/tests/`, que es donde ADR-044
 * dejó la regla ("los cambios de la estación se prueban por HTTP") después de
 * que un smoke que reimplementaba la lógica diera 17/17 con la ruta caída.
 */
export default {
  displayName: 'commercial',
  preset: '../../jest.preset.js',
  testEnvironment: 'node',
  coverageDirectory: '../../coverage/libs/commercial',
  transform: {
    '^.+\\.[tj]s$': ['ts-jest', { tsconfig: '<rootDir>/tsconfig.spec.json' }],
  },
  moduleFileExtensions: ['ts', 'js', 'html'],
};
