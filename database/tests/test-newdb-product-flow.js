#!/usr/bin/env node
'use strict';
/**
 * `[PF.1]` Candado del flujo de venta de cualquier producto: las consultas REALES del servidor
 * (`product-flow.sql.ts`, no una copia) contra una segunda implementación, sobre el escenario conocido
 * de Productos nuevos (sembrado por el camino real, dentro de una transacción que se revierte).
 *
 *   1. La venta en vivo ENTRANDO POR FECHA = la de `fn_new_products_movimientos` (que entra por SKU):
 *      mismas filas, mismos pesos, mismas unidades. Si alguien cambia una regla de un lado, rojo.
 *   2. La historia partida en periodos = un cálculo hecho aquí en JS sobre `mv_kepler_sales_daily`.
 *   3. El kardex por sucursal y rótulo = lo sembrado.
 *
 * ⛔ Escribe (y revierte): no corre contra producción (`assertSafeTarget`).
 *
 *   node database/tests/test-newdb-product-flow.js
 */
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '..', '.env'), quiet: true });
require('./_lib/assert-safe-target').assertSafeTarget('test-newdb-product-flow');
const knex = require('knex')(require('../knexfile-newdb.js').development);
const esc = require('./_lib/new-products-scenario');
require('ts-node').register({
  transpileOnly: true, skipProject: true,
  compilerOptions: { module: 'commonjs', target: 'es2020', esModuleInterop: true, moduleResolution: 'node', ignoreDeprecations: '6.0' },
});
const SQL = require(path.resolve(__dirname, '../../libs/commercial/src/lib/commercial-products/product-flow.sql.ts'));

let ok = 0;
let ko = 0;
const check = (desc, cond, detalle) => {
  if (cond) { ok += 1; console.log(`  ✓ ${desc}`); }
  else { ko += 1; console.log(`  ✗ ${desc}${detalle !== undefined ? `  → ${JSON.stringify(detalle).slice(0, 600)}` : ''}`); }
};
const n = (v) => Math.round(Number(v ?? 0) * 1000) / 1000;
const dia = (f, k) => new Date(Date.parse(`${f}T00:00:00Z`) + k * 86400000).toISOString().slice(0, 10);

/** Segunda implementación de los periodos (la del servidor vive en product-flow.ts). */
function periodosJs(hoy) {
  const [y, m, d] = hoy.split('-').map(Number);
  const mesIni = `${y}-${String(m).padStart(2, '0')}-01`;
  const pY = m === 1 ? y - 1 : y;
  const pM = m === 1 ? 12 : m - 1;
  const prevIni = `${pY}-${String(pM).padStart(2, '0')}-01`;
  const fin = dia(prevIni, d);
  return { hoy, mesIni, prevIni, prevFin: fin < mesIni ? fin : mesIni, desde30: dia(hoy, -29), desdeHistoria: dia(hoy, -120) };
}

(async () => {
  console.log('\n=== [PF.1] Flujo de venta — las consultas del servidor contra una segunda implementación ===\n');
  const trx = await knex.transaction();
  try {
    await esc.limpiar(trx);
    const { hoy, productos } = await esc.sembrar(trx);
    await esc.sembrarVivo(trx, hoy);
    await esc.refrescar(trx);
    await trx.raw(`SELECT set_config('app.tenant_id', ?, true)`, [esc.TENANT]);
    const skus = productos.map((p) => p.sku);
    const ids = productos.map((p) => p.product_id);

    console.log('── 1. Venta en vivo: por fecha = por SKU ──');
    const desde = dia(hoy, -60);
    const nueva = (await trx.raw(SQL.VENTA_VIVO_SQL, [skus, desde, hoy])).rows;
    const fn = (await trx.raw(`
      SELECT sku, plaza, to_char(fecha, 'YYYY-MM-DD') AS fecha, sum(importe) AS monto, sum(cantidad_base) AS unidades
        FROM analytics.fn_new_products_movimientos(?, ?::text[], ?::date, ?::date)
       WHERE tipo = 'venta' GROUP BY 1, 2, 3`, [esc.TENANT, skus, desde, hoy])).rows;
    const llave = (r) => `${r.sku}|${r.plaza}|${r.fecha}`;
    const mf = new Map(fn.map((r) => [llave(r), r]));
    const mn = new Map(nueva.map((r) => [llave(r), r]));
    const malas = [...new Set([...mf.keys(), ...mn.keys()])].filter((k) => {
      const a = mn.get(k); const b = mf.get(k);
      return !a || !b || Math.abs(n(a.monto) - n(b.monto)) > 0.005 || Math.abs(n(a.unidades) - n(b.unidades)) > 0.0005;
    }).map((k) => ({ k, por_fecha: mn.get(k), por_sku: mf.get(k) }));
    check(`mismas filas, pesos y unidades (${mf.size} sku×sucursal×día)`, mf.size > 0 && malas.length === 0, malas.slice(0, 5));
    check('incluye lo de HOY (en vivo)', nueva.some((r) => r.fecha === hoy), nueva.map((r) => r.fecha).sort().slice(-3));

    console.log('\n── 2. Historia partida en periodos = cálculo en JS sobre la venta diaria ──');
    const p = periodosJs(hoy);
    const corte = (await trx.raw(SQL.CORTE_SQL)).rows[0].corte;
    const hist = (await trx.raw(SQL.RESUMEN_HISTORIA_SQL, [
      p.mesIni, p.prevIni, p.prevFin, p.prevIni, p.mesIni, p.desde30, p.desde30, ids, p.desdeHistoria, corte,
    ])).rows;
    const crudo = (await trx.raw(`
      SELECT k.product_id::text AS product_id, k.source_branch AS plaza, to_char(k.business_date, 'YYYY-MM-DD') AS f,
             sum(k.monto) AS m, sum(k.units) AS u
        FROM analytics.mv_kepler_sales_daily k
        JOIN analytics.v_branch_erp_cutover x ON x.tenant_id = k.tenant_id AND x.kepler_code = k.source_branch
                                            AND k.business_date >= x.cutover_date
       WHERE k.tenant_id = ? AND k.product_id = ANY(?::uuid[]) AND k.business_date < ?::date
       GROUP BY 1, 2, 3`, [esc.TENANT, ids, corte])).rows;
    const esperado = new Map();
    for (const r of crudo) {
      if (r.f < p.desdeHistoria) continue;
      const k = `${r.product_id}|${r.plaza}`;
      const e = esperado.get(k) ?? { mes: 0, mant: 0, mtot: 0, m30: 0, u30: 0, ultima: null };
      const m = Number(r.m); const u = Number(r.u);
      if (r.f >= p.mesIni) e.mes += m;
      if (r.f >= p.prevIni && r.f < p.prevFin) e.mant += m;
      if (r.f >= p.prevIni && r.f < p.mesIni) e.mtot += m;
      if (r.f >= p.desde30) { e.m30 += m; e.u30 += u; }
      if (u > 0 && (!e.ultima || r.f > e.ultima)) e.ultima = r.f;
      esperado.set(k, e);
    }
    const malasH = hist.filter((h) => {
      const e = esperado.get(`${h.product_id}|${h.plaza}`);
      return !e || Math.abs(n(h.mes) - n(e.mes)) > 0.005 || Math.abs(n(h.mes_anterior_mismo) - n(e.mant)) > 0.005
        || Math.abs(n(h.mes_anterior_total) - n(e.mtot)) > 0.005 || Math.abs(n(h.monto30) - n(e.m30)) > 0.005
        || Math.abs(n(h.unidades30) - n(e.u30)) > 0.0005 || (h.ultima ?? null) !== e.ultima;
    }).map((h) => ({ sql: h, js: esperado.get(`${h.product_id}|${h.plaza}`) }));
    check(`historia por periodos = JS (${hist.length} producto×sucursal)`, hist.length > 0 && hist.length === esperado.size && malasH.length === 0,
      { sql: hist.length, js: esperado.size, malas: malasH.slice(0, 3) });
    check('la historia NO trae el día del corte en adelante (eso es en vivo: nada se cuenta dos veces)',
      crudo.every((r) => r.f < corte), { corte });

    console.log('\n── 3. Kardex por sucursal y rótulo = lo sembrado ──');
    const p03 = productos.find((x) => x.clave === '03');
    const kx = (await trx.raw(SQL.KARDEX_SQL, [dia(hoy, -90), [p03.sku]])).rows;
    const esperadoK = {};
    for (const k of esc.KARDEX.filter((x) => x.clave === '03')) {
      const key = `${k.plaza}|${k.u}`;
      esperadoK[key] = (esperadoK[key] ?? 0) + (k.es === 'S' ? -1 : 1) * k.qty;
    }
    const obtenido = Object.fromEntries(kx.map((r) => [`${r.plaza}|${r.unidad}`, n(r.q)]));
    check('neto por sucursal y rótulo', JSON.stringify(Object.keys(esperadoK).sort().map((k) => [k, esperadoK[k]]))
      === JSON.stringify(Object.keys(obtenido).sort().map((k) => [k, obtenido[k]])), { esperadoK, obtenido });
    const c04 = kx.find((r) => r.plaza === '04' && r.unidad === 'CJA');
    check('la compra física de la ventana se cuenta (X-A-40 en cajas en la 04)', c04 && n(c04.comprado) === 4, c04);
    console.log('\n── 4. Salidas y traspasos: el destino se clasifica y telemarketing no es reparto ──');
    // Lo sembrado del 03 (caja de 12): a la sucursal TI005 2 cajas, a RUTA 22 1 caja, una remisión de
    // telemarketing de 1 caja (destino de cliente: "otro", que la pantalla NO cuenta) y 2 cajas recibidas en la 05.
    const sal = (await trx.raw(SQL.SALIDAS_SQL, [p03.sku, dia(hoy, -90)])).rows;
    const q = (dest) => n(sal.filter((r) => r.plaza === '01' && r.destino === dest).reduce((a, r) => a + Number(r.q), 0));
    check('a otra sucursal 24 piezas (2 cajas), a ruta 12, telemarketing aparte como "otro"',
      q('sucursal') === 24 && q('ruta') === 12 && q('otro') === 12, sal);
    const tra = (await trx.raw(SQL.TRASPASOS_SQL, [p03.sku, dia(hoy, -90)])).rows;
    check('traspaso recibido en la 05: 24 piezas', tra.length === 1 && tra[0].plaza === '05' && n(tra[0].q) === 24, tra);
    const fichas = (await trx.raw(SQL.FICHAS_SQL, [[p03.sku]])).rows;
    check('la ficha de la sucursal viaja para la escalera', fichas.some((f) => f.plaza === '04' && f.u1 === 'PZA'), fichas);

    console.log('\n── 5. [PF.2] Líderes: la consulta = el corte de Pareto calculado aquí en JS ──');
    const stats = (await trx.raw(`
      SELECT product_id::text AS id, revenue_90d::float AS r FROM analytics.product_sales_stats
       WHERE tenant_id = ? AND revenue_90d > 0`, [esc.TENANT])).rows
      .sort((a, b) => b.r - a.r || (a.id < b.id ? -1 : 1));
    if (!stats.length) {
      console.log('  · NO MEDIDO: analytics.product_sales_stats está vacía en esta base');
    } else {
      const total = stats.reduce((a, x) => a + x.r, 0);
      let acum = 0;
      const lideresJs = [];
      for (const [i, x] of stats.entries()) { if (acum / total < 0.5) lideresJs.push({ id: x.id, rank: i + 1 }); acum += x.r; }
      const lideres = (await trx.raw(SQL.LIDERES_SQL, [0.5, null, null])).rows;
      check(`los líderes = los que juntos hacen la primera mitad de la venta (${lideresJs.length} de ${stats.length})`,
        JSON.stringify(lideres.map((l) => [l.product_id, l.rank]).sort()) === JSON.stringify(lideresJs.map((l) => [l.id, l.rank]).sort()),
        { sql: lideres.slice(0, 5), js: lideresJs.slice(0, 5) });
      const uno = lideresJs[0].id;
      const filtrado = (await trx.raw(SQL.LIDERES_SQL, [0.5, [uno, ids[0]], [uno, ids[0]]])).rows;
      check('con ids, el lugar es el de TODA la red (no el de los pedidos)', filtrado.some((l) => l.product_id === uno && l.rank === 1), filtrado);
      check('[negativa] con corte 0 no hay líderes', (await trx.raw(SQL.LIDERES_SQL, [0, null, null])).rows.length === 0);
    }

    console.log('\n── 6. [PF.3] Lotes con caducidad: lo sembrado, por sucursal de Kepler ──');
    const wh = (await trx.raw(`SELECT id FROM commercial.warehouses WHERE tenant_id = ? AND kepler_code = '04' AND deleted_at IS NULL LIMIT 1`, [esc.TENANT])).rows[0];
    if (!wh) {
      console.log('  · NO MEDIDO: no hay almacén con sucursal de Kepler 04 en esta base');
    } else {
      await trx.raw(`
        INSERT INTO commercial.stock_lots (tenant_id, warehouse_id, product_id, lot_code, expiry_date, quantity, received_at)
        VALUES (?, ?, ?, 'PF3-A', ?::date, 36, now()), (?, ?, ?, 'PF3-B', NULL, 10, now()), (?, ?, ?, 'PF3-C', ?::date, 0, now())`,
      [esc.TENANT, wh.id, p03.product_id, dia(hoy, 20), esc.TENANT, wh.id, p03.product_id, esc.TENANT, wh.id, p03.product_id, dia(hoy, 5)]);
      const lotes = (await trx.raw(SQL.LOTES_CADUCIDAD_SQL, [[p03.product_id], [p03.product_id]])).rows.filter((l) => l.lote.startsWith('PF3-'));
      check('sólo el lote con fecha y con cantidad (sin fecha o en cero no cuentan)',
        lotes.length === 1 && lotes[0].lote === 'PF3-A' && lotes[0].plaza === '04' && lotes[0].caduca === dia(hoy, 20) && n(lotes[0].cantidad) === 36, lotes);
      const todos = (await trx.raw(SQL.LOTES_CADUCIDAD_SQL, [null, null])).rows;
      check('sin ids trae todos los productos con lote (para "Para cuidar hoy")', todos.some((l) => l.lote === 'PF3-A'));
    }

    console.log('\n── 7. [PF.5] Margen de la tabla (matvista) = el de la función de Productos nuevos ──');
    // Dos implementaciones del mismo margen: la lista suma mv_erp_margin_daily; el detalle, la función.
    // Medido en prod el 2026-10-09: por sucursal coinciden al centavo hasta ayer.
    await trx.raw('SAVEPOINT pf5');
    let refresco = null;
    try { await trx.raw('REFRESH MATERIALIZED VIEW analytics.mv_erp_margin_daily'); await trx.raw('RELEASE SAVEPOINT pf5'); }
    catch (e) { refresco = e.message; await trx.raw('ROLLBACK TO SAVEPOINT pf5'); }
    if (refresco) console.log(`  · la matvista no se pudo refrescar aquí (${refresco.slice(0, 80)}): se mide con lo que tenga`);
    const desdeM = dia(hoy, -30);
    const lista = (await trx.raw(SQL.MARGEN_LISTA_SQL, [desdeM, hoy, ids])).rows;
    if (!lista.length) {
      console.log('  · NO MEDIDO: la matvista de margen no trae venta de los productos sembrados en esta base');
    } else {
      const malas = [];
      for (const r of lista) {
        const sku = productos.find((x) => x.product_id === r.product_id).sku;
        const fn = (await trx.raw(SQL.MARGEN_DETALLE_SQL, [esc.TENANT, sku, desdeM, dia(hoy, -1)])).rows.filter((x) => x.tipo === 'venta');
        const suma = (k) => n(fn.reduce((a, x) => a + Number(x[k] ?? 0), 0));
        if (Math.abs(n(r.n) - suma('n')) > 0.05 || Math.abs(n(r.nc) - suma('nc')) > 0.05 || Math.abs(n(r.c) - suma('c')) > 0.05) {
          malas.push({ sku, lista: r, fn: { n: suma('n'), nc: suma('nc'), c: suma('c') } });
        }
      }
      check(`venta neta, con costo y costo coinciden (${lista.length} productos)`, malas.length === 0, malas.slice(0, 3));
    }

    console.log('\n── 8. [PF.4] Los que no se venden: las reglas de la consulta ──');
    // Un producto del catálogo SIN venta en el año, con existencia sembrada en la 04 (se revierte al final).
    const quieto = (await trx.raw(`
      SELECT p.id::text AS id, p.sku FROM catalog.products p
       WHERE p.tenant_id = ? AND p.deleted_at IS NULL AND p.sku ~ '^[0-9]{5}$'
         AND NOT EXISTS (SELECT 1 FROM analytics.mv_kepler_sales_daily s WHERE s.product_id = p.id)
         AND NOT EXISTS (SELECT 1 FROM kepler_ods.kdil k WHERE btrim(k.c3) = p.sku)
       LIMIT 1`, [esc.TENANT])).rows[0];
    if (quieto) {
      await trx.raw('SAVEPOINT pf4');
      try {
        await trx.raw(`INSERT INTO kepler_ods.kdil (sucursal, c1, c2, c3, c4, c8, c9) VALUES ('04', '04', 1, ?, 50, 0, 0)`, [quieto.sku]);
        await trx.raw('RELEASE SAVEPOINT pf4');
      } catch (e) {
        await trx.raw('ROLLBACK TO SAVEPOINT pf4');
        console.log(`  · no se pudo sembrar existencia (${e.message.slice(0, 80)})`);
      }
    }
    const nv = (await trx.raw(SQL.NO_SE_VENDEN_SQL, [dia(hoy, -365), 30, 90, 500])).rows;
    if (quieto) {
      check('⭐ el producto con existencia y sin venta aparece, sin fecha de última venta', nv.some((x) => x.product_id === quieto.id && x.dias === null && n(x.existencia) === 50),
        nv.filter((x) => x.product_id === quieto.id));
    }
    if (!nv.length) {
      console.log('  · NO MEDIDO: ningún producto con existencia y sin venta en esta base');
    } else {
      check(`todos llevan 30 días o más sin venderse, o no vendieron en el año (${nv.length})`,
        nv.every((x) => x.dias === null || Number(x.dias) >= 30), nv.filter((x) => x.dias !== null && Number(x.dias) < 30).slice(0, 3));
      check('todos tienen existencia', nv.every((x) => n(x.existencia) > 0));
      check('primero lo de más dinero detenido', nv.every((x, i) => i === 0 || n(nv[i - 1].valor) >= n(x.valor)));
      const vendidos = new Set(productos.map((x) => x.product_id));
      const conVenta = (await trx.raw(`SELECT DISTINCT product_id::text AS id FROM analytics.mv_kepler_sales_daily
        WHERE business_date >= current_date - 29 AND units > 0 AND product_id = ANY(?::uuid[])`, [ids])).rows.map((r) => r.id);
      check('[negativa] un producto que vendió en los últimos 30 días no aparece',
        conVenta.length > 0 && conVenta.every((id) => !nv.some((x) => x.product_id === id)), { conVenta: conVenta.length, sembrados: vendidos.size });
    }
  } catch (e) {
    ko += 1;
    console.log(`  ✗ excepción: ${e.message}`);
  } finally {
    await trx.rollback().catch(() => undefined);
  }
  console.log(`\n${ok} ✓ · ${ko} ✗`);
  await knex.destroy();
  process.exit(ko ? 1 : 0);
})();
