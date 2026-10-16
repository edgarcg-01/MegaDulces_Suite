#!/usr/bin/env node
'use strict';
/**
 * `[ETQ-CAMBIOS.11]` — Verifica contra una base REAL lo que las pruebas unitarias no pueden: el SQL.
 *
 *   DATABASE_URL_NEW=<url-de-solo-lectura> node database/scripts/verificar-cambios-compras.js [sucursal] [AAAA-MM-DD]
 *
 * SÓLO LEE. No inserta ni una fila: la foto diaria se simula con el mismo `SELECT` sin el `INSERT`.
 *
 * Por qué existe: las pruebas del PR simulan la base, así que **no prueban que `v_kepler_standard_cost`,
 * `v_label_prices` o la bitácora hablen el mismo idioma**. Hay una hipótesis que sostiene toda la pantalla y
 * que sólo se comprueba acá: que el rótulo de la unidad de la bitácora (`CJA`, `PZA`, `500`…) coincide con
 * el rótulo de los peldaños de la ficha. Si no coincide, las columnas de costo dicen «sin dato» y el defecto
 * parecería «poca cobertura», no un casado roto.
 *
 * Lo que no se pueda medir se DECLARA (ADR-056): sale «NO MEDIDO», nunca un verde.
 */
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '..', '.env'), quiet: true });
const knex = require('knex')(require('../knexfile-newdb.js').development);

const SUC = /^[0-9]{2}$/.test(process.argv[2] || '') ? process.argv[2] : '01';
const DIA = /^\d{4}-\d{2}-\d{2}$/.test(process.argv[3] || '') ? process.argv[3] : null;

const pct = (a, b) => (b ? `${((a / b) * 100).toFixed(1)} %` : 'NO MEDIDO');
let rojo = 0;
const ok = (m) => console.log(`  ✔ ${m}`);
const mal = (m) => { rojo++; console.log(`  ✖ ${m}`); };
const nomedido = (m) => console.log(`  ? NO MEDIDO — ${m}`);

async function main() {
  console.log(`\n[ETQ-CAMBIOS.11] plaza ${SUC}${DIA ? ` · día ${DIA}` : ''}\n`);

  // 1. ¿Está la tabla de historia?
  const t = (await knex.raw(`SELECT to_regclass('analytics.product_cost_history') AS t`)).rows[0].t;
  if (t) ok('existe analytics.product_cost_history'); else mal('NO existe analytics.product_cost_history: falta aplicar la migración 20261015131321 ANTES del código');

  // 2. La foto simulada: cuántos costos lee y si el rótulo viene vacío o repetido.
  const vig = (await knex.raw(`
    WITH t AS (
      SELECT sucursal, sku, unidad_base AS unidad, costo_estandar AS costo FROM analytics.v_kepler_standard_cost WHERE costo_estandar > 0
      UNION ALL SELECT sucursal, sku, unidad_dos, costo_estandar_u2 FROM analytics.v_kepler_standard_cost WHERE costo_estandar_u2 > 0
      UNION ALL SELECT sucursal, sku, unidad_tres, costo_estandar_u3 FROM analytics.v_kepler_standard_cost WHERE costo_estandar_u3 > 0)
    SELECT count(*)::int AS filas,
           count(*) FILTER (WHERE unidad IS NULL OR btrim(unidad) = '')::int AS sin_rotulo,
           (SELECT count(*)::int FROM (SELECT 1 FROM t WHERE unidad IS NOT NULL GROUP BY sucursal, sku, unidad HAVING count(*) > 1) d) AS llaves_repetidas
      FROM t`)).rows[0];
  console.log(`\n  La foto leería ${vig.filas.toLocaleString()} costos (plaza×SKU×unidad).`);
  if (vig.filas > 0) ok('la vista de costo estándar devuelve costos'); else mal('la vista de costo estándar no devolvió nada: la foto saldría en rojo');
  console.log(`  · ${vig.sin_rotulo} sin rótulo de unidad (se descartan) · ${vig.llaves_repetidas} llaves con el MISMO rótulo en dos peldaños (gana el costo menor)`);

  // 3. La hipótesis: ¿el rótulo de la bitácora casa con el de la ficha?
  const dia = DIA || (await knex.raw(`SELECT max(fecha)::text AS d FROM analytics.v_label_price_changes WHERE sucursal = ?`, [SUC])).rows[0].d;
  if (!dia) { nomedido('la bitácora no tiene días para esa plaza'); return finish(); }
  const m = (await knex.raw(`
    WITH b AS (
      SELECT DISTINCT sku, upper(btrim(unidad)) AS unidad FROM analytics.v_label_price_changes
       WHERE sucursal = ? AND fecha = ?::date AND unidad IS NOT NULL),
    f AS (
      SELECT sku, upper(btrim(u)) AS unidad FROM analytics.v_kepler_standard_cost c,
             LATERAL (VALUES (c.unidad_base, c.costo_estandar), (c.unidad_dos, c.costo_estandar_u2), (c.unidad_tres, c.costo_estandar_u3)) v(u, k)
       WHERE c.sucursal = ? AND v.u IS NOT NULL AND v.k > 0)
    SELECT count(*)::int AS lineas,
           count(*) FILTER (WHERE EXISTS (SELECT 1 FROM f WHERE f.sku = b.sku AND f.unidad = b.unidad))::int AS casan,
           count(*) FILTER (WHERE (SELECT count(*) FROM f WHERE f.sku = b.sku AND f.unidad = b.unidad) > 1)::int AS ambiguas,
           count(*) FILTER (WHERE NOT EXISTS (SELECT 1 FROM f WHERE f.sku = b.sku))::int AS sku_sin_costo
      FROM b`, [SUC, dia, SUC])).rows[0];
  console.log(`\n  Día ${dia}: ${m.lineas} líneas (sku×unidad) en la bitácora.`);
  console.log(`  · casan por rótulo con un peldaño de la ficha: ${m.casan} (${pct(m.casan, m.lineas)})`);
  console.log(`  · rótulo ambiguo (dos peldaños iguales): ${m.ambiguas} · SKU sin ningún costo en la ficha: ${m.sku_sin_costo}`);
  if (!m.lineas) nomedido('ese día no tiene líneas');
  else if (m.casan / m.lineas >= 0.9) ok('la hipótesis del casado por rótulo se sostiene (≥ 90 %)');
  else mal(`el casado por rótulo cubre sólo ${pct(m.casan, m.lineas)}: las columnas de costo dirán «sin dato» en el resto`);

  // 4. Cobertura de impuesto y proveedor sobre los SKU del día.
  const c = (await knex.raw(`
    WITH s AS (SELECT DISTINCT sku FROM analytics.v_label_price_changes WHERE sucursal = ? AND fecha = ?::date)
    SELECT count(*)::int AS skus,
           count(*) FILTER (WHERE EXISTS (SELECT 1 FROM analytics.v_kepler_standard_cost k WHERE k.sucursal = ? AND k.sku = s.sku AND k.impuesto_pct IS NOT NULL))::int AS con_impuesto,
           count(*) FILTER (WHERE EXISTS (SELECT 1 FROM catalog.products p JOIN catalog.suppliers su ON su.id = p.supplier_id
                                            WHERE p.sku = s.sku AND su.name NOT ILIKE 'PRODUCTOS SIN%'))::int AS con_proveedor,
           count(*) FILTER (WHERE EXISTS (SELECT 1 FROM analytics.v_label_prices l WHERE l.sucursal = ? AND l.sku = s.sku AND l.box_price > 0))::int AS con_caja
      FROM s`, [SUC, dia, SUC, SUC])).rows[0];
  console.log(`\n  Sobre ${c.skus} SKU del día:`);
  console.log(`  · con tasa de impuesto observada: ${c.con_impuesto} (${pct(c.con_impuesto, c.skus)})  ← sin ella el costo con impuesto dice «sin dato»`);
  console.log(`  · con proveedor: ${c.con_proveedor} (${pct(c.con_proveedor, c.skus)})`);
  console.log(`  · con precio de caja (mayoreo): ${c.con_caja} (${pct(c.con_caja, c.skus)})`);

  // 5. Historia: ¿desde cuándo hay foto?
  if (t) {
    const h = (await knex.raw(`SELECT min(valid_from)::text AS desde, count(*)::int AS filas FROM analytics.product_cost_history`)).rows[0];
    if (h.filas) console.log(`\n  Historia: ${h.filas.toLocaleString()} filas desde ${h.desde}.`);
    else nomedido('la historia está vacía: todavía no corrió el cron nocturno (el «costo anterior» sale vacío para todos)');
  }
  return finish();
}

function finish() {
  console.log(rojo ? `\n✖ ${rojo} problema(s)\n` : '\n✔ sin problemas medibles\n');
  process.exitCode = rojo ? 1 : 0;
}

main().catch((e) => { console.error(e.message); process.exitCode = 2; }).finally(() => knex.destroy());
