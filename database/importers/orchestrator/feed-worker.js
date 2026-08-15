/* eslint-disable no-console */
/**
 * WORKER de feeds (pg-boss) — reemplazo gradual del Task Scheduler de Windows.
 *
 * Proceso Node único, siempre-vivo (bajo PM2 como servicio de Windows). Agenda los
 * modos de `run-prod-feeds.js` vía pg-boss (cola respaldada en Postgres, sin Redis/
 * Docker) y los dispara al llegar su cron. NO contiene lógica de feed: spawnea el
 * mismo `run-prod-feeds.js <mode> --apply` que hoy corre el Task Scheduler → el
 * heartbeat `feed_*`, el timeout por paso y el barrido de huérfanos siguen ahí.
 *
 * pg-boss = PULL/polling con SKIP LOCKED (no triggers): el worker jala jobs "listos"
 * de la tabla `pgboss.job` cada ~2s. El cron vive en `pgboss.schedule`; un reloj líder
 * encola el job al llegar la hora. Reintentos con backoff + historial = nativos.
 *
 * ── Migración gradual (sin big-bang) ──
 * `PGBOSS_MODES` (env) = lista separada por comas de los modos que pg-boss POSEE.
 * Los NO listados siguen en el Task Scheduler. Cutover por modo:
 *   1) agregá el modo a PGBOSS_MODES y reiniciá el worker (pm2 restart),
 *   2) DESHABILITÁ la tarea de Windows equivalente,
 *   3) verificá el heartbeat `feed_<modo>` en /admin/db-health.
 * `PGBOSS_MODES=` vacío = no agenda nada (boot de prueba). `all` = todos.
 *
 * Config (archivo de entorno, gitignored — ver README):
 *   PGBOSS_DATABASE_URL   = postgres en .245 (cola durable, siempre-encendida)
 *   PGBOSS_MODES          = receipts,contpaqi,...   (o 'all', o vacío)
 *   DATABASE_URL_NEW      = prod Railway (donde escriben los feeds)
 *   DATABASE_URL_KEPLER_CONSOLIDADO / MEGA_DULCES_URL / FEEDS_SINK / FEEDS_INGEST_* / RECEIPTS_DAYS
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { PgBoss } = require('pg-boss'); // v12: export con nombre (antes era default)

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const TZ = 'America/Mexico_City';
const SCHEDULES = require('./schedules');

// ── Carga de entorno (archivo local gitignored; no pisa lo ya presente en env) ──
function loadEnvFile(f) {
  if (!fs.existsSync(f)) return false;
  for (const line of fs.readFileSync(f, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.+?)\s*$/i);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
  return true;
}
loadEnvFile(process.env.PGBOSS_ENV_FILE || path.join(__dirname, 'orchestrator.local.env'));

const PGBOSS_URL = process.env.PGBOSS_DATABASE_URL;
const MODES_RAW = (process.env.PGBOSS_MODES || '').trim();
const enabled = MODES_RAW === 'all'
  ? SCHEDULES.map((s) => s.mode)
  : MODES_RAW.split(',').map((s) => s.trim()).filter(Boolean);

function log(msg) { console.log(`[${new Date().toISOString()}] ${msg}`); }

// Spawnea run-prod-feeds.js <mode> --apply con el env por-modo mezclado. Resuelve
// en exit 0; rechaza si no → pg-boss marca el job fallido y reintenta (retryLimit).
function runMode(mode, extraEnv) {
  return new Promise((resolve, reject) => {
    const script = path.join('database', 'importers', 'kepler', 'run-prod-feeds.js');
    const child = spawn(process.execPath, [script, mode, '--apply'], {
      cwd: REPO_ROOT,
      stdio: 'inherit',
      env: { ...process.env, ...extraEnv },
    });
    child.on('close', (code) => (code === 0 ? resolve(code) : reject(new Error(`run-prod-feeds ${mode} salió con código ${code}`))));
    child.on('error', (e) => reject(new Error(`no se pudo lanzar ${mode}: ${e.message}`)));
  });
}

(async () => {
  if (!PGBOSS_URL) { console.error('FATAL: falta PGBOSS_DATABASE_URL (cola pg-boss en .245).'); process.exit(2); }
  if (!process.env.DATABASE_URL_NEW) { console.error('FATAL: falta DATABASE_URL_NEW (destino prod de los feeds).'); process.exit(2); }
  const isRailway = /proxy\.rlwy\.net|railway/i.test(process.env.DATABASE_URL_NEW);
  if (!isRailway) console.warn('AVISO: DATABASE_URL_NEW no parece prod (Railway) — run-prod-feeds abortará el --apply por seguridad.');

  const ssl = /@(localhost|127\.0\.0\.1|192\.168\.)/.test(PGBOSS_URL) ? false : { rejectUnauthorized: false };
  const boss = new PgBoss({ connectionString: PGBOSS_URL, ssl, schema: 'pgboss', application_name: 'feed-worker' });
  boss.on('error', (e) => console.error(`[pg-boss] ${e.message}`));

  await boss.start();
  log(`pg-boss arriba (cola en ${PGBOSS_URL.replace(/:[^:@/]+@/, ':***@')}).`);

  if (!enabled.length) {
    log('PGBOSS_MODES vacío → no se agenda ningún modo (boot de prueba). Agregá modos para migrar.');
  }

  for (const s of SCHEDULES) {
    if (!enabled.includes(s.mode)) continue;
    const queue = `feed_${s.mode}`;
    // Cola 'stately': un solo job activo + no se apilan corridas si una se atrasa (≈ IgnoreNew).
    await boss.createQueue(queue, {
      policy: 'stately',
      retryLimit: s.retryLimit ?? 1,
      retryDelay: 60,
      expireInSeconds: (s.expireInMinutes ?? 15) * 60,
      retentionMinutes: 60 * 24 * 7,
    });
    await boss.schedule(queue, s.cron, {}, { tz: TZ });
    await boss.work(queue, { batchSize: 1 }, async ([job]) => {
      const t0 = Date.now();
      log(`▶ ${s.mode} (${s.label}) — job ${job.id}`);
      try {
        await runMode(s.mode, s.env || {});
        log(`✔ ${s.mode} OK en ${Math.round((Date.now() - t0) / 1000)}s`);
      } catch (e) {
        log(`✗ ${s.mode} FALLÓ: ${e.message} — pg-boss reintenta (retryLimit ${s.retryLimit ?? 1})`);
        throw e;
      }
    });
    log(`agendado ${queue}: '${s.cron}' (${TZ}) · ${s.label}`);
  }

  log(`worker listo · modos activos: ${enabled.length ? enabled.join(', ') : '(ninguno)'} · el resto sigue en Task Scheduler.`);

  // Apagado limpio (PM2 manda SIGINT en restart/stop): drena y cierra la conexión.
  for (const sig of ['SIGINT', 'SIGTERM']) {
    process.on(sig, async () => {
      log(`${sig} — cerrando pg-boss…`);
      try { await boss.stop({ graceful: true, timeout: 30000 }); } catch { /* */ }
      process.exit(0);
    });
  }
})().catch((e) => { console.error('FATAL worker:', e); process.exit(1); });
