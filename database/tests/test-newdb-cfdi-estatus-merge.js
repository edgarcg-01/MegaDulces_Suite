/* eslint-disable no-console */
/**
 * `[LC.19.1]` — Candado de la fusión de `fiscal.cfdis.estatus_sat` en el feed del ADD.
 *
 * El defecto (medido el 2026-10-21): el UPSERT del feed hacía `estatus_sat = EXCLUDED.estatus_sat`
 * y el ADD lo trae vacío (→ `desconocido`), así que borraba lo que el cron FISCAL.6 había
 * verificado ante el SAT. 100 % de los recibidos de ago/sep/oct-2026 «sin verificar».
 *
 *   1. ⭐ la regla, evaluada por Postgres sobre los 9 casos (guardado × entrante);
 *   2. ⛔ prueba negativa: la expresión vieja (`EXCLUDED` a secas) reprueba la misma tabla;
 *   3. el UPSERT con la forma EXACTA del feed compila contra la tabla real (EXPLAIN, que no
 *      ejecuta: corre igual en una transacción de sólo lectura contra prod);
 *   4. el feed arma `estatus_sat` con esta regla y no con la vieja.
 *
 * No escribe en ningún destino.
 */
const path = require('path');
const fs = require('fs');

const ROOT = path.resolve(__dirname, '..', '..');
require('dotenv').config({ path: path.join(ROOT, '.env'), quiet: true });
const { Client } = require('pg');
const { mergeEstatusSatSql } = require(path.join(ROOT, 'database', 'importers', 'contpaqi', 'estatus-sat-merge.js'));

let ok = 0;
let fail = 0;
let nm = 0;
const check = (cond, label) => {
  if (cond) { ok += 1; console.log(`  ✓ ${label}`); } else { fail += 1; console.log(`  ✗ ${label}`); }
};

// guardado, entrante → esperado
const CASOS = [
  ['vigente', 'desconocido', 'vigente'],      // ⭐ el caso que rompía: el ADD no preguntó
  ['cancelado', 'desconocido', 'cancelado'],  // ⭐ ni una cancelación nuestra se pierde
  ['desconocido', 'desconocido', 'desconocido'],
  ['vigente', 'vigente', 'vigente'],
  ['desconocido', 'vigente', 'vigente'],      // el ADD sí trae «Cancelable…»
  ['vigente', 'cancelado', 'cancelado'],      // el ADD sabe que se canceló
  ['desconocido', 'cancelado', 'cancelado'],
  ['cancelado', 'vigente', 'cancelado'],      // ⛔ absorbente: cancelado no revive
  [null, 'desconocido', 'desconocido'],
];

async function evaluar(c, expr) {
  const valores = CASOS.map((_, i) => `($${i * 2 + 1}::text, $${i * 2 + 2}::text, ${i})`).join(',');
  const { rows } = await c.query(
    `SELECT i, ${expr('v.actual', 'v.entrante')} AS fundido FROM (VALUES ${valores}) AS v(actual, entrante, i) ORDER BY i`,
    CASOS.flatMap(([a, e]) => [a, e]));
  return rows.map((r) => r.fundido);
}

(async () => {
  const url = process.env.DATABASE_URL_NEW;
  if (!url) { nm += 1; console.log('  ⚠ NO MEDIDO: sin DATABASE_URL_NEW'); }
  else {
    const c = new Client({ connectionString: url });
    await c.connect();
    try {
      await c.query('BEGIN READ ONLY');

      console.log('\n[1] La regla, evaluada por Postgres');
      const res = await evaluar(c, mergeEstatusSatSql);
      CASOS.forEach(([a, e, esperado], i) => check(res[i] === esperado, `guardado ${a ?? 'NULL'} + llega ${e} → ${res[i]} (esperado ${esperado})`));

      console.log('\n[2] Prueba negativa: la expresión vieja');
      const vieja = await evaluar(c, (_a, e) => e);
      const malas = CASOS.filter(([, , esperado], i) => vieja[i] !== esperado).length;
      check(malas >= 3, `⛔ \`EXCLUDED.estatus_sat\` a secas reprueba ${malas} de ${CASOS.length} casos — el candado sí distingue`);

      console.log('\n[3] El UPSERT del feed compila contra la tabla real');
      const sqlUpsert = `INSERT INTO fiscal.cfdis AS t (tenant_id, uuid, estatus_sat) VALUES ($1, $2, $3)
         ON CONFLICT (tenant_id, uuid) DO UPDATE SET estatus_sat=${mergeEstatusSatSql('t.estatus_sat', 'EXCLUDED.estatus_sat')}, updated_at=now()`;
      let errPlan = null;
      try { await c.query(`EXPLAIN ${sqlUpsert}`, ['00000000-0000-0000-0000-00000000d01c', 'X', 'desconocido']); }
      catch (e) { errPlan = e.message; }
      if (errPlan && /permission denied/.test(errPlan)) {
        // El usuario de este destino no puede escribir en fiscal.cfdis (en prod, a propósito):
        // ni EXPLAIN de un INSERT. Se mide en `pruebas-db`, donde hay permisos.
        nm += 1; console.log(`  ⚠ NO MEDIDO: el UPSERT no se pudo planear aquí (${errPlan})`);
      } else {
        check(!errPlan, `EXPLAIN del INSERT … ON CONFLICT con el alias \`t.estatus_sat\`${errPlan ? `: ${errPlan}` : ''}`);
      }
      await c.query('ROLLBACK');
    } finally {
      await c.end();
    }
  }

  console.log('\n[4] El feed usa la regla');
  const feed = fs.readFileSync(path.join(ROOT, 'database', 'importers', 'contpaqi', 'import-contpaqi-cfdis.js'), 'utf8');
  check(/require\('\.\/estatus-sat-merge'\)/.test(feed)
    && /c === 'estatus_sat'[\s\S]{0,120}mergeEstatusSatSql\('t\.estatus_sat', 'EXCLUDED\.estatus_sat'\)/.test(feed)
    && /INSERT INTO fiscal\.cfdis AS t \(/.test(feed),
    'import-contpaqi-cfdis.js arma estatus_sat con mergeEstatusSatSql sobre el alias t (cableado, leído del fuente)');

  console.log(`\n${fail === 0 ? '✅' : '❌'} LC.19.1 fusión de estatus_sat: ${ok} ✓ / ${fail} ✗${nm ? ` · ${nm} NO MEDIDO` : ''}\n`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.log(`  ✗ excepción: ${e && e.message}`); process.exit(1); });
