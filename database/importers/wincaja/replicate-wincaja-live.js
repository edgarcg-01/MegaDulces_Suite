'use strict';
/**
 * Fase WR.3 + WR.4 — RÉPLICA CRUDA CONTINUA de las bases Wincaja (Access 97 → Postgres).
 * Hermano de `replicate-ods-live.js` (Kepler), pero con Jet como reader (Access no tiene
 * replicación lógica). Espeja TODAS las tablas de cada .mdb a la DB `wincaja` @ :5433,
 * schema por sucursal, en dos carriles (incremental por watermark + hash-delta).
 *
 * ⚙️ EL MOTOR YA NO VIVE ACÁ. Se subió a `../lib/access-replicate.js` cuando la Fase CG (ADR-070)
 * necesitó el mismo carril para `BDatos.mdb`: duplicar 295 líneas de un motor probado en
 * producción es lo que ADR-056 prohíbe. Este archivo es el punto de entrada de Wincaja y aporta
 * su configuración; la lógica —los dos carriles, el invariante WR.7 del watermark, el
 * anti-cacheo del esquema vacío, el preflight del share, el heartbeat por carril— está allá,
 * verbatim, con sus comentarios.
 *
 * El refactor se verificó con `--dry --branch=32` contra la .mdb real ANTES y DESPUÉS: salida
 * idéntica byte a byte.
 *
 * On-prem only (Jet 32-bit + Z:). NO en Railway.
 *
 * Uso (sin cambios):
 *   node replicate-wincaja-live.js --branch=30 --dry           # 1 pasada, no escribe (muestra plan)
 *   node replicate-wincaja-live.js --branch=30 --once          # 1 pasada real y sale
 *   node replicate-wincaja-live.js --once                      # 1 pasada, todas las sucursales
 *   node replicate-wincaja-live.js --watch=5                   # loop cada 5 min (proceso largo)
 *   node replicate-wincaja-live.js --branch=30 --only=Articulos,Precios --once   # subset
 *   node replicate-wincaja-live.js --carril=inc --watch=2      # sólo movimientos
 */
const path = require('path');
const cfg = require('./wincaja-replica-config');

require(path.join(__dirname, '..', 'lib', 'access-replicate')).run({
  ...cfg,
  stateTable: 'ods.wincaja_watermark',
  label: 'WR.3 réplica cruda Wincaja',
  hbPrefix: 'wincaja_replica',
  hbLabel: 'Wincaja réplica cruda',
  batchEnv: 'WINCAJA_UPSERT_BATCH',
  mdbBaseEnv: 'WINCAJA_MDB_BASE',
});
