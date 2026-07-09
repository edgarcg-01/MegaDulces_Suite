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
 *   node database/importers/kepler/import-in-transit.js          # dry-run
 *   node database/importers/kepler/import-in-transit.js --apply  # commit
 */

const { Client } = require('pg');

const M = '00000000-0000-0000-0000-00000000d01c';
const DST = process.env.DATABASE_URL_NEW || 'postgresql://postgres:superoot@localhost:5433/postgres_platform';
const APPLY = process.argv.includes('--apply');
const BATCH = 1000;

const MAP = process.env.STOCK_BRANCH_MAP
  ? JSON.parse(process.env.STOCK_BRANCH_MAP)
  : [
      { code: '00', url: 'postgresql://platform_ro:kepler123@192.168.9.95:5432/md_00' },
      { code: '01', url: 'postgresql://platform_ro:kepler123@192.168.10.10:1977/md_01' },
      { code: '02', url: 'postgresql://platform_ro:kepler123@192.168.42.42:5432/md_02' },
      { code: '03', url: 'postgresql://platform_ro:kepler123@192.168.40.40:5432/md_03' },
      { code: '04', url: 'postgresql://platform_ro:kepler123@192.168.44.44:5432/md_04' },
      { code: '05', url: 'postgresql://platform_ro:kepler123@192.168.54.54:5432/md_05' },
    ];

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

    const prods = (await db.query(`SELECT id, sku FROM public.products WHERE tenant_id=$1 AND btrim(coalesce(sku,''))<>''`, [M])).rows;
    const skuToId = new Map(prods.map((p) => [p.sku, p.id]));
    console.log(`  catálogo prod con sku: ${skuToId.size}`);

    await db.query('BEGIN');
    await db.query(`CREATE TEMP TABLE stg_transit (warehouse_id uuid, product_id uuid, qty numeric, oc_count int) ON COMMIT DROP`);

    const summary = [];
    for (const m of MAP) {
      const whr = (await db.query(`SELECT id FROM commercial.warehouses WHERE tenant_id=$1 AND code=$2`, [M, m.code])).rows;
      if (!whr.length) { console.log(`  ⚠ warehouse ${m.code} no existe — skip`); continue; }
      const warehouseId = whr[0].id;
      const suc = branchNum(m.url);
      if (!suc) { console.log(`  ⚠ ${m.code}: no pude derivar sucursal de la URL — skip`); continue; }

      let src;
      try { src = new Client({ connectionString: m.url }); await src.connect(); }
      catch (e) { console.log(`  ⚠ ${m.code}: sin conexión (${e.message}) — skip`); continue; }

      let matched = 0, unmatched = 0, ocs = 0;
      try {
        const rows = (await src.query(IN_TRANSIT_SQL, [suc])).rows;
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
      } catch (e) {
        console.log(`  ⚠ ${m.code}: error leyendo kdm1/kdm2 (${e.message}) — skip`);
      } finally { await src.end(); }
    }
    console.table(summary);

    if (!APPLY) { await db.query('ROLLBACK'); console.log('\n[DRY-RUN] ROLLBACK — nada cambió.'); return; }

    // Merge: reemplaza el tránsito de los almacenes tocados (borra los viejos, upsert los nuevos).
    await db.query(`
      DELETE FROM analytics.purchase_in_transit pit
      WHERE pit.tenant_id=$1 AND pit.warehouse_id IN (SELECT DISTINCT warehouse_id FROM stg_transit)`, [M]);
    const up = await db.query(`
      INSERT INTO analytics.purchase_in_transit (tenant_id, warehouse_id, product_id, qty_in_transit, oc_count, computed_at)
      SELECT $1, warehouse_id, product_id, SUM(qty), SUM(oc_count), now()
      FROM stg_transit GROUP BY warehouse_id, product_id
      ON CONFLICT (tenant_id, warehouse_id, product_id) DO UPDATE
        SET qty_in_transit=EXCLUDED.qty_in_transit, oc_count=EXCLUDED.oc_count, computed_at=now()`, [M]);
    await db.query('COMMIT');
    console.log(`\n[APPLY] COMMIT — ${up.rowCount} filas de tránsito upserted (${summary.length} almacenes).`);
  } catch (e) {
    await db.query('ROLLBACK').catch(() => {});
    console.error('\nERROR (rollback):', e.message);
    process.exitCode = 1;
  } finally { await db.end(); }
})();
