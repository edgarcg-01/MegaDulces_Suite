/* eslint-disable no-console */
/**
 * RR — Feed: VENTA A BORDO de las rutas del PUSH (camionetas Kepler local) →
 * `analytics.sales_by_route_monthly`, el gold que consume /comercial/ventas-por-ruta.
 *
 * Contexto (cutover fin de junio 2026): las rutas de PH migraron de las Access `.mdb`
 * de Wincaja (fuente legacy, congelada ~06-27) al PUSH: cada camioneta corre un Kepler
 * local y su `push-ruta.cmd` sube la venta cada 15 min al runner consolidado
 * (`192.168.0.222:5433/kepler_consolidado` → `mart.ventas`, `sucursal='ruta_NN'`).
 * Ese push llega FRESCO pero no había puente hacia la plataforma → el reporte mostraba
 * julio vacío. Este feed cierra ese puente.
 *
 * Escribe con el MISMO namespace que Wincaja (`route_code = 'WIN-<NN>'`, warehouse = la
 * sucursal madre por el prefijo del almacén, ej. '01-003' → '01') para que sea UNA sola
 * fila continua por ruta (Wincaja ene–jun histórico + push jul→ actual). UPSERT GREATEST:
 * julio crece con los días; junio (2 días del push) nunca degrada el mes completo Wincaja.
 * Compatible con import-wincaja-routes-monthly (ahora UPSERT, no borra el namespace).
 *
 * ⭐ [VL.7.5] EL RUNNER SE MUDÓ A LINUX (2026-09-14). Era `192.168.0.249:5433`, un Postgres en
 * Docker Desktop sobre Windows. Ahora `192.168.0.222:5433` (`md`), y este feed lo lee **local**
 * por `DATABASE_URL_KEPLER_CONSOLIDADO` (el contenedor `pg-ods`), sin salir a la red.
 *
 * ⛔ LAS ~35 CAMIONETAS SIGUEN APUNTANDO A `.249` Y ESO ES A PROPÓSITO. Tienen la IP escrita a
 * mano en su `push-ruta.cmd`, y repuntarlas es visitar 35 equipos. En su lugar, `.249:5433` quedó
 * como un **reenvío TCP de Windows** (`netsh interface portproxy`) hacia `md`: la camioneta cree
 * que habla con `.249` y el dato aterriza en Linux.
 *
 * ⭐ El reenvío NO es sólo comodidad, es más disponible que lo que reemplaza: `netsh portproxy`
 * vive en el servicio `iphlpsvc` (automático, arranca CON LA MÁQUINA), mientras que el Postgres
 * en Docker Desktop **no arranca hasta que alguien inicia sesión** — la falla que dejó 9.5 h sin
 * ingesta el 2026-09-10.
 *
 * ⚠️ Antes se leía desde `.249` a través del proxy de puertos de Docker Desktop, y eso tenía a
 * este feed fallando **27 de 27 corridas** con `timeout expired`. Leer local lo elimina.
 *
 *   SRC_URL=…@192.168.0.222:5433/kepler_consolidado (default; en `md` gana DATABASE_URL_KEPLER_CONSOLIDADO)
 *   DST_URL / DATABASE_URL_NEW = destino (prod Railway)
 *
 * `[CANON.5.16]` (2026-11-06) — por default ya no lee el `mart`: suma `analytics.route_push_lines`,
 * que es el mismo push a nivel línea y ya vive en prod (lo llena `import-route-push-lines`). El
 * almacén madre de la ruta sale de `commercial.warehouses` (`RUTA-<NN>` → su `source_warehouse_id`);
 * si la ruta no tiene almacén propio (las vecinales `1V00N`), del renglón `WIN-<NN>` que ya existe;
 * si tampoco, `01` como antes. Comparación en seco (2026, sólo lectura): simulado el upsert GREATEST
 * de la fuente nueva contra la tabla, las 77 filas ruta×mes ya existen y NINGUNA cambiaría. Control
 * (comparar contra el mes siguiente): 34 cambiarían y 15 serían nuevas.
 * ⚠️ En los carriles corre ANTES de `import-route-push-lines`, así que suma las líneas de la vuelta
 * anterior: va una vuelta atrás hasta que se inviertan. `--source=mart` conserva la fuente vieja.
 *
 *   DST_URL=…railway node database/importers/kepler/import-route-push-monthly.js           # dry-run
 *   DST_URL=…             node database/importers/kepler/import-route-push-monthly.js --apply
 *   ... [--year 2026] [--source=mart]
 */
const { Client } = require('pg');

const M = '00000000-0000-0000-0000-00000000d01c';
const SRC = process.env.SRC_URL || process.env.DATABASE_URL_KEPLER_CONSOLIDADO || 'postgresql://postgres:superoot@192.168.0.222:5433/kepler_consolidado';
const DST = process.env.DST_URL || process.env.DATABASE_URL_NEW || (() => { throw new Error('falta la URL de la DB destino: exporta DATABASE_URL_NEW — la copia local :5433/postgres_platform fue PURGADA 2026-09-08 (ver reference_prod_db_connection_topology)'); })();
const APPLY = process.argv.includes('--apply');
const yi = process.argv.indexOf('--year');
const YEAR = yi !== -1 ? Number(process.argv[yi + 1]) : new Date().getFullYear();
const SOURCE = (process.argv.find((a) => a.startsWith('--source=')) || '').split('=')[1] || 'lines';
if (!['lines', 'mart'].includes(SOURCE)) throw new Error(`--source desconocido: ${SOURCE} (lines | mart)`);

// Ruta × mes desde las líneas del push en prod. wcode: almacén madre de `RUTA-<NN>`; si la ruta no
// tiene almacén propio, el del renglón WIN-<NN> que ya existe; si tampoco, '01' (como el mart).
const LINES_SQL = `
  WITH r AS (
    SELECT route_no, date_trunc('month', business_date)::date AS month,
           sum(qty)::numeric AS units, sum(importe)::numeric AS revenue, count(DISTINCT folio)::int AS tickets
      FROM analytics.route_push_lines
     WHERE tenant_id = $3 AND business_date >= $1 AND business_date < $2 AND business_date <= CURRENT_DATE
     GROUP BY 1, 2)
  SELECT COALESCE(
           (SELECT f.code FROM commercial.warehouses w JOIN commercial.warehouses f ON f.id = w.source_warehouse_id
             WHERE w.tenant_id = $3 AND w.code = 'RUTA-' || r.route_no AND w.deleted_at IS NULL LIMIT 1),
           (SELECT w.code FROM analytics.sales_by_route_monthly s JOIN commercial.warehouses w ON w.id = s.warehouse_id
             WHERE s.tenant_id = $3 AND s.route_code = 'WIN-' || r.route_no ORDER BY s.month DESC LIMIT 1),
           '01') AS wcode,
         r.route_no, r.month, r.units, r.revenue, r.tickets
    FROM r`;
// Fuente vieja: mart.ventas (line-level) → ruta × mes. warehouse = prefijo del almacén ('01-003' → '01').
const MART_SQL = `
  SELECT COALESCE(NULLIF(split_part(max(almacen), '-', 1), ''), '01') AS wcode,
         substring(sucursal from 'ruta_(.*)') AS route_no,
         date_trunc('month', fecha)::date AS month,
         sum(cantidad)::numeric AS units,
         sum(importe)::numeric  AS revenue,
         count(DISTINCT folio)::int AS tickets
    FROM mart.ventas
   WHERE sucursal LIKE 'ruta_%' AND fecha >= $1 AND fecha < $2 AND fecha <= CURRENT_DATE
   GROUP BY sucursal, date_trunc('month', fecha)`;

(async () => {
  const dst = new Client({ connectionString: DST, ssl: /rlwy|railway|proxy/i.test(DST) ? { rejectUnauthorized: false } : false });
  await dst.connect();
  const src = SOURCE === 'mart' ? new Client({ connectionString: SRC, connectionTimeoutMillis: 8000, statement_timeout: 120000 }) : dst;
  try {
    console.log(`\n=== VENTA en ruta (PUSH camionetas, ${SOURCE}) → analytics.sales_by_route_monthly (${APPLY ? 'APPLY' : 'DRY-RUN'}, año ${YEAR}) ===\n`);
    if (src !== dst) {
      try { await src.connect(); }
      catch (e) { console.error(`❌ sin conexión al runner consolidado (${e.message}) — abortando`); process.exitCode = 1; return; }
    }

    const from = `${YEAR}-01-01`, to = `${YEAR + 1}-01-01`;
    const { rows } = SOURCE === 'mart'
      ? await src.query(MART_SQL, [from, to])
      : await src.query(LINES_SQL, [from, to, M]);
    if (!rows.length) { console.log('sin ventas de ruta en el runner para el rango — nada que hacer.'); return; }

    const routes = new Set(rows.map((r) => r.route_no)).size;
    const rev = rows.reduce((s, r) => s + Number(r.revenue || 0), 0);
    console.log(`  origen (runner): ${rows.length} filas ruta×mes · ${routes} rutas · $${Math.round(rev).toLocaleString()}`);
    for (const r of rows.slice(0, 20)) {
      console.log(`    ${r.wcode} · ruta ${r.route_no} · ${r.month.toISOString().slice(0, 7)} · $${Math.round(Number(r.revenue)).toLocaleString()} · ${r.tickets} tickets`);
    }

    if (!APPLY) { console.log('\n[DRY-RUN] nada cambió.'); return; }

    // warehouse code → id
    const whs = (await dst.query(`SELECT id, code FROM commercial.warehouses WHERE tenant_id=$1`, [M])).rows;
    const whTo = new Map(whs.map((w) => [w.code, w.id]));

    await dst.query('BEGIN');
    await dst.query(`SET LOCAL app.tenant_id = '${M}'`);
    const payload = rows.filter((r) => whTo.has(r.wcode) && r.route_no);
    const skipped = rows.length - payload.length;
    let upserts = 0;
    const BATCH = 500;
    for (let i = 0; i < payload.length; i += BATCH) {
      const chunk = payload.slice(i, i + BATCH);
      const vals = chunk.map((_, ri) => { const b = ri * 8; return `($${b+1},$${b+2},$${b+3},$${b+4},$${b+5},$${b+6},$${b+7},$${b+8})`; });
      const params = [];
      for (const r of chunk) params.push(M, whTo.get(r.wcode), `WIN-${r.route_no}`, r.route_no, r.month, r.units, r.revenue, r.tickets);
      // GREATEST: no degrada el mes completo Wincaja (junio); julio crece con los días del push.
      const res = await dst.query(
        `INSERT INTO analytics.sales_by_route_monthly
           (tenant_id, warehouse_id, route_code, route_no, month, units, revenue, tickets)
         VALUES ${vals.join(',')}
         ON CONFLICT (tenant_id, warehouse_id, route_code, month) DO UPDATE SET
           units   = GREATEST(analytics.sales_by_route_monthly.units,   EXCLUDED.units),
           revenue = GREATEST(analytics.sales_by_route_monthly.revenue, EXCLUDED.revenue),
           tickets = GREATEST(analytics.sales_by_route_monthly.tickets, EXCLUDED.tickets),
           route_no = COALESCE(EXCLUDED.route_no, analytics.sales_by_route_monthly.route_no),
           updated_at = now()`, params);
      upserts += res.rowCount;
    }
    await dst.query('COMMIT');
    console.log(`\n[APPLY] COMMIT — ${upserts} filas WIN-<ruta> upserted${skipped ? ` · ${skipped} sin warehouse resuelto (omitidas)` : ''}.`);
  } catch (e) {
    await dst.query('ROLLBACK').catch(() => {});
    console.error('\nERROR (rollback):', e.message);
    process.exitCode = 1;
  } finally {
    if (src !== dst) await src.end().catch(() => {});
    await dst.end().catch(() => {});
  }
})();
