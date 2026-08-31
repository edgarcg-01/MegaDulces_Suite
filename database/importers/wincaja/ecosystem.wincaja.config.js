/**
 * PM2 ecosystem — réplica cruda Wincaja (Access 97 → :5433/wincaja). DURABLE (autorestart, sobrevive
 * reinicios con `pm2 save` + `pm2 startup`). **Reemplaza la Windows Scheduled Task `WincajaReplicaLoop`**
 * (que corría run-wincaja-replica.ps1 --once cada 15 min).
 *
 * DOS CARRILES (WR.5.1) → frescura real sin re-escanear catálogos cada rato:
 *   - wincaja-inc  : movimientos append-only (watermark Consecutivo/Folio), barato → @2 min.
 *   - wincaja-hash : catálogos/existencias mutables (md5-en-JS, full-scan), caro → @60 min.
 *
 * ON-PREM ONLY: lee el .mdb vía Jet 32-bit (PS32). Correr en la MÁQUINA que tiene el .mdb + `Z:` montado
 * (WINCAJA_MDB_BASE, default `Z:/Salidas/Bases/Actuales`) + Postgres local `:5433/wincaja`
 * (WINCAJA_REPLICA_URL). NO va en Railway (sin Jet). Distinto del ecosystem kepler (que empuja a prod
 * por feeds-ingest); acá se escribe DIRECTO a la réplica local, sin FEEDS_SINK.
 *
 * Arranque (una vez, en la box on-prem de Wincaja):
 *   # (si WINCAJA_MDB_BASE / WINCAJA_REPLICA_URL no son los defaults, exportarlos antes)
 *   pm2 start database/importers/wincaja/ecosystem.wincaja.config.js
 *   pm2 save            # persiste la lista
 *   pm2 startup         # (una vez) para que reviva tras reinicio de Windows
 *   # y BORRAR la tarea vieja:
 *   schtasks /Delete /TN "WincajaReplicaLoop" /F     (o Task Scheduler → deshabilitar/eliminar)
 *
 * Operación:  pm2 ls · pm2 logs wincaja-inc · pm2 restart wincaja-hash · pm2 stop all
 * Observabilidad: cada carril emite heartbeat `wincaja_replica_inc` / `wincaja_replica_hash` a cron_runs
 * (FeedGuardian/db-health) — ajustar umbrales por carril (inc ~5min, hash ~2h).
 */

const path = require('path');
const REPO = path.resolve(__dirname, '..', '..', '..'); // .../Trade_marketing
const WINCAJA = 'database/importers/wincaja/replicate-wincaja-live.js';

// Escribe directo a :5433/wincaja (NO usa feeds-ingest) → sin FEEDS_SINK.
//
// El heartbeat SÍ necesita la DB de plataforma (escribe a cron_runs). PM2 no hereda el entorno del
// shell de forma confiable, y sin esta var los dos carriles corren MUDOS: es exactamente lo que dejó
// la réplica 4 días en cero (27→31 ago 2026) mientras `pm2 ls` decía "online". Se pasa explícita y
// se falla ACÁ, al arrancar, en vez de dos días después en un log que nadie mira.
const DB = process.env.DATABASE_URL_NEW || process.env.DATABASE_URL;
if (!DB) {
  throw new Error('falta DATABASE_URL_NEW: exportala antes de "pm2 start" — el heartbeat la necesita '
    + 'para reportar a cron_runs; sin ella un feed muerto es indistinguible de uno sano.');
}
const base = {
  cwd: REPO, autorestart: true, max_restarts: 50, restart_delay: 5000, time: true,
  env: { DATABASE_URL_NEW: DB },
};

module.exports = {
  apps: [
    // MOVIMIENTOS (append-only, watermark) → frescura alta.
    { name: 'wincaja-inc', script: WINCAJA, args: '--carril=inc --watch=2', ...base },
    // CATÁLOGOS + existencias (hash-delta, full-scan) → más pesado, cadencia baja.
    { name: 'wincaja-hash', script: WINCAJA, args: '--carril=hash --watch=60', ...base },
  ],
};
