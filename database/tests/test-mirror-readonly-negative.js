/* eslint-disable no-console */
/**
 * `[REP.1.2]` — Prueba NEGATIVA del read-only del espejo, contra PROD de verdad.
 *
 * El espejo PROD → LOCAL lee de producción. Esta suite comprueba que **no puede
 * escribirle**, mandando escrituras a propósito y exigiendo que el motor las
 * rechace. Es la contraparte de `test-target-guard-negative.js`: aquélla prueba
 * la guarda de software; ésta prueba que el motor también dice que no.
 *
 * ── Carga las funciones REALES, no una copia ─────────────────────────────────
 * `openProdReadOnly` y `assertProdIsReadOnly` se importan de
 * `database/scripts/pull-prod-to-local.js`. Una copia se desincroniza y el test
 * se queda verde midiendo un código que ya nadie corre — el mismo error que
 * RE.27 tuvo que corregir leyendo el SQL del servicio en vez de duplicarlo.
 *
 * ── Lo que se midió el 2026-09-08 contra prod (PG 18.6) ──────────────────────
 * Tres candidatas a sonda, y sólo dos sirven:
 *
 *     pg_current_xact_id()  PASA (devolvió el XID 10612378). Igual txid_current().
 *                           Era la sonda que el diseño proponía: habría dado
 *                           verde SIEMPRE. No la vuelvas a poner.
 *     CREATE TEMP TABLE     rechazado 25006 — al revés de lo que decía el diseño.
 *     UPDATE de 0 filas     rechazado 25006 — y es la forma exacta del daño.
 *
 * El UPDATE va además porque GOTCHAS §33: un `SELECT` que funciona no prueba que
 * un `UPDATE` funcione. Ahí un rol "de solo lectura" tumbó prod porque el login
 * SÍ escribía, y todos los chequeos de lectura habían pasado.
 *
 * ── Tercer estado ────────────────────────────────────────────────────────────
 * Si no se puede llegar a prod (sin red, sin credencial), esto reporta
 * **NO MEDIDO** (exit 2), nunca verde: una suite que no pudo comprobar nada no
 * es una suite que aprobó.
 */

const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '..', '.env'), quiet: true });

const { noMedido, esFaltaDeAcceso } = require('./_lib/no-medido');
const {
  openProdReadOnly,
  assertProdIsReadOnly,
  LECTURA,
  TABLA_SONDA,
} = require(path.resolve(__dirname, '../scripts/pull-prod-to-local.js'));

let pass = 0;
let fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log('  ✓', msg); } else { fail++; console.log('  ✗', msg); } };

// ── La allowlist (capa B) es pura: se puede probar sin tocar la red ──────────
function probarAllowlist() {
  const permitidas = [
    'SELECT 1',
    '  select * from x',
    'WITH a AS (SELECT 1) SELECT * FROM a',
    'COPY (SELECT * FROM analytics.cron_runs) TO STDOUT',
    'copy ( with q as (select 1) select * from q ) to stdout',
    'SHOW transaction_read_only',
    'EXPLAIN SELECT 1',
    'SET LOCAL statement_timeout = 1000',
  ];
  const rechazadas = [
    'UPDATE t SET x = 1',
    'DELETE FROM t',
    'INSERT INTO t VALUES (1)',
    'TRUNCATE t',
    'DROP TABLE t',
    'CREATE TABLE t (x int)',
    'ALTER TABLE t ADD COLUMN y int',
    'COPY t FROM STDIN',                       // la dirección peligrosa de COPY
    'REFRESH MATERIALIZED VIEW m',
    'GRANT SELECT ON t TO x',
  ];
  const malPermitidas = rechazadas.filter((s) => LECTURA.test(s));
  const malRechazadas = permitidas.filter((s) => !LECTURA.test(s));
  ok(malPermitidas.length === 0, `capa B rechaza las ${rechazadas.length} formas de escritura${malPermitidas.length ? ` (dejó pasar: ${malPermitidas.join(' | ')})` : ''}`);
  ok(malRechazadas.length === 0, `capa B deja pasar las ${permitidas.length} formas de lectura${malRechazadas.length ? ` (frenó: ${malRechazadas.join(' | ')})` : ''}`);
}

(async () => {
  console.log('\nREP.1.2 read-only del espejo contra PROD\n');

  probarAllowlist();

  const url = process.env.MIRROR_SOURCE_URL || process.env.FLEET_DB_URL;
  if (!url) {
    noMedido('no hay MIRROR_SOURCE_URL ni FLEET_DB_URL: no hay prod contra qué comprobar');
  }

  let prod;
  try {
    prod = await openProdReadOnly(url);
  } catch (e) {
    if (esFaltaDeAcceso(e)) noMedido(`no se pudo llegar a prod — ${e.message}`);
    throw e;
  }

  try {
    const ro = (await prod.query('SHOW transaction_read_only')).rows[0].transaction_read_only;
    ok(ro === 'on', `capa A: la sesión se declara read-only (${ro})`);

    const sonda = await assertProdIsReadOnly(prod);
    ok(sonda.temp === 'rechazado', 'capa C: el motor rechaza CREATE TEMP TABLE con 25006');

    if (sonda.update === 'no_medido') {
      console.log(`  ⓘ capa C: UPDATE sobre ${TABLA_SONDA} NO MEDIDO (la tabla no existe en este destino)`);
    } else {
      ok(sonda.update === 'rechazado', `capa C: el motor rechaza un UPDATE sobre ${TABLA_SONDA} con 25006`);
    }

    // Y que la capa B frene ANTES del cable: el error tiene que ser el nuestro,
    // no un 25006 del motor. Si esto trae 25006, la capa B está desarmada y lo
    // único que nos separa de prod es la configuración de la sesión.
    let mensaje = '';
    try {
      await prod.query('DELETE FROM analytics.cron_runs WHERE false');
    } catch (e) {
      mensaje = e.message;
    }
    ok(/sólo LEE de prod/.test(mensaje), 'capa B frena el DELETE antes de mandarlo al cable (no llega a ser 25006)');

    // Que la lectura siga funcionando: una guarda que rompe el camino feliz se
    // desactiva sola a la semana.
    const n = Number((await prod.query('SELECT count(*)::int n FROM analytics.cron_runs')).rows[0].n);
    ok(Number.isFinite(n), `la lectura sigue funcionando (${n} filas en ${TABLA_SONDA})`);
  } finally {
    try { await prod.end(); } catch { /* nada */ }
  }

  console.log(`\nREP.1.2 read-only del espejo: ${pass} OK, ${fail} fallidos`);
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  if (esFaltaDeAcceso(e)) noMedido(`no se pudo llegar a prod — ${e.message}`);
  console.error('\nERROR:', e.message, '\n');
  process.exit(1);
});
