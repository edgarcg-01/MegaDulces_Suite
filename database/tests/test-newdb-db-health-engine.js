/* eslint-disable no-console */
/**
 * DBH — CANDADOS de Salud de Base de Datos: motor, correo y ruido.
 *
 * Los tres problemas que este test existe para que no vuelvan, todos medidos el 2026-09-01:
 *
 *  1. **El motor no se veía.** Las ~45 fuentes miden frescura del dato ("¿llegó?"), ninguna medía
 *     el estado de Postgres ("¿cómo está?"). Con 1,339,125 filas muertas en una sola tabla y una
 *     consulta corriendo 12 minutos, no había pantalla que lo dijera.
 *  2. **El aviso no salía de la pestaña.** `wincaja_branch_stale` estuvo 20 días en `critical`; el
 *     único canal era un toast WS que se emite sólo en la transición. Sin `last_notified_at` no hay
 *     forma de recordar sin spamear cada 5 minutos.
 *  3. **La bandeja era ruido.** El barrido iteraba tenants y abría una alerta por cada uno del MISMO
 *     problema de infraestructura: 5 problemas reales → 20 filas, 15 de ellas de tenants de prueba.
 *     488 alertas creadas en cinco semanas, **cero** reconocidas.
 *
 *   DATABASE_URL_NEW=… node database/tests/test-newdb-db-health-engine.js
 */
const { Client } = require('pg');

const PLATFORM = process.env.CRON_TENANT_ID || '00000000-0000-0000-0000-00000000d01c';
const URL = process.env.DATABASE_URL_NEW || process.env.DST_URL
  || 'postgresql://postgres:superoot@localhost:5433/postgres_platform';

let ok = 0; let fail = 0;
const check = (label, cond, detail = '') => {
  if (cond) { ok++; console.log(`  ✔ ${label}`); }
  else { fail++; console.log(`  ✖ ${label}${detail ? ` — ${detail}` : ''}`); }
};

(async () => {
  const c = new Client({ connectionString: URL, ssl: /rlwy|railway|proxy/i.test(URL) ? { rejectUnauthorized: false } : false });
  await c.connect();
  console.log('\n=== DBH · motor, correo y ruido de Salud BD ===\n');

  // ── 1. El SQL del reporte de motor corre y devuelve formas usables ────────────────────────
  // Son consultas a catálogos: si Postgres cambia de versión y una columna se va, esto lo caza
  // acá y no con un 500 en la pantalla de un admin.
  const act = (await c.query(`
    SELECT count(*)::int AS conns,
           count(*) FILTER (WHERE state = 'active')::int AS activas,
           count(*) FILTER (WHERE state = 'idle in transaction')::int AS idle_tx,
           COALESCE(max(EXTRACT(EPOCH FROM (now() - query_start))) FILTER (WHERE state = 'active'), 0)::int AS query_s,
           COALESCE(max(EXTRACT(EPOCH FROM (now() - state_change))) FILTER (WHERE state = 'idle in transaction'), 0)::int AS idle_tx_s,
           (SELECT setting::int FROM pg_settings WHERE name = 'max_connections') AS max_conns
      FROM pg_stat_activity WHERE backend_type = 'client backend'`)).rows[0];
  check('actividad: la consulta corre', !!act);
  check('actividad: hay al menos esta conexión', Number(act.conns) >= 1, `conns=${act.conns}`);
  check('actividad: max_connections se lee', Number(act.max_conns) > 0, `max=${act.max_conns}`);
  check('actividad: los segundos no son negativos', Number(act.query_s) >= 0 && Number(act.idle_tx_s) >= 0);

  const bloat = (await c.query(`
    SELECT schemaname, relname, n_live_tup, n_dead_tup, last_autovacuum,
           pg_total_relation_size(relid) AS size_bytes
      FROM pg_stat_user_tables WHERE n_dead_tup > 0 ORDER BY n_dead_tup DESC LIMIT 25`)).rows;
  check('hinchazón: la consulta corre', Array.isArray(bloat));
  check('hinchazón: viene ordenada de mayor a menor',
    bloat.every((r, i) => i === 0 || Number(bloat[i - 1].n_dead_tup) >= Number(r.n_dead_tup)));
  check('hinchazón: el tamaño es un número', bloat.every((r) => Number(r.size_bytes) >= 0));

  const db = (await c.query(`SELECT pg_size_pretty(pg_database_size(current_database())) AS s,
                                    split_part(version(), ' on ', 1) AS v`)).rows[0];
  check('base: tamaño y versión legibles', !!db.s && /PostgreSQL/i.test(db.v), `${db.s} · ${db.v}`);

  const av = (await c.query(`SELECT name, setting FROM pg_settings WHERE name LIKE 'autovacuum%'`)).rows;
  check('autovacuum: hay settings que mostrar', av.length > 0, `${av.length} parámetros`);
  // El porqué del umbral de 20%: es el default de Postgres. Si alguien lo cambia, el umbral del
  // panel deja de significar "autovacuum no alcanza" y hay que revisarlo.
  const scale = av.find((r) => r.name === 'autovacuum_vacuum_scale_factor');
  check('autovacuum: scale_factor presente (el umbral del panel se calibra contra él)', !!scale,
    scale ? `= ${scale.setting}` : 'ausente');

  // ── 2. El recordatorio de correo tiene dónde apoyarse ─────────────────────────────────────
  const col = (await c.query(`
    SELECT data_type FROM information_schema.columns
     WHERE table_schema='analytics' AND table_name='db_health_alerts' AND column_name='last_notified_at'`)).rows[0];
  check('db_health_alerts.last_notified_at existe', !!col, 'sin ella el recordatorio de 24 h no es posible');
  check('last_notified_at es timestamptz', col?.data_type === 'timestamp with time zone', col?.data_type);

  // El anti-spam de fondo: UNA sola alerta abierta por fuente. Si este índice se cae, cada ciclo
  // de 5 min abre una fila nueva y el correo se multiplica por 288 al día.
  const uq = (await c.query(`
    SELECT indexdef FROM pg_indexes
     WHERE schemaname='analytics' AND tablename='db_health_alerts' AND indexname='uq_db_health_alerts_open'`)).rows[0];
  check('índice único parcial de alerta abierta sigue vivo', !!uq);
  check('el único parcial filtra por resolved_at IS NULL', /resolved_at IS NULL/i.test(uq?.indexdef || ''), uq?.indexdef);

  // ── 3. El ruido: las alertas de infraestructura son de UN tenant, no de todos ──────────────
  const porTenant = (await c.query(`
    SELECT tenant_id::text AS t, count(*)::int AS n
      FROM analytics.db_health_alerts WHERE resolved_at IS NULL GROUP BY 1`)).rows;
  const ajenas = porTenant.filter((r) => r.t !== PLATFORM);
  check('no hay alertas abiertas de tenants ajenos',
    ajenas.length === 0,
    ajenas.length ? `${ajenas.length} tenant(s): ${ajenas.map((r) => `${r.t.slice(0, 8)}…=${r.n}`).join(', ')} — corré el scanner para que las cierre` : '');

  // Un mismo problema no puede tener dos filas abiertas.
  const dup = (await c.query(`
    SELECT source_key, count(*)::int AS n FROM analytics.db_health_alerts
     WHERE resolved_at IS NULL GROUP BY 1 HAVING count(*) > 1`)).rows;
  check('ninguna fuente tiene alertas abiertas duplicadas', dup.length === 0,
    dup.map((r) => `${r.source_key}×${r.n}`).join(', '));

  await c.end();
  console.log(`\n  ${ok} OK · ${fail} falla(s)\n`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
