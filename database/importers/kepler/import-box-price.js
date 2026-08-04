/* eslint-disable no-console */
/**
 * RA-PRO.39 — Precio de LISTA de la CAJA (CJA) por producto → analytics.product_box_price.
 *
 * Fuente: Kepler `kdpv_prod_util` (c1=sku, c2=presentación, c3=tier, c4=min_qty, c7=precio).
 * Toma el precio de la presentación 'CJA' en el tier de MENOR volumen (list price = c4 más
 * chico). Multi-sucursal: recorre las 5 sucursales vivas y toma el precio (MAX para cobertura;
 * son ~iguales entre sucursales). Base de la conversión robusta a cajas del sell-out:
 * `cajas = revenue / cja_price` (ver [[project_box_factor_override_vs_etiquetera]]).
 *
 * Idempotente: staging TEMP → UPSERT ON CONFLICT DO UPDATE ... WHERE IS DISTINCT (sin churn).
 *
 *   node database/importers/kepler/import-box-price.js            # dry-run
 *   node database/importers/kepler/import-box-price.js --apply
 */
const { Client } = require('pg');

const M = '00000000-0000-0000-0000-00000000d01c';
const DST = process.env.DATABASE_URL_NEW || 'postgresql://postgres:superoot@localhost:5433/postgres_platform';
const APPLY = process.argv.includes('--apply');
const MAP = process.env.STOCK_BRANCH_MAP
  ? JSON.parse(process.env.STOCK_BRANCH_MAP)
  : [
      { code: '01', url: 'postgresql://platform_ro:kepler123@192.168.10.10:1977/md_01' },
      { code: '02', url: 'postgresql://platform_ro:kepler123@192.168.42.42:5432/md_02' },
      { code: '03', url: 'postgresql://platform_ro:kepler123@192.168.40.40:5432/md_03' },
      { code: '04', url: 'postgresql://platform_ro:kepler123@192.168.44.44:5432/md_04' },
      { code: '05', url: 'postgresql://platform_ro:kepler123@192.168.54.54:5432/md_05' },
    ];

(async () => {
  const dst = new Client({ connectionString: DST, ssl: /rlwy|railway|proxy/i.test(DST) ? { rejectUnauthorized: false } : false });
  await dst.connect();
  try {
    console.log(`\n=== PRECIO CAJA (kdpv CJA) → analytics.product_box_price (${APPLY ? 'APPLY' : 'DRY-RUN'}) ===\n`);
    await dst.query(`CREATE SCHEMA IF NOT EXISTS analytics`);
    await dst.query(`CREATE TABLE IF NOT EXISTS analytics.product_box_price (
      tenant_id uuid NOT NULL, product_id uuid NOT NULL, cja_price numeric NOT NULL,
      source text NOT NULL DEFAULT 'kepler_kdpv', updated_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (tenant_id, product_id))`);
    await dst.query(`GRANT SELECT ON analytics.product_box_price TO app_runtime`).catch(() => {});

    // sku → product_id + factor_sale (para el fallback derivado PAQ×factor).
    const { rows: prods } = await dst.query(`SELECT id, btrim(sku) sku, COALESCE(factor_sale,1)::numeric fs FROM catalog.products WHERE tenant_id=$1 AND btrim(coalesce(sku,''))<>''`, [M]);
    const skuToId = new Map(prods.map((r) => [r.sku, r.id]));
    const skuToFs = new Map(prods.map((r) => [r.sku, Number(r.fs)]));

    // precio CJA y PAQ por SKU: tier de menor volumen (list) = c7 en el min(c4). MAX entre sucursales.
    const cjaPrice = new Map();
    const paqPrice = new Map();
    for (const b of MAP) {
      const src = new Client({ connectionString: b.url, connectionTimeoutMillis: 8000 });
      try {
        await src.connect();
        const { rows } = await src.query(`
          SELECT btrim(c1) sku, c2 present, (array_agg(c7::numeric ORDER BY c4::numeric ASC))[1] AS price
            FROM md.kdpv_prod_util WHERE c2 IN ('CJA','PAQ') AND c7::numeric > 0
            GROUP BY btrim(c1), c2`);
        let n = 0;
        for (const r of rows) {
          const p = Number(r.price); const m = r.present === 'CJA' ? cjaPrice : paqPrice;
          if (p > (m.get(r.sku) || 0)) m.set(r.sku, p);
          n++;
        }
        console.log(`  md_${b.code}: ${n} filas CJA/PAQ`);
        await src.end();
      } catch (e) { console.log(`  ⚠ md_${b.code}: sin conexión (${e.message.slice(0, 40)}) — skip`); try { await src.end(); } catch {} }
    }

    // rows: [pid, price, source]. CJA directo; si no hay CJA, derivar PAQ×factor_sale (marcado 'derived_paq').
    const rows = [];
    let unmatched = 0, direct = 0, derived = 0;
    const allSkus = new Set([...cjaPrice.keys(), ...paqPrice.keys()]);
    for (const sku of allSkus) {
      const pid = skuToId.get(sku); if (!pid) { unmatched++; continue; }
      const cja = cjaPrice.get(sku);
      if (cja > 0) { rows.push([pid, cja, 'kepler_kdpv']); direct++; continue; }
      // fallback: PAQ × factor_sale (paquetes por caja). Solo si es plausible (fs>1 y > precio PAQ).
      const paq = paqPrice.get(sku), fs = skuToFs.get(sku) || 1;
      if (paq > 0 && fs > 1) { rows.push([pid, paq * fs, 'derived_paq']); derived++; }
    }
    console.log(`\n  ${rows.length} enlazados (${direct} precio CJA directo · ${derived} derivado PAQ×factor) · ${unmatched} sin match`);

    if (!APPLY) { console.log('\n[DRY-RUN] muestra:'); rows.slice(0, 6).forEach(([pid, p, s]) => console.log(`  ${pid.slice(0, 8)}  $${p.toFixed(2)}  ${s}`)); console.log('\nCorré con --apply.'); return; }

    await dst.query('BEGIN');
    await dst.query(`CREATE TEMP TABLE stg_bp (product_id uuid, cja_price numeric, source text) ON COMMIT DROP`);
    const B = 1000;
    for (let i = 0; i < rows.length; i += B) {
      const chunk = rows.slice(i, i + B);
      const vals = chunk.map((_, j) => `($${j * 3 + 1},$${j * 3 + 2},$${j * 3 + 3})`).join(',');
      await dst.query(`INSERT INTO stg_bp (product_id, cja_price, source) VALUES ${vals}`, chunk.flat());
    }
    const up = await dst.query(`
      INSERT INTO analytics.product_box_price AS t (tenant_id, product_id, cja_price, source, updated_at)
      SELECT $1, product_id, cja_price, source, now() FROM stg_bp
      ON CONFLICT (tenant_id, product_id) DO UPDATE SET cja_price=EXCLUDED.cja_price, source=EXCLUDED.source, updated_at=now()
       WHERE (t.cja_price, t.source) IS DISTINCT FROM (EXCLUDED.cja_price, EXCLUDED.source)`, [M]);
    const del = await dst.query(`
      DELETE FROM analytics.product_box_price t
       WHERE t.tenant_id=$1 AND NOT EXISTS (SELECT 1 FROM stg_bp s WHERE s.product_id=t.product_id)`, [M]);
    await dst.query('COMMIT');
    console.log(`\n[APPLY] ${up.rowCount} escritas (nuevas/cambiadas) · ${del.rowCount} borradas.`);
  } catch (e) {
    await dst.query('ROLLBACK').catch(() => {});
    console.error('\nERROR (rollback):', e.message);
    process.exitCode = 1;
  } finally {
    await dst.end();
  }
})();
