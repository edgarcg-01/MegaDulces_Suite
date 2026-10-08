#!/usr/bin/env node
'use strict';
/**
 * `[NP.3]` Candado de Productos nuevos: la historia y la parte en vivo miden lo que dicen.
 *
 * Siembra un escenario con resultado CONOCIDO (`_lib/new-products-scenario.js`) por el camino
 * real —documentos de Kepler en el ODS—, refresca `mv_kepler_sales_daily` y `mv_new_products`
 * DENTRO de una transacción y la REVIERTE al final: no deja rastro en la base.
 *
 * Tres cruces, ninguno de la vista contra sí misma:
 *   1. Las SERIES de la matvista contra un cálculo hecho aparte en JavaScript sobre lo sembrado.
 *   2. La función EN VIVO contra las fuentes canónicas en días ya CERRADOS: la venta contra
 *      `v_sellout_daily` (pierna Kepler de tienda) y las entradas contra la lista de la matvista
 *      (que sale de `erp_goods_receipt_lines`). Si alguien cambia una regla de un lado y no del
 *      otro, aquí se pone rojo.
 *   3. Lo que pasa HOY: lo trae la función y la matvista NO lo trae (nada se cuenta dos veces).
 *
 * Además vigila: un producto que se mueve desde hace 262 días NO es nuevo; la historia se exige
 * POR FUENTE; la recompra es en una plaza que ya lo tenía; sin entrada en Kepler la inversión es
 * NULL; el código DESC se excluye solo; el código de barras repetido levanta la señal.
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
const r2 = (v) => Math.round(Number(v) * 100) / 100;
const iso = (v) => (v === null || v === undefined ? null : new Date(v).toISOString().slice(0, 10));
const suma = (arr) => r2((arr || []).reduce((a, b) => a + Number(b), 0));
const primeros = (arr, n) => (arr || []).slice(0, n);
const nulo = (v) => (v === 0 ? null : v);

(async () => {
  console.log('\n=== [NP.3] Productos nuevos — historia + en vivo contra un escenario conocido ===\n');
  const existe = await knex.raw(`SELECT to_regclass('analytics.mv_new_products') AS mv,
                                        to_regclass('catalog.new_product_reviews') AS tabla,
                                        to_regprocedure('analytics.fn_new_products_movimientos(date,date)') AS fn`);
  if (!existe.rows[0].mv || !existe.rows[0].tabla || !existe.rows[0].fn) {
    console.log('  NO MEDIDO — faltan las migraciones 20261007200000/200100/200200 en esta base.');
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
    await esc.limpiar(trx);
    const { hoy, productos } = await esc.sembrar(trx);
    const vivo = await esc.sembrarVivo(trx, hoy);
    await esc.refrescar(trx);

    const { rows } = await trx.raw(
      `SELECT * FROM analytics.mv_new_products WHERE tenant_id = ? AND sku LIKE ?`,
      [esc.TENANT, `${esc.PREFIJO_SKU}%`]);
    const porSku = new Map(rows.map((r) => [r.sku, r]));
    const P = (clave) => productos.find((p) => p.clave === clave);
    const fila = (clave) => porSku.get(P(clave).sku);

    console.log('── 1. Quién es nuevo y quién no ──');
    check('el producto que se mueve desde hace 262 días NO aparece como nuevo', !fila('OLD'));
    for (const c of ['01', '02', '03', '04', '05', '06', '07', '08', '09']) check(`NPDEMO-${c} aparece`, !!fila(c));
    check('el corte de la historia es HOY', iso(rows[0] && rows[0].corte) === hoy, rows[0] && iso(rows[0].corte));

    console.log('\n── 2. Lanzamiento = primera actividad, con historia suficiente ──');
    for (const c of ['01', '02', '03', '04', '05', '06', '09']) {
      const f = fila(c);
      const L = P(c).esperado.lanzamiento;
      check(`NPDEMO-${c}: lanzamiento = hoy ${L}`, f && iso(f.lanzamiento) === esc.fecha(hoy, L), f && iso(f.lanzamiento));
      check(`NPDEMO-${c}: medible (90 días de historia en sus fuentes)`, f && f.no_medible === false, f && iso(f.historia_desde));
      check(`NPDEMO-${c}: la serie diaria cubre del lanzamiento a ayer (${-L} días)`,
        f && f.venta_dia.length === -L, f && f.venta_dia.length);
    }

    console.log('\n── 3. Series contra el cálculo independiente ──');
    for (const c of ['01', '02', '03', '05', '06']) {
      const f = fila(c);
      const e = P(c).esperado;
      for (const n of [30, 60, 90]) {
        check(`NPDEMO-${c}: venta a ${n} días = ${e[`venta_${n}`]}`, f && nulo(suma(primeros(f.venta_dia, n))) === e[`venta_${n}`],
          f && suma(primeros(f.venta_dia, n)));
      }
      check(`NPDEMO-${c}: venta total = ${e.venta_total}`, f && suma(f.venta_dia) === e.venta_total, f && suma(f.venta_dia));
      const ent = f ? f.entradas : [];
      check(`NPDEMO-${c}: inversión total = ${e.inversion_total}`, nulo(suma(ent.map((x) => x.i))) === e.inversion_total,
        suma(ent.map((x) => x.i)));
      check(`NPDEMO-${c}: entradas = ${e.entradas}`, ent.length === e.entradas, ent.length);
      check(`NPDEMO-${c}: plazas que lo venden = ${e.plazas_venta}`, f && Object.keys(f.venta_por_plaza).length === e.plazas_venta,
        f && Object.keys(f.venta_por_plaza));
      // La serie por plaza suma lo mismo que la global.
      const porPlaza = f ? r2(Object.values(f.venta_por_plaza).reduce((a, s) => a + suma(s), 0)) : null;
      check(`NPDEMO-${c}: las series por plaza suman la global`, porPlaza === (e.venta_total ?? 0), porPlaza);
      // Recompra, calculada aquí sobre la lista de entradas.
      const fechasPorPlaza = new Map();
      for (const x of ent) fechasPorPlaza.set(x.p, [...new Set([...(fechasPorPlaza.get(x.p) || []), x.f])].sort());
      const segundas = [...fechasPorPlaza.values()].map((ds) => ds[1]).filter(Boolean).sort();
      check(`NPDEMO-${c}: recompra = ${e.recompra === null ? 'ninguna' : `hoy ${e.recompra}`}`,
        (segundas[0] || null) === (e.recompra === null ? null : esc.fecha(hoy, e.recompra)), segundas[0] || null);
    }
    check('el surtido inicial en otra plaza NO cuenta como recompra (01: recompra = día -75, no -118)',
      fila('01') && fila('01').entradas.some((x) => x.f === esc.fecha(hoy, -118)));

    console.log('\n── 4. La función EN VIVO da lo mismo que las fuentes canónicas en días CERRADOS ──');
    const desde = esc.fecha(hoy, -130);
    const ayer = esc.fecha(hoy, -1);
    const fnVenta = (await trx.raw(`
      SELECT f.product_id, f.plaza, f.fecha::text AS fecha, f.importe
        FROM analytics.fn_new_products_movimientos(?::date, ?::date) f
        JOIN catalog.products p ON p.id = f.product_id
       WHERE f.tipo = 'venta' AND p.sku LIKE ?`, [desde, ayer, `${esc.PREFIJO_SKU}%`])).rows;
    const canon = (await trx.raw(`
      SELECT s.product_id, s.warehouse_code AS plaza, s.business_date::text AS fecha, sum(s.monto) AS importe
        FROM analytics.v_sellout_daily s
       WHERE s.source = 'kepler' AND s.channel <> 'ruta' AND s.sku LIKE ?
         AND s.business_date BETWEEN ?::date AND ?::date
         -- El mismo universo que la funcion: los productos de la matvista (el viejo no esta).
         AND s.product_id IN (SELECT product_id FROM analytics.mv_new_products)
       GROUP BY 1, 2, 3`, [`${esc.PREFIJO_SKU}%`, desde, ayer])).rows;
    const llave = (x) => `${x.product_id}|${x.plaza}|${x.fecha}|${r2(x.importe)}`;
    const a = new Set(fnVenta.map(llave));
    const b = new Set(canon.map(llave));
    const soloFn = [...a].filter((k) => !b.has(k));
    const soloCanon = [...b].filter((k) => !a.has(k));
    check(`venta: la función y v_sellout_daily coinciden renglón por renglón (${a.size} días-plaza)`,
      a.size > 0 && soloFn.length === 0 && soloCanon.length === 0, { soloFn: soloFn.slice(0, 3), soloCanon: soloCanon.slice(0, 3) });
    const fnEnt = (await trx.raw(`
      SELECT p.sku, f.plaza, f.fecha::text AS fecha, f.importe
        FROM analytics.fn_new_products_movimientos(?::date, ?::date) f
        JOIN catalog.products p ON p.id = f.product_id
       WHERE f.tipo = 'entrada' AND p.sku LIKE ?`, [desde, ayer, `${esc.PREFIJO_SKU}%`])).rows;
    const histEnt = rows.flatMap((r) => (r.entradas || []).filter((x) => x.f >= desde)
      .map((x) => `${r.sku}|${x.p}|${x.f}|${r2(x.i)}`));
    const fnEntK = fnEnt.map((x) => `${x.sku}|${x.plaza}|${x.fecha}|${r2(x.importe)}`);
    check(`entradas: la función y la historia (erp_goods_receipt_lines) coinciden (${fnEntK.length})`,
      fnEntK.length > 0 && fnEntK.length === histEnt.length && fnEntK.every((k) => histEnt.includes(k)),
      { fn: fnEntK.length, historia: histEnt.length });

    console.log('\n── 5. Lo de HOY: lo trae la función y la historia NO ──');
    const hoyFn = (await trx.raw(`
      SELECT p.sku, f.tipo, f.plaza, f.importe
        FROM analytics.fn_new_products_movimientos(?::date, ?::date) f
        JOIN catalog.products p ON p.id = f.product_id
       WHERE p.sku LIKE ?`, [hoy, hoy, `${esc.PREFIJO_SKU}%`])).rows;
    for (const v of vivo) {
      const sk = `${esc.PREFIJO_SKU}${v.clave}`;
      const enc = hoyFn.find((x) => x.sku === sk && x.tipo === v.tipo && x.plaza === v.plaza);
      check(`hoy: ${v.tipo} de ${sk} en ${v.plaza} por ${v.importe}`, enc && r2(enc.importe) === v.importe, enc && enc.importe);
    }
    check('la venta de hoy NO está en la serie de la historia (NPDEMO-03 sigue en su total cerrado)',
      fila('03') && suma(fila('03').venta_dia) === P('03').esperado.venta_total, fila('03') && suma(fila('03').venta_dia));
    check('la entrada de hoy NO está en la lista de la historia (NPDEMO-02 sigue con 1 entrada)',
      fila('02') && fila('02').entradas.length === 1, fila('02') && fila('02').entradas.length);

    console.log('\n── 6. Lo que no se mide se declara, y las señales ──');
    const f09 = fila('09');
    check('sin entrada en Kepler → lista de entradas vacía (la inversión será "no medida")', f09 && f09.entradas.length === 0);
    check('…y su venta sí se mide', f09 && suma(f09.venta_dia) === P('09').esperado.venta_total);
    check('entró y no se vendió → serie en ceros', fila('04') && suma(fila('04').venta_dia) === 0);
    const f08 = fila('08');
    check('dado de alta sin movimiento → sin_movimiento, sin lanzamiento', f08 && f08.sin_movimiento === true && f08.lanzamiento === null);
    check('el código DESC se excluye solo', fila('07') && fila('07').exclusion_auto === 'descuento');
    const hayViejo = (await trx.raw(
      `SELECT 1 FROM catalog.products WHERE tenant_id = ? AND sku NOT LIKE ? AND btrim(coalesce(barcode,'')) ~ '^[0-9]{13}$' LIMIT 1`,
      [esc.TENANT, `${esc.PREFIJO_SKU}%`])).rows.length > 0;
    if (hayViejo) check('mismo código de barras que un producto más viejo → posible recodificación', fila('06') && fila('06').posible_recodificacion === true);
    else { noMedido += 1; console.log('  · NO MEDIDO — la base no tiene un producto con EAN-13 para copiarle el código'); }
    check('un producto normal NO levanta la señal de recodificación', fila('01') && fila('01').posible_recodificacion === false);

    console.log('\n── 7. Prueba negativa: la historia se exige POR FUENTE ──');
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
