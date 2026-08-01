/* eslint-disable no-console */
/**
 * KV.6 — Promos vigentes del ERP → analytics.erp_promotions, refresco full.
 *
 * Lee las 4 tablas kdpv_* de una sucursal Kepler (las promos se fijan central),
 * sólo VIGENTES (c8 = valid_to >= hoy), mapea sku→product_id, TRUNCATE+INSERT.
 *
 *   node database/importers/kepler/import-erp-promos.js          # dry-run
 *   node database/importers/kepler/import-erp-promos.js --apply  # commit
 */

const { Client } = require('pg');

const M = '00000000-0000-0000-0000-00000000d01c';
const SRC = process.env.MARGIN_BRANCH_URL || 'postgresql://platform_ro:kepler123@192.168.40.40:5432/md_03';
const DST = process.env.DATABASE_URL_NEW || 'postgresql://postgres:superoot@localhost:5433/postgres_platform';
const APPLY = process.argv.includes('--apply');

// type, tabla, col producto, col free (o null), col threshold, col benefit
const SRCS = [
  { type: 'descuento_qty',   tbl: 'kdpv_descuxq', free: null, thr: 'c5', ben: 'c6' },
  { type: 'gratis_qty',      tbl: 'kdpv_gratisxq', free: 'c6', thr: 'c5', ben: 'c11' },
  { type: 'descuento_monto', tbl: 'kdpv_descuxm', free: null, thr: 'c5', ben: 'c6' },
  { type: 'gratis_monto',    tbl: 'kdpv_gratisxm', free: 'c6', thr: 'c5', ben: 'c11' },
];

(async () => {
  const src = new Client({ connectionString: SRC });
  const db = new Client({ connectionString: DST });
  await src.connect();
  await db.connect();
  try {
    console.log(`\n=== Promos ERP vigentes → analytics.erp_promotions (${APPLY ? 'APPLY' : 'DRY-RUN'}) ===\n`);

    const prods = (await db.query(
      `SELECT id, sku FROM public.products WHERE tenant_id=$1 AND btrim(coalesce(sku,''))<>''`, [M])).rows;
    const skuTo = new Map(prods.map((p) => [p.sku, p.id]));

    const rows = []; let noMatch = 0;
    for (const s of SRCS) {
      const sel = `SELECT c1 suc, c2 sku, c4 nombre, ${s.thr} thr, ${s.ben} ben, ${s.free ? s.free : 'NULL'} freesku, c7 vfrom, c8 vto FROM md.${s.tbl} WHERE c8::date >= current_date`;
      const { rows: pr } = await src.query(sel);
      for (const r of pr) {
        const pid = skuTo.get(String(r.sku).trim());
        if (!pid) { noMatch++; continue; }
        const freePid = r.freesku ? skuTo.get(String(r.freesku).trim()) || null : null;
        rows.push([pid, s.type, r.thr, r.ben, freePid, r.vfrom, r.vto, r.suc, r.nombre]);
      }
      console.log(`  ${s.tbl}: ${pr.length} vigentes`);
    }
    console.log(`  a cargar: ${rows.length} (sin match catálogo: ${noMatch})`);

    if (!APPLY) { console.log('\n[DRY-RUN] nada cambió.'); return; }

    await db.query('BEGIN');
    await db.query(`SET LOCAL app.tenant_id = '${M}'`);
    // Sin clave natural (id surrogate) → no aplica UPSERT por fila. En su lugar: si el snapshot
    // vigente es IDÉNTICO al de la tabla (md5 del conjunto), no se escribe nada. Solo se
    // reescribe (TRUNCATE+INSERT) cuando las promos realmente cambiaron → cero churn diario
    // (las promos cambian pocas veces al mes). Evita reescribir toda la tabla cada noche.
    await db.query(`CREATE TEMP TABLE stg_promos (product_id uuid, promo_type text, threshold numeric,
      benefit numeric, free_product_id uuid, valid_from date, valid_to date, warehouse_code text, raw_name text) ON COMMIT DROP`);
    for (let i = 0; i < rows.length; i += 500) {
      const chunk = rows.slice(i, i + 500);
      const vals = [], params = [];
      chunk.forEach((row, ri) => {
        const b = ri * 9;
        vals.push(`($${b+1},$${b+2},$${b+3},$${b+4},$${b+5},$${b+6},$${b+7},$${b+8},$${b+9})`);
        params.push(row[0], row[1], row[2], row[3], row[4], row[5], row[6], row[7], row[8]);
      });
      await db.query(`INSERT INTO stg_promos
        (product_id, promo_type, threshold, benefit, free_product_id, valid_from, valid_to, warehouse_code, raw_name)
        VALUES ${vals.join(',')}`, params);
    }
    const FP = `concat_ws('|', product_id::text, promo_type, coalesce(threshold::text,''), coalesce(benefit::text,''),
      coalesce(free_product_id::text,''), coalesce(valid_from::text,''), coalesce(valid_to::text,''),
      coalesce(warehouse_code,''), coalesce(raw_name,''))`;
    const { rows: cmp } = await db.query(
      `SELECT (SELECT md5(coalesce(string_agg(fp, E'\\n' ORDER BY fp),'')) FROM (SELECT ${FP} fp FROM stg_promos) a)
            = (SELECT md5(coalesce(string_agg(fp, E'\\n' ORDER BY fp),'')) FROM (SELECT ${FP} fp FROM analytics.erp_promotions WHERE tenant_id=$1) b) AS same`, [M]);
    if (cmp[0].same) {
      await db.query('COMMIT');
      console.log(`\n[APPLY] snapshot idéntico (${rows.length} promos) — sin cambios, cero escrituras.`);
      return;
    }
    await db.query(`TRUNCATE analytics.erp_promotions`);
    await db.query(
      `INSERT INTO analytics.erp_promotions
         (id, tenant_id, product_id, promo_type, threshold, benefit, free_product_id, valid_from, valid_to, warehouse_code, raw_name, computed_at)
       SELECT gen_random_uuid(), $1, product_id, promo_type, threshold, benefit, free_product_id, valid_from, valid_to, warehouse_code, raw_name, now()
         FROM stg_promos`, [M]);
    await db.query('COMMIT');
    console.log(`\n[APPLY] COMMIT — snapshot cambió → ${rows.length} promos vigentes reescritas.`);
  } catch (e) {
    await db.query('ROLLBACK').catch(() => {});
    console.error('\nERROR (rollback):', e.message);
    process.exitCode = 1;
  } finally {
    await src.end();
    await db.end();
  }
})();
