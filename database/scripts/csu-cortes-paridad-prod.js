/* eslint-disable no-console */
/**
 * `[CSU.10]` Antes/después de Cortes/Sucursales EN PROD, sólo lectura: paridad exacta de la salida y
 * tiempo de la SQL de antes contra la nueva, con los datos reales.
 *
 *   node database/scripts/csu-cortes-paridad-prod.js [AAAA-MM-DD desde] [AAAA-MM-DD hasta] [--antes=<ref>]
 *   (default: 2026-10-01 .. 2026-10-31)
 *
 * Candados: (1) la identidad del clúster (`pg_control_system`) tiene que ser la de prod — el nombre
 * de la base NO sirve, `md` es una restauración y se llama igual; (2) transacción READ ONLY;
 * (3) statement_timeout; (4) ROLLBACK siempre. Lee `PROD_DB_URL` del `.env` (de preferencia un
 * usuario de sólo lectura). La SQL vieja tardaba ~80 s en el banco local: es una lectura PESADA,
 * córrela fuera de horario pico.
 */
const fs = require('fs');
const path = require('path');
const L = require('./_lib/csu-cortes-sql');
require('dotenv').config({ path: path.join(L.REPO, '.env') });
const { Client } = require('pg');

const PROD_CLUSTER_ID = process.env.PROD_CLUSTER_ID || '7688376744939610156';
const args = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const from = args[0] || '2026-10-01', to = args[1] || '2026-10-31';
const ANTES = (process.argv.find((a) => a.startsWith('--antes=')) || '').slice(8) || L.ANTES_CSU10;

(async () => {
  if (!process.env.PROD_DB_URL) throw new Error('Falta PROD_DB_URL en .env');
  const sql = L.sqlNueva();
  const vieja = L.sqlVieja(ANTES);
  const c = new Client({ connectionString: process.env.PROD_DB_URL, application_name: 'csu10-paridad-prod' });
  await c.connect();
  try {
    const id = (await c.query('SELECT system_identifier::text AS id FROM pg_control_system()')).rows[0].id;
    if (id !== PROD_CLUSTER_ID) throw new Error(`el clúster ${id} NO es prod (${PROD_CLUSTER_ID})`);
    await c.query('BEGIN TRANSACTION READ ONLY');
    await c.query(`SET LOCAL statement_timeout = '180s'`);
    const tv = [], tn = [];
    let a, b;
    for (let i = 0; i < 3; i++) {
      const t0 = Date.now();
      a = (await c.query(vieja, L.paramsVieja(from, to))).rows;
      tv.push(Date.now() - t0);
      const r = await L.nueva(c, sql, from, to);
      b = r.filas;
      tn.push(r.ms);
      console.log(`corrida ${i + 1}: vieja ${tv[i]} ms · nueva ${r.ms} ms (cortes ${r.msCortes} + cobros ${r.msCobros})`);
    }
    console.log(`MEDIANA ${from}..${to}: vieja ${L.mediana(tv)} ms · nueva ${L.mediana(tn)} ms · ${a.length} cortes crudos`);
    if (L.iguales(a, b)) console.log('PARIDAD OK: salida idéntica campo por campo');
    else { console.log('PARIDAD ROTA'); console.log(L.diferencias(a, b).join('\n')); process.exitCode = 1; }
    const plan = (await c.query(`EXPLAIN (ANALYZE, BUFFERS) ${sql.SQL}`, L.paramsNueva(from, to))).rows.map((x) => x['QUERY PLAN']).join('\n');
    const out = path.join(process.env.PLANES_DIR || process.cwd(), 'plan-csu-nueva-prod.txt');
    fs.writeFileSync(out, plan);
    console.log(`plan de la nueva: ${out}`);
  } finally {
    await c.query('ROLLBACK').catch(() => {});
    await c.end();
  }
})().catch((e) => { console.error('ERROR:', e.message); process.exit(1); });
