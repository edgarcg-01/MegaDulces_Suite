/* eslint-disable no-console */
/**
 * RR — Feed: RUTAS VECINALES de Kepler (reparto tiendita-a-tiendita) → el reporte
 * /comercial/ventas-por-ruta, SEPARADAS de la venta de mostrador de su sucursal.
 *
 * A diferencia del push de camionetas (`.249 mart.ventas`, ruta_NN), las rutas vecinales
 * NO tienen Kepler local propio: son ventas de la sucursal madre (md_01 = Padre Hidalgo)
 * etiquetadas con el código de ruta en la cabecera `kdm1.c12` (catálogo `md.kduv`, ej.
 * `1V001 = "RUTA VECINAL PH 01"`). Entran a la plataforma como venta de la suc 01 (feed
 * de ventas), pero sin desagregar por ruta → invisibles en el reporte. Este feed cierra
 * ese hueco leyendo md_01 directo y aterrizando la ruta con el MISMO modelo que el push:
 *   1) auto-registra cada ruta activa en `wincaja.branches` (is_route, parent = la suc),
 *   2) rollup mes → `analytics.sales_by_route_monthly` (route_code `WIN-<code>`),
 *   3) line-level folio×sku → `analytics.route_push_lines` (para el drill-down),
 * de modo que reusa toda la maquinaria del servicio (matriz, filtros, desglose) sin tocar
 * el backend. No hay doble conteo: el reporte de ruta lee tablas de ruta, no `sales_daily`.
 *
 * Fuente Kepler: kdm1 h ⋈ kdm2 d ON (c1,c2,c3,c4,c6); venta = U/D/10;
 *   ruta = h.c12 · cliente = h.c10 · fecha = h.c9 · folio = h.c6 ·
 *   sku = d.c8 · nombre = d.c10 (denormalizado) · unidades = d.c9 · importe = d.c13.
 *   (c5 varía por línea → NO es clave de documento, se excluye del join.)
 *
 *   SRC_URL = md_01 (default 192.168.10.10:1977) · PARENT = branch madre (default 10 = PH)
 *   DST_URL / DATABASE_URL_NEW = destino (prod Railway)
 *   node database/importers/kepler/import-kepler-vecinal-routes.js           # dry-run
 *   node database/importers/kepler/import-kepler-vecinal-routes.js --apply
 *   ... [--year 2026]
 */
const { Client } = require('pg');

const M = '00000000-0000-0000-0000-00000000d01c';
const SRC = process.env.SRC_URL || 'postgresql://postgres:kepler123@192.168.10.10:1977/md_01';
const DST = process.env.DST_URL || process.env.DATABASE_URL_NEW || 'postgresql://postgres:superoot@localhost:5433/postgres_platform';
const PARENT = process.env.PARENT || '10';        // wincaja.branches.source_branch de la suc madre (PH)
const APPLY = process.argv.includes('--apply');
const CUTOVER = '2026-06-27';                       // las vecinales arrancan a facturar aquí
const yi = process.argv.indexOf('--year');
const YEAR = yi !== -1 ? Number(process.argv[yi + 1]) : new Date().getFullYear();

(async () => {
  const dst = new Client({ connectionString: DST, ssl: /rlwy|railway|proxy/i.test(DST) ? { rejectUnauthorized: false } : false });
  await dst.connect();
  const src = new Client({ connectionString: SRC, connectionTimeoutMillis: 8000, statement_timeout: 180000 });
  try {
    console.log(`\n=== RUTAS VECINALES Kepler (md_01) → reporte por ruta (${APPLY ? 'APPLY' : 'DRY-RUN'}, año ${YEAR}) ===\n`);
    try { await src.connect(); }
    catch (e) { console.error(`❌ sin conexión a md_01 (${e.message}) — abortando`); process.exitCode = 1; return; }

    // 1) catálogo kduv → rutas vecinales ACTIVAS (c4=1). c2 = código (1V001), c3 = nombre.
    const cat = (await src.query(`SELECT c2 AS code, btrim(c3) AS name FROM md.kduv WHERE c4=1 AND c2 <> '' ORDER BY c2`)).rows;
    if (!cat.length) { console.log('sin rutas vecinales activas en kduv — nada que hacer.'); return; }
    const codes = cat.map((r) => r.code);
    console.log(`  rutas activas (kduv): ${cat.map((r) => `${r.code}=${r.name}`).join(' · ')}`);

    // warehouse de la suc madre: code = COALESCE(parent.kepler_code, parent.warehouse_code) — mismo que resuelve el servicio.
    const par = (await dst.query(
      `SELECT COALESCE(kepler_code, warehouse_code) AS wcode, branch_name FROM wincaja.branches WHERE tenant_id=$1 AND source_branch=$2`, [M, PARENT])).rows[0];
    if (!par) { console.error(`❌ branch madre '${PARENT}' no existe en wincaja.branches — abortando`); process.exitCode = 1; return; }
    const wh = (await dst.query(`SELECT id, code FROM commercial.warehouses WHERE tenant_id=$1 AND code=$2 AND deleted_at IS NULL`, [M, par.wcode])).rows[0];
    if (!wh) { console.error(`❌ warehouse '${par.wcode}' (madre ${PARENT}) no existe — abortando`); process.exitCode = 1; return; }
    console.log(`  suc madre: ${PARENT} (${par.branch_name}) → warehouse ${wh.code}`);

    // 2) rollup mes (año completo → GREATEST no degrada) ...
    const from = `${YEAR}-01-01`, to = `${YEAR + 1}-01-01`;
    const J = `md.kdm1 h JOIN md.kdm2 d ON h.c1=d.c1 AND h.c2=d.c2 AND h.c3=d.c3 AND h.c4=d.c4 AND h.c6=d.c6`;
    const V = `h.c2='U' AND h.c3='D' AND h.c4='10' AND h.c12 = ANY($1)`;
    const roll = (await src.query(
      `SELECT h.c12 AS code, date_trunc('month', h.c9)::date AS month,
              sum(d.c9)::numeric AS units, sum(d.c13)::numeric AS revenue, count(DISTINCT h.c6)::int AS tickets
         FROM ${J} WHERE ${V} AND h.c9 >= $2 AND h.c9 < $3 AND h.c9 <= CURRENT_DATE
        GROUP BY 1, 2`, [codes, from, to])).rows;

    // 3) line-level INCREMENTAL (desde el último día cargado −1, piso en cutover).
    const maxRow = await dst.query(
      `SELECT max(business_date)::text d FROM analytics.route_push_lines WHERE tenant_id=$1 AND route_no = ANY($2)`, [M, codes]);
    let since = maxRow.rows[0]?.d
      ? new Date(new Date(maxRow.rows[0].d).getTime() - 864e5).toISOString().slice(0, 10)
      : CUTOVER;
    if (since < CUTOVER) since = CUTOVER;
    const lines = (await src.query(
      `SELECT h.c12 AS route_no, h.c9::date AS business_date, h.c6 AS folio, d.c8 AS sku,
              max(d.c10) AS producto, max(NULLIF(NULLIF(btrim(h.c10), ''), '0001')) AS cliente,
              sum(d.c9)::numeric AS qty, sum(d.c13)::numeric AS importe
         FROM ${J} WHERE ${V} AND h.c9 >= $2 AND h.c9 <= CURRENT_DATE AND btrim(coalesce(d.c8,'')) <> ''
        GROUP BY 1, 2, 3, 4`, [codes, since])).rows;

    const rev = roll.reduce((s, r) => s + Number(r.revenue || 0), 0);
    console.log(`  rollup: ${roll.length} filas ruta×mes · $${Math.round(rev).toLocaleString()}`);
    console.log(`  line-level: ${lines.length} líneas (folio×sku) desde ${since}`);

    if (!APPLY) { console.log('\n[DRY-RUN] nada cambió.'); return; }

    await dst.query('BEGIN');
    await dst.query(`SET LOCAL app.tenant_id = '${M}'`);

    // 1) auto-registro de rutas en wincaja.branches (idempotente)
    for (const r of cat) {
      await dst.query(
        `INSERT INTO wincaja.branches (tenant_id, source_branch, branch_name, is_route, parent_branch, warehouse_code, status, imported_at)
         VALUES ($1,$2,$3,true,$4,$5,'active',now())
         ON CONFLICT (tenant_id, source_branch) DO UPDATE SET
           branch_name=EXCLUDED.branch_name, is_route=true, parent_branch=EXCLUDED.parent_branch, imported_at=now()`,
        [M, r.code, r.name, PARENT, `RUTA-${r.code}`]);
    }

    // 2) rollup → sales_by_route_monthly (WIN-<code>, GREATEST)
    for (const r of roll) {
      await dst.query(
        `INSERT INTO analytics.sales_by_route_monthly (tenant_id, warehouse_id, route_code, route_no, month, units, revenue, tickets)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
         ON CONFLICT (tenant_id, warehouse_id, route_code, month) DO UPDATE SET
           units   = GREATEST(analytics.sales_by_route_monthly.units,   EXCLUDED.units),
           revenue = GREATEST(analytics.sales_by_route_monthly.revenue, EXCLUDED.revenue),
           tickets = GREATEST(analytics.sales_by_route_monthly.tickets, EXCLUDED.tickets),
           route_no = COALESCE(EXCLUDED.route_no, analytics.sales_by_route_monthly.route_no), updated_at = now()`,
        [M, wh.id, `WIN-${r.code}`, r.code, r.month, r.units, r.revenue, r.tickets]);
    }

    // 3) line-level → route_push_lines (DO UPDATE: idempotente + corrige)
    let ins = 0;
    const BATCH = 1000, N = 9;
    for (let i = 0; i < lines.length; i += BATCH) {
      const chunk = lines.slice(i, i + BATCH);
      const vals = chunk.map((_, ri) => `(${Array.from({ length: N }, (_, k) => `$${ri * N + k + 1}`).join(',')})`);
      const params = [];
      for (const r of chunk) params.push(M, r.route_no, r.business_date, r.folio, r.sku, r.producto || null, r.cliente || null, r.qty, r.importe);
      const res = await dst.query(
        `INSERT INTO analytics.route_push_lines (tenant_id, route_no, business_date, folio, sku, producto, cliente, qty, importe)
         VALUES ${vals.join(',')}
         ON CONFLICT (tenant_id, route_no, business_date, folio, sku) DO UPDATE SET
           producto = EXCLUDED.producto, cliente = EXCLUDED.cliente,
           qty = EXCLUDED.qty, importe = EXCLUDED.importe, imported_at = now()`, params);
      ins += res.rowCount;
    }

    await dst.query('COMMIT');
    console.log(`\n[APPLY] COMMIT — ${cat.length} rutas registradas · ${roll.length} filas rollup · ${ins} líneas.`);
  } catch (e) {
    await dst.query('ROLLBACK').catch(() => {});
    console.error('\nERROR (rollback):', e.message);
    process.exitCode = 1;
  } finally {
    await src.end().catch(() => {});
    await dst.end().catch(() => {});
  }
})();
