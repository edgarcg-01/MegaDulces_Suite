#!/usr/bin/env node
'use strict';
/**
 * `[NP.3]` Candado de Productos nuevos: la matvista mide lo que dice.
 *
 * Siembra un escenario con resultado CONOCIDO (`_lib/new-products-scenario.js`) por el camino
 * real —documentos de Kepler en el ODS—, refresca `mv_kepler_sales_daily` y `mv_new_products`
 * DENTRO de una transacción y la REVIERTE al final: no deja rastro en la base.
 *
 * Cada cifra se compara contra un cálculo hecho por separado en JavaScript sobre los mismos datos
 * sembrados. Verificar la vista contra sí misma pasaría los errores en verde.
 *
 * Lo que vigila, además de las cifras:
 *   · un producto que se mueve desde hace 262 días NO sale como nuevo;
 *   · un producto sin entrada en Kepler tiene inversión NULL, no 0;
 *   · la recompra es en una plaza que ya lo tenía, no el surtido inicial en otra plaza;
 *   · el código DESC se excluye solo; el código de barras repetido levanta la señal;
 *   · un producto dado de alta sin movimiento aparece como tal.
 *
 * ⛔ Escribe (y revierte): no corre contra producción (`assertSafeTarget`). Necesita un usuario
 * dueño de las matvistas para el REFRESH (el `postgres` de la base local).
 *
 *   node database/tests/test-newdb-new-products.js
 */
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '..', '.env'), quiet: true });
require('./_lib/assert-safe-target').assertSafeTarget('test-newdb-new-products');
const knex = require('knex')(require('../knexfile-newdb.js').development);
const esc = require('./_lib/new-products-scenario');

let ok = 0;
let ko = 0;
let noMedido = 0;
const check = (desc, cond, detalle) => {
  if (cond) { ok += 1; console.log(`  ✓ ${desc}`); }
  else { ko += 1; console.log(`  ✗ ${desc}${detalle !== undefined ? `  → ${JSON.stringify(detalle)}` : ''}`); }
};
const num = (v) => (v === null || v === undefined ? null : Math.round(Number(v) * 100) / 100);
const iso = (v) => (v === null || v === undefined ? null : new Date(v).toISOString().slice(0, 10));

(async () => {
  console.log('\n=== [NP.3] Productos nuevos — la matvista contra un escenario conocido ===\n');
  const existe = await knex.raw(`SELECT to_regclass('analytics.mv_new_products') AS mv,
                                        to_regclass('catalog.new_product_reviews') AS tabla`);
  if (!existe.rows[0].mv || !existe.rows[0].tabla) {
    console.log('  NO MEDIDO — faltan las migraciones 20261007200000 / 20261007200100 en esta base.');
    await knex.destroy();
    process.exit(1);
  }

  const contar = async () => (await knex.raw(
    `SELECT (SELECT count(*) FROM catalog.products WHERE sku LIKE ?)
          + (SELECT count(*) FROM kepler_ods.kdm1 WHERE c5 = ? AND c6 LIKE 'NPD%') AS n`,
    [`${esc.PREFIJO_SKU}%`, esc.SERIE])).rows[0].n;
  // Se compara antes contra después y no contra cero: si el demo local está cargado, sus filas
  // son legítimas y la prueba no debe confundirlas con rastro propio.
  const antes = await contar();
  const trx = await knex.transaction();
  try {
    // Por si una corrida anterior murió a la mitad sin revertir.
    await esc.limpiar(trx);
    const { hoy, productos } = await esc.sembrar(trx);
    await esc.refrescar(trx);

    const { rows } = await trx.raw(
      `SELECT * FROM analytics.mv_new_products WHERE tenant_id = ? AND sku LIKE ?`,
      [esc.TENANT, `${esc.PREFIJO_SKU}%`]);
    const porSku = new Map(rows.map((r) => [r.sku, r]));
    const P = (clave) => productos.find((p) => p.clave === clave);
    const fila = (clave) => porSku.get(P(clave).sku);

    console.log('── 1. Quién es nuevo y quién no ──');
    check('el producto que se mueve desde hace 262 días NO aparece como nuevo', !fila('OLD'));
    for (const c of ['01', '02', '03', '04', '05', '06', '07', '08', '09']) {
      check(`NPDEMO-${c} aparece`, !!fila(c));
    }

    console.log('\n── 2. Lanzamiento = primera actividad, con historia suficiente ──');
    for (const c of ['01', '02', '03', '04', '05', '06', '09']) {
      const f = fila(c);
      const L = P(c).esperado.lanzamiento;
      check(`NPDEMO-${c}: lanzamiento = hoy ${L}`, f && iso(f.lanzamiento) === esc.fecha(hoy, L), f && iso(f.lanzamiento));
      check(`NPDEMO-${c}: medible (90 días de historia en sus fuentes)`, f && f.no_medible === false, f && iso(f.historia_desde));
    }

    console.log('\n── 3. Inversión y venta por ventana (contra el cálculo independiente) ──');
    for (const c of ['01', '02', '03', '05', '06']) {
      const f = fila(c);
      const e = P(c).esperado;
      for (const k of ['inversion_30', 'inversion_60', 'inversion_90', 'inversion_total',
        'venta_30', 'venta_60', 'venta_90', 'venta_total']) {
        check(`NPDEMO-${c}: ${k} = ${e[k]}`, f && num(f[k]) === e[k], f && num(f[k]));
      }
      check(`NPDEMO-${c}: entradas = ${e.entradas}`, f && Number(f.entradas) === e.entradas, f && f.entradas);
      check(`NPDEMO-${c}: plazas que lo recibieron = ${e.plazas_recibido}`, f && Number(f.plazas_recibido) === e.plazas_recibido);
      check(`NPDEMO-${c}: plazas que lo venden = ${e.plazas_venta}`, f && Number(f.plazas_venta) === e.plazas_venta);
      check(`NPDEMO-${c}: días con venta en su primer mes = ${e.dias_con_venta_30}`,
        f && Number(f.dias_con_venta_30) === e.dias_con_venta_30, f && f.dias_con_venta_30);
      check(`NPDEMO-${c}: plazas con existencia = ${e.plazas_con_existencia}`,
        f && Number(f.plazas_con_existencia) === e.plazas_con_existencia, f && f.plazas_con_existencia);
    }

    console.log('\n── 4. Recompra = segunda entrada en una plaza que YA lo tenía ──');
    for (const c of ['01', '02', '03']) {
      const f = fila(c);
      const r = P(c).esperado.recompra;
      check(`NPDEMO-${c}: primera recompra = ${r === null ? 'ninguna' : `hoy ${r}`}`,
        f && iso(f.primera_recompra) === (r === null ? null : esc.fecha(hoy, r)), f && iso(f.primera_recompra));
    }
    // El 01 entra en la plaza 03 dos días después de la 01: eso es surtido inicial, no recompra.
    check('el surtido inicial en otra plaza NO cuenta como recompra (01: recompra = día -75, no -118)',
      fila('01') && iso(fila('01').primera_recompra) === esc.fecha(hoy, -75));

    console.log('\n── 5. Lo que no se mide se declara ──');
    const f09 = fila('09');
    check('sin entrada en Kepler → inversión NULL, no 0', f09 && f09.inversion_total === null, f09 && f09.inversion_total);
    check('…y su venta sí se mide', f09 && num(f09.venta_total) === P('09').esperado.venta_total);
    const f04 = fila('04');
    check('entró y no se vendió → venta NULL (la pantalla lo marca "sin venta a 30 días")',
      f04 && f04.venta_30 === null && f04.venta_total === null);
    const f08 = fila('08');
    check('dado de alta sin movimiento → sin_movimiento, sin lanzamiento', f08 && f08.sin_movimiento === true && f08.lanzamiento === null);

    console.log('\n── 6. Exclusiones y señales ──');
    check('el código DESC se excluye solo', fila('07') && fila('07').exclusion_auto === 'descuento', fila('07') && fila('07').exclusion_auto);
    const f06 = fila('06');
    if (f06 && f06.posible_recodificacion !== null) {
      // Sólo se puede medir si la base tiene un producto real con EAN-13 al cual copiarle el código.
      const hayViejo = (await trx.raw(
        `SELECT 1 FROM catalog.products WHERE tenant_id = ? AND sku NOT LIKE ? AND btrim(coalesce(barcode,'')) ~ '^[0-9]{13}$' LIMIT 1`,
        [esc.TENANT, `${esc.PREFIJO_SKU}%`])).rows.length > 0;
      if (hayViejo) check('mismo código de barras que un producto más viejo → posible recodificación', f06.posible_recodificacion === true);
      else { noMedido += 1; console.log('  · NO MEDIDO — la base no tiene un producto con EAN-13 para copiarle el código'); }
    }
    check('un producto normal NO levanta la señal de recodificación', fila('01') && fila('01').posible_recodificacion === false);

    console.log('\n── 7. Prueba negativa: el candado tiene que poder ponerse rojo ──');
    // Si la regla de historia por fuente se rompiera (un solo "desde" global), un producto que
    // sólo existe en una fuente con historia corta saldría medible. Se fabrica uno y se exige que
    // NO lo sea: su única fuente (ruta) se siembra sin historia previa.
    const rutaSinHistoria = (await trx.raw(
      `SELECT count(*)::int AS n FROM analytics.mv_new_products m
        WHERE m.tenant_id = ? AND m.fuentes = ARRAY['ruta'] AND m.no_medible = false
          AND m.lanzamiento < (SELECT min(business_date) FROM analytics.v_sellout_daily WHERE channel = 'ruta') + 90`,
      [esc.TENANT])).rows[0].n;
    check('ningún producto que sólo se vio en ruta sale medible antes de 90 días de historia de ruta', rutaSinHistoria === 0, rutaSinHistoria);
  } catch (e) {
    ko += 1;
    console.log(`  ✗ excepción: ${e.message}`);
  } finally {
    await trx.rollback().catch(() => {});
  }

  const despues = await contar();
  check('no quedó rastro: la transacción se revirtió', String(despues) === String(antes), { antes, despues });

  console.log(`\n${ok} ✓ · ${ko} ✗${noMedido ? ` · ${noMedido} NO MEDIDO` : ''}`);
  await knex.destroy();
  process.exit(ko ? 1 : 0);
})();
