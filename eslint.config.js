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
      // Aislamiento de módulos enforced (todos los dominios migrados a libs).
      // 'error': un import cross-domain ilegal ROMPE el lint. Esta es la red
      // que impide que un cambio en un dominio acople/rompa otro en silencio.
      // banTransitiveDependencies omitido a propósito: con una sola package.json
      // raíz y libs no-buildable genera falsos positivos; el aislamiento real
      // lo dan los depConstraints de scope de abajo.
      '@nx/enforce-module-boundaries': [
        'error',
        {
          enforceBuildableLibDependency: true,
          allow: ['^.*/eslint(\\.base)?\\.config\\.[cm]?js$'],
          depConstraints: [
            // ── capas (type:*) ──
            { sourceTag: 'type:app', onlyDependOnLibsWithTags: ['type:feature', 'type:data', 'type:util'] },
            { sourceTag: 'type:feature', onlyDependOnLibsWithTags: ['type:feature', 'type:data', 'type:util'] },
            { sourceTag: 'type:data', onlyDependOnLibsWithTags: ['type:data', 'type:util'] },
            { sourceTag: 'type:util', onlyDependOnLibsWithTags: ['type:util'] },
            // ── dominios (scope:*) ──
            // la app api compone todos los dominios
            { sourceTag: 'scope:api', onlyDependOnLibsWithTags: ['scope:platform', 'scope:shared', 'scope:commercial', 'scope:logistics', 'scope:trade', 'scope:intake', 'scope:finance', 'scope:reconciliation'] },
            // cada dominio: él mismo + platform + shared(contracts) SOLAMENTE
            { sourceTag: 'scope:commercial', onlyDependOnLibsWithTags: ['scope:commercial', 'scope:platform', 'scope:shared'] },
            { sourceTag: 'scope:logistics', onlyDependOnLibsWithTags: ['scope:logistics', 'scope:platform', 'scope:shared'] },
            { sourceTag: 'scope:trade', onlyDependOnLibsWithTags: ['scope:trade', 'scope:platform', 'scope:shared'] },
            // MAAT (ADR-028): finanzas NO importa commercial/trade — query-service propio
            { sourceTag: 'scope:finance', onlyDependOnLibsWithTags: ['scope:finance', 'scope:platform', 'scope:shared'] },
            // Supervisor de Movimientos (ADR-029): lee analytics.* vía platform, escribe reconciliation.* — no importa dominios
            { sourceTag: 'scope:reconciliation', onlyDependOnLibsWithTags: ['scope:reconciliation', 'scope:platform', 'scope:shared'] },
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
  // ── TS.0 / ADR-052 — ratchet de tipado del boundary REST ───────────────────
  // `libs/contracts` es la fuente unica de tipos del wire: se mantiene PRISTINO.
  {
    files: ['libs/contracts/**/*.ts'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/explicit-module-boundary-types': 'error',
    },
  },
  // Boundary REST (controllers/services back + services front): `any` visible
  // como WARN — no bloquea el lint. El gate de CI (scripts/lint-boundary-gate.js
  // + eslint.gate.config.js) lo eleva a ERROR solo en los archivos CAMBIADOS,
  // asi la deuda vieja no revienta pero no entra deuda nueva. Ver
  // docs/IMPLEMENTACION/FASES/FASE_TS_CONTRATOS_TIPADOS.md
  {
    files: [
      'libs/**/*.controller.ts',
      'libs/**/*.service.ts',
      'apps/api/**/*.controller.ts',
      'apps/api/**/*.service.ts',
      'apps/view/**/*.service.ts',
      'apps/vendor/**/*.service.ts',
      'apps/portal/**/*.service.ts',
    ],
    rules: {
      '@typescript-eslint/no-explicit-any': 'warn',
    },
  },
  {
    files: ['**/*.html'],
    rules: {
      '@typescript-eslint/ban-ts-comment': 'off',
    },
  },
];
