'use strict';
/**
 * CG.9 — RÉPLICA CRUDA CONTINUA de `BDatos.mdb` (Dulcería / back-end del Access `Control`).
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
 *   node replicate-dulceria-live.js --branch=20 --dry      # 1 pasada, no escribe (muestra plan)
 *   node replicate-dulceria-live.js --branch=20 --once     # 1 pasada real
 *   node replicate-dulceria-live.js --watch=30             # loop cada 30 min
 *   node replicate-dulceria-live.js --only=Doctos,Cuenta --once
 */
const path = require('path');
const cfg = require('./dulceria-replica-config');

require(path.join(__dirname, '..', 'lib', 'access-replicate')).run({
  ...cfg,
  stateTable: 'ods.dulceria_watermark',
  label: 'CG.9 réplica cruda Dulcería (BDatos.mdb)',
  hbPrefix: 'dulceria_replica',
  hbLabel: 'Dulcería réplica cruda',
  batchEnv: 'DULCERIA_UPSERT_BATCH',
  mdbBaseEnv: 'DULCERIA_MDB_BASE',
});
