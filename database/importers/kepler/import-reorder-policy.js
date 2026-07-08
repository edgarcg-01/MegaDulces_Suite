/* eslint-disable no-console */
/**
 * RA.2 — Umbrales de reorden Kepler → commercial.reorder_policy (BULK, source='kepler').
 *
 * Kepler guarda mín/reorden/máx en el maestro de producto (verificado 2026-07-08 vs
 * el form `invcatprdpag.kpl`): kdii.c33=mínimo, kdii.c34=punto de reorden, kdii.c35=máximo
 * (en PIEZAS, misma unidad que commercial.stock). Sólo ~0–18% del catálogo por sucursal
 * los tiene (CEDIS=0) → el resto lo cubre el cómputo por demanda (import-computed-reorder.js).
 *
 * Grano = producto×almacén. Reusa el MISMO map code→sucursal que el stock
 * (STOCK_BRANCH_MAP) → reorden y existencia caen en el mismo warehouse_id. El `code`
 * es el código del ALMACÉN (naming mixto: KEPLER-03/MD-10/MD-CEDIS...), no el número
 * de sucursal. Preserva filas source='manual' (override humano nunca se pisa).
 *
 *   node database/importers/kepler/import-reorder-policy.js          # dry-run
 *   node database/importers/kepler/import-reorder-policy.js --apply  # commit
 */

const { Client } = require('pg');

const M = '00000000-0000-0000-0000-00000000d01c';
const DST = process.env.DATABASE_URL_NEW || 'postgresql://postgres:superoot@localhost:5433/postgres_platform';
const APPLY = process.argv.includes('--apply');
const BATCH = 1000;

// Mismo mapa que el stock (STOCK_BRANCH_MAP). code = código de almacén en
// commercial.warehouses. Default = mapeo verificado 2026-07-08 (04/05 → MD-30/MD-50
// por confirmar contra el runner; el dry-run muestra los matches).
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

(async () => {
  const db = new Client({ connectionString: DST });
  await db.connect();
  try {
    console.log(`\n=== Reorden Kepler → commercial.reorder_policy (BULK, ${APPLY ? 'APPLY' : 'DRY-RUN'}) ===\n`);

    const prods = (await db.query(`SELECT id, sku FROM public.products WHERE tenant_id=$1 AND btrim(coalesce(sku,''))<>''`, [M])).rows;
    const skuToId = new Map(prods.map((p) => [p.sku, p.id]));
    console.log(`  catálogo prod con sku: ${skuToId.size}`);

    await db.query('BEGIN');
    await db.query(`SET LOCAL app.tenant_id = '${M}'`);
    await db.query(`CREATE TEMP TABLE stg_reorder (code text, product_id uuid, min_stock numeric, reorder_point numeric, max_stock numeric) ON COMMIT DROP`);

    const summary = [];
    for (const m of MAP) {
      const whr = (await db.query(`SELECT id FROM commercial.warehouses WHERE tenant_id=$1 AND code=$2`, [M, m.code])).rows;
      if (!whr.length) { console.log(`  ⚠ warehouse ${m.code} no existe — skip`); continue; }

      let src;
      try {
        src = new Client({ connectionString: m.url });
        await src.connect();
      } catch (e) { console.log(`  ⚠ ${m.code}: sin conexión (${e.message}) — skip`); continue; }

      let matched = 0, unmatched = 0;
      try {
        // Sólo productos con reorden configurado (c34<>0); los 3 se setean juntos.
        const rows = (await src.query(`SELECT c1 AS sku, c33 AS mn, c34 AS ro, c35 AS mx FROM md.kdii WHERE c34 <> 0`)).rows;
        const staged = [];
        for (const r of rows) {
          const pid = skuToId.get(r.sku);
          if (!pid) { unmatched++; continue; }
          staged.push([m.code, pid, r.mn, r.ro, r.mx]); matched++;
        }
        for (let i = 0; i < staged.length; i += BATCH) {
          const chunk = staged.slice(i, i + BATCH);
          const vals = [], params = [];
          chunk.forEach((row, ri) => { vals.push(`($${ri*5+1},$${ri*5+2},$${ri*5+3},$${ri*5+4},$${ri*5+5})`); params.push(...row); });
          await db.query(`INSERT INTO stg_reorder (code, product_id, min_stock, reorder_point, max_stock) VALUES ${vals.join(',')}`, params);
        }
        summary.push({ code: m.code, matched, unmatched });
      } catch (e) {
        console.log(`  ⚠ ${m.code}: error leyendo kdii (${e.message}) — skip`);
      } finally { await src.end(); }
    }
    console.table(summary);

    if (!APPLY) { await db.query('ROLLBACK'); console.log('\n[DRY-RUN] ROLLBACK — nada cambió.'); return; }

    // Merge server-side (sólo almacenes tocados):
    // 1) borra filas 'kepler' que ya no vienen (reorden removido en Kepler),
    //    respetando 'manual'/'computed'.
    await db.query(`
      DELETE FROM commercial.reorder_policy rp
      USING commercial.warehouses w
      WHERE rp.tenant_id=$1 AND rp.source='kepler' AND rp.warehouse_id=w.id
        AND w.code IN (SELECT DISTINCT code FROM stg_reorder)
        AND NOT EXISTS (
          SELECT 1 FROM stg_reorder s JOIN commercial.warehouses w2 ON w2.tenant_id=$1 AND w2.code=s.code
          WHERE w2.id=rp.warehouse_id AND s.product_id=rp.product_id)`, [M]);
    // 2) upsert desde staging (agregado por almacén×producto para no chocar ON CONFLICT).
    //    NUNCA pisa source='manual'.
    const up = await db.query(`
      INSERT INTO commercial.reorder_policy (id, tenant_id, warehouse_id, product_id, min_stock, reorder_point, max_stock, source, computed_at, updated_at)
      SELECT gen_random_uuid(), $1, w.id, agg.product_id, agg.min_stock, agg.reorder_point, agg.max_stock, 'kepler', now(), now()
      FROM (SELECT code, product_id, max(min_stock) min_stock, max(reorder_point) reorder_point, max(max_stock) max_stock
              FROM stg_reorder GROUP BY code, product_id) agg
      JOIN commercial.warehouses w ON w.tenant_id=$1 AND w.code=agg.code
      ON CONFLICT (tenant_id, warehouse_id, product_id) DO UPDATE
        SET min_stock=EXCLUDED.min_stock, reorder_point=EXCLUDED.reorder_point, max_stock=EXCLUDED.max_stock,
            source='kepler', computed_at=now(), updated_at=now()
        WHERE commercial.reorder_policy.source <> 'manual'`, [M]);
    await db.query('COMMIT');
    console.log(`\n[APPLY] COMMIT — ${up.rowCount} filas de reorden upserted (${summary.length} almacenes).`);
  } catch (e) {
    await db.query('ROLLBACK').catch(() => {});
    console.error('\nERROR (rollback):', e.message);
    process.exitCode = 1;
  } finally { await db.end(); }
})();
