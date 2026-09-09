/* eslint-disable no-console */
/**
 * RR — Line-level del PUSH de rutas para el DRILL-DOWN de /comercial/ventas-por-ruta.
 * Lee `.249 mart.ventas` (sucursal='ruta_NN') a nivel línea (folio×sku) y lo aterriza en
 * `analytics.route_push_lines`, que la vista `analytics.v_route_sales_lines` une con la
 * venta a bordo Wincaja. Complementa a import-route-push-monthly.js (ese es el rollup para
 * la matriz; éste es el detalle).
 *
 * INCREMENTAL POR RUTA: cada ruta arranca en SU último día ya cargado (menos 1, por si quedó
 * parcial); una ruta que la plataforma todavía no conoce arranca en el cutover y trae toda su
 * historia. Así el egress es de ~1-2 días por corrida sin dejar afuera a una van recién dada de
 * alta. Agrega en origen por (folio, sku) para clave natural limpia y hace UPSERT DO UPDATE
 * (idempotente: re-cargar un día ya cargado reescribe los mismos valores).
 *
 *   DST_URL / DATABASE_URL_NEW = destino (prod)
 *   SRC_URL = runner .249 (default)  ·  --days N = piso mínimo de ventana (default auto)
 *   node database/importers/kepler/import-route-push-lines.js --apply
 */
const { Client } = require('pg');

const M = '00000000-0000-0000-0000-00000000d01c';
const SRC = process.env.SRC_URL || 'postgresql://postgres:superoot@192.168.0.249:5433/kepler_consolidado';
const DST = process.env.DST_URL || process.env.DATABASE_URL_NEW || (() => { throw new Error('falta la URL de la DB destino: exporta DATABASE_URL_NEW — la copia local :5433/postgres_platform fue PURGADA 2026-09-08 (ver reference_prod_db_connection_topology)'); })();
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

    // Incremental POR RUTA (no global): cada ruta reanuda desde su propio último día cargado (−1),
    // y una ruta NUEVA — una van recién dada de alta — arranca en el cutover y trae TODA su historia.
    // Con el watermark global, el máximo de las rutas viejas tapaba a la nueva: las vans de Canindo
    // empezaron a pushear el 12-ago y la ventana arrancaba el 07-sep (el max de PH), así que sus
    // primeros 26 días quedaban inalcanzables para siempre — $1.23M medidos el 2026-09-08.
    // `--days N` sigue siendo un piso que aplica a todas.
    // El piso del runner se mide con EL MISMO filtro que inserta el loader (sku no vacío) para que
    // el hueco frontal converja: una vez cargado, `plat_min == runner_min` y se vuelve a incremental.
    const rutas = (await src.query(
      `SELECT substring(sucursal from 'ruta_(.*)') rt, min(fecha)::date::text d0
         FROM mart.ventas_enriched
        WHERE sucursal LIKE 'ruta_%' AND fecha <= CURRENT_DATE AND btrim(coalesce(sku,'')) <> ''
        GROUP BY 1 ORDER BY 1`)).rows.filter((r) => r.rt);
    if (!rutas.length) { console.log('  el runner no tiene ninguna ruta_* — nada que hacer.'); return; }

    const plat = new Map((await dst.query(
      `SELECT route_no, min(business_date)::text d0, max(business_date)::text d1
         FROM analytics.route_push_lines WHERE tenant_id=$1 GROUP BY 1`, [M])).rows.map((r) => [r.route_no, r]));

    const floor = DAYS_FLOOR ? new Date(Date.now() - DAYS_FLOOR * 864e5).toISOString().slice(0, 10) : null;
    const ventana = rutas.map(({ rt, d0 }) => {
      const p = plat.get(rt);
      // 1) ruta que la plataforma no conoce → toda su historia.
      // 2) hueco FRONTAL (el runner tiene días anteriores al primero cargado) → sanar desde el piso
      //    del runner. Pasa cuando una van se da de alta después del cutover: su historia previa
      //    quedaba tapada por el watermark de las rutas viejas.
      // 3) al día → reanudar en su propio último día −1 (por si quedó parcial).
      let since, motivo;
      if (!p) { since = d0 || CUTOVER; motivo = 'ruta nueva'; }
      else if (d0 && d0 < p.d0) { since = d0; motivo = `hueco frontal (runner ${d0} < cargado ${p.d0})`; }
      else { since = new Date(new Date(p.d1).getTime() - 864e5).toISOString().slice(0, 10); motivo = null; }
      if (floor && floor < since) { since = floor; motivo = motivo || `piso --days ${DAYS_FLOOR}`; }
      if (since < CUTOVER) since = CUTOVER;
      return { rt, since, motivo };
    });
    console.log(`  ventana por ruta: ${ventana.map((v) => `${v.rt}>=${v.since}${v.motivo ? '*' : ''}`).join(' · ')}`);
    for (const v of ventana.filter((x) => x.motivo)) console.log(`    * ruta ${v.rt}: ${v.motivo}`);

    // RR2.2: se lee de `mart.ventas_enriched` (mismo universo verificado — 53,429 líneas /
    // 1,761 folios / $5,660,101.61 idénticos a mart.ventas) para tomar:
    //   · `erp_customer_ref` = el cliente DE VERDAD (antes se sacaba de `forma_pago`, columna
    //     mal nombrada en el contrato del push, con un NULLIF a 'CONTADO' como parche);
    //     NULL en channel='tienda' = mostrador a bordo (público), que es la semántica correcta.
    //   · `unidad` = unidad de venta POR LÍNEA tal como la declara la fuente (PAQ/PZA/KG/CJA…).
    //   · `precio_neto` = precio unitario en esa unidad.
    const vals = ventana.map((_, i) => `($${i * 2 + 1}::text, $${i * 2 + 2}::date)`).join(',');
    const { rows } = await src.query(
      `WITH w(route_no, since) AS (VALUES ${vals})
       SELECT w.route_no,
              v.fecha::date AS business_date, v.folio, v.sku, max(v.producto) AS producto,
              max(v.erp_customer_ref) AS cliente,
              max(NULLIF(btrim(v.unidad), '')) AS unidad,
              max(v.precio_neto)::numeric AS precio_unitario,
              sum(v.cantidad)::numeric AS qty, sum(v.importe)::numeric AS importe
         FROM mart.ventas_enriched v
         JOIN w ON v.sucursal = 'ruta_' || w.route_no
        WHERE v.fecha >= w.since AND v.fecha <= CURRENT_DATE AND btrim(coalesce(v.sku,'')) <> ''
        GROUP BY 1, 2, 3, 4`,
      ventana.flatMap((v) => [v.rt, v.since]),
    );
    console.log(`  origen (runner): ${rows.length} líneas (folio×sku)`);
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
    // `rowCount` de un ON CONFLICT DO UPDATE cuenta insertadas + actualizadas: no se puede decir
    // "N nuevas / M ya existían" con este número (siempre daba "0 ya existían" — línea mentirosa).
    console.log(`\n[APPLY] COMMIT — ${ins} líneas escritas (insert o update, el UPSERT no las distingue).`);
  } catch (e) {
    await dst.query('ROLLBACK').catch(() => {});
    console.error('\nERROR (rollback):', e.message);
    process.exitCode = 1;
  } finally {
    await src.end().catch(() => {});
    await dst.end().catch(() => {});
  }
})();
