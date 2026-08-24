/**
 * Heartbeat de crons → analytics.cron_runs (Salud BD grupo "Crons").
 *
 * Uso como módulo (feeds node):
 *   const hb = require('../lib/cron-heartbeat');
 *   await hb.begin('wincaja_sync', 'Wincaja sync (05:00)');
 *   try { ...; await hb.end('wincaja_sync', { status: 'ok', rows }); }
 *   catch (e) { await hb.end('wincaja_sync', { status: 'error', error: e.message }); throw e; }
 *
 * Uso como CLI (orquestadores PowerShell):
 *   node lib/cron-heartbeat.js begin wincaja_sync "Wincaja sync (05:00)"
 *   node lib/cron-heartbeat.js end   wincaja_sync ok
 *   node lib/cron-heartbeat.js end   wincaja_sync error "detalle del fallo"
 *
 * NUNCA lanza: si no puede escribir el heartbeat, avisa por consola y sigue (no debe
 * tumbar el feed). Conexión por DATABASE_URL_NEW (fallback DATABASE_URL).
 */
const os = require('os');
const { Client } = require('pg');

const TENANT = process.env.CRON_TENANT_ID || '00000000-0000-0000-0000-00000000d01c';

function client() {
  const cs = process.env.DATABASE_URL_NEW || process.env.DATABASE_URL;
  if (!cs) throw new Error('sin DATABASE_URL_NEW/DATABASE_URL');
  const ssl = /@(localhost|127\.0\.0\.1|192\.168\.)/.test(cs) ? false : { rejectUnauthorized: false };
  return new Client({ connectionString: cs, ssl, connectionTimeoutMillis: 10000, statement_timeout: 15000, keepAlive: true });
}

async function begin(jobKey, label) {
  // `client()` LANZA si falta la cadena de conexión; construirlo fuera del try rompía el
  // contrato "nunca lanza" y podía tumbar el feed entero por un heartbeat.
  let c;
  try {
    c = client();
    await c.connect();
    // Si la corrida ANTERIOR quedó en 'running', se cierra como error antes de arrancar.
    // Por qué: `end()` nunca lanza (no debe tumbar el feed), así que cuando la BD está
    // inalcanzable justo al terminar, el cierre se pierde y el job queda 'running' para
    // siempre → el monitor lo reporta como **COLGADO** aunque en realidad **FALLÓ**. Eso
    // pasó el 24/08/2026 con `wincaja_sync` (GOLD murió con ROLLBACK por caída de conexión)
    // y mandó el diagnóstico por el camino equivocado. Ahora se autocura en el próximo
    // arranque y dice la verdad.
    await c.query(
      `UPDATE analytics.cron_runs
          SET status = 'error', last_finish = now(), updated_at = now(),
              error = COALESCE(error, 'la corrida anterior no reportó cierre (proceso caído o BD inalcanzable al terminar)')
        WHERE tenant_id = $1 AND job_key = $2 AND status = 'running'`,
      [TENANT, jobKey],
    );
    await c.query(
      `INSERT INTO analytics.cron_runs (tenant_id, job_key, label, last_start, status, host, updated_at)
       VALUES ($1,$2,$3, now(), 'running', $4, now())
       ON CONFLICT (tenant_id, job_key) DO UPDATE
         SET label = COALESCE(EXCLUDED.label, analytics.cron_runs.label),
             last_start = now(), status = 'running', host = EXCLUDED.host, updated_at = now()`,
      [TENANT, jobKey, label || jobKey, os.hostname()],
    );
  } catch (e) {
    console.warn(`[cron-heartbeat] begin ${jobKey}: ${e.message}`);
  } finally { try { if (c) await c.end(); } catch { /* nada que cerrar */ } }
}

async function end(jobKey, { status = 'ok', rows = null, note = null, error = null } = {}) {
  // Se reintenta: el cierre es justo lo que se pierde cuando la red parpadea al terminar, y
  // un cierre perdido se lee como job colgado. Sigue sin lanzar nunca.
  const intentos = 3;
  for (let i = 1; i <= intentos; i++) {
    let c;
    try {
      c = client(); // puede lanzar (sin cadena de conexión) → queda dentro del try a propósito
      await c.connect();
      await c.query(
        `UPDATE analytics.cron_runs
           SET last_finish = now(), status = $3, rows_affected = $4, note = $5, error = $6,
               duration_ms = CASE WHEN last_start IS NOT NULL THEN (EXTRACT(EPOCH FROM (now() - last_start))*1000)::bigint END,
               updated_at = now()
         WHERE tenant_id = $1 AND job_key = $2`,
        [TENANT, jobKey, status, rows, note, error ? String(error).slice(0, 500) : null],
      );
      return;
    } catch (e) {
      console.warn(`[cron-heartbeat] end ${jobKey} (intento ${i}/${intentos}): ${e.message}`);
      if (i < intentos) await new Promise((r) => setTimeout(r, 2000 * i));
    } finally { try { if (c) await c.end(); } catch { /* nada que cerrar */ } }
  }
}

module.exports = { begin, end };

// CLI
if (require.main === module) {
  const [, , cmd, jobKey, a1, a2] = process.argv;
  (async () => {
    if (!cmd || !jobKey) { console.error('uso: cron-heartbeat.js begin|end <job_key> [...]'); process.exit(2); }
    if (cmd === 'begin') await begin(jobKey, a1);
    else if (cmd === 'end') await end(jobKey, { status: a1 === 'error' ? 'error' : 'ok', error: a1 === 'error' ? (a2 || 'error') : null, note: a1 === 'error' ? null : (a2 || null) });
    else { console.error(`cmd desconocido: ${cmd}`); process.exit(2); }
  })();
}
