'use strict';
/**
 * Fase WR.2 — crea el destino de la réplica cruda Wincaja y AUTO-GENERA el DDL espejo.
 *
 * ⚙️ El motor se subió a `../lib/access-mirror-ddl.js` junto con `access-replicate.js` cuando la
 * Fase CG (ADR-070) necesitó el mismo carril para `BDatos.mdb`. Acá queda sólo la config.
 *
 * On-prem (Jet 32-bit + Z: viven en la máquina de feeds). NO en Railway.
 *
 * Uso (sin cambios):
 *   node database/importers/wincaja/wincaja-replica-ddl.js --branch=30 --dry     # imprime el DDL
 *   node database/importers/wincaja/wincaja-replica-ddl.js --branch=30 --apply   # crea DB+schema+tablas
 *   node database/importers/wincaja/wincaja-replica-ddl.js --apply                # todas las sucursales
 */
const path = require('path');
const cfg = require('./wincaja-replica-config');

require(path.join(__dirname, '..', 'lib', 'access-mirror-ddl')).run({
  ...cfg,
  REPLICA_DB: 'wincaja',
  label: 'WR.2 DDL espejo Wincaja',
});
