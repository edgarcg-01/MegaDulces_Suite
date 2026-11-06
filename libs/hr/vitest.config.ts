import { randomUUID } from 'node:crypto';
import { defineConfig } from 'vitest/config';
import { aliasDeTsconfig, raizCanonica } from '../../vitest.shared';

export default defineConfig({
  root: raizCanonica(__dirname),
  plugins: [aliasDeTsconfig(__dirname)],
  test: {
    name: 'hr',
    environment: 'node',
    globals: true,
    include: ['src/**/*.spec.ts'],
    passWithNoTests: true,
    // `platform-core` exige JWT_SECRET AL IMPORTARSE (fail-fast a propósito). Un servicio de RH que lo importa
    // (p. ej. AnthropicService) tumbaba sus pruebas al cargar. Mismo valor GENERADO que libs/finance.
    env: { JWT_SECRET: `pruebas-${randomUUID()}-${randomUUID()}` },
    coverage: {
      provider: 'v8',
      reportsDirectory: '../../coverage/libs/hr',
    },
  },
});
