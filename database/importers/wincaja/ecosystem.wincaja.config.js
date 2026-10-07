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
const TICKETS = 'database/importers/wincaja/live-tickets-poller-wincaja.js';

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

// [VL.7.3] A DÓNDE ESCRIBE LA RÉPLICA. Hasta el 2026-09-12 era el Postgres local de `.249`
// (`localhost:5433`); ese Postgres se jubila, y la base `wincaja` vive ahora en `md`
// (192.168.0.222:5433) — movida con `pg_dump`/`pg_restore` y cuadrada: 2,316 tablas,
// 147,449,607 filas y 264 sumas de control de dinero idénticas a las del origen.
//
// ⛔ OJO: los tres carriles NO se mudan de máquina. Leen los `.mdb` con Jet de 32 bits sobre `Z:`,
// así que siguen corriendo en `.249`. Lo único que cambia es su DESTINO.
//
// ⚠️ Y se exige explícita, sin default, a propósito. Los tres scripts traen
// `|| 'postgresql://…@localhost:5433/wincaja'` como respaldo: con la base vieja todavía en pie,
// arrancar sin esta variable haría que los carriles escriban felices al Postgres JUBILADO —
// `pm2 ls` en verde, cero errores, y el dato yéndose a una base que nadie lee. Es exactamente el
// modo de falla que ya costó 4 días de réplica en cero (27→31 ago) y que el párrafo de arriba
// describe para `DATABASE_URL_NEW`. Fallar acá, al arrancar, cuesta un minuto; no fallar cuesta
// días.
const REPLICA = process.env.WINCAJA_REPLICA_URL;
if (!REPLICA) {
  throw new Error('falta WINCAJA_REPLICA_URL: exportala antes de "pm2 start". Desde VL.7.3 la '
    + 'réplica vive en md (192.168.0.222:5433/wincaja), no en localhost — y el default de los '
    + 'scripts apunta al Postgres de .249 que se está jubilando.');
}

const base = {
  cwd: REPO, autorestart: true, max_restarts: 50, restart_delay: 5000, time: true,
  env: { DATABASE_URL_NEW: DB, WINCAJA_REPLICA_URL: REPLICA },
};

module.exports = {
  apps: [
    // MOVIMIENTOS (append-only, watermark) → frescura alta.
    { name: 'wincaja-inc', script: WINCAJA, args: '--carril=inc --watch=2', ...base },
    // CATÁLOGOS + existencias (hash-delta, full-scan) → más pesado, cadencia baja.
    { name: 'wincaja-hash', script: WINCAJA, args: '--carril=hash --watch=60', ...base },
    // `[TDA.Wincaja]` TICKETS EN VIVO → `/tienda/live`. Lee la réplica cruda local (:5433/wincaja)
    // y empuja los tickets de venta de las tiendas Wincaja (30/32) al monitor de prod, igual que el
    // poller de Kepler hace con 00-06. A diferencia de los dos carriles de arriba, éste SÍ escribe a
    // prod (POST /store/live/ingest), así que necesita STORE_INGEST_URL/KEY — las lee del .env del
    // repo (el propio script hace dotenv). El WINDOW ancho (20 min) absorbe la latencia del carril
    // `wincaja-inc` (~2 min): un ticket recién replicado entra en el siguiente poll, el upsert
    // idempotente descarta el solape. NO emite heartbeat propio (como el de Kepler): su salud se ve
    // en el propio /tienda/live y en el sensor `store_live`.
    { name: 'wincaja-live-tickets', script: TICKETS, ...base },
  ],
};
