/**
 * Registro de cadencias del orquestador de feeds (pg-boss).
 *
 * Fuente única de la programación on-prem. Cada entrada = un MODO de
 * `run-prod-feeds.js` (el orquestador que HOY dispara el Task Scheduler). pg-boss
 * NO duplica lógica: solo agenda y dispara ese mismo script → el heartbeat `feed_*`
 * y las guardas de timeout/huérfanos siguen viviendo en run-prod-feeds.js.
 *
 * `cron` = expresión estándar de 5 campos, evaluada en TZ `America/Mexico_City`
 * (mismo horario que el Task Scheduler actual). Extraído de las tareas reales:
 *   Stock PT15M · Live PT30M · Receipts PT1M · Contpaqi PT1M · Intraday PT1H ·
 *   ContpaqiSlow PT2H · Nightly diario 03:00 · Catalog diario 02:00.
 *
 * `env` = variables por-modo que hoy setea run-feeds.cmd condicionalmente (ventanas
 * rodantes). Las globales (URLs de DB, FEEDS_SINK, ingest key, RECEIPTS_DAYS) van en
 * el archivo de entorno del worker, NO acá (sin secretos en el repo).
 *
 * `expireInMinutes` = backstop de pg-boss si un modo se cuelga pese al timeout interno.
 * Los LOOPS continuos (livefast, ods-fast) NO están acá: siguen como tareas-loop
 * propias; migran después si conviene.
 */
module.exports = [
  { mode: 'receipts',      cron: '* * * * *',    label: 'Recepciones XA2001',        env: {},                                                            retryLimit: 1, expireInMinutes: 5 },
  { mode: 'contpaqi',      cron: '* * * * *',    label: 'ContPAQi pólizas+bancos',   env: {},                                                            retryLimit: 1, expireInMinutes: 5 },
  { mode: 'stock',         cron: '*/15 * * * *', label: 'Stock existencia',          env: {},                                                            retryLimit: 2, expireInMinutes: 12 },
  { mode: 'live',          cron: '*/30 * * * *', label: 'Venta viva',                env: { SALES_FACT_DAYS: '2' },                                       retryLimit: 2, expireInMinutes: 15 },
  { mode: 'intraday',      cron: '0 * * * *',    label: 'Transaccionales intradía',  env: { PAYMENTS_DAYS: '120', COLLECTIONS_DAYS: '120', KEPLER_BANK_DAYS: '120', STOCK_MOVEMENTS_DAYS: '15', SKIP_AUTOLINK: '1' }, retryLimit: 1, expireInMinutes: 30 },
  { mode: 'contpaqi-slow', cron: '0 */2 * * *',  label: 'ContPAQi balanza+prov',     env: {},                                                            retryLimit: 1, expireInMinutes: 30 },
  { mode: 'catalog',       cron: '0 2 * * *',    label: 'Catálogo + precios',        env: {},                                                            retryLimit: 1, expireInMinutes: 60 },
  { mode: 'nightly',       cron: '0 3 * * *',    label: 'Batch nocturno',            env: {},                                                            retryLimit: 1, expireInMinutes: 120 },
];
