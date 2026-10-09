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
 *      `v_sellout_daily` (pierna Kepler de tienda) y las entradas contra
 *      `erp_goods_receipt_lines`. Si alguien cambia una regla de un lado y no del otro, aquí se
 *      pone rojo.
 *   3. Lo que pasa HOY: lo trae la función y la matvista NO lo trae (nada se cuenta dos veces).
 *   4. Las UNIDADES de Kepler (NP.11): lo publicado por plaza y por rótulo contra lo sembrado; un
 *      renglón que dice "caja" sin que su identidad cierre se cuenta en su base; y la fecha de la
 *      primera entrada de la lista contra `primera_recepcion`, que sale de OTRA consulta.
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
// `-infinity` (sucursal que siempre fue Kepler) llega como Infinity: se deja como texto.
const iso = (v) => {
  if (v === null || v === undefined) return null;
  const d = new Date(v);
  return Number.isFinite(d.getTime()) ? d.toISOString().slice(0, 10) : String(v);
};
const suma = (arr) => r2((arr || []).reduce((a, b) => a + Number(b), 0));
const primeros = (arr, n) => (arr || []).slice(0, n);
const nulo = (v) => (v === 0 ? null : v);

(async () => {
  console.log('\n=== [NP.3] Productos nuevos — historia + en vivo contra un escenario conocido ===\n');
  const existe = await knex.raw(`SELECT to_regclass('analytics.mv_new_products') AS mv,
                                        to_regclass('catalog.new_product_reviews') AS tabla,
                                        to_regprocedure('analytics.fn_new_products_movimientos(uuid,text[],date,date)') AS fn`);
  if (!existe.rows[0].mv || !existe.rows[0].tabla || !existe.rows[0].fn) {
    console.log('  NO MEDIDO — faltan las migraciones 20261007360000/360100/360200 en esta base.');
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
    for (const c of ['01', '02', '03', '04', '05', '06', '07', '08', '09', '10', '11']) check(`NPDEMO-${c} aparece`, !!fila(c));
    check('el corte de la historia es HOY', iso(rows[0] && rows[0].corte) === hoy, rows[0] && iso(rows[0].corte));

    console.log('\n── 2. Lanzamiento = primera actividad; la historia se mide POR SUCURSAL ──');
    // Segunda implementación del "¿se puede medir?": la historia Kepler de cada plaza es su corte
    // (v_branch_erp_cutover). Se mide si alguna plaza donde se movió tiene 90 días de Kepler antes
    // del lanzamiento. Una plaza fuera del resolvedor no aporta.
    const cortes = new Map((await trx.raw(
      `SELECT kepler_code, cutover_date::text AS d FROM analytics.v_branch_erp_cutover WHERE tenant_id = ?`,
      [esc.TENANT])).rows.map((r) => [r.kepler_code, r.d]));
    const medibleEsperado = (c) => {
      const p = esc.PRODUCTOS.find((x) => x.clave === c);
      const plazas = [...new Set([...p.entradas, ...p.ventas].map((x) => x.plaza))].filter((pl) => cortes.has(pl));
      if (!plazas.length) return false;
      if (plazas.some((pl) => cortes.get(pl) === '-infinity')) return true;
      const historia = plazas.map((pl) => cortes.get(pl)).sort()[0];
      return historia <= esc.fecha(hoy, P(c).esperado.lanzamiento - 90);
    };
    for (const c of ['01', '02', '03', '04', '05', '06', '09']) {
      const f = fila(c);
      const L = P(c).esperado.lanzamiento;
      const esperado = medibleEsperado(c);
      check(`NPDEMO-${c}: lanzamiento = hoy ${L}`, f && iso(f.lanzamiento) === esc.fecha(hoy, L), f && iso(f.lanzamiento));
      check(`NPDEMO-${c}: ${esperado ? 'medible' : 'NO medible'} (historia Kepler de sus plazas)`,
        f && f.no_medible === !esperado, f && { no_medible: f.no_medible, historia: iso(f.historia_desde) });
      check(`NPDEMO-${c}: la serie diaria cubre del lanzamiento a ayer (${-L} días)`,
        f && f.venta_dia.length === -L, f && f.venta_dia.length);
    }
    // Que la regla de verdad separe: con estas fechas tiene que haber de los dos.
    const medibles = ['01', '02', '03', '04', '05', '06', '09'].map(medibleEsperado);
    check('el escenario ejercita los dos lados (hay medibles y NO medibles por historia de plaza)',
      medibles.includes(true) && medibles.includes(false), medibles);

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
    // El mismo universo que la matvista (el producto viejo no esta), por SKU como la llama el servidor.
    const skus = rows.map((r) => r.sku);
    const fn = async (d, h) => (await trx.raw(`
      SELECT f.sku, f.tipo, f.plaza, f.fecha::text AS fecha, f.folio, f.unidad, f.cantidad, f.importe
        FROM analytics.fn_new_products_movimientos(?::uuid, ?::text[], ?::date, ?::date) f`,
    [esc.TENANT, skus, d, h])).rows;
    const cerrado = await fn(desde, ayer);
    // La funcion separa por unidad; el sell-out no. Se junta por (sku, plaza, dia) para comparar.
    const juntar = (lista, campos) => {
      const m = new Map();
      for (const x of lista) {
        const k = campos.map((c) => x[c]).join('|');
        m.set(k, r2((m.get(k) || 0) + Number(x.importe)));
      }
      return new Set([...m.entries()].map(([k, v]) => `${k}|${v}`));
    };
    // [NP.13] Contra la venta Kepler canónica (mv_kepler_sales_daily, con el corte de cada plaza):
    // es la misma fuente de la que la matvista saca la primera venta.
    const canon = (await trx.raw(`
      SELECT k.sku, k.source_branch AS plaza, k.business_date::text AS fecha, sum(k.monto) AS importe
        FROM analytics.mv_kepler_sales_daily k
       WHERE k.sku = ANY(?::text[]) AND k.product_deleted = false
         AND k.business_date BETWEEN ?::date AND ?::date
         AND EXISTS (SELECT 1 FROM analytics.v_branch_erp_cutover x
                      WHERE x.tenant_id = k.tenant_id AND x.kepler_code = k.source_branch
                        AND k.business_date >= x.cutover_date)
       GROUP BY 1, 2, 3`, [skus, desde, ayer])).rows;
    const a = juntar(cerrado.filter((x) => x.tipo === 'venta'), ['sku', 'plaza', 'fecha']);
    const b = juntar(canon, ['sku', 'plaza', 'fecha']);
    const soloFn = [...a].filter((k) => !b.has(k));
    const soloCanon = [...b].filter((k) => !a.has(k));
    check(`venta: la función y mv_kepler_sales_daily coinciden renglón por renglón (${a.size} días-plaza)`,
      a.size > 0 && soloFn.length === 0 && soloCanon.length === 0, { soloFn: soloFn.slice(0, 3), soloCanon: soloCanon.slice(0, 3) });
    // Entradas contra la vista canonica de renglones; la fecha, del encabezado de cada folio.
    const canonEnt = (await trx.raw(`
      SELECT l.sku, btrim(l.sucursal) AS plaza, h.c9::date::text AS fecha, l.folio, sum(l.importe) AS importe
        FROM analytics.erp_goods_receipt_lines l
        JOIN kepler_ods.kdm1 h
          ON h.sucursal = l.sucursal AND btrim(h.c6) = l.folio AND h.c2 = 'X' AND h.c3 = 'A'
         AND btrim(h.c4::text) = '20' AND btrim(h.c1) = h.sucursal
       WHERE l.sku = ANY(?::text[]) AND h.c9::date BETWEEN ?::date AND ?::date
       GROUP BY 1, 2, 3, 4`, [skus, desde, ayer])).rows;
    const ea = juntar(cerrado.filter((x) => x.tipo === 'entrada'), ['sku', 'plaza', 'fecha', 'folio']);
    const eb = juntar(canonEnt, ['sku', 'plaza', 'fecha', 'folio']);
    check(`entradas: la función y erp_goods_receipt_lines coinciden folio por folio (${ea.size})`,
      ea.size > 0 && ea.size === eb.size && [...ea].every((k) => eb.has(k)),
      { soloFn: [...ea].filter((k) => !eb.has(k)).slice(0, 3), soloCanon: [...eb].filter((k) => !ea.has(k)).slice(0, 3) });
    // Y la lista de la matvista sale de la MISMA funcion: tiene que ser lo mismo, folio por folio.
    const histEnt = new Set(rows.flatMap((r) => (r.entradas || []).filter((x) => x.f >= desde)
      .map((x) => `${r.sku}|${x.p}|${x.f}|${x.folio}|${r2(x.i)}`)));
    check(`entradas: la lista de la matvista es la de la función (${histEnt.size})`,
      histEnt.size === ea.size && [...ea].every((k) => histEnt.has(k)), { historia: histEnt.size, fn: ea.size });

    console.log('\n── 5. Lo de HOY: lo trae la función y la historia NO ──');
    // Con todos los SKUs de la matvista, como el servidor: el 08 está "sin movimiento" y hoy entra.
    const hoyFn = await fn(hoy, hoy);
    for (const v of vivo) {
      const sk = `${esc.PREFIJO_SKU}${v.clave}`;
      const enc = hoyFn.find((x) => x.sku === sk && x.tipo === v.tipo && x.plaza === v.plaza && x.unidad === v.unidad);
      check(`hoy: ${v.tipo} de ${sk} en ${v.plaza}: ${v.cantidad} ${v.unidad} por ${v.importe}`,
        enc && r2(enc.importe) === v.importe && Number(enc.cantidad) === v.cantidad, enc && { u: enc.unidad, q: enc.cantidad, i: enc.importe });
    }
    check('la venta de hoy NO está en la serie de la historia (NPDEMO-03 sigue en su total cerrado)',
      fila('03') && suma(fila('03').venta_dia) === P('03').esperado.venta_total, fila('03') && suma(fila('03').venta_dia));
    check('la entrada de hoy NO está en la lista de la historia (NPDEMO-02 sigue con 1 entrada)',
      fila('02') && fila('02').entradas.length === 1, fila('02') && fila('02').entradas.length);
    // [NP.13] Lanzamientos EN VIVO: sin ninguna actividad antes del corte y movidos desde el corte.
    const f10 = fila('10');
    check('un producto viejo sin movimiento que HOY se vende por primera vez entra como lanzamiento de hoy',
      f10 && iso(f10.lanzamiento) === hoy && f10.sin_movimiento === false && f10.venta_dia.length === 0,
      f10 && { lanzamiento: iso(f10.lanzamiento), sin_mov: f10.sin_movimiento, dias: f10.venta_dia.length });
    check('…y lo hace por la venta de hoy (fuente kepler, primera venta hoy)',
      f10 && iso(f10.primera_venta) === hoy && (f10.fuentes || []).join() === 'kepler', f10 && f10.fuentes);
    const f08 = fila('08');
    check('el que estaba "sin movimiento" y HOY recibe pasa a lanzamiento de hoy',
      f08 && iso(f08.lanzamiento) === hoy && iso(f08.primera_recepcion) === hoy && f08.sin_movimiento === false,
      f08 && { lanzamiento: iso(f08.lanzamiento), sin_mov: f08.sin_movimiento });

    console.log('\n── 6. Lo que no se mide se declara, y las señales ──');
    const f09 = fila('09');
    check('sin entrada en Kepler → lista de entradas vacía (la inversión será "no medida")', f09 && f09.entradas.length === 0);
    check('…y su venta sí se mide', f09 && suma(f09.venta_dia) === P('09').esperado.venta_total);
    check('entró y no se vendió → serie en ceros', fila('04') && suma(fila('04').venta_dia) === 0);
    const f11 = fila('11');
    check('dado de alta sin movimiento → sin_movimiento, sin lanzamiento', f11 && f11.sin_movimiento === true && f11.lanzamiento === null);
    check('el código DESC se excluye solo', fila('07') && fila('07').exclusion_auto === 'descuento');
    const hayViejo = (await trx.raw(
      `SELECT 1 FROM catalog.products WHERE tenant_id = ? AND sku NOT LIKE ? AND btrim(coalesce(barcode,'')) ~ '^[0-9]{13}$' LIMIT 1`,
      [esc.TENANT, `${esc.PREFIJO_SKU}%`])).rows.length > 0;
    if (hayViejo) check('mismo código de barras que un producto más viejo → posible recodificación', fila('06') && fila('06').posible_recodificacion === true);
    else { noMedido += 1; console.log('  · NO MEDIDO — la base no tiene un producto con EAN-13 para copiarle el código'); }
    check('un producto normal NO levanta la señal de recodificación', fila('01') && fila('01').posible_recodificacion === false);

    console.log('\n── 7. Unidades de Kepler, tal como las declara el renglón ──');
    const norm = (o) => JSON.stringify(Object.keys(o || {}).sort().map((p) => [p,
      Object.keys(o[p]).sort().map((u) => [u, Number(o[p][u])])]));
    for (const c of ['01', '02', '03', '04', '05', '06', '09']) {
      const f = fila(c);
      const e = P(c).esperado;
      const pub = Object.fromEntries(Object.entries((f && f.venta_unidades) || {}).map(([p, x]) => [p, x.u]));
      check(`NPDEMO-${c}: venta por plaza y unidad = ${norm(e.unidades_venta)}`, norm(pub) === norm(e.unidades_venta), pub);
      const ent = {};
      for (const x of (f && f.entradas) || []) {
        ent[x.p] = ent[x.p] || {};
        for (const [u, q] of Object.entries(x.u || {})) ent[x.p][u] = Math.round(((ent[x.p][u] || 0) + Number(q)) * 1000) / 1000;
      }
      check(`NPDEMO-${c}: entradas por plaza y unidad = ${norm(e.unidades_entrada)}`, norm(ent) === norm(e.unidades_entrada), ent);
      // Los pesos que cubren las unidades: toda la venta sembrada es de tienda Kepler.
      const cubierto = f ? r2(Object.values(f.venta_unidades).reduce((s2, x) => s2 + Number(x.i), 0)) : null;
      check(`NPDEMO-${c}: los pesos con unidad son toda su venta de tienda (${e.venta_total ?? 0})`,
        cubierto === (e.venta_total ?? 0), cubierto);
    }
    const u09 = fila('09') && fila('09').venta_unidades['03'] && fila('09').venta_unidades['03'].u;
    check('un renglón que DICE caja pero cuya identidad no cierra se cuenta en piezas, no en cajas',
      u09 && u09.CJA === undefined && Number(u09.PZA) === 68, u09);
    const u03 = fila('03') && fila('03').venta_unidades;
    check('la misma venta se publica en la unidad de cada plaza: cajas en la 01, piezas en la 04',
      u03 && Object.keys(u03['01'].u).join() === 'CJA' && Object.keys(u03['04'].u).join() === 'PZA', u03);
    // Segunda implementacion del lanzamiento: primera_recepcion sale de erp_goods_receipt_lines
    // (todo el ODS) y la lista de entradas de la funcion. Tienen que decir la misma fecha.
    for (const c of ['01', '02', '03', '04', '05', '06']) {
      const f = fila(c);
      const primera = f && (f.entradas || []).map((x) => x.f).sort()[0];
      check(`NPDEMO-${c}: la primera entrada de la lista = primera_recepcion`, f && primera === iso(f.primera_recepcion),
        { lista: primera, columna: f && iso(f.primera_recepcion) });
    }

    // Las premisas del cruce que hace el servidor para nombrar la existencia: la cantidad de Kepler
    // viene marcada unit_source = 'kepler' (source vale 'kepler_ods' y NO sirve: así falló la
    // primera versión, y sólo lo vio la prueba por HTTP) y la ficha de la plaza se encuentra por
    // (kepler_code, sku).
    if (!(await trx.raw(`SELECT to_regclass('analytics.v_kepler_unit_ladder') AS v`)).rows[0].v) {
      noMedido += 1; console.log('  · NO MEDIDO — falta analytics.v_kepler_unit_ladder en esta base');
    } else {
      const ficha = (await trx.raw(`
        SELECT s.unit_source, l.u1_label, l.unidad_caja, l.factor_caja::int AS factor_caja
          FROM analytics.v_erp_stock_on_hand s
          JOIN commercial.warehouses w ON w.id = s.warehouse_id
          LEFT JOIN analytics.v_kepler_unit_ladder l ON l.sucursal = w.kepler_code AND l.sku = btrim(s.sku)
         WHERE s.sku = ? AND s.warehouse_code = '01'`, [`${esc.PREFIJO_SKU}03`])).rows[0];
      check('existencia de Kepler: unit_source = kepler y la ficha de la 01 dice PZA / CJA de 12',
        ficha && ficha.unit_source === 'kepler' && ficha.u1_label === 'PZA' && ficha.unidad_caja === 'CJA' && ficha.factor_caja === 12, ficha);
    }

    console.log('\n── 8. Sólo Kepler, y dos implementaciones de la primera venta ──');
    const fuentesRaras = rows.filter((r) => (r.fuentes || []).some((x) => !['kepler', 'entradas'].includes(x)));
    check('ninguna fila trae una fuente que no sea Kepler (venta en tienda o entradas)', fuentesRaras.length === 0,
      fuentesRaras.map((r) => [r.sku, r.fuentes]).slice(0, 3));
    // primera_venta sale de mv_kepler_sales_daily; la serie, de la función. Tienen que decir lo mismo.
    const primeraPorFn = new Map();
    for (const x of cerrado.filter((y) => y.tipo === 'venta')) {
      if (!primeraPorFn.has(x.sku) || x.fecha < primeraPorFn.get(x.sku)) primeraPorFn.set(x.sku, x.fecha);
    }
    const conVenta = rows.filter((r) => r.primera_venta && iso(r.primera_venta) < hoy && r.sku !== `${esc.PREFIJO_SKU}10`);
    const discrepan = conVenta.filter((r) => primeraPorFn.get(r.sku) !== iso(r.primera_venta));
    check(`primera venta: mv_kepler_sales_daily y la función dicen la misma fecha (${conVenta.length} productos)`,
      conVenta.length > 0 && discrepan.length === 0,
      discrepan.map((r) => [r.sku, iso(r.primera_venta), primeraPorFn.get(r.sku)]).slice(0, 3));

    console.log('\n── 9. [NP.15] Márgenes por sucursal: la matvista contra una segunda implementación ──');
    // Se recalcula AQUÍ, de lo sembrado, lo que la matvista guarda por plaza: venta neta de IVA/IEPS,
    // la parte con costo y su costo (c62 × c56, o × c9 sin peldaño), la meta de la ficha por el
    // peldaño VENDIDO (markup → margen sobre venta), y lo vendido/comprado por unidad base.
    const margenFicha = (p, plaza, factor) => {
      if (!p.ficha || !p.existencia.includes(plaza)) return null; // sin renglón en kdii
      const k = factor === 1 ? p.ficha.k1 : factor === p.ficha.c81 ? p.ficha.k2 : null;
      return k ? (100 * k) / (100 + k) : null;
    };
    const esperadoMargen = (p) => {
      const out = {};
      for (const [i, v] of p.ventas.entries()) {
        const uv = esc.unidadRenglon(p, v);
        const cv = esc.costoRenglon(p, v, i);
        const neto = r2(v.qty * v.precio) / (1 + (p.iva || 0) / 100 + (p.ieps || 0) / 100);
        const costo = cv.c62 === null ? null : Number(cv.c62) * (uv.c56 !== null ? Number(uv.c56) : uv.c9);
        const meta = margenFicha(p, v.plaza, v.u && !v.rota ? v.f : 1);
        const a = (out[v.plaza] = out[v.plaza] || { n: 0, nc: 0, c: 0, nm: 0, m: 0, b: {} });
        a.n += neto;
        if (costo !== null) { a.nc += neto; a.c += costo; }
        if (meta !== null) { a.nm += neto; a.m += (neto * meta) / 100; }
        const b = (a.b[uv.c11] = a.b[uv.c11] || { q: 0, n: 0 });
        b.q += uv.c9;
        b.n += neto;
      }
      return out;
    };
    const cerca = (a, b, tol = 0.02) => Math.abs(Number(a) - Number(b)) <= tol;
    for (const c of ['01', '02', '03', '09']) {
      const p = esc.PRODUCTOS.find((x) => x.clave === c);
      const esp = esperadoMargen(p);
      const mp = (fila(c) && fila(c).margen_plaza) || {};
      const plazas = [...new Set([...Object.keys(esp), ...Object.keys(mp)])].sort();
      const malas = plazas.filter((pl) => {
        const e = esp[pl];
        const g = mp[pl];
        if (!e || !g) return true;
        const bOk = Object.keys(e.b).every((u) => g.b && g.b[u] && cerca(g.b[u].q, e.b[u].q, 0.001) && cerca(g.b[u].n, e.b[u].n));
        return !(cerca(g.n, e.n) && cerca(g.nc, e.nc) && cerca(g.c, e.c) && cerca(g.nm, e.nm) && cerca(g.m, e.m) && bOk);
      });
      check(`NPDEMO-${c}: margen por plaza = segunda implementación (${plazas.length} plazas)`, plazas.length > 0 && malas.length === 0,
        malas.map((pl) => ({ plaza: pl, matvista: mp[pl], esperado: esp[pl] })).slice(0, 2));
    }
    // Los casos que el escenario existe para ejercer — que la regla separe, no que coincida por vacío.
    const m02 = (fila('02') && fila('02').margen_plaza['02']) || {};
    check('venta sin costo (mayoreo): la parte con costo es la MITAD, no se promedian ceros',
      Number(m02.nc) > 0 && cerca(Number(m02.nc) * 2, m02.n, 0.05), m02);
    check('sin meta en la ficha: la venta con meta es cero (se declara, no se inventa)', Number(m02.nm) === 0, m02);
    const m03 = (fila('03') && fila('03').margen_plaza) || {};
    const pctLista = (x) => (x && Number(x.nm) > 0 ? (100 * Number(x.m)) / Number(x.nm) : null);
    check('la meta va por el peldaño VENDIDO: la caja (01) a 9.09%, la pieza (04) a 23.08%',
      cerca(pctLista(m03['01']), 9.09, 0.01) && cerca(pctLista(m03['04']), 23.08, 0.01),
      { caja: pctLista(m03['01']), pieza: pctLista(m03['04']) });
    const m09 = (fila('09') && fila('09').margen_plaza['03']) || {};
    check('el renglón "roto" no lleva costo: la cobertura del real no lo cuenta',
      Number(m09.nc) > 0 && Number(m09.nc) < Number(m09.n), m09);
    // Lo comprado por unidad base (sin impuesto: la compra ya viene neta).
    const compraEsperada = (p) => {
      const out = {};
      for (const e of p.entradas) {
        const u = esc.unidadRenglon(p, e);
        const a = (out[u.c11] = out[u.c11] || { q: 0, i: 0 });
        a.q += u.c9;
        a.i += r2(e.qty * e.costo);
      }
      return out;
    };
    for (const c of ['01', '03']) {
      const p = esc.PRODUCTOS.find((x) => x.clave === c);
      const e = compraEsperada(p);
      const g = (fila(c) && fila(c).compra_base) || {};
      const okCompra = Object.keys(e).length === Object.keys(g).length
        && Object.keys(e).every((u) => g[u] && cerca(g[u].q, e[u].q, 0.001) && cerca(g[u].i, e[u].i));
      check(`NPDEMO-${c}: lo comprado por unidad base = segunda implementación`, okCompra, { matvista: g, esperado: e });
    }
    check('sin compras en su historia: compra_base vacía (el margen sobre lo pagado se declara)',
      fila('09') && Object.keys(fila('09').compra_base || {}).length === 0, fila('09') && fila('09').compra_base);
  } catch (e) {
    ko += 1;
    console.log(`  ✗ excepción: ${e.message}`);
  } finally {
    // Si la transacción ya se cerró por el error, el rollback falla: no hay nada que deshacer.
    await trx.rollback().catch(() => undefined);
  }

  const despues = await contar();
  check('no quedó rastro: la transacción se revirtió', String(despues) === String(antes), { antes, despues });

  console.log(`\n${ok} ✓ · ${ko} ✗${noMedido ? ` · ${noMedido} NO MEDIDO` : ''}`);
  await knex.destroy();
  process.exit(ko ? 1 : 0);
})();
