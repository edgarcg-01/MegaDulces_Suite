import { defineConfig } from 'vitest/config';
import { aliasDeTsconfig, raizCanonica } from '../../vitest.shared';

export default defineConfig({
  root: raizCanonica(__dirname),
  plugins: [aliasDeTsconfig(__dirname)],
  test: {
    name: 'platform-core',
    environment: 'node',
    globals: true,
    include: ['src/**/*.spec.ts'],
    passWithNoTests: true,
    coverage: {
      provider: 'v8',
      reportsDirectory: '../../coverage/libs/platform-core',
    },
  },
});
