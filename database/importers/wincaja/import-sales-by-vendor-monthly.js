/* eslint-disable no-console */
/**
 * RS.9 — Feed del rollup `analytics.sales_by_vendor_monthly` (venta WINCAJA por
 * vendedor). Deriva de `wincaja.v_sales_lines` (view cara) UNA sola vez por mes y
 * persiste el agregado producto × almacén × canal × vendedor × mes, para que el
 * sell-out (mode=canal / by-vendor / vendors) lea ~ms en vez de escanear la view.
 *
 * Replica EXACTO el blend y mapeo del service (commercial-analytics.service.ts):
 *   · blend: wincaja_only OR (PH '10' < 2026-07-01) OR (La Piedad '42' < 2025-10-01)
 *   · warehouse: 10→01, 42→02, resto = warehouse_code
 *   · units: CJA×factor_venta, KGS→kg (unit_kind), resto qty
 *   · vendor_code = source_branch:vendedor · nombre por (sucursal,vendedor)
 * → los totales del rollup coinciden con la query en vivo (solo más rápido).
 *
 * POR LOTES MENSUALES: DELETE+INSERT por mes en su propia transacción → transacciones
 * chicas, sin el pico de WAL/memoria que tumbó la DB managed con un DELETE+INSERT gigante.
 *
 *   node database/importers/wincaja/import-sales-by-vendor-monthly.js          # dry-run (lista meses)
 *   node database/importers/wincaja/import-sales-by-vendor-monthly.js --apply
 */
const { Client } = require('pg');

const M = '00000000-0000-0000-0000-00000000d01c';
const DST = process.env.DATABASE_URL_NEW || 'postgresql://postgres:superoot@localhost:5433/postgres_platform';
const APPLY = process.argv.includes('--apply');

const BLEND = `(vl.wincaja_only = true
   OR (vl.source_branch = '10' AND vl.business_date < DATE '2026-07-01')
   OR (vl.source_branch = '42' AND vl.business_date < DATE '2025-10-01'))`;
const WH_MAP = `CASE WHEN vl.source_branch='10' THEN '01' WHEN vl.source_branch='42' THEN '02' ELSE vl.warehouse_code END`;

// INSERT del mes [d0, d1). Se ejecuta con $1=tenant, $2=d0, $3=d1.
const INSERT_MONTH = `
  WITH am AS (
    SELECT DISTINCT ON (articulo) articulo AS sku,
           upper(btrim(coalesce(unidad_venta,''))) AS uv, factor_venta
      FROM wincaja.articulos WHERE tenant_id=$1 ORDER BY articulo, source_dataset DESC),
  ven AS (
    SELECT DISTINCT ON (source_branch, vendedor) source_branch, vendedor, nombre
      FROM wincaja.vendedores WHERE tenant_id=$1 ORDER BY source_branch, vendedor, source_dataset DESC)
  INSERT INTO analytics.sales_by_vendor_monthly
    (id, tenant_id, product_id, warehouse_id, sale_channel, vendor_code, vendor_name,
     year_month, unit_kind, units, revenue, tickets, updated_at)
  SELECT gen_random_uuid(), $1, p.id, w.id, vl.sale_channel,
         (vl.source_branch || ':' || COALESCE(NULLIF(btrim(vl.vendedor),''), '·')),
         coalesce(ven.nombre, NULLIF(btrim(vl.vendedor),''), 'Sin vendedor'),
         to_char(vl.business_date, 'YYYY-MM'),
         CASE WHEN bool_or(am.uv='KGS') THEN 'weight' ELSE 'piece' END,
         SUM(CASE WHEN am.uv='CJA' THEN vl.qty * COALESCE(NULLIF(am.factor_venta,0),1) ELSE vl.qty END),
         SUM(vl.importe),
         count(DISTINCT vl.consecutivo),
         now()
    FROM wincaja.v_sales_lines vl
    JOIN catalog.products p ON p.tenant_id = vl.tenant_id AND p.sku = vl.sku AND p.deleted_at IS NULL AND p.is_promo = false
    JOIN commercial.warehouses w ON w.tenant_id = vl.tenant_id AND w.deleted_at IS NULL AND w.code = ${WH_MAP}
    LEFT JOIN am  ON am.sku = vl.sku
    LEFT JOIN ven ON ven.source_branch = vl.source_branch AND ven.vendedor = vl.vendedor
   WHERE vl.tenant_id = $1 AND ${BLEND}
     AND vl.business_date >= $2 AND vl.business_date < $3
   GROUP BY p.id, w.id, vl.sale_channel, vl.source_branch, vl.vendedor,
            coalesce(ven.nombre, NULLIF(btrim(vl.vendedor),''), 'Sin vendedor'), to_char(vl.business_date, 'YYYY-MM')`;

const nextMonth = (ym) => { const [y, m] = ym.split('-').map(Number); return m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, '0')}-01`; };

(async () => {
  const remote = !/@(localhost|127\.0\.0\.1|192\.168\.)/.test(DST);
  const db = new Client({ connectionString: DST, ssl: remote ? { rejectUnauthorized: false } : false, keepAlive: true, statement_timeout: 0 });
  await db.connect();
  try {
    console.log(`\n=== Rollup venta por vendedor (Wincaja) → analytics.sales_by_vendor_monthly (${APPLY ? 'APPLY' : 'DRY-RUN'}) ===\n`);
    const months = (await db.query(
      `SELECT DISTINCT to_char(vl.business_date,'YYYY-MM') ym
         FROM wincaja.v_sales_lines vl
        WHERE vl.tenant_id=$1 AND ${BLEND} ORDER BY 1`, [M])).rows.map((r) => r.ym);
    console.log(`  meses a procesar: ${months.length}${months.length ? ` (${months[0]} … ${months[months.length - 1]})` : ''}`);

    if (!APPLY) { console.log('\n[DRY-RUN] nada cambió.'); return; }

    let totalRows = 0;
    for (const ym of months) {
      const d0 = `${ym}-01`, d1 = nextMonth(ym), t = Date.now();
      await db.query('BEGIN');
      await db.query(`SET LOCAL app.tenant_id = '${M}'`);
      await db.query(`DELETE FROM analytics.sales_by_vendor_monthly WHERE tenant_id=$1 AND year_month=$2`, [M, ym]);
      const ins = await db.query(INSERT_MONTH, [M, d0, d1]);
      await db.query('COMMIT');
      totalRows += ins.rowCount;
      console.log(`  ${ym}: ${ins.rowCount} filas (${Date.now() - t}ms)`);
    }
    await db.query(`ANALYZE analytics.sales_by_vendor_monthly`);
    console.log(`\n[APPLY] OK — ${totalRows} filas en ${months.length} meses.`);
  } catch (e) {
    await db.query('ROLLBACK').catch(() => {});
    console.error('\nERROR (rollback):', e.message);
    process.exitCode = 1;
  } finally {
    await db.end();
  }
})();
