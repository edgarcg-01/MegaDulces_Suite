'use strict';
/**
 * CG.9 — crea el destino de la réplica cruda de la Caja General y AUTO-GENERA el DDL espejo (ADR-070).
 * Motor compartido con Wincaja en `../lib/access-mirror-ddl.js`.
 *
 * On-prem (Jet 32-bit + el share). NO en Railway.
 *
 *   node database/importers/movimientos-caja/caja-general-replica-ddl.js --branch=20 --dry
 *   node database/importers/movimientos-caja/caja-general-replica-ddl.js --branch=20 --apply
 */
const path = require('path');
const cfg = require('./caja-general-replica-config');

require(path.join(__dirname, '..', 'lib', 'access-mirror-ddl')).run({
  ...cfg,
  REPLICA_DB: 'caja_general',
  label: 'CG.9 DDL espejo Caja General (BDatos.mdb)',
});
