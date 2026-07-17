/* eslint-disable no-console */
/**
 * W (gold) — Historial de INVENTARIO continuo: movimientos Wincaja históricos →
 * `analytics.stock_movements` (la tabla del Diario de Movimientos, Fase DM).
 *
 * PROPÓSITO: las sucursales que migraron Wincaja→Kepler (PH→01, La Piedad→02,
 * 8Esq→03, Yurécuaro→04, Zamora→05) solo tienen su inventario RECIENTE en Kepler
 * (ventana 120d, ~mar-2026+). Su historial pre-migración (entradas/salidas/compras/
 * ajustes) vive en el archivo Wincaja, DESCONECTADO. Esto lo enlaza: alimenta los
 * movimientos Wincaja al MISMO `stock_movements`, mapeados al almacén Kepler, para
 * que el Diario y la existencia histórica sean continuos a través de la migración.
 * Las tiendas SOLO-Wincaja (30/32/50) también entran (Kepler nunca las vio).
 *
 * FUENTE: bronze `wincaja.detalles_mov_almacen` ⋈ `maestro_mov_almacen` (DB→DB dentro
 * de prod; NO toca Kepler on-prem). Se AGREGA por (almacén, producto, día, tipo): las
 * ventas son 2M+ líneas/sucursal → el grano diario mantiene volumen sano y reconstruye
 * la existencia igual (suma acumulada del signed_qty).
 *
 * TIPOS Wincaja (decode 2026-07-17 por documento/observaciones/valores):
 *   V=Venta·S=Salida ajuste·I=Merma/baja → SALIDA (−)
 *   C=Compra·E=Entrada ajuste·D=Devolución de venta·P=Compra pedido·M=Ajuste → ENTRADA (+)
 *   X=movimiento sin cantidad (qty=0) → se descarta.
 *
 * ANTI-DOBLE-CONTEO:
 *   - Dedup por FECHA: la 'concentrada' es autoritativa; 'actual'/'2025' solo aportan
 *     fechas que la concentrada NO cubre (mismo criterio que v_sales_lines).
 *   - Guard: fecha ∈ [2015-01-01, hoy] (mata basura POS 2000/2029) + qty<10M.
 *   - Cutover: para sucursales migradas, solo movimientos ANTERIORES a la 1ª fecha
 *     que Kepler ya cubre en stock_movements (calculado en runtime → cero solape).
 *   - source_branch='W<code>' (ej 'W10','W30') distingue el origen Wincaja; el feed
 *     Kepler (import-stock-movements) excluye 'W%' de su DELETE. Cada feed maneja SUS
 *     filas. Idempotente: DELETE 'W%' de los almacenes tocados + INSERT.
 *
 *   node database/importers/wincaja/import-wincaja-stock-movements.js            # dry-run
 *   node database/importers/wincaja/import-wincaja-stock-movements.js --apply
 *
 * Env: DATABASE_URL_NEW (destino = fuente; todo vive en prod).
 */
'use strict';
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '..', '..', '.env') });
const knexLib = require('knex');

const APPLY = process.argv.includes('--apply');
const TENANT = process.env.WINCAJA_TENANT_ID || '00000000-0000-0000-0000-00000000d01c';
const BATCH = 2000;

// Unidad Wincaja → almacén plataforma. migrated=true → aplica cutover vs Kepler.
const UNITS = [
  { br: '10', code: '01', migrated: true },
  { br: '42', code: '02', migrated: true },
  { br: '40', code: '03', migrated: true },
  { br: '44', code: '04', migrated: true },
  { br: '54', code: '05', migrated: true },
  { br: '30', code: 'MD-30', migrated: false },
  { br: '32', code: 'MD-32', migrated: false },
  { br: '50', code: 'MD-50', migrated: false },
];

// tipo → { kind, dir, label }. dir: +1 entrada, −1 salida.
const TIPOS = {
  V: { kind: 'salida', dir: -1, label: 'Venta' },
  S: { kind: 'salida', dir: -1, label: 'Salida (ajuste)' },
  I: { kind: 'salida', dir: -1, label: 'Merma / baja' },
  C: { kind: 'entrada', dir: 1, label: 'Compra' },
  E: { kind: 'entrada', dir: 1, label: 'Entrada (ajuste)' },
  D: { kind: 'entrada', dir: 1, label: 'Devolución de venta' },
  P: { kind: 'entrada', dir: 1, label: 'Compra (pedido)' },
  M: { kind: 'entrada', dir: 1, label: 'Ajuste (entrada)' },
};
const TIPO_KEYS = Object.keys(TIPOS);

(async () => {
  const cfg = process.env.DATABASE_URL_NEW
    ? { client: 'pg', connection: { connectionString: process.env.DATABASE_URL_NEW, ssl: /@(localhost|127\.0\.0\.1|192\.168\.)/.test(process.env.DATABASE_URL_NEW) ? false : { rejectUnauthorized: false } }, pool: { min: 0, max: 3 } }
    : require(path.resolve(__dirname, '..', '..', 'knexfile-newdb.js')).development;
  const db = knexLib(cfg);

  try {
    console.log(`\n=== Movimientos Wincaja → analytics.stock_movements (${APPLY ? 'APPLY' : 'DRY-RUN'}) ===\n`);

    // catálogo sku→product_id
    const prods = await db('catalog.products').where({ tenant_id: TENANT }).whereNotNull('sku').whereNull('deleted_at').select('id', 'sku');
    const skuToId = new Map(prods.map((p) => [p.sku, p.id]));
    console.log(`  catálogo con sku: ${skuToId.size}`);

    // warehouses code→id
    const whs = await db('commercial.warehouses').where({ tenant_id: TENANT }).whereNull('deleted_at').select('id', 'code');
    const codeToWh = new Map(whs.map((w) => [w.code, w.id]));

    // Kepler cutover por almacén (1ª fecha que Kepler ya cubre en stock_movements; las
    // filas Wincaja NO 'W%' = Kepler). Wincaja migrada solo < esa fecha.
    const kmin = new Map();
    const krows = await db.raw(
      `SELECT w.code, min(sm.doc_date) dmin FROM analytics.stock_movements sm
       JOIN commercial.warehouses w ON w.tenant_id=sm.tenant_id AND w.id=sm.warehouse_id
       WHERE sm.tenant_id=? AND coalesce(sm.source_branch,'') NOT LIKE 'W%'
       GROUP BY w.code`, [TENANT]);
    for (const r of krows.rows) kmin.set(r.code, r.dmin);

    const staging = [];
    const touched = new Set();
    const summary = [];

    for (const u of UNITS) {
      const warehouseId = codeToWh.get(u.code);
      if (!warehouseId) { console.log(`  ⚠ almacén ${u.code} no existe — skip`); continue; }
      const cutover = u.migrated ? kmin.get(u.code) : null;
      const cutTxt = cutover ? cutover.toISOString().slice(0, 10) : '(sin cutover)';

      const rows = (await db.raw(`
        WITH conc AS (
          SELECT DISTINCT fecha::date d FROM wincaja.maestro_mov_almacen
          WHERE tenant_id=:t AND source_branch=:br AND source_dataset='concentrada'
        )
        SELECT m.fecha::date AS doc_date, d.tipo,
               d.articulo AS sku,
               SUM(ABS(d.cantidad_regular))            AS qty,
               SUM(ABS(COALESCE(d.valor_costo,0)))     AS cost_total,
               SUM(ABS(COALESCE(d.valor_venta,0)))     AS venta_total
        FROM wincaja.detalles_mov_almacen d
        JOIN wincaja.maestro_mov_almacen m
          ON m.tenant_id=d.tenant_id AND m.source_branch=d.source_branch
         AND m.source_dataset=d.source_dataset AND m.consecutivo=d.consecutivo
        LEFT JOIN conc ON conc.d = m.fecha::date
        WHERE d.tenant_id=:t AND d.source_branch=:br
          AND d.tipo IN (${TIPO_KEYS.map((k) => `'${k}'`).join(',')})
          AND COALESCE(m.cancelado,false)=false
          AND d.cantidad_regular <> 0 AND ABS(d.cantidad_regular) < 10000000
          AND m.fecha::date BETWEEN DATE '2015-01-01' AND CURRENT_DATE
          AND (m.source_dataset='concentrada' OR conc.d IS NULL)
          ${cutover ? 'AND m.fecha::date < :cutover' : ''}
        GROUP BY 1,2,3
      `, cutover ? { t: TENANT, br: u.br, cutover } : { t: TENANT, br: u.br })).rows;

      let matched = 0, unmatched = 0;
      for (const r of rows) {
        const info = TIPOS[r.tipo];
        if (!info) continue;
        const qty = Number(r.qty) || 0;
        if (qty === 0) continue;
        const pid = skuToId.get(r.sku) || null;
        if (!pid) unmatched++; else matched++;
        const amount = info.kind === 'salida' && Number(r.venta_total) ? Number(r.venta_total) : Number(r.cost_total) || null;
        staging.push([
          warehouseId, pid, r.sku || null, r.doc_date,
          'W', info.dir > 0 ? 'A' : 'D', r.tipo, null, `WIN_${r.tipo}`,
          info.kind, info.label, null,
          info.dir * qty, qty, amount != null && qty ? amount / qty : null, amount,
          null, null, null, `W${u.br}`,
        ]);
      }
      touched.add(warehouseId);
      summary.push({ almacen: u.code, origen: `W${u.br}`, cutover: cutTxt, filas: rows.length, sku_ok: matched, sku_null: unmatched });
    }

    console.table(summary);
    console.log(`  filas a insertar: ${staging.length.toLocaleString()}`);

    if (!APPLY) { console.log('\n[DRY-RUN] usar --apply.'); await db.destroy(); return; }
    if (!staging.length) { console.log('\nNada que insertar.'); await db.destroy(); return; }

    await db.transaction(async (trx) => {
      const ids = [...touched];
      const del = await trx('analytics.stock_movements')
        .where({ tenant_id: TENANT }).whereIn('warehouse_id', ids)
        .where('source_branch', 'like', 'W%').del();
      let ins = 0;
      const COLS = ['warehouse_id', 'product_id', 'sku', 'doc_date', 'genero', 'naturaleza', 'doc_type', 'doc_serie', 'doc_code', 'movement_kind', 'movement_label', 'folio', 'signed_qty', 'qty', 'unit_cost', 'amount', 'parent_group', 'parent_serie', 'parent_folio', 'source_branch'];
      for (let i = 0; i < staging.length; i += BATCH) {
        const chunk = staging.slice(i, i + BATCH);
        const vals = [], params = [TENANT];
        chunk.forEach((row, ri) => {
          const b = ri * COLS.length + 1;
          vals.push(`($1,${COLS.map((_, ci) => `$${b + ci + 1}`).join(',')})`);
          params.push(...row);
        });
        const res = await trx.raw(
          `INSERT INTO analytics.stock_movements (tenant_id,${COLS.join(',')}) VALUES ${vals.join(',')}`, params);
        ins += res.rowCount;
      }
      console.log(`  analytics.stock_movements (Wincaja): -${del} +${ins}`);
    });

    // Verificación
    const chk = (await db.raw(
      `SELECT w.code, sm.movement_kind, count(*) n, round(sum(sm.signed_qty)::numeric,0) net, min(sm.doc_date) dmin, max(sm.doc_date) dmax
       FROM analytics.stock_movements sm JOIN commercial.warehouses w ON w.tenant_id=sm.tenant_id AND w.id=sm.warehouse_id
       WHERE sm.tenant_id=? AND sm.source_branch LIKE 'W%' GROUP BY 1,2 ORDER BY 1,2`, [TENANT])).rows;
    console.log('\n✅ Movimientos Wincaja en stock_movements:');
    for (const r of chk) console.log(`   ${r.code} ${r.movement_kind}: ${Number(r.n).toLocaleString()} filas, neto=${Number(r.net).toLocaleString()} [${r.dmin?.toISOString?.().slice(0,10)}→${r.dmax?.toISOString?.().slice(0,10)}]`);
    await db.destroy();
  } catch (e) {
    console.error('\nERROR:', e.message);
    await db.destroy();
    process.exit(1);
  }
})();
