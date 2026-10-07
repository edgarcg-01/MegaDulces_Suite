/**
 * ⛔ RETIRADO 2026-09-05. NO arrancar: los CUATRO apps ya tienen dueño en otro lado, y levantarlos
 * acá crea un SEGUNDO dueño del mismo carril — el modo de falla que documenta el hermano
 * `ecosystem.cdc.config.js` (dos procesos peleando el mismo watermark y escribiendo el MISMO
 * renglón de `analytics.cron_runs`, que sólo tiene PK (tenant_id, job_key), sin host → uno le
 * presta el pulso al otro y un carril colgado sale `healthy`).
 *
 * Verificado renglón por renglón el 2026-09-05:
 *   · sync-product → `replicate-ods-live.js --tables=kdii` == el contenedor `ods-live-hot`
 *     (`ops/vl/docker-compose.yml`), que ya trae kdii en KP_ODS_TABLES y ODS_HASH_TABLES.
 *     Mismo script, mismo `ods.ctl`/`ods.shadow`, mismo latido `ods_live_hot`.
 *   · sync-stock   → `import-branch-stock-live.js` ya corre dentro de `run-prod-feeds.js`
 *     (tarea `\Kepler\Stock`, latido `feed_stock`).
 *   · sync-sales   → `import-sales-fact.js` ya corre dentro de `run-prod-feeds.js`
 *     (tareas `\Live` y `\Kepler\Nightly`, latido `kepler_sales_fact`).
 *   · ods-cdc      → `ods-cdc-forward.js`, el CDC por WAL retirado en OBS.8; sus slots ya se
 *     dropearon de los replicas. Ver `ecosystem.cdc.config.js`.
 *
 * Se conserva el archivo (no se borra) porque documenta la topología de la Fase SYNC y el
 * `--watch` de cada carril. Regla que sale de acá: **un carril = UN dueño**, y hoy ese dueño es
 * Docker para el ODS y el Programador de tareas para los feeds.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * PM2 ecosystem — loops de sincronización "al momento" (Fase SYNC). DURABLE (autorestart,
 * sobrevive reinicios con `pm2 save` + `pm2 startup`). Reemplaza correr los loops a mano.
 *
 * Los 3 loops empujan por FEEDS_SINK=http → feeds-ingest (ingress gratis). Requieren en el
 * entorno (NO se hardcodean acá): FEEDS_INGEST_URL, FEEDS_INGEST_KEY, DATABASE_URL_NEW, y
 * para sales-fact DATABASE_URL_KEPLER_CONSOLIDADO (default :5433). Sourcealos de run-feeds.cmd
 * ANTES de arrancar.
 *
 * Arranque (una vez, en la .249):
 *   # 1) importar las vars al entorno del proceso (incluye la key; no se imprime)
 *   Get-Content 'C:\KeplerRunner\run-feeds.cmd' | ForEach-Object {
 *     if ($_ -match '^\s*@?set\s+"?([A-Za-z_][A-Za-z0-9_]*)=(.*?)"?\s*$') {
 *       [Environment]::SetEnvironmentVariable($matches[1], $matches[2], 'Process') } }
 *   # 2) arrancar los 3 loops
 *   pm2 start database/importers/kepler/ecosystem.sync.config.js
 *   pm2 save            # persiste la lista
 *   pm2 startup         # (una vez) para que reviva tras reinicio de Windows
 *
 * Operación:  pm2 ls · pm2 logs sync-product · pm2 restart sync-stock · pm2 stop all
 *
 * OJO: si dejaste loops corriendo a mano (consola), matalos antes de arrancar PM2 para no
 * duplicar (dos loops del mismo feed se pisan en el watermark/snapshot — inofensivo pero
 * derrocha). Wincaja POS va aparte (run-wincaja-live.ps1 vía Task Scheduler; usa Jet 32-bit).
 */

const path = require('path');
const REPO = path.resolve(__dirname, '..', '..', '..'); // .../Trade_marketing

// FEEDS_SINK=http forzado; el resto de las vars se heredan del entorno (secretos NO acá).
const env = { ...process.env, FEEDS_SINK: 'http' };
const base = { cwd: REPO, env, autorestart: true, max_restarts: 50, restart_delay: 5000, time: true };

// ⛔⛔ [CT.2 2026-09-24] EL FRENO, QUE FALTABA.
//
// Este archivo se declaraba RETIRADO desde el 2026-09-05 **en un comentario**, y exportaba los
// cuatro apps con toda normalidad. Un comentario no frena a `pm2 start`: levantaba un SEGUNDO
// `replicate-ods-live.js --tables=kdii` peleando el `ods.ctl`/`ods.shadow` con `ods-live-hot` y
// escribiendo su mismo renglón de `analytics.cron_runs` — el falso verde que este mismo
// encabezado describe. Y no es hipotético: `PM2 Resurrect ODS` ya revivió una vez los carriles
// de ContPAQi tras un reinicio de Windows, y corrieron duplicados y mudos.
//
// El hermano `ecosystem.cdc.config.js` sí frenaba. Éste no. Ahora los dos fallan igual.
throw new Error(
  'ecosystem.sync.config.js está RETIRADO (2026-09-05). Sus cuatro carriles YA tienen dueño: ' +
  'sync-product → contenedor `ods-live-hot` · sync-stock → línea `stock` de ops/vl/crontab.feeds · ' +
  'sync-sales → líneas `live`/`nightly` de ops/vl/crontab.feeds · ods-cdc → retirado en OBS.8. ' +
  'Arrancarlo acá crea un SEGUNDO dueño del watermark y del latido: un carril = UN dueño.',
);

module.exports = {
  apps: [
    // PRODUCTO: réplicas lógicas locales (01-06, INCLUYE Canindo) → hash-delta → kepler_ods.kdii
    // → normalize-al-llegar. Evoluciona replicate-ods-fast (ctid, 00-05, perdía UPDATE in-place).
    { name: 'sync-product', script: 'database/importers/kepler/replicate-ods-live.js', args: '--apply --watch=10 --tables=kdii', ...base },
    // STOCK: kdil de las 5 sucursales → delta → commercial.stock (fórmula c4+c8-c9).
    { name: 'sync-stock', script: 'database/importers/kepler/import-branch-stock-live.js', args: '--apply --watch=15', ...base },
    // VENTAS (Kepler mayoreo): mart.ventas_enriched → analytics.sales_daily (ventana 2d/ciclo).
    { name: 'sync-sales', script: 'database/importers/kepler/import-sales-fact.js', args: '--apply --watch=60', ...base },
    // ESPEJO CDC: trigger ALWAYS en el replica encola I/U/D de las ~315 tablas mutables → este
    // forwarder drena la cola y empuja SOLO el delta a kepler_ods. Reemplaza el re-scan del carril
    // hash → las 335 tablas frescas casi al segundo sin re-leer. Requiere el setup una vez
    // (ods-cdc-setup.js --apply). Las append-only grandes (kdm1/kdm2…) van por sync-product/ctid.
    { name: 'ods-cdc', script: 'database/importers/kepler/ods-cdc-forward.js', args: '--apply --watch=5', ...base },
  ],
};
