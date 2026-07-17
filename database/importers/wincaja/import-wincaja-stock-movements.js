/* eslint-disable no-console */
/**
 * W (gold) — Historial de INVENTARIO continuo: movimientos Wincaja históricos →
 * `analytics.stock_movements` (la tabla del Diario de Movimientos, Fase DM).
 *
 * PROPÓSITO: las sucursales que migraron Wincaja→Kepler (PH→01, La Piedad→02,
 * 8Esq→03, Yurécuaro→04, Zamora→05) solo tienen su inventario RECIENTE en Kepler
 * (ventana 120d). Su historial pre-migración (entradas/salidas/compras/ajustes/ventas)
 * vive en el archivo Wincaja, DESCONECTADO. Esto lo enlaza: alimenta los movimientos
 * Wincaja al MISMO `stock_movements`, mapeados al almacén Kepler, para que el Diario y
 * la existencia histórica sean continuos a través de la migración. Las tiendas
 * SOLO-Wincaja (30/32/50) también entran (Kepler nunca las vio).
 *
 * GRANO: agrega por (almacén, producto, día, tipo) — las ventas son 2M+ líneas/sucursal;
 * el grano diario mantiene volumen sano y reconstruye la existencia igual (suma
 * acumulada de signed_qty). INSERT server-side (no round-trip de millones de filas).
 *
 * TIPOS Wincaja (decode 2026-07-17 por documento/observaciones/valores):
 *   V=Venta·S=Salida ajuste·I=Merma/baja → SALIDA (−)
 *   C=Compra·E=Entrada ajuste·D=Devolución de venta·P=Compra pedido·M=Ajuste → ENTRADA (+)
 *   X=movimiento sin cantidad (qty=0) → se descarta.
 *
 * ANTI-DOBLE-CONTEO:
 *   - Datasets DISJUNTOS por período (verificado): concentrada=2026 ene–jun, 2025=año
 *     2025, actual=reciente. Se toman concentrada+2025 completos + actual solo para
 *     fechas > max(concentrada) (única volátil). Cero solape.
 *   - Guard: fecha ∈ [2015-01-01, hoy] (mata basura POS 2000/2029) + qty<10M.
 *   - Cutover: sucursales migradas solo < 1ª fecha que Kepler ya cubre (runtime).
 *   - source_branch='W<code>' distingue origen; el feed Kepler excluye 'W%' de su DELETE.
 *     Idempotente por almacén: DELETE 'W%' del almacén + INSERT.
 *
 * PERF: las tablas bronze se cargan en bulk SIN estadísticas → el planner elige
 * nested-loop (rows=1) y cuelga. Este importer hace ANALYZE al inicio (→ hash join, 0.8s).
 *
 *   node database/importers/wincaja/import-wincaja-stock-movements.js            # dry-run (cuenta)
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

const TIPOS_IN = "'V','C','E','S','D','I','P','M'";
const IS_SALIDA = "agg.tipo IN ('V','S','I')";
// subquery de agregación por (día, tipo, sku) para una sucursal.
const AGG = (cutover) => `
  SELECT m.fecha::date AS doc_date, d.tipo, d.articulo AS sku,
         SUM(ABS(d.cantidad_regular))        AS qty,
         SUM(ABS(COALESCE(d.valor_costo,0))) AS cost_total,
         SUM(ABS(COALESCE(d.valor_venta,0))) AS venta_total
  FROM wincaja.detalles_mov_almacen d
  JOIN wincaja.maestro_mov_almacen m
    ON m.tenant_id=d.tenant_id AND m.source_branch=d.source_branch
   AND m.source_dataset=d.source_dataset AND m.consecutivo=d.consecutivo
  WHERE d.tenant_id=:t AND d.source_branch=:br
    AND d.tipo IN (${TIPOS_IN}) AND COALESCE(m.cancelado,false)=false
    AND d.cantidad_regular<>0 AND ABS(d.cantidad_regular)<10000000
    AND m.fecha >= DATE '2015-01-01' AND m.fecha < CURRENT_DATE + 1
    AND ( m.source_dataset IN ('concentrada','2025')
          OR (m.source_dataset='actual' AND m.fecha > COALESCE(:conc_max::date, DATE '1900-01-01')) )
    ${cutover ? 'AND m.fecha < :cutover::date' : ''}
  GROUP BY 1,2,3`;

(async () => {
  const cfg = process.env.DATABASE_URL_NEW
    ? { client: 'pg', connection: { connectionString: process.env.DATABASE_URL_NEW, ssl: /@(localhost|127\.0\.0\.1|192\.168\.)/.test(process.env.DATABASE_URL_NEW) ? false : { rejectUnauthorized: false } }, pool: { min: 0, max: 3 } }
    : require(path.resolve(__dirname, '..', '..', 'knexfile-newdb.js')).development;
  const db = knexLib(cfg);

  try {
    console.log(`\n=== Movimientos Wincaja → analytics.stock_movements (${APPLY ? 'APPLY' : 'DRY-RUN'}) ===\n`);

    // Estadísticas frescas (bronze bulk-loaded sin ANALYZE → nested-loop que cuelga).
    console.log('  ANALYZE bronze…');
    await db.raw('ANALYZE wincaja.detalles_mov_almacen');
    await db.raw('ANALYZE wincaja.maestro_mov_almacen');

    const whs = await db('commercial.warehouses').where({ tenant_id: TENANT }).whereNull('deleted_at').select('id', 'code');
    const codeToWh = new Map(whs.map((w) => [w.code, w.id]));

    // Kepler cutover por almacén (1ª fecha que Kepler cubre; filas NO 'W%' = Kepler).
    const kmin = new Map();
    for (const r of (await db.raw(
      `SELECT w.code, min(sm.doc_date) dmin FROM analytics.stock_movements sm
       JOIN commercial.warehouses w ON w.tenant_id=sm.tenant_id AND w.id=sm.warehouse_id
       WHERE sm.tenant_id=? AND coalesce(sm.source_branch,'') NOT LIKE 'W%' GROUP BY w.code`, [TENANT])).rows) {
      kmin.set(r.code, r.dmin);
    }

    const summary = [];
    for (const u of UNITS) {
      const warehouseId = codeToWh.get(u.code);
      if (!warehouseId) { console.log(`  ⚠ almacén ${u.code} no existe — skip`); continue; }
      const cutover = u.migrated ? (kmin.get(u.code) || null) : null;
      const cutStr = cutover ? cutover.toISOString().slice(0, 10) : null;

      const concMax = (await db.raw(
        `SELECT max(fecha)::date mx FROM wincaja.maestro_mov_almacen
         WHERE tenant_id=:t AND source_branch=:br AND source_dataset='concentrada'
           AND fecha >= DATE '2015-01-01' AND fecha < CURRENT_DATE + 1`, { t: TENANT, br: u.br })).rows[0].mx;
      const concMaxStr = concMax ? concMax.toISOString().slice(0, 10) : null;

      const binds = { t: TENANT, br: u.br, conc_max: concMaxStr, cutover: cutStr, wh: warehouseId, sb: `W${u.br}` };

      if (!APPLY) {
        const [c] = (await db.raw(`SELECT count(*) n, coalesce(sum(qty),0) u FROM (${AGG(cutStr)}) agg`, binds)).rows;
        summary.push({ almacen: u.code, origen: `W${u.br}`, cutover: cutStr || '—', conc_max: concMaxStr || '—', filas: Number(c.n), unidades: Math.round(Number(c.u)) });
        continue;
      }

      await db.transaction(async (trx) => {
        const del = await trx('analytics.stock_movements').where({ tenant_id: TENANT, warehouse_id: warehouseId }).where('source_branch', 'like', 'W%').del();
        const ins = await trx.raw(`
          INSERT INTO analytics.stock_movements
            (tenant_id, warehouse_id, product_id, sku, doc_date, genero, naturaleza, doc_type, doc_code, folio,
             movement_kind, movement_label, signed_qty, qty, unit_cost, amount, source_branch)
          SELECT :t, :wh::uuid, p.id, agg.sku, agg.doc_date, 'W',
                 CASE WHEN ${IS_SALIDA} THEN 'D' ELSE 'A' END,
                 agg.tipo, 'WIN_'||agg.tipo,
                 'WIN-'||to_char(agg.doc_date,'YYYYMMDD')||'-'||agg.tipo,
                 CASE WHEN ${IS_SALIDA} THEN 'salida' ELSE 'entrada' END,
                 CASE agg.tipo WHEN 'V' THEN 'Venta' WHEN 'C' THEN 'Compra' WHEN 'E' THEN 'Entrada (ajuste)'
                      WHEN 'S' THEN 'Salida (ajuste)' WHEN 'D' THEN 'Devolución de venta' WHEN 'I' THEN 'Merma / baja'
                      WHEN 'P' THEN 'Compra (pedido)' WHEN 'M' THEN 'Ajuste (entrada)' END,
                 (CASE WHEN ${IS_SALIDA} THEN -1 ELSE 1 END) * agg.qty, agg.qty,
                 CASE WHEN agg.qty>0 THEN (CASE WHEN ${IS_SALIDA} AND agg.venta_total>0 THEN agg.venta_total ELSE agg.cost_total END)/agg.qty END,
                 CASE WHEN ${IS_SALIDA} AND agg.venta_total>0 THEN agg.venta_total ELSE agg.cost_total END,
                 :sb
          FROM (${AGG(cutStr)}) agg
          LEFT JOIN catalog.products p ON p.tenant_id=:t AND p.sku=agg.sku AND p.deleted_at IS NULL`, binds);
        summary.push({ almacen: u.code, origen: `W${u.br}`, cutover: cutStr || '—', borradas: del, insertadas: ins.rowCount });
      });
    }
    console.table(summary);

    if (APPLY) {
      const chk = (await db.raw(
        `SELECT w.code, sm.movement_kind, count(*) n, round(sum(sm.signed_qty)::numeric,0) net, min(sm.doc_date) dmin, max(sm.doc_date) dmax
         FROM analytics.stock_movements sm JOIN commercial.warehouses w ON w.tenant_id=sm.tenant_id AND w.id=sm.warehouse_id
         WHERE sm.tenant_id=? AND sm.source_branch LIKE 'W%' GROUP BY 1,2 ORDER BY 1,2`, [TENANT])).rows;
      console.log('\n✅ Movimientos Wincaja en stock_movements:');
      for (const r of chk) console.log(`   ${r.code} ${r.movement_kind}: ${Number(r.n).toLocaleString()} filas, neto=${Number(r.net).toLocaleString()} [${r.dmin?.toISOString?.().slice(0,10)}→${r.dmax?.toISOString?.().slice(0,10)}]`);
    } else {
      console.log('\n[DRY-RUN] usar --apply para escribir.');
    }
    await db.destroy();
  } catch (e) {
    console.error('\nERROR:', e.message);
    await db.destroy();
    process.exit(1);
  }
})();
