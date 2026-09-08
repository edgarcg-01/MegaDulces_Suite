export default {
  displayName: 'view',
  preset: '../../jest.preset.js',
  setupFilesAfterEnv: ['<rootDir>/src/test-setup.ts'],
  coverageDirectory: '../../coverage/apps/view',
  // `[CV.24]` Sin esto, un spec que importe CUALQUIER módulo de PrimeNG revienta antes de
  // arrancar: `primeng/*` → `@primeui/license-manager` → `@noble/{ed25519,hashes}`, todos
  // ESM en archivos `.js` que jest lee como CommonJS ("Unexpected token 'export'"). Por eso
  // este app no tenía ni un spec de componente. La licencia no es contrato de producto (sólo
  // silencia un banner en prod), así que en tests se apunta a un doble no-op.
  moduleNameMapper: {
    '^@primeui/license-manager$': '<rootDir>/src/testing/primeui-license-stub.ts',
  },
  testEnvironment: 'jsdom',
  transform: {
    '^.+\.(ts|mjs|js|html)$': [
      'jest-preset-angular',
      {
        tsconfig: '<rootDir>/tsconfig.spec.json',
        stringifyContentPathRegex: '\.(html|svg)$',
      },
    ],
  },
  transformIgnorePatterns: ['node_modules/(?!.*\.mjs$)'],
};
