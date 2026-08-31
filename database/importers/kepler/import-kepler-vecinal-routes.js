/* eslint-disable no-console */
/**
 * RR — Feed: RUTAS VECINALES de Kepler (reparto tiendita-a-tiendita) → el reporte
 * /comercial/ventas-por-ruta, SEPARADAS de la venta de mostrador de su sucursal.
 *
 * A diferencia del push de camionetas (`.249 mart.ventas`, ruta_NN), las rutas vecinales
 * NO tienen Kepler local propio: son ventas de la sucursal madre etiquetadas con el código
 * de ruta en la cabecera `kdm1.c12` (catálogo `md.kduv`, ej. `1V003 = "RUTA VECINAL ABASTOS
 * LP"`). Entran a la plataforma como venta de la suc (feed de ventas), pero sin desagregar
 * por ruta → invisibles en el reporte. Este feed cierra ese hueco leyendo la sucursal directo
 * y aterrizando la ruta con el MISMO modelo que el push:
 *   1) auto-registra cada ruta activa en `wincaja.branches` (is_route, parent = la suc),
 *   2) rollup mes → `analytics.sales_by_route_monthly` (route_code `WIN-<code>`),
 *   3) line-level folio×sku → `analytics.route_push_lines` (para el drill-down),
 * de modo que reusa toda la maquinaria del servicio (matriz, filtros, desglose) sin tocar
 * el backend. No hay doble conteo: el reporte de ruta lee tablas de ruta, no `sales_daily`.
 *
 * ATRIBUCIÓN (2026-08-03): el catálogo `md.kduv` está REPLICADO idéntico entre sucursales, y
 * el flag `c4=1` (activa) solo se marca en la sucursal DUEÑA de la ruta (PH: 1V001/1V002).
 * En Piedad Abastos (md_02) y Yurécuaro (md_04) el mismo `kduv` trae las rutas con c4=0 aunque
 * VENDEN real (1V003 $1.97M en md_02, 1V004 $640k en md_04). Por eso NO basta `c4=1`: cada
 * rama declara EXPLÍCITAMENTE su(s) código(s) de ruta y su warehouse destino → atribución
 * limpia (cada ruta cae en el almacén de su sucursal dueña, sin contaminación cruzada).
 *
 * Fuente Kepler: kdm1 h ⋈ kdm2 d ON (c1,c2,c3,c4,c6); venta = U/D/10;
 *   ruta = h.c12 · cliente = h.c10 · fecha = h.c9 · folio = h.c6 ·
 *   sku = d.c8 · nombre = d.c10 (denormalizado) · unidades = d.c9 · importe = d.c13.
 *   (c5 varía por línea → NO es clave de documento, se excluye del join.)
 *
 * Config: VECINAL_BRANCHES (JSON) sobreescribe la lista built-in. Cada entrada:
 *   { src, parent, warehouse, codes:['1V003'], cutover:'2026-04-18' }
 *   - warehouse: código de commercial.warehouses (ej. 'MD-42'). Si falta, se resuelve por parent.
 *   - codes: lista explícita de códigos de ruta. Si falta, cae a `kduv WHERE c4=1` (auto).
 *   DST_URL / DATABASE_URL_NEW = destino (prod Railway)
 *   node database/importers/kepler/import-kepler-vecinal-routes.js           # dry-run TODAS las ramas
 *   node database/importers/kepler/import-kepler-vecinal-routes.js --apply
 *   ... [--year 2026]
 */
const { Client } = require('pg');

const M = '00000000-0000-0000-0000-00000000d01c';
const DST = process.env.DST_URL || process.env.DATABASE_URL_NEW || 'postgresql://postgres:superoot@localhost:5433/postgres_platform';
const APPLY = process.argv.includes('--apply');
const yi = process.argv.indexOf('--year');
const YEAR = yi !== -1 ? Number(process.argv[yi + 1]) : new Date().getFullYear();

// Sucursales con ruta vecinal. Cada ruta cae en el almacén de SU sucursal dueña.
// (env VECINAL_BRANCHES para override; el default cubre PH + Piedad Abastos + Yurécuaro.)
// El warehouse se resuelve por `parent` en wincaja.branches (prueba kepler_code y warehouse_code,
// usa el que exista en commercial.warehouses) → robusto a prod (códigos cortos 01/02/04) y a
// dev (MD-10/MD-42/MD-44). Pasar `warehouse` explícito solo si se quiere forzar uno.
// Fuente única del mapa de sucursales (paso 3 normalización almacén). src vía branchUrl
// (centraliza cred; de paso corrige md_01 que usaba 'postgres' en vez de 'platform_ro').
const { branchUrl } = require('../lib/kepler-branches');
const VECINAL_BRANCHES = process.env.VECINAL_BRANCHES ? JSON.parse(process.env.VECINAL_BRANCHES) : [
  { src: branchUrl('01'), parent: '10', codes: ['1V001', '1V002'], cutover: '2026-06-27' }, // Padre Hidalgo
  { src: branchUrl('02'), parent: '42', codes: ['1V003'], cutover: '2026-04-18' }, // Piedad Abastos
  { src: branchUrl('04'), parent: '44', codes: ['1V004'], cutover: '2026-05-08' }, // Yurécuaro
];

async function processBranch(dst, cfg) {
  const src = new Client({ connectionString: cfg.src, connectionTimeoutMillis: 8000, statement_timeout: 180000 });
  const tag = `${cfg.warehouse || cfg.parent}`;
  try { await src.connect(); }
  catch (e) { console.error(`  ❌ ${tag}: sin conexión (${e.message.slice(0, 50)}) — skip`); return { ok: false }; }
  try {
    // 1) rutas: explícitas (cfg.codes) o auto por kduv c4=1. Nombre siempre desde kduv.
    let cat;
    if (cfg.codes && cfg.codes.length) {
      cat = (await src.query(`SELECT c2 AS code, btrim(c3) AS name FROM md.kduv WHERE c2 = ANY($1)`, [cfg.codes])).rows;
      const missing = cfg.codes.filter((c) => !cat.some((r) => r.code === c));
      for (const c of missing) cat.push({ code: c, name: c }); // sin nombre en kduv → usa el código
    } else {
      cat = (await src.query(`SELECT c2 AS code, btrim(c3) AS name FROM md.kduv WHERE c4=1 AND c2 <> '' ORDER BY c2`)).rows;
    }
    if (!cat.length) { console.log(`  ${tag}: sin rutas (codes/kduv c4=1) — skip`); return { ok: true, routes: 0 }; }
    const codes = cat.map((r) => r.code);

    // warehouse destino: prueba explícito (cfg.warehouse), kepler_code y warehouse_code del
    // parent en wincaja.branches, y usa el PRIMERO que exista en commercial.warehouses. Prod
    // usa códigos cortos (01/02/04 = kepler_code); dev usa MD-10/MD-42/MD-44 (warehouse_code).
    const par = (await dst.query(
      `SELECT kepler_code, warehouse_code FROM wincaja.branches WHERE tenant_id=$1 AND source_branch=$2`, [M, cfg.parent])).rows[0];
    const candidates = [cfg.warehouse, par?.kepler_code, par?.warehouse_code].filter(Boolean);
    let wh = null;
    for (const code of candidates) {
      wh = (await dst.query(`SELECT id, code FROM commercial.warehouses WHERE tenant_id=$1 AND code=$2 AND deleted_at IS NULL`, [M, code])).rows[0];
      if (wh) break;
    }
    if (!wh) { console.error(`  ❌ ${tag}: ningún warehouse existe de [${candidates.join(', ')}] — skip`); return { ok: false }; }
    console.log(`  ${wh.code} ← ${cat.map((r) => `${r.code}=${r.name}`).join(' · ')}`);

    // 2) rollup mes (año completo → GREATEST no degrada)
    const from = `${YEAR}-01-01`, to = `${YEAR + 1}-01-01`;
    const J = `md.kdm1 h JOIN md.kdm2 d ON h.c1=d.c1 AND h.c2=d.c2 AND h.c3=d.c3 AND h.c4=d.c4 AND h.c6=d.c6`;
    const V = `h.c2='U' AND h.c3='D' AND h.c4='10' AND h.c12 = ANY($1)`;
    const roll = (await src.query(
      `SELECT h.c12 AS code, date_trunc('month', h.c9)::date AS month,
              sum(d.c9)::numeric AS units, sum(d.c13)::numeric AS revenue, count(DISTINCT h.c6)::int AS tickets
         FROM ${J} WHERE ${V} AND h.c9 >= $2 AND h.c9 < $3 AND h.c9 <= CURRENT_DATE
        GROUP BY 1, 2`, [codes, from, to])).rows;

    // 3) line-level INCREMENTAL (desde el último día cargado −1, piso en el cutover de la rama).
    const cutover = cfg.cutover || '2026-06-27';
    const maxRow = await dst.query(
      `SELECT max(business_date)::text d FROM analytics.route_push_lines WHERE tenant_id=$1 AND route_no = ANY($2)`, [M, codes]);
    let since = maxRow.rows[0]?.d
      ? new Date(new Date(maxRow.rows[0].d).getTime() - 864e5).toISOString().slice(0, 10)
      : cutover;
    if (since < cutover) since = cutover;
    // RR2.2: `d.c11` = unidad de venta POR LÍNEA y `d.c12` = precio unitario (decode ya
    // probado en la Fase AX: passthrough, cero unidades inventadas). Sin esto el desglose
    // por ticket de las rutas vecinales no puede decir en qué unidad se vendió.
    const lines = (await src.query(
      `SELECT h.c12 AS route_no, h.c9::date AS business_date, h.c6 AS folio, d.c8 AS sku,
              max(d.c10) AS producto, max(NULLIF(NULLIF(btrim(h.c10), ''), '0001')) AS cliente,
              max(NULLIF(btrim(d.c11), '')) AS unidad, max(d.c12)::numeric AS precio_unitario,
              sum(d.c9)::numeric AS qty, sum(d.c13)::numeric AS importe
         FROM ${J} WHERE ${V} AND h.c9 >= $2 AND h.c9 <= CURRENT_DATE AND btrim(coalesce(d.c8,'')) <> ''
        GROUP BY 1, 2, 3, 4`, [codes, since])).rows;

    const rev = roll.reduce((s, r) => s + Number(r.revenue || 0), 0);
    console.log(`    rollup: ${roll.length} filas ruta×mes · $${Math.round(rev).toLocaleString()} · line-level: ${lines.length} líneas desde ${since}`);

    if (!APPLY) return { ok: true, routes: cat.length, rev };

    // 1) auto-registro de rutas en wincaja.branches (idempotente)
    for (const r of cat) {
      await dst.query(
        `INSERT INTO wincaja.branches (tenant_id, source_branch, branch_name, is_route, parent_branch, warehouse_code, status, imported_at)
         VALUES ($1,$2,$3,true,$4,$5,'active',now())
         ON CONFLICT (tenant_id, source_branch) DO UPDATE SET
           branch_name=EXCLUDED.branch_name, is_route=true, parent_branch=EXCLUDED.parent_branch, imported_at=now()`,
        [M, r.code, r.name, cfg.parent, `RUTA-${r.code}`]);
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
    const BATCH = 1000, N = 11;
    for (let i = 0; i < lines.length; i += BATCH) {
      const chunk = lines.slice(i, i + BATCH);
      const vals = chunk.map((_, ri) => `(${Array.from({ length: N }, (_, k) => `$${ri * N + k + 1}`).join(',')})`);
      const params = [];
      for (const r of chunk) {
        params.push(M, r.route_no, r.business_date, r.folio, r.sku, r.producto || null, r.cliente || null,
          r.qty, r.importe, r.unidad || null, r.precio_unitario ?? null);
      }
      const res = await dst.query(
        `INSERT INTO analytics.route_push_lines (tenant_id, route_no, business_date, folio, sku, producto, cliente, qty, importe, unidad, precio_unitario)
         VALUES ${vals.join(',')}
         ON CONFLICT (tenant_id, route_no, business_date, folio, sku) DO UPDATE SET
           producto = EXCLUDED.producto, cliente = EXCLUDED.cliente,
           qty = EXCLUDED.qty, importe = EXCLUDED.importe,
           unidad = EXCLUDED.unidad, precio_unitario = EXCLUDED.precio_unitario, imported_at = now()`, params);
      ins += res.rowCount;
    }
    console.log(`    [APPLY] ${cat.length} rutas · ${roll.length} filas rollup · ${ins} líneas → ${wh.code}`);
    return { ok: true, routes: cat.length, rev };
  } catch (e) {
    console.error(`  ❌ ${tag}: ${e.message}`);
    return { ok: false };
  } finally { await src.end().catch(() => {}); }
}

(async () => {
  const dst = new Client({ connectionString: DST, ssl: /rlwy|railway|proxy/i.test(DST) ? { rejectUnauthorized: false } : false });
  await dst.connect();
  try {
    console.log(`\n=== RUTAS VECINALES Kepler → reporte por ruta (${APPLY ? 'APPLY' : 'DRY-RUN'}, año ${YEAR}, ${VECINAL_BRANCHES.length} ramas) ===\n`);
    if (APPLY) { await dst.query('BEGIN'); await dst.query(`SET LOCAL app.tenant_id = '${M}'`); }
    let totalRev = 0, okCount = 0;
    for (const cfg of VECINAL_BRANCHES) {
      const r = await processBranch(dst, cfg);
      if (r.ok) { okCount++; totalRev += r.rev || 0; }
    }
    if (APPLY) await dst.query('COMMIT');
    console.log(`\n=== ${okCount}/${VECINAL_BRANCHES.length} ramas OK · $${Math.round(totalRev).toLocaleString()} vecinal total ${APPLY ? '(aplicado)' : '(dry-run)'} ===`);
  } catch (e) {
    await dst.query('ROLLBACK').catch(() => {});
    console.error('\nERROR (rollback):', e.message);
    process.exitCode = 1;
  } finally {
    await dst.end().catch(() => {});
  }
})();
