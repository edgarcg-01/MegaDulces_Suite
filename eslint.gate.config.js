// TS.0 — Gate de tipado del boundary (ADR-052 / FASE_TS_CONTRATOS_TIPADOS).
//
// Config STANDALONE a proposito: NO carga @nx/enforce-module-boundaries (esa
// regla necesita el project graph de Nx y solo corre bien dentro de `nx lint`).
// Este gate corre `eslint` DIRECTO sobre los .controller.ts/.service.ts que un
// PR/push toca (ver scripts/lint-boundary-gate.js) y eleva a ERROR las reglas de
// tipado del boundary — asi el codigo NUEVO/CAMBIADO no puede agregar `any` ni
// returns sin tipar, sin reventar por la deuda pre-existente de archivos ajenos.
//
// Las mismas reglas viven como WARN en eslint.config.js (visibilidad en editor);
// aca son ERROR (bloquean el merge).

const parser = require('@typescript-eslint/parser');
const plugin = require('@typescript-eslint/eslint-plugin');

module.exports = [
  // Todos los controllers/services (backend y frontend): nada de `any` nuevo.
  {
    files: ['**/*.controller.ts', '**/*.service.ts'],
    languageOptions: { parser },
    plugins: { '@typescript-eslint': plugin },
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
    },
  },
  // Solo backend: ademas, todo metodo publico declara su tipo de retorno
  // (mata el `Promise<any>` implicito por inferencia sobre filas de Knex).
  {
    files: ['libs/**/*.controller.ts', 'libs/**/*.service.ts', 'apps/api/**/*.ts'],
    languageOptions: { parser },
    plugins: { '@typescript-eslint': plugin },
    rules: {
      '@typescript-eslint/explicit-module-boundary-types': 'error',
    },
  },
];
