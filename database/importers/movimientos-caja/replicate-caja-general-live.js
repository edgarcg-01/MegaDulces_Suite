'use strict';
/**
 * CG.9 — RÉPLICA CRUDA CONTINUA de la CAJA GENERAL (`BDatos.mdb`, back-end del Access `Control`).
 * Hermano de `replicate-wincaja-live.js`: MISMO motor (`../lib/access-replicate.js`), otra config.
 *
 * Reemplaza a `import-caja-general.js`, que era un importer `script → tabla` contra la regla
 * principal del proyecto. Con esto `analytics.caja_general_*` pasa a ser vista derive-no-copy.
 *
 * ⛔ TODO va por hash-delta, y está medido: la PK de `Doctos` es (TipoDto, IdDocto) —dos ejes— y
 * un watermark escalar dejaría los 23,174 ingresos ($654.7M) invisibles para siempre. Además
 * `Doctos` muta (`Corte` se prende después). El motivo completo está en la config.
 *
 * On-prem only (Jet 32-bit + el share). NO en Railway. Vive en `.249` hasta VL.5.
 *
 *   node replicate-caja-general-live.js --branch=20 --dry      # 1 pasada, no escribe (muestra plan)
 *   node replicate-caja-general-live.js --branch=20 --once     # 1 pasada real
 *   node replicate-caja-general-live.js --watch=30             # loop cada 30 min
 *   node replicate-caja-general-live.js --only=Doctos,Cuenta --once
 */
const path = require('path');
const cfg = require('./caja-general-replica-config');

require(path.join(__dirname, '..', 'lib', 'access-replicate')).run({
  ...cfg,
  stateTable: 'ods.caja_general_watermark',
  label: 'CG.9 réplica cruda Caja General (BDatos.mdb)',
  hbPrefix: 'caja_general_replica',
  hbLabel: 'Caja General réplica cruda',
  batchEnv: 'CAJA_GENERAL_UPSERT_BATCH',
  mdbBaseEnv: 'CAJA_GENERAL_MDB_BASE',
});
