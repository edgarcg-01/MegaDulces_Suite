/**
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

module.exports = {
  apps: [
    // PRODUCTO: CDC ctid → kepler_ods.kdii → normalize-al-llegar (catalog.products + product_prices).
    { name: 'sync-product', script: 'database/importers/kepler/replicate-ods-fast.js', args: '--apply --watch=10 --tables=kdii', ...base },
    // STOCK: kdil de las 5 sucursales → delta → commercial.stock (fórmula c4+c8-c9).
    { name: 'sync-stock', script: 'database/importers/kepler/import-branch-stock-live.js', args: '--apply --watch=15', ...base },
    // VENTAS (Kepler mayoreo): mart.ventas_enriched → analytics.sales_daily (ventana 2d/ciclo).
    { name: 'sync-sales', script: 'database/importers/kepler/import-sales-fact.js', args: '--apply --watch=60', ...base },
  ],
};
