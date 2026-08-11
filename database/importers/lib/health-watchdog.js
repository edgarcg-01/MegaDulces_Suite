/* eslint-disable no-console */
/**
 * WATCHDOG on-prem — "¿quién vigila al vigilante?".
 *
 * El scanner de Salud BD vive en el API (@Cron). Si el proceso del API muere o su cron
 * se traba (pasó el 07-31: 10 días ciego), NADIE alerta. Este watchdog corre ON-PREM como
 * proceso FRESCO cada corrida (no se puede "trabar" como un @Cron de proceso largo) y es el
 * dead-man's switch: **solo actúa cuando el scanner del API está caído**, así no duplica
 * alertas mientras el API esté sano (ahí el scanner del API ya cubre todo).
 *
 * Qué hace cuando detecta el scanner caído:
 *   1. Abre/actualiza alertas en `analytics.db_health_alerts` (→ bell, cuando el API web esté vivo).
 *   2. Si hay `WATCHDOG_WEBHOOK_URL`, POST del resumen (push externo — funciona AUNQUE el API esté 100% caído).
 * Cuando el scanner del API revive: resuelve sus alertas (cede el control al scanner).
 *
 * Config (de wincaja/sync.local.env — gitignored — o env):
 *   DATABASE_URL_NEW      = prod (mismo que usan los feeds)
 *   WATCHDOG_WEBHOOK_URL  = (opcional) webhook Slack/Discord/etc. para push externo
 *
 *   node database/importers/lib/health-watchdog.js          # 1 corrida
 *   node database/importers/lib/health-watchdog.js --dry     # no escribe, solo reporta
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { Client } = require('pg');

const DRY = process.argv.includes('--dry');
const MEGA = '00000000-0000-0000-0000-00000000d01c';

// Cargar sync.local.env (prod DATABASE_URL_NEW + WATCHDOG_WEBHOOK_URL opcional).
(function loadLocalEnv() {
  const f = path.join(__dirname, '..', 'wincaja', 'sync.local.env');
  if (!fs.existsSync(f)) return;
  for (const line of fs.readFileSync(f, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.+?)\s*$/i);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
})();

const DB_URL = process.env.WATCHDOG_DB_URL || process.env.DATABASE_URL_NEW;
const WEBHOOK = process.env.WATCHDOG_WEBHOOK_URL || null;

// Jobs vigilados. `canary` = si ÉSTE está stale, el scanner del API está caído.
const JOBS = [
  { key: 'db_health_scan',    label: 'Scanner Salud BD (API)',       maxMin: 30, canary: true },
  { key: 'analytics_refresh', label: 'Refresh MVs analytics (API)',  maxMin: 60 },
  { key: 'kepler_stock',      label: 'Kepler stock vivo',            maxMin: 30 },
  { key: 'wincaja_live',      label: 'Wincaja live (exist+ventas+mov)', maxMin: 45 },
  { key: 'kepler_sales_fact', label: 'Kepler ventas (sales-fact)',   maxMin: 90 },
  { key: 'wincaja_sync',      label: 'Wincaja sync diario',          maxMin: 30 * 60 },
];

function postWebhook(text) {
  return new Promise((resolve) => {
    if (!WEBHOOK) return resolve(false);
    let lib, u;
    try { u = new URL(WEBHOOK); lib = u.protocol === 'https:' ? require('https') : require('http'); }
    catch { return resolve(false); }
    const body = Buffer.from(JSON.stringify({ text, content: text }), 'utf8'); // Slack=text, Discord=content
    const req = lib.request(u, { method: 'POST', headers: { 'content-type': 'application/json', 'content-length': body.length }, timeout: 15000 },
      (res) => { res.on('data', () => {}); res.on('end', () => resolve(res.statusCode >= 200 && res.statusCode < 300)); });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.write(body); req.end();
  });
}

(async () => {
  if (!DB_URL) { console.error('watchdog: falta DATABASE_URL_NEW (en wincaja/sync.local.env o env).'); process.exit(2); }
  const ssl = /@(localhost|127\.0\.0\.1|192\.168\.)/.test(DB_URL) ? false : { rejectUnauthorized: false };
  const db = new Client({ connectionString: DB_URL, ssl, connectionTimeoutMillis: 15000, statement_timeout: 30000 });
  await db.connect();
  try {
    const rows = (await db.query(
      `SELECT job_key, status, last_finish,
              EXTRACT(EPOCH FROM (now() - last_finish))/60 AS age_min
       FROM analytics.cron_runs WHERE tenant_id=$1 AND job_key = ANY($2)`,
      [MEGA, JOBS.map((j) => j.key)],
    )).rows;
    const byKey = new Map(rows.map((r) => [r.job_key, r]));

    const isFailing = (j) => {
      const r = byKey.get(j.key);
      if (!r) return true;                       // nunca reportó = sospechoso
      if (r.status === 'error') return true;
      return r.age_min != null && Number(r.age_min) > j.maxMin;
    };

    const canary = JOBS.find((j) => j.canary);
    const scannerDown = isFailing(canary);

    console.log(`\n=== Watchdog Salud BD (${DRY ? 'DRY' : 'LIVE'}) ===`);
    for (const j of JOBS) {
      const r = byKey.get(j.key);
      const age = r && r.age_min != null ? `${Math.round(r.age_min)}min` : 'sin dato';
      console.log(`  ${isFailing(j) ? '✗' : '✓'} ${j.key.padEnd(20)} ${age.padStart(9)}  (${r?.status || '—'})`);
    }
    console.log(`  → scanner del API: ${scannerDown ? 'CAÍDO' : 'vivo'}`);

    // Alertas abiertas del watchdog (para reconciliar).
    const open = (await db.query(
      `SELECT id, source_key FROM analytics.db_health_alerts
       WHERE tenant_id=$1 AND resolved_at IS NULL AND source_key LIKE 'watchdog%'`, [MEGA],
    )).rows;
    const openByKey = new Map(open.map((r) => [r.source_key, r]));

    const nowFailingKeys = new Set();
    const newlyOpened = [];

    if (scannerDown) {
      // El scanner del API está caído → el watchdog toma el control y reporta lo que ve.
      for (const j of JOBS) {
        if (!isFailing(j)) continue;
        const sk = `watchdog:${j.key}`;
        nowFailingKeys.add(sk);
        const r = byKey.get(j.key);
        const ageSec = r && r.age_min != null ? Math.round(Number(r.age_min) * 60) : null;
        const note = `Watchdog on-prem: ${j.label} sin latido${r ? ` hace ${Math.round(r.age_min)}min` : ' (sin registro)'}` +
                     (j.canary ? ' — el scanner del API está caído' : '');
        if (openByKey.has(sk)) {
          if (!DRY) await db.query(
            `UPDATE analytics.db_health_alerts SET status='critical', age_seconds=$2, note=$3, last_seen_at=now(), updated_at=now() WHERE id=$1`,
            [openByKey.get(sk).id, ageSec, note]);
        } else {
          if (!DRY) await db.query(
            `INSERT INTO analytics.db_health_alerts (tenant_id, source_key, source_label, group_key, status, age_seconds, note, detail, last_seen_at, updated_at)
             VALUES ($1,$2,$3,'watchdog','critical',$4,$5,$6,now(),now())`,
            [MEGA, sk, j.label, ageSec, note, JSON.stringify({ watchdog: true, job: j.key })]);
          newlyOpened.push(`${j.label} (${r ? Math.round(r.age_min) + 'min' : 'sin registro'})`);
        }
      }
    }

    // Resolver alertas del watchdog cuya condición ya no aplica (scanner revivió o el job volvió).
    let resolved = 0;
    for (const a of open) {
      if (nowFailingKeys.has(a.source_key)) continue;
      if (!DRY) await db.query(`UPDATE analytics.db_health_alerts SET resolved_at=now(), updated_at=now() WHERE id=$1`, [a.id]);
      resolved++;
    }

    console.log(`  abiertas/actualizadas: ${nowFailingKeys.size} · nuevas: ${newlyOpened.length} · resueltas: ${resolved}`);

    // Push externo SOLO en fallas nuevas (anti-spam; el bell muestra las persistentes).
    if (newlyOpened.length && WEBHOOK && !DRY) {
      const ok = await postWebhook(`🚨 Salud BD (watchdog on-prem): el scanner del API está CAÍDO.\nSin latido: ${newlyOpened.join(' · ')}`);
      console.log(`  webhook: ${ok ? 'enviado' : 'falló/no-config'}`);
    }
  } catch (e) {
    console.error('watchdog ERROR:', e.message);
    process.exitCode = 1;
  } finally { await db.end(); }
})();
