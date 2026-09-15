/**
 * Tests de `libs/ui-web`.
 *
 * Entorno jsdom, no node: lo que se prueba es comportamiento del DOM (foco y eventos). No hay
 * Angular ni DB acá.
 *
 * Límite declarado: jsdom NO implementa el incremento por rueda de `input[type=number]` —es
 * comportamiento del navegador real—, así que estos tests verifican el MECANISMO (que la guarda
 * suelta el foco, y sólo cuando corresponde), no el efecto final en el navegador. La verificación
 * de que soltar el foco evita el incremento es del navegador, no de esta suite.
 */
export default {
  displayName: 'ui-web',
  preset: '../../jest.preset.js',
  testEnvironment: 'jsdom',
  coverageDirectory: '../../coverage/libs/ui-web',
  transform: {
    '^.+\\.[tj]s$': ['ts-jest', { tsconfig: '<rootDir>/tsconfig.spec.json' }],
  },
  moduleFileExtensions: ['ts', 'js', 'html'],
};
