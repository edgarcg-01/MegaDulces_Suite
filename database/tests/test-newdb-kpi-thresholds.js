'use strict';
/* eslint-disable no-console */
/**
 * `[CDRP.2]` — **El registro de umbrales, probado contra Postgres de verdad.**
 *
 * El clasificador se prueba en `libs/contracts` (es una función pura y ahí hay runner). Lo que
 * NO se puede probar ahí es lo que sólo existe en la base: los CHECK, el índice único con
 * `COALESCE`, y el RLS. Un `CHECK` sin una fila que lo viole es una intención (ADR-056), así que
 * cada uno se rompe a propósito y se verifica que Postgres lo rechace.
 *
 * ⛔ Corre contra `DATABASE_URL_NEW` (réplica de pruebas), porque ESCRIBE. Nunca contra prod.
 *
 * Uso:  node database/tests/test-newdb-kpi-thresholds.js
 */

const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '..', '.env'), quiet: true });

const DST = process.env.DATABASE_URL_NEW;
if (!DST) {
  console.error('Falta DATABASE_URL_NEW.');
  process.exit(1);
}
if (/railway/.test(DST)) {
  console.error('⛔ DATABASE_URL_NEW apunta a PROD y esta suite ESCRIBE. Abortado.');
  process.exit(1);
}

const knex = require('knex')({ client: 'pg', connection: DST });
const TABLA = 'analytics.kpi_thresholds';
const TENANT = '00000000-0000-0000-0000-00000000d01c';
/** Prefijo propio: todo lo que esta suite escribe se borra al final por esta marca. */
const PFX = `test.cdrp2.${Date.now()}.`;

let ok = 0;
let fail = 0;
function check(nombre, cond, extra) {
  if (cond) {
    ok++;
    console.log(`  OK   ${nombre}`);
  } else {
    fail++;
    console.log(`  FAIL ${nombre}${extra !== undefined ? ' — ' + JSON.stringify(extra) : ''}`);
  }
}

/** Corre algo que DEBE fallar y devuelve el `code` de Postgres (o null si no falló). */
async function rechaza(fn) {
  try {
    await fn();
    return null;
  } catch (e) {
    return e.code || 'sin-code';
  }
}

const base = (over) => ({
  tenant_id: TENANT,
  kpi_key: PFX + 'ventas',
  position_code: null,
  period: 'mes',
  target: 100,
  warn_at: 95,
  escalate_at: 80,
  direction: 'higher_is_better',
  escalate_to: 'direccion',
  source: 'suite de pruebas',
  ...over,
});

(async () => {
  console.log('\n══ [CDRP.2] Registro de umbrales ══');

  console.log('\n── 1. La tabla y su gobierno ──');
  const cols = await knex('information_schema.columns')
    .where({ table_schema: 'analytics', table_name: 'kpi_thresholds' })
    .pluck('column_name');
  check('la tabla existe', cols.length > 0, cols.length);
  for (const c of ['kpi_key', 'position_code', 'period', 'target', 'warn_at', 'escalate_at',
    'direction', 'escalate_to', 'source', 'manual_lock', 'auto_tuned_at']) {
    check(`columna ${c}`, cols.includes(c));
  }
  /*
   * `manual_lock` y `auto_tuned_at` no son opcionales: son el primitivo heredado de Horus
   * (ADR-021). Sin ellos, el día que exista un auto-calibrador va a pisar lo que Dirección fijó.
   */
  check('⛔ hereda el pin humano de Horus (manual_lock + auto_tuned_at)',
    cols.includes('manual_lock') && cols.includes('auto_tuned_at'));

  const rls = await knex.raw(
    `SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE oid = ?::regclass`, [TABLA]);
  check('RLS habilitado y FORZADO',
    rls.rows[0] && rls.rows[0].relrowsecurity === true && rls.rows[0].relforcerowsecurity === true,
    rls.rows[0]);

  console.log('\n── 2. Nace VACÍA, y eso es la verdad ──');
  /*
   * ⛔ Si algún día alguien siembra un umbral "de ejemplo", este candado se pone rojo. Es
   * deliberado: un umbral inventado convierte el tablero en decorado, y es peor que no tenerlo.
   */
  const reales = await knex(TABLA).whereNull('deleted_at').whereNot('kpi_key', 'like', 'test.%')
    .count({ n: '*' }).first();
  check('sin umbrales sembrados (no existe ninguna meta que registrar)',
    Number(reales.n) === 0, reales.n);

  /*
   * ⭐ EL CANDADO QUE ESTE BLOQUE NECESITABA Y NO TENÍA.
   *
   * La justificación de que la tabla nazca vacía es una MEDICIÓN («no hay metas por renglón»), y
   * una medición con fecha envejece. Ésta duró tres días: la migración afirmaba «las 6 tablas de
   * presupuesto tienen 0 filas (2026-09-18)» y al 2026-09-21 ya eran 13 tablas con 3 pobladas
   * (Fase PU), incluido un presupuesto FY2027 en borrador capturado ese mismo día. La afirmación
   * quedó además persistida en `COMMENT ON TABLE`, en prod, donde nadie la iba a revisar.
   *
   * Así que la medición deja de ser un comentario y pasa a ser una compuerta: **el día que
   * aparezca el primer RENGLÓN de presupuesto, esta suite se pone roja** — no porque algo se haya
   * roto, sino porque la razón para tener la tabla vacía dejó de existir y toca registrar el
   * primer umbral con su `source`. Un comentario no avisa; un test sí.
   *
   * ⚠️ Se miran los RENGLONES, no los encabezados: `budget.budgets` con una fila es un
   * presupuesto empezado, no una meta. La meta es `meta_amount` en una línea.
   */
  const TABLAS_DE_META = [
    'budget.sales_plan_lines',   // ⭐ de acá saldrá la meta de ventas (medido 2026-09-21)
    'budget.budget_lines',
    'budget.expense_plan_lines',
    'commercial.sales_targets',  // tiene la forma exacta y CERO escritores
  ];
  const conRenglones = [];
  for (const t of TABLAS_DE_META) {
    const existe = await knex.raw('SELECT to_regclass(?) AS t', [t]);
    if (!existe.rows[0] || !existe.rows[0].t) continue; // ausente ≠ vacía: se declara, no se cuenta
    const n = await knex(t).count({ n: '*' }).first();
    if (Number(n.n) > 0) conRenglones.push(`${t}=${n.n}`);
  }
  check('⛔ la razón de nacer vacía sigue vigente: cero RENGLONES de presupuesto ' +
    '(si esto se pone rojo, ya hay meta y toca registrar el primer umbral, no aflojar el test)',
    conRenglones.length === 0, conRenglones);

  // Y el `COMMENT ON TABLE` no puede seguir publicando la medición que ya se corrigió.
  const com = await knex.raw('SELECT obj_description(?::regclass) AS c', [TABLA]);
  check('⛔ NEGATIVA — el comentario de la tabla no repite la medición vencida del 2026-09-18',
    !/6 tablas de presupuesto/.test((com.rows[0] && com.rows[0].c) || ''));

  console.log('\n── 3. Los CHECK, cada uno roto a propósito ──');
  const insertado = await knex(TABLA).insert(base()).returning('id');
  check('una fila coherente SÍ entra', insertado.length === 1);

  check('⛔ NEGATIVA — periodo fuera de la lista se rechaza',
    (await rechaza(() => knex(TABLA).insert(base({ kpi_key: PFX + 'p', period: 'quincena' })))) === '23514');
  check('⛔ NEGATIVA — dirección inventada se rechaza',
    (await rechaza(() => knex(TABLA).insert(base({ kpi_key: PFX + 'd', direction: 'mas_o_menos' })))) === '23514');
  check('⛔ NEGATIVA — clave vacía se rechaza',
    (await rechaza(() => knex(TABLA).insert(base({ kpi_key: '   ' })))) === '23514');
  check('⛔ NEGATIVA — procedencia vacía se rechaza (un umbral sin origen no es un umbral)',
    (await rechaza(() => knex(TABLA).insert(base({ kpi_key: PFX + 's', source: '' })))) === '23514');

  /*
   * El caso que justifica el CHECK de coherencia: el amarillo POR ENCIMA de la meta. El
   * clasificador nunca devolvería `warn` y el indicador saltaría de verde a rojo sin aviso.
   */
  check('⛔ NEGATIVA — amarillo por ENCIMA de la meta (higher_is_better) se rechaza',
    (await rechaza(() => knex(TABLA).insert(
      base({ kpi_key: PFX + 'c1', target: 90, warn_at: 95 })))) === '23514');
  check('⛔ NEGATIVA — en lower_is_better el orden se invierte, y también se exige',
    (await rechaza(() => knex(TABLA).insert(base({
      kpi_key: PFX + 'c2', direction: 'lower_is_better', target: 100, warn_at: 95, escalate_at: 80,
    })))) === '23514');
  check('lower_is_better coherente (target ≤ warn ≤ escalate) SÍ entra',
    (await rechaza(() => knex(TABLA).insert(base({
      kpi_key: PFX + 'c3', direction: 'lower_is_better', target: 80, warn_at: 95, escalate_at: 100,
    })))) === null);

  /*
   * ⛔ Y el que de verdad protege: RECORTAR LA META y olvidar el amarillo. Es el descuido real —
   * nadie inserta una fila incoherente, la dejan incoherente al editarla, y un presupuesto que se
   * ajusta a mitad de año es justo eso.
   *
   * ⚠️ Este caso empezó al revés («subir la meta») y la prueba lo refutó: con `higher_is_better`
   * subir el target lo ALEJA del amarillo y no rompe nada. El comentario de la migración decía lo
   * mismo y también se corrigió.
   */
  const id = insertado[0].id || insertado[0];
  check('subir la meta NO es incoherente (se aleja del amarillo) y debe aceptarse',
    (await rechaza(() => knex(TABLA).where({ id }).update({ target: 200 }))) === null);
  check('⛔ NEGATIVA — RECORTAR la meta por debajo del amarillo se rechaza en el UPDATE',
    (await rechaza(() => knex(TABLA).where({ id }).update({ target: 90 }))) === '23514');

  console.log('\n── 4. El único por (kpi, puesto, periodo) ──');
  check('⛔ NEGATIVA — dos filas genéricas del mismo KPI y periodo chocan (COALESCE en el índice)',
    (await rechaza(() => knex(TABLA).insert(base()))) === '23505');
  check('la del PUESTO convive con la genérica',
    (await rechaza(() => knex(TABLA).insert(base({ position_code: 'jefe_zona' })))) === null);
  check('⛔ NEGATIVA — dos del MISMO puesto chocan',
    (await rechaza(() => knex(TABLA).insert(base({ position_code: 'jefe_zona' })))) === '23505');
  check('otro periodo del mismo KPI convive',
    (await rechaza(() => knex(TABLA).insert(base({ period: 'dia' })))) === null);

  console.log('\n── 5. El contrato y la migración dicen lo MISMO ──');
  const fs = require('fs');
  const srcC = fs.readFileSync(
    path.resolve(__dirname, '../../libs/contracts/src/http/kpi-threshold.contract.ts'), 'utf8');
  /*
   * ⛔ El estado que este registro existe para que NO pase: sin fila, el clasificador tiene que
   * devolver `sin_meta`. Si alguien lo cambia a `ok`, vuelve el `cfg ? classify : 'ok'`.
   */
  check('⛔ el contrato devuelve sin_meta cuando no hay umbral, NUNCA ok',
    /if \(!umbral\)[\s\S]{0,200}estado: 'sin_meta'/.test(srcC));
  check('el contrato distingue las DOS ausencias', /'sin_meta'/.test(srcC) && /'sin_medir'/.test(srcC));
  check('tiene su spec con negativas',
    fs.existsSync(path.resolve(__dirname, '../../libs/contracts/src/http/kpi-threshold.spec.ts')));
  const srcM = fs.readFileSync(
    path.resolve(__dirname, '../migrations-newdb/20260921120000_analytics_kpi_thresholds.js'), 'utf8');
  for (const v of ['higher_is_better', 'lower_is_better', 'dia', 'semana', 'mes', 'trimestre', 'anio']) {
    check(`la migración y el contrato comparten el valor "${v}"`,
      srcM.includes(`'${v}'`) && srcC.includes(`'${v}'`));
  }

  // Limpieza: sólo lo de esta corrida.
  const borradas = await knex(TABLA).where('kpi_key', 'like', PFX + '%').del();
  check('la suite limpia lo suyo', borradas > 0, borradas);

  console.log(`\n${ok} OK · ${fail} FAIL`);
  await knex.destroy();
  process.exit(fail === 0 ? 0 : 1);
})().catch(async (e) => {
  console.error('ERROR:', e.message);
  try { await knex(TABLA).where('kpi_key', 'like', PFX + '%').del(); await knex.destroy(); } catch { /* noop */ }
  process.exit(1);
});
