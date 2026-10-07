'use strict';
/**
 * `[IDG.1]` — Guarda de destino para los tests que ESCRIBEN.
 *
 * ⚠️ LA IMPLEMENTACIÓN YA NO VIVE ACÁ. Se subió a
 * `libs/platform-core/src/lib/provenance/target-guard.js` el 2026-09-08, por
 * ADR-056: un primitivo no cierra la fase hasta vivir en `libs/` compartido.
 * Este archivo queda como re-export para que los 34 tests que lo llaman —y
 * `run-all-tests.js`— no se toquen. Si venís a cambiar la lógica (los patrones
 * de prod, los hosts locales, la clasificación), es allá.
 *
 * El motivo original, que sigue siendo el motivo: el 2026-08-29 el suite se
 * corrió con el `.env` apuntando a PRODUCCIÓN y dejó 5 cuentas y 2 tenants de
 * prueba en el padrón real. 37 archivos de `database/tests/` hacen DELETE /
 * TRUNCATE / DROP y ninguno miraba contra qué base estaba corriendo.
 *
 * Uso, como PRIMERA línea ejecutable del test (después de dotenv):
 *
 *     require('./_lib/assert-safe-target').assertSafeTarget('test-foo');
 *
 * Si el test resuelve su URL de una forma propia, pasársela:
 *
 *     assertSafeTarget('test-foo', { url: miUrl });
 *
 * Lo nuevo que trae `libs/` y acá no había: `assertTarget` (que además valida
 * el ORIGEN) y `assertDistinct` (que impide copiar una base sobre sí misma).
 */

const path = require('path');

module.exports = require(
  path.resolve(__dirname, '../../../libs/platform-core/src/lib/provenance/target-guard.js'),
);
