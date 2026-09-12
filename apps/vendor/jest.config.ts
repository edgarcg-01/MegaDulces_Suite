export default {
  displayName: 'vendor',
  preset: '../../jest.preset.js',
  coverageDirectory: '../../coverage/apps/vendor',
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
