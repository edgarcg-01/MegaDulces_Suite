/* eslint-disable no-console */
/**
 * [VP.3.3] CANDADO — la bitácora de corridas de feeds (ADR-056).
 *
 * ── LO QUE ESTE TEST EXISTE PARA QUE NO VUELVA ───────────────────────────────────────────
 * `analytics.cron_runs` tiene PK `(tenant_id, job_key)` — un renglón por job, UPSERT en cada
 * corrida. Perfecto para "¿está sano AHORA?" e incapaz de contestar lo que se pregunta cuando un
 * número sorprende: *"¿cuántas filas tocó el importer de precios el martes?"*, *"¿cuántas veces
 * falló este mes?"*, *"¿desde cuándo viene el hueco?"*.
 *
 * ── LO QUE CANDADEA, Y POR QUÉ CADA UNO ──────────────────────────────────────────────────
 *  1. Una corrida terminada deja **exactamente una** fila. Ni cero (se perdió) ni dos (el UPSERT
 *     del heartbeat escribe varias veces y duplicaría el conteo de fallas).
 *  2. `running` NO deja fila: es un estado, no un hecho consumado. Su síntoma vive en `cron_runs`
 *     y lo vigila el `maxRunH` de db-health como COLGADO.
 *  3. Un re-UPSERT del MISMO cierre tampoco: si contara, "cuántas veces falló" saldría inflado.
 *  4. Se conservan las cifras que se van a consultar (`rows_affected`, `duration_ms`, `error`).
 *  5. El trigger **nunca lanza**: el hecho primario ya vive en `cron_runs`, y tumbar el latido de
 *     un feed por no poder escribir su bitácora cambiaría un problema chico por uno grande. Es la
 *     asimetría opuesta a la del trigger de VP.3.1, y es deliberada.
 *  6. `app_runtime` no puede editar ni borrar la bitácora.
 *
 *   DATABASE_URL_NEW=… node database/tests/test-newdb-cron-run-log.js
 */
const { Client } = require('pg');
const { esFaltaDeAcceso, noMedido } = require('./_lib/no-medido');

const URL = process.env.DATABASE_URL_NEW || process.env.DST_URL
  || 'postgresql://postgres:superoot@localhost:5433/postgres_platform';
const TEN = process.env.CRON_TENANT_ID || '00000000-0000-0000-0000-00000000d01c';
const JOB = '__test_vp33';

let ok = 0; let fail = 0;
const ck = (l, c, d = '') => {
  if (c) { ok++; console.log(`  ✔ ${l}`); } else { fail++; console.log(`  ✖ ${l}${d ? ` — ${d}` : ''}`); }
};

(async () => {
  const c = new Client({ connectionString: URL, ssl: /rlwy|railway|proxy/i.test(URL) ? { rejectUnauthorized: false } : false });
  await c.connect().catch((e) => {
    if (esFaltaDeAcceso(e)) noMedido(`no se pudo conectar a la base — ${e.message}`);
    throw e;
  });
  const q = async (s, p) => (await c.query(s, p)).rows;
  console.log('\n=== VP.3.3 · la bitácora de corridas de feeds ===\n');

  if (!(await q(`SELECT to_regclass('analytics.cron_run_log') IS NOT NULL AS ok`))[0].ok) {
    noMedido('falta la migración 20260907140000 en este destino');
  }
  ck('analytics.cron_run_log existe', true);

  const cuenta = async () => Number((await q(
    `SELECT count(*)::int n FROM analytics.cron_run_log WHERE job_key=$1`, [JOB]))[0].n);

  // El heartbeat real: INSERT ... ON CONFLICT DO UPDATE. Se replica su forma exacta para que el
  // test ejercite el camino que usan los 13 importers, no uno inventado.
  const latir = async (status, extra = {}) => c.query(`
    INSERT INTO analytics.cron_runs
      (tenant_id, job_key, label, last_start, last_finish, status, rows_affected, duration_ms, host, error, updated_at)
    VALUES ($1,$2,'candado VP.3.3', now(), $3, $4, $5, $6, 'test', $7, now())
    ON CONFLICT (tenant_id, job_key) DO UPDATE SET
      last_finish = EXCLUDED.last_finish, status = EXCLUDED.status,
      rows_affected = EXCLUDED.rows_affected, duration_ms = EXCLUDED.duration_ms,
      host = EXCLUDED.host, error = EXCLUDED.error, updated_at = now()`,
  [TEN, JOB, extra.finish ?? null, status, extra.rows ?? null, extra.ms ?? null, extra.error ?? null]);

  try {
    await c.query(`DELETE FROM analytics.cron_run_log WHERE job_key=$1`, [JOB]);
    await c.query(`DELETE FROM analytics.cron_runs WHERE job_key=$1`, [JOB]);

    // (1) begin() → running: no es un hecho consumado.
    await latir('running');
    ck('un job en RUNNING no deja fila (es un estado, no una corrida)', (await cuenta()) === 0);

    // (2) end() → ok: una corrida, una fila.
    await latir('ok', { finish: new Date(), rows: 1234, ms: 5678 });
    ck('una corrida terminada deja EXACTAMENTE una fila', (await cuenta()) === 1);
    const r1 = (await q(`SELECT * FROM analytics.cron_run_log WHERE job_key=$1 ORDER BY id DESC LIMIT 1`, [JOB]))[0];
    ck('conserva rows_affected (la pregunta "cuántas filas tocó el martes")', Number(r1.rows_affected) === 1234);
    ck('conserva duration_ms', Number(r1.duration_ms) === 5678);
    ck('conserva el status terminal', r1.status === 'ok');
    ck('conserva finished_at', !!r1.finished_at);

    // (3) el MISMO cierre reescrito no es una corrida nueva.
    const antes = await cuenta();
    await c.query(`UPDATE analytics.cron_runs SET host='test2' WHERE job_key=$1 AND tenant_id=$2`, [JOB, TEN]);
    ck('re-UPSERT del MISMO cierre no duplica (si contara, "cuántas veces falló" saldría inflado)',
      (await cuenta()) === antes, `${antes} → ${await cuenta()}`);

    // (4) corrida siguiente: running otra vez y luego error.
    await latir('running');
    ck('volver a RUNNING sigue sin dejar fila', (await cuenta()) === 1);
    await latir('error', { finish: new Date(Date.now() + 1000), rows: 0, error: 'ECONNRESET de prueba' });
    ck('la SEGUNDA corrida deja su propia fila', (await cuenta()) === 2);
    const r2 = (await q(`SELECT * FROM analytics.cron_run_log WHERE job_key=$1 ORDER BY id DESC LIMIT 1`, [JOB]))[0];
    ck('conserva el error (para "¿lleva semanas fallando o es de hoy?")', /ECONNRESET/.test(r2.error || ''));
    ck('status = error', r2.status === 'error');

    // (5) la serie se puede leer, que es el punto de todo esto.
    const serie = await q(
      `SELECT status, rows_affected FROM analytics.cron_run_log WHERE job_key=$1 ORDER BY id`, [JOB]);
    ck('la serie histórica queda consultable (ok → error)',
      serie.map((s) => s.status).join(',') === 'ok,error', serie.map((s) => s.status).join(','));

    // (6) el trigger NO puede tumbar un latido. Se rompe la bitácora a propósito y se comprueba
    //     que el feed sigue pudiendo latir — es la asimetría deliberada contra VP.3.1.
    await c.query(`ALTER TABLE analytics.cron_run_log ADD CONSTRAINT tmp_vp33_imposible CHECK (false) NOT VALID`);
    let latioIgual = true;
    try { await latir('ok', { finish: new Date(Date.now() + 2000), rows: 7 }); } catch { latioIgual = false; }
    await c.query(`ALTER TABLE analytics.cron_run_log DROP CONSTRAINT tmp_vp33_imposible`);
    ck('con la bitácora rota, el feed IGUAL puede latir (el trigger no lanza)', latioIgual,
      'tumbar un latido por no poder escribir su bitácora sería cambiar un problema chico por uno grande');
    const vivo = (await q(`SELECT status, rows_affected FROM analytics.cron_runs WHERE job_key=$1`, [JOB]))[0];
    ck('y el hecho primario sobrevive en cron_runs', vivo && Number(vivo.rows_affected) === 7,
      JSON.stringify(vivo));
  } finally {
    await c.query(`ALTER TABLE analytics.cron_run_log DROP CONSTRAINT IF EXISTS tmp_vp33_imposible`).catch(() => {});
    await c.query(`DELETE FROM analytics.cron_run_log WHERE job_key=$1`, [JOB]).catch(() => {});
    await c.query(`DELETE FROM analytics.cron_runs WHERE job_key=$1`, [JOB]).catch(() => {});
  }

  // (7) inmutable para la app + la purga existe y NO está agendada.
  const g = (await q(`
    SELECT privilege_type FROM information_schema.table_privileges
     WHERE table_schema='analytics' AND table_name='cron_run_log' AND grantee='app_runtime'`))
    .map((r) => r.privilege_type).sort();
  ck('app_runtime tiene INSERT+SELECT y NADA más', g.join(',') === 'INSERT,SELECT', g.join(','));
  ck('la purga existe como función manual',
    !!(await q(`SELECT to_regprocedure('analytics.prune_cron_run_log(int)') IS NOT NULL AS ok`))[0].ok);

  await c.end();
  console.log(`\n  ${ok} OK · ${fail} falla(s)\n`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
