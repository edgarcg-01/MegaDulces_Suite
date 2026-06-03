const nx = require('@nx/eslint-plugin');

module.exports = [
  ...nx.configs['flat/base'],
  ...nx.configs['flat/typescript'],
  ...nx.configs['flat/javascript'],
  {
    ignores: ['**/dist'],
  },
  {
    files: ['**/*.ts', '**/*.tsx', '**/*.js', '**/*.jsx'],
    rules: {
      // Fase 0 de aislamiento de módulos: regla en 'warn' mientras se
      // completan los tags y se migran dominios a libs. Se flipea a 'error'
      // por scope a medida que cada dominio aterriza (ver plan de migración).
      '@nx/enforce-module-boundaries': [
        'warn',
        {
          enforceBuildableLibDependency: true,
          banTransitiveDependencies: true,
          allow: ['^.*/eslint(\\.base)?\\.config\\.[cm]?js$'],
          depConstraints: [
            // ── capas (type:*) ──
            { sourceTag: 'type:app', onlyDependOnLibsWithTags: ['type:feature', 'type:data', 'type:util'] },
            { sourceTag: 'type:feature', onlyDependOnLibsWithTags: ['type:feature', 'type:data', 'type:util'] },
            { sourceTag: 'type:data', onlyDependOnLibsWithTags: ['type:data', 'type:util'] },
            { sourceTag: 'type:util', onlyDependOnLibsWithTags: ['type:util'] },
            // ── dominios (scope:*) ──
            // la app api compone todos los dominios
            { sourceTag: 'scope:api', onlyDependOnLibsWithTags: ['scope:platform', 'scope:shared', 'scope:commercial', 'scope:logistics', 'scope:trade', 'scope:intake'] },
            // cada dominio: él mismo + platform + shared(contracts) SOLAMENTE
            { sourceTag: 'scope:commercial', onlyDependOnLibsWithTags: ['scope:commercial', 'scope:platform', 'scope:shared'] },
            { sourceTag: 'scope:logistics', onlyDependOnLibsWithTags: ['scope:logistics', 'scope:platform', 'scope:shared'] },
            { sourceTag: 'scope:trade', onlyDependOnLibsWithTags: ['scope:trade', 'scope:platform', 'scope:shared'] },
            { sourceTag: 'scope:intake', onlyDependOnLibsWithTags: ['scope:intake', 'scope:platform', 'scope:shared', 'scope:commercial'] },
            // platform es infra leaf: sin deps de dominio
            { sourceTag: 'scope:platform', onlyDependOnLibsWithTags: ['scope:platform', 'scope:shared'] },
            // contracts no depende de nada
            { sourceTag: 'scope:shared', onlyDependOnLibsWithTags: ['scope:shared'] },
            // frontend
            { sourceTag: 'scope:view', onlyDependOnLibsWithTags: ['scope:shared', 'scope:platform'] },
          ],
        },
      ],
    },
  },
  {
    files: ['**/*.ts', '**/*.tsx', '**/*.js', '**/*.jsx'],
    // Override or add rules here
    rules: {},
  },
  {
    files: ['**/*.html'],
    rules: {
      '@typescript-eslint/ban-ts-comment': 'off',
    },
  },
];
