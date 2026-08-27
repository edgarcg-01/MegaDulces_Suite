/* eslint-disable no-console */
/**
 * RA.5 — OC en tránsito Kepler → analytics.purchase_in_transit (BULK).
 *
 * "En tránsito" = mercancía pedida al proveedor que aún NO entró al inventario.
 * En la cadena de compras de Kepler (verificada 2026-07-09, ver FASE_RA §2.5):
 *   Requisición X-A-30 → Orden de compra X-A-35 → Vale de entrada X-A-37 →
 *   Orden de entrada X-A-40 (AQUÍ suma existencia) → Aplica/CxP X-A-20.
 * El enlace al documento PADRE es el back-pointer c37(grupo)/c39(folio).
 *
 * En tránsito = OC (X-A-35) SIN una orden de entrada (X-A-40) aguas abajo vía su
 * vale (X-A-37). Como Mega Dulces suele capturar toda la cadena de golpe, la mayoría
 * de las OCs ya traen su X-A-40 → en_tránsito ≈ 0; sólo las OCs realmente abiertas
 * (sin recepción) cuentan. Se agrega por sku×almacén.
 *
 * Grano/almacén: reusa el MISMO map code→sucursal que el stock/reorden (STOCK_BRANCH_MAP).
 * El nº de sucursal para el filtro kdm1.c1 se deriva del `md_NN` de la URL (kdm1 arrastra
 * réplicas de otras sucursales → filtrar la propia). analytics.* sin RLS → tenant_id explícito.
 *
 * FUENTE: el ODS, vía el shim `md` (CDC.8, mig 20260827130000). Antes abría una conexión POR
 * SUCURSAL a `:5433/kepler_md_XX` — o sea 7 conexiones a la LAN desde el runner on-prem, con su
 * timeout y su modo de falla propio. Ahora lee de `kepler_ods` en la MISMA conexión de destino,
 * fijando `app.kepler_sucursal` en cada vuelta: `md.kdm1` es una vista sobre
 * `kepler_ods.kdm1 WHERE sucursal = current_setting('app.kepler_sucursal')`, que reproduce la DB de
 * esa sucursal tal cual (incluidas las réplicas cruzadas que el `c1=$1` de abajo ya filtra).
 * **El SQL no cambió ni un carácter** — el shim existe justo para eso. El `md_NN` de la URL del MAP
 * se sigue usando, pero sólo como fuente del número de sucursal: ya no se conecta ahí.
 *
 *   node database/importers/kepler/import-in-transit.js          # dry-run
 *   node database/importers/kepler/import-in-transit.js --apply  # commit
 */

const { Client } = require('pg');

const M = '00000000-0000-0000-0000-00000000d01c';
const DST = process.env.DATABASE_URL_NEW || 'postgresql://postgres:superoot@localhost:5433/postgres_platform';
const APPLY = process.argv.includes('--apply');
const BATCH = 1000;
// Ventana de OCs a escanear. Una OC "en tránsito" es RECIENTE (las viejas ya se recibieron);
// sin esto el NOT EXISTS correlacionado escanea TODO el histórico de kdm1 → nested-loop → cuelga
// (>10 min → el orquestador lo mata, código 124). 120 d cubre cualquier OC abierta razonable.
const IN_TRANSIT_DAYS = Math.max(1, Number(process.env.IN_TRANSIT_DAYS) || 120);

// Fuente única del mapa de sucursales (paso 3 normalización almacén). Con CEDIS '00'.
const { stockMap } = require('../lib/kepler-branches');
const MAP = process.env.STOCK_BRANCH_MAP ? JSON.parse(process.env.STOCK_BRANCH_MAP) : stockMap({ cedis: true });

// Nº de sucursal Kepler (kdm1.c1) desde el md_NN de la URL — kdm1 trae réplicas.
function branchNum(url) {
  const m = /md_(\d+)/i.exec(url || '');
  return m ? m[1] : null;
}

// OCs (X-A-35) sin orden de entrada (X-A-40) aguas abajo vía el vale (X-A-37).
const IN_TRANSIT_SQL = `
  SELECT l.c8 AS sku, SUM(l.c9) AS qty, COUNT(DISTINCT oc.c6) AS oc_count
  FROM md.kdm1 oc
  JOIN md.kdm2 l
    ON l.c1=oc.c1 AND l.c2=oc.c2 AND l.c3=oc.c3 AND l.c4=oc.c4 AND l.c6=oc.c6
  WHERE oc.c1=$1 AND oc.c2='X' AND oc.c3='A' AND oc.c4='35'
    AND oc.c9::date >= CURRENT_DATE - ${IN_TRANSIT_DAYS}
    AND NOT EXISTS (
      SELECT 1
      FROM md.kdm1 vale
      JOIN md.kdm1 oe
        ON oe.c1=vale.c1 AND oe.c2='X' AND oe.c3='A' AND oe.c4='40'
       AND oe.c37='37' AND oe.c39=vale.c6
      WHERE vale.c1=oc.c1 AND vale.c2='X' AND vale.c3='A' AND vale.c4='37'
        AND vale.c37='35' AND vale.c39=oc.c6
    )
  GROUP BY l.c8
  HAVING SUM(l.c9) > 0`;

(async () => {
  const db = new Client({ connectionString: DST });
  await db.connect();
  try {
    console.log(`\n=== OC en tránsito Kepler → analytics.purchase_in_transit (BULK, ${APPLY ? 'APPLY' : 'DRY-RUN'}) ===\n`);

    // El shim `md` es la fuente ahora (ya no hay conexiones per-branch): sin él no hay de dónde leer.
    if (!(await db.query(`SELECT to_regclass('md.kdm1') AS t`)).rows[0].t) {
      throw new Error('falta el esquema md (shim del ODS) — corré la migración 20260827130000_kepler_ods_md_shim');
    }
    // Crea sólo las vistas que falten (el ODS gana un kdc2YYMM por mes). Sin `force` es una query
    // al catálogo, no 225 DDL.
    await db.query(`SELECT md.refresh_shim() AS n`);

    const prods = (await db.query(`SELECT id, sku FROM public.products WHERE tenant_id=$1 AND btrim(coalesce(sku,''))<>''`, [M])).rows;
    const skuToId = new Map(prods.map((p) => [p.sku, p.id]));
    console.log(`  catálogo prod con sku: ${skuToId.size}`);

    await db.query('BEGIN');
    await db.query(`CREATE TEMP TABLE stg_transit (warehouse_id uuid, product_id uuid, qty numeric, oc_count int) ON COMMIT DROP`);

    const summary = [];
    const touched = []; // warehouse_ids leídos OK (para delete-not-seen, incl. los que quedaron en 0)
    for (const m of MAP) {
      const whr = (await db.query(`SELECT id FROM commercial.warehouses WHERE tenant_id=$1 AND code=$2`, [M, m.code])).rows;
      if (!whr.length) { console.log(`  ⚠ warehouse ${m.code} no existe — skip`); continue; }
      const warehouseId = whr[0].id;
      const suc = branchNum(m.url);
      if (!suc) { console.log(`  ⚠ ${m.code}: no pude derivar sucursal de la URL — skip`); continue; }

      // REPOINTEADO AL ODS (CDC.8). Antes abría una conexión por sucursal a :5433/kepler_md_XX.
      // Ahora lee del ODS por el shim `md`, en la MISMA conexión, fijando la sucursal de la sesión:
      // `md.kdm1` es una vista sobre `kepler_ods.kdm1 WHERE sucursal = current_setting(...)`, o sea
      // la DB de esa sucursal tal cual. **El SQL de arriba no cambió** — eso es todo el punto.
      let matched = 0, unmatched = 0, ocs = 0;
      try {
        // set_config y no SET: SET no acepta parámetros. `false` = alcance de sesión (se sobreescribe
        // en cada vuelta del loop). Si esto no se fija, las vistas devuelven 0 filas, no 7 copias.
        await db.query(`SELECT set_config('app.kepler_sucursal', $1, false)`, [suc]);
        const rows = (await db.query(IN_TRANSIT_SQL, [suc])).rows;
        const staged = [];
        for (const r of rows) {
          const pid = skuToId.get(r.sku);
          if (!pid) { unmatched++; continue; }
          staged.push([warehouseId, pid, r.qty, Number(r.oc_count) || 0]); matched++; ocs += Number(r.oc_count) || 0;
        }
        for (let i = 0; i < staged.length; i += BATCH) {
          const chunk = staged.slice(i, i + BATCH);
          const vals = [], params = [];
          chunk.forEach((row, ri) => { vals.push(`($${ri*4+1},$${ri*4+2},$${ri*4+3},$${ri*4+4})`); params.push(...row); });
          await db.query(`INSERT INTO stg_transit (warehouse_id, product_id, qty, oc_count) VALUES ${vals.join(',')}`, params);
        }
        summary.push({ code: m.code, suc, matched, unmatched, ocs });
        touched.push(warehouseId);
      } catch (e) {
        console.log(`  ⚠ ${m.code}: error leyendo kdm1/kdm2 por md.* (${e.message}) — skip`);
      }
    }
    console.table(summary);

    if (!APPLY) { await db.query('ROLLBACK'); console.log('\n[DRY-RUN] ROLLBACK — nada cambió.'); return; }

    // Merge SIN churn: UPSERT solo-cambios + DELETE solo lo que ya no viene (scope = almacenes
    // leídos OK, incl. los que quedaron en 0). Antes: DELETE-all-touched+INSERT reescribía todo.
    const up = await db.query(`
      INSERT INTO analytics.purchase_in_transit AS t (tenant_id, warehouse_id, product_id, qty_in_transit, oc_count, computed_at)
      SELECT $1, warehouse_id, product_id, SUM(qty), SUM(oc_count), now()
      FROM stg_transit GROUP BY warehouse_id, product_id
      ON CONFLICT (tenant_id, warehouse_id, product_id) DO UPDATE
        SET qty_in_transit=EXCLUDED.qty_in_transit, oc_count=EXCLUDED.oc_count, computed_at=now()
        WHERE (t.qty_in_transit, t.oc_count) IS DISTINCT FROM (EXCLUDED.qty_in_transit, EXCLUDED.oc_count)`, [M]);
    const del = await db.query(`
      DELETE FROM analytics.purchase_in_transit t
      WHERE t.tenant_id=$1 AND t.warehouse_id = ANY($2::uuid[])
        AND NOT EXISTS (SELECT 1 FROM stg_transit s WHERE s.warehouse_id=t.warehouse_id AND s.product_id=t.product_id)`, [M, touched]);
    await db.query('COMMIT');
    console.log(`\n[APPLY] COMMIT — ${up.rowCount} escritas (nuevas/cambiadas) · ${del.rowCount} borradas (desaparecidas) (${summary.length} almacenes).`);
  } catch (e) {
    await db.query('ROLLBACK').catch(() => {});
    console.error('\nERROR (rollback):', e.message);
    process.exitCode = 1;
  } finally { await db.end(); }
})();
