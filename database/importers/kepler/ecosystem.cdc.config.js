/**
 * PM2 ecosystem — CDC WAL-decode (ADR-047): 7 consumidores `ods-cdc-wal.js --watch` (uno por
 * sucursal 00-06) que leen el WAL de los replicas locales `:5433/kepler_md_XX` y empujan SOLO los
 * cambios reales (I/U/D, INCLUIDO DELETE) a `kepler_ods` en prod por feeds-ingest (ingress gratis).
 * Reemplaza el poll (`OdsLiveLoop` + `OdsFullMirror`) — ver FASE_CDC_ODS_LOGICAL.md.
 *
 * ⛔ PREREQUISITOS antes de arrancar (si no, no funciona / arriesga disco):
 *   1) feeds-ingest REDESPLEGADO con los handlers `raw-delete` + `cdc-heartbeat` (apply-handlers.js).
 *   2) `:5433` con `wal_level=logical` (ya hecho) + **`max_slot_wal_keep_size`** puesto (backstop de
 *      disco: si un consumidor muere, su slot retiene WAL → sin este cap, llena disco).
 *   3) En la box on-prem: env `FEEDS_INGEST_KEY` exportado (secreto; NO se hardcodea acá — mismo
 *      lote de rotación que los .cmd de KeplerRunner).
 *
 * Arranque (una vez, en la box on-prem que tiene los replicas :5433):
 *   $env:FEEDS_INGEST_KEY = "<key>"      # (o ya presente en el entorno del servicio)
 *   pm2 start database/importers/kepler/ecosystem.cdc.config.js
 *   pm2 save ; pm2 startup               # persiste + revive tras reinicio
 * Cutover (CDC.6, tras validar en sombra): deshabilitar OdsLiveLoop + OdsFullMirror.
 *
 * Operación:  pm2 ls · pm2 logs cdc-wal-03 · pm2 restart cdc-wal-03 · pm2 stop all
 * Observabilidad: cada consumidor late `cdc_wal_<suc>` → cron_runs (db-health dead-man's switch,
 *   CRON_JOBS cdc_wal_00..06). Un consumidor caído → su latido envejece → ROJO antes de llenar disco.
 *
 * Rollback: `pm2 delete all` (de este ecosystem) + re-enable de OdsLiveLoop/OdsFullMirror. Los slots
 *   `ods_cdc` quedan en :5433 reteniendo WAL → dropearlos: `node ods-cdc-wal.js --branch=XX --drop-slot`.
 */
const path = require('path');
const REPO = path.resolve(__dirname, '..', '..', '..'); // .../Trade_marketing
const SCRIPT = 'database/importers/kepler/ods-cdc-wal.js';
const BRANCHES = (process.env.ODS_LIVE_BRANCHES || '00,01,02,03,04,05,06').split(',').map((s) => s.trim()).filter(Boolean);

// Empuja a prod por feeds-ingest (ingress gratis). DATABASE_URL_NEW = BASE local :5433 (el consumidor
// le cambia el nombre de la DB por sucursal). FEEDS_INGEST_KEY se hereda del entorno (secreto).
const env = {
  FEEDS_SINK: 'http',
  FEEDS_INGEST_URL: process.env.FEEDS_INGEST_URL || 'https://feeds-ingest-production.up.railway.app',
  DATABASE_URL_NEW: process.env.DATABASE_URL_NEW || 'postgresql://postgres:superoot@localhost:5433/postgres_platform',
};
const base = { cwd: REPO, autorestart: true, max_restarts: 50, restart_delay: 5000, time: true, env };

module.exports = {
  apps: BRANCHES.map((code) => ({ name: `cdc-wal-${code}`, script: SCRIPT, args: `--branch=${code} --watch`, ...base })),
};
