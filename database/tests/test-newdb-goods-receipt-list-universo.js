#!/usr/bin/env node
/**
 * `[RE.49]` — **La lista de entradas evalúa la vista UNA vez por petición.**
 *
 * `listReceipts` vuelca el universo (tenant + sin copia CEDIS + alcance + carril + rango) a una
 * tabla TEMPORAL de la transacción y todas sus consultas leen de ahí: antes evaluaba
 * `analytics.erp_goods_receipts` (~300 ms cada vez) hasta 7 veces en serie.
 *
 * Esta prueba vigila los cuatro supuestos de los que depende ese cambio:
 *   1. `app_runtime` puede crear tablas temporales (sin eso, la lista daría 500).
 *   2. La temporal trae EXACTAMENTE las filas de la vista con el mismo filtro.
 *   3. Crearla cabe en el presupuesto (< 1 s; medido en prod: 327–430 ms).
 *   4. ⭐ Ninguna llave del universo tiene OTRA fila en la vista fuera de él (copia CEDIS o fecha
 *      previa al arranque). El expediente ahora lee sus entradas de la temporal y no de la vista:
 *      si esto deja de cumplirse, el expediente podría ver una fila distinta de la que veía.
 *      Medido en prod (2026-10-21): 0 de 2,802 llaves.
 *
 * Correr: node database/tests/test-newdb-goods-receipt-list-universo.js
 */

const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '..', '.env'), quiet: true });

let pass = 0, fail = 0, noMedido = 0;
const ok = (c, m) => { if (c) { console.log(`  ✓ ${m}`); pass++; } else { console.error(`  ✗ ${m}`); fail++; } };
const sinMedir = (m) => { console.log(`  ⚠️  NO MEDIDO — ${m}`); noMedido++; };

const T = process.env.TENANT_ID || '00000000-0000-0000-0000-00000000d01c';

(async () => {
  const DST = process.env.DATABASE_URL_NEW;
  if (!DST) {
    sinMedir('sin DATABASE_URL_NEW: los cuatro supuestos necesitan la base');
    console.log(`\n✅ TODO VERDE — ${pass} aserción(es) · ${noMedido} NO MEDIDO(S)`);
    process.exit(0);
  }
  const knex = require('knex')({
    client: 'pg',
    connection: /localhost|127\.0\.0\.1|192\.168/.test(DST) ? DST : { connectionString: DST, ssl: { rejectUnauthorized: false } },
    pool: { min: 0, max: 2 },
  });
  try {
    console.log('\n═══ 1. Permiso ═══');
    const { rows: [p] } = await knex.raw(`SELECT has_database_privilege('app_runtime', current_database(), 'TEMP') AS puede`)
      .catch(() => ({ rows: [{ puede: null }] }));
    if (p.puede === null) sinMedir('no existe el rol app_runtime en este ambiente');
    else ok(p.puede === true, 'app_runtime puede crear tablas temporales');

    const { rows: [cfg] } = await knex.raw(
      `SELECT COALESCE((SELECT to_char(reception_start, 'YYYY-MM-DD') FROM finance.receipt_settings WHERE tenant_id = ?), '2026-08-01') AS inicio`, [T])
      .catch(() => ({ rows: [{ inicio: '2026-08-01' }] }));

    console.log('\n═══ 2–3. La temporal trae lo mismo que la vista, y cabe en el presupuesto ═══');
    // El MISMO armado que `listReceipts` (select c.* + los filtros comunes), con knex.
    const uq = knex('analytics.erp_goods_receipts as c').select('c.*')
      .where('c.tenant_id', T).whereRaw('c.dup_of_folio IS NULL').where('c.receipt_date', '>=', cfg.inicio);
    const { sql, bindings } = uq.toSQL();
    await knex.transaction(async (trx) => {
      const t0 = Date.now();
      await trx.raw(`CREATE TEMP TABLE ?? ON COMMIT DROP AS ${sql}`, ['tmp_gr_prueba', ...bindings]);
      const ms = Date.now() - t0;
      const [{ n: enTemp }] = (await trx.raw('SELECT count(*)::int AS n FROM tmp_gr_prueba')).rows;
      const [{ n: enVista }] = (await trx.raw(`SELECT count(*)::int AS n FROM (${sql}) v`, bindings)).rows;
      ok(enTemp === enVista, `misma cantidad de filas: temporal ${enTemp} = vista ${enVista}`);
      ok(ms < 1000, `crear la temporal cabe en el presupuesto (${ms} ms; prod: 327–430 ms)`);
      // Se revierte con un error centinela: nada de esto debe quedar en la base.
      throw new Error('__revertir__');
    }).catch((e) => { if (e?.message !== '__revertir__') ok(false, `la temporal no se pudo crear: ${e?.message}`); });

    console.log('\n═══ 4. Invariante de llaves (de él depende leer el expediente de la temporal) ═══');
    const { rows: [inv] } = await knex.raw(
      `WITH v AS MATERIALIZED (SELECT sucursal, folio, dup_of_folio, receipt_date FROM analytics.erp_goods_receipts WHERE tenant_id = ?),
            u AS (SELECT DISTINCT sucursal, folio FROM v WHERE dup_of_folio IS NULL AND receipt_date >= ?)
       SELECT count(*)::int AS llaves,
              count(*) FILTER (WHERE n > 1)::int AS con_mas_de_una,
              count(*) FILTER (WHERE fuera > 0)::int AS con_fila_fuera
         FROM (SELECT u.sucursal, u.folio, count(*) n,
                      count(*) FILTER (WHERE v.dup_of_folio IS NOT NULL OR v.receipt_date < ?) fuera
                 FROM u JOIN v USING (sucursal, folio) GROUP BY 1, 2) z`, [T, cfg.inicio, cfg.inicio]);
    if (!inv.llaves) sinMedir('no hay entradas en este ambiente');
    else ok(inv.con_mas_de_una === 0 && inv.con_fila_fuera === 0,
      `ninguna de las ${inv.llaves} llaves tiene otra fila fuera del universo (más de una: ${inv.con_mas_de_una} · fuera: ${inv.con_fila_fuera})`);
  } catch (e) {
    console.error('  ✗ ERROR', e.message);
    fail++;
  } finally {
    await knex.destroy();
  }
  console.log(`\n${fail === 0 ? '✅ TODO VERDE' : `❌ ${fail} fallo(s)`} — ${pass} aserción(es)${noMedido ? ` · ${noMedido} NO MEDIDO(S)` : ''}`);
  process.exit(fail === 0 ? 0 : 1);
})();
