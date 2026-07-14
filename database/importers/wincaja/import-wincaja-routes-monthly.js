/**
 * RR + W.10 (gold) — Feed: VENTA A BORDO de las rutas Wincaja →
 * `analytics.sales_by_route_monthly`, el MISMO gold que consume el reporte
 * /comercial/ventas-por-ruta (hoy solo Kepler). Así las rutas Wincaja aparecen
 * como filas de ruta propias, junto a las de Kepler, sin doble query en vivo.
 *
 * Fuente: silver `wincaja.v_sales_lines` (sale_channel='ruta_venta'), agregado a
 * ruta × mes. tickets = COUNT(DISTINCT consecutivo) — el conteo REAL de canastas
 * (no se puede sacar del gold sales_daily, que está agregado por producto → inflaría).
 *
 * Atribución: la ruta se atribuye a su SUCURSAL MADRE (branches.parent_branch);
 * warehouse = kepler_code si existe (PH→'01') o warehouse_code (MD-32/MD-50).
 * route_code = 'WIN-<code>' (namespace propio → nunca choca con la serie Kepler).
 *
 * SIN corte de Padre Hidalgo: Kepler NO tiene rutas de reparto (su serie c63
 * UD100N = CAJA de mostrador, no ruta → verificado 2026-07-14). Como no hay ruta
 * Kepler contra qué doble-contar, la venta a bordo Wincaja de PH se incluye completa.
 * (El reporte /comercial/ventas-por-ruta ya filtra 'WIN-%' → solo rutas reales.)
 *
 * Idempotente: DELETE route_code LIKE 'WIN-%' del rango + INSERT (reload full,
 * NO GREATEST — el bronze Wincaja es snapshot completo, no purga como Kepler).
 * NO toca las filas Kepler (route_code sin prefijo). analytics.* sin RLS (filtro
 * tenant explícito). Corre como owner (DATABASE_URL_NEW).
 *
 * Uso (desde database/):
 *   node importers/wincaja/import-wincaja-routes-monthly.js               # dry-run (año actual)
 *   node importers/wincaja/import-wincaja-routes-monthly.js --apply
 *   node importers/wincaja/import-wincaja-routes-monthly.js --year 2026 --apply
 */
'use strict';
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '..', '..', '.env') });
const knexLib = require('knex');

const APPLY = process.argv.includes('--apply');
const TENANT = process.env.WINCAJA_TENANT_ID || '00000000-0000-0000-0000-00000000d01c';
const yi = process.argv.indexOf('--year');
const YEAR = yi !== -1 ? Number(process.argv[yi + 1]) : new Date().getFullYear();

const SRC = `
  SELECT
    COALESCE(pw.code, pb.warehouse_code)        AS wcode,
    'WIN-' || b.source_branch                   AS route_code,
    b.source_branch                             AS route_no,
    date_trunc('month', sl.business_date)::date AS month,
    SUM(sl.qty)::numeric                         AS units,
    SUM(sl.importe)::numeric                     AS revenue,
    COUNT(DISTINCT sl.consecutivo)::int          AS tickets
  FROM wincaja.v_sales_lines sl
  JOIN wincaja.branches b  ON b.tenant_id=sl.tenant_id AND b.source_branch=sl.source_branch AND b.is_route = true
  JOIN wincaja.branches pb ON pb.tenant_id=sl.tenant_id AND pb.source_branch=b.parent_branch
  LEFT JOIN commercial.warehouses pw
    ON pw.tenant_id=sl.tenant_id AND pw.code=COALESCE(pb.kepler_code, pb.warehouse_code) AND pw.deleted_at IS NULL
  WHERE sl.tenant_id = ? AND sl.sale_channel = 'ruta_venta'
    AND sl.business_date >= ? AND sl.business_date < ?
  GROUP BY 1, 2, 3, 4
`;

(async () => {
  const cfg = process.env.DATABASE_URL_NEW
    ? { client: 'pg', connection: { connectionString: process.env.DATABASE_URL_NEW, ssl: /@(localhost|127\.0\.0\.1|192\.168\.)/.test(process.env.DATABASE_URL_NEW) ? false : { rejectUnauthorized: false } }, pool: { min: 0, max: 3 } }
    : require(path.resolve(__dirname, '..', '..', 'knexfile-newdb.js')).development;
  const db = knexLib(cfg);
  const from = `${YEAR}-01-01`;
  const to = `${YEAR + 1}-01-01`;

  try {
    console.log(`\n=== VENTA A BORDO Wincaja → analytics.sales_by_route_monthly (${APPLY ? 'APPLY' : 'DRY-RUN'}, año ${YEAR}) ===`);
    const t0 = Date.now();
    const rows = (await db.raw(SRC, [TENANT, from, to])).rows;
    const rev = rows.reduce((s, r) => s + Number(r.revenue || 0), 0);
    const tk = rows.reduce((s, r) => s + Number(r.tickets || 0), 0);
    const routes = new Set(rows.map((r) => r.route_code)).size;
    const unresolved = rows.filter((r) => !r.wcode).length;
    console.log(`origen (silver): ${rows.length} filas ruta×mes · ${routes} rutas · revenue $${Math.round(rev).toLocaleString()} · tickets ${tk.toLocaleString()} (${Date.now() - t0}ms)`);
    if (unresolved) console.log(`  ⚠️  ${unresolved} filas sin warehouse padre resuelto — se omitirían`);

    if (!APPLY) { console.log('(dry-run — usar --apply)'); await db.destroy(); return; }

    await db.transaction(async (trx) => {
      await trx.raw(`SET LOCAL app.tenant_id = '${TENANT}'`);
      const whs = await trx('commercial.warehouses').where({ tenant_id: TENANT }).whereNull('deleted_at').select('id', 'code');
      const whTo = new Map(whs.map((w) => [w.code, w.id]));

      const del = await trx('analytics.sales_by_route_monthly')
        .where({ tenant_id: TENANT })
        .whereRaw(`route_code LIKE 'WIN-%'`)
        .andWhere('month', '>=', from).andWhere('month', '<', to)
        .del();

      const payload = rows.filter((r) => whTo.has(r.wcode)).map((r) => ({
        tenant_id: TENANT,
        warehouse_id: whTo.get(r.wcode),
        route_code: r.route_code,
        route_no: r.route_no,
        month: r.month,
        units: r.units,
        revenue: r.revenue,
        tickets: r.tickets,
      }));
      let ins = 0;
      for (let i = 0; i < payload.length; i += 500) {
        const chunk = payload.slice(i, i + 500);
        await trx('analytics.sales_by_route_monthly').insert(chunk);
        ins += chunk.length;
      }
      console.log(`analytics.sales_by_route_monthly: -${del} (WIN-%) +${ins} filas`);
    });

    const chk = (await db.raw(
      `SELECT w.code, count(*)::int filas, count(distinct s.route_code)::int rutas, round(sum(s.revenue)::numeric,0) revenue, sum(s.tickets)::int tickets
       FROM analytics.sales_by_route_monthly s JOIN commercial.warehouses w ON w.id=s.warehouse_id
       WHERE s.tenant_id=? AND s.route_code LIKE 'WIN-%' GROUP BY 1 ORDER BY 1`, [TENANT])).rows;
    console.log('✅ rutas Wincaja en gold:');
    for (const r of chk) console.log(`   ${r.code}: ${r.rutas} rutas, ${r.filas} filas, revenue $${Number(r.revenue).toLocaleString()}, tickets ${r.tickets.toLocaleString()}`);
    await db.destroy();
  } catch (e) {
    console.error('\nERROR:', e.message);
    await db.destroy();
    process.exit(1);
  }
})();
