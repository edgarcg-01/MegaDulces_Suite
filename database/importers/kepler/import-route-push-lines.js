/* eslint-disable no-console */
/**
 * RR — Line-level del PUSH de rutas para el DRILL-DOWN de /comercial/ventas-por-ruta.
 * Lee `.249 mart.ventas` (sucursal='ruta_NN') a nivel línea (folio×sku) y lo aterriza en
 * `analytics.route_push_lines`, que la vista `analytics.v_route_sales_lines` une con la
 * venta a bordo Wincaja. Complementa a import-route-push-monthly.js (ese es el rollup para
 * la matriz; éste es el detalle).
 *
 * INCREMENTAL: arranca en el último día ya cargado (menos 1, por si quedó parcial) o en el
 * cutover; así el egress a Railway es de ~1-2 días por corrida, no del histórico. Ticket POS
 * inmutable → UPSERT DO NOTHING (nunca reescribe). Agrega en origen por (folio, sku) para
 * clave natural limpia.
 *
 *   DST_URL / DATABASE_URL_NEW = destino (prod)
 *   SRC_URL = runner .249 (default)  ·  --days N = piso mínimo de ventana (default auto)
 *   node database/importers/kepler/import-route-push-lines.js --apply
 */
const { Client } = require('pg');

const M = '00000000-0000-0000-0000-00000000d01c';
const SRC = process.env.SRC_URL || 'postgresql://postgres:superoot@192.168.0.249:5433/kepler_consolidado';
const DST = process.env.DST_URL || process.env.DATABASE_URL_NEW || 'postgresql://postgres:superoot@localhost:5433/postgres_platform';
const APPLY = process.argv.includes('--apply');
const CUTOVER = '2026-06-28'; // PH migró de .mdb al push ~fin de junio
const di = process.argv.indexOf('--days');
const DAYS_FLOOR = di !== -1 ? Number(process.argv[di + 1]) : null; // fuerza ventana mínima (backfill)

(async () => {
  const dst = new Client({ connectionString: DST, ssl: /rlwy|railway|proxy/i.test(DST) ? { rejectUnauthorized: false } : false });
  await dst.connect();
  const src = new Client({ connectionString: SRC, connectionTimeoutMillis: 8000, statement_timeout: 180000 });
  try {
    console.log(`\n=== LINE-LEVEL venta en ruta (PUSH .249) → analytics.route_push_lines (${APPLY ? 'APPLY' : 'DRY-RUN'}) ===\n`);
    try { await src.connect(); }
    catch (e) { console.error(`❌ sin conexión al runner .249 (${e.message}) — abortando`); process.exitCode = 1; return; }

    // Incremental: desde el último día cargado (−1) o el cutover. --days fuerza un piso mayor (backfill).
    const maxRow = await dst.query(`SELECT max(business_date)::text d FROM analytics.route_push_lines WHERE tenant_id=$1`, [M]);
    let since = maxRow.rows[0]?.d
      ? new Date(new Date(maxRow.rows[0].d).getTime() - 864e5).toISOString().slice(0, 10)
      : CUTOVER;
    if (DAYS_FLOOR) {
      const floor = new Date(Date.now() - DAYS_FLOOR * 864e5).toISOString().slice(0, 10);
      if (floor < since) since = floor;
    }
    if (since < CUTOVER) since = CUTOVER;
    console.log(`  ventana: business_date >= ${since}`);

    // RR2.2: se lee de `mart.ventas_enriched` (mismo universo verificado — 53,429 líneas /
    // 1,761 folios / $5,660,101.61 idénticos a mart.ventas) para tomar:
    //   · `erp_customer_ref` = el cliente DE VERDAD (antes se sacaba de `forma_pago`, columna
    //     mal nombrada en el contrato del push, con un NULLIF a 'CONTADO' como parche);
    //     NULL en channel='tienda' = mostrador a bordo (público), que es la semántica correcta.
    //   · `unidad` = unidad de venta POR LÍNEA tal como la declara la fuente (PAQ/PZA/KG/CJA…).
    //   · `precio_neto` = precio unitario en esa unidad.
    const { rows } = await src.query(
      `SELECT substring(sucursal from 'ruta_(.*)') AS route_no,
              fecha::date AS business_date, folio, sku, max(producto) AS producto,
              max(erp_customer_ref) AS cliente,
              max(NULLIF(btrim(unidad), '')) AS unidad,
              max(precio_neto)::numeric AS precio_unitario,
              sum(cantidad)::numeric AS qty, sum(importe)::numeric AS importe
         FROM mart.ventas_enriched
        WHERE sucursal LIKE 'ruta_%' AND fecha >= $1 AND fecha <= CURRENT_DATE AND btrim(coalesce(sku,'')) <> ''
        GROUP BY 1, 2, 3, 4`,
      [since],
    );
    console.log(`  origen (runner): ${rows.length} líneas (folio×sku) desde ${since}`);
    if (!rows.length) { console.log('  nada nuevo.'); return; }

    if (!APPLY) { console.log('\n[DRY-RUN] nada cambió.'); return; }

    await dst.query('BEGIN');
    await dst.query(`SET LOCAL app.tenant_id = '${M}'`);
    let ins = 0;
    const BATCH = 1000, N = 11;
    for (let i = 0; i < rows.length; i += BATCH) {
      const chunk = rows.slice(i, i + BATCH);
      const vals = chunk.map((_, ri) => `(${Array.from({ length: N }, (_, k) => `$${ri * N + k + 1}`).join(',')})`);
      const params = [];
      for (const r of chunk) {
        params.push(M, r.route_no, r.business_date, r.folio, r.sku, r.producto || null, r.cliente || null,
          r.qty, r.importe, r.unidad || null, r.precio_unitario ?? null);
      }
      // DO UPDATE: corrige filas ya cargadas (ej. backfill del cliente/unidad) e idempotente en el nightly.
      const res = await dst.query(
        `INSERT INTO analytics.route_push_lines (tenant_id, route_no, business_date, folio, sku, producto, cliente, qty, importe, unidad, precio_unitario)
         VALUES ${vals.join(',')}
         ON CONFLICT (tenant_id, route_no, business_date, folio, sku) DO UPDATE SET
           producto = EXCLUDED.producto, cliente = EXCLUDED.cliente,
           qty = EXCLUDED.qty, importe = EXCLUDED.importe,
           unidad = EXCLUDED.unidad, precio_unitario = EXCLUDED.precio_unitario, imported_at = now()`, params);
      ins += res.rowCount;
    }
    await dst.query('COMMIT');
    console.log(`\n[APPLY] COMMIT — ${ins} líneas nuevas insertadas (${rows.length - ins} ya existían).`);
  } catch (e) {
    await dst.query('ROLLBACK').catch(() => {});
    console.error('\nERROR (rollback):', e.message);
    process.exitCode = 1;
  } finally {
    await src.end().catch(() => {});
    await dst.end().catch(() => {});
  }
})();
