/* eslint-disable no-console */
/**
 * RA-PRO.37 — Factor de caja AUTORITATIVO desde Kepler `kdii.c84` (piezas por caja).
 *
 * Descubierto 2026-08-04: c84 es la conversión a caja que el propio ERP maneja
 * (verificado 17/17 vs etiquetera + 1455 coincidencias). Reemplaza la adivinanza
 * por el "/N" del nombre / factor_sale roto. Puebla `analytics.product_box_factor`,
 * que `import-replenishment-plan.js` usa como tope de precedencia del uxc (por
 * encima de etiquetera/factor_sale; el override manual sigue ganando).
 *
 * Fuente: kdii.c84 de las 5 sucursales vivas (READ-ONLY platform_ro). c84 es un
 * dato FÍSICO (constante por producto) pero cada branch lo puebla distinto →
 * tomamos MAX(c84) donde c84>1 (mejor cobertura; branch sin capturar = 0/1).
 * c84 ∈ {0,1} = granel/suelto → NO se escribe (deja el fallback del plan).
 *
 * Idempotente: staging TEMP → UPSERT ON CONFLICT DO UPDATE ... WHERE IS DISTINCT
 * (sin churn). Borra las filas cuyo c84 dejó de ser >1 (producto ya no trae caja).
 *
 *   node database/importers/kepler/import-box-factor.js            # dry-run
 *   node database/importers/kepler/import-box-factor.js --apply
 */
const { Client } = require('pg');

const M = '00000000-0000-0000-0000-00000000d01c';
const DST = process.env.DATABASE_URL_NEW || 'postgresql://postgres:superoot@localhost:5433/postgres_platform';
const APPLY = process.argv.includes('--apply');
// Fuente única del mapa de sucursales (paso 3 normalización almacén). Sin CEDIS '00'.
const { stockMap } = require('../lib/kepler-branches');
const MAP = process.env.STOCK_BRANCH_MAP ? JSON.parse(process.env.STOCK_BRANCH_MAP) : stockMap();

(async () => {
  const dst = new Client({ connectionString: DST, ssl: /rlwy|railway|proxy/i.test(DST) ? { rejectUnauthorized: false } : false });
  await dst.connect();
  try {
    console.log(`\n=== BOX FACTOR (kdii.c84) → analytics.product_box_factor (${APPLY ? 'APPLY' : 'DRY-RUN'}) ===\n`);
    // tabla idempotente (matchea la migración 20260804140000)
    await dst.query(`CREATE SCHEMA IF NOT EXISTS analytics`);
    await dst.query(`CREATE TABLE IF NOT EXISTS analytics.product_box_factor (
      tenant_id uuid NOT NULL, product_id uuid NOT NULL, box_factor numeric NOT NULL,
      source text NOT NULL DEFAULT 'kepler_c84', updated_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (tenant_id, product_id))`);
    await dst.query(`GRANT SELECT ON analytics.product_box_factor TO app_runtime`).catch(() => {});

    // catálogo sku → product_id
    const { rows: prods } = await dst.query(`SELECT id, btrim(sku) sku FROM catalog.products WHERE tenant_id=$1 AND btrim(coalesce(sku,''))<>''`, [M]);
    const skuToId = new Map(prods.map((r) => [r.sku, r.id]));

    // MAX(c84>1) por sku entre sucursales
    const c84 = new Map();
    for (const b of MAP) {
      const src = new Client({ connectionString: b.url, connectionTimeoutMillis: 8000 });
      try {
        await src.connect();
        const { rows } = await src.query(`SELECT btrim(c1) sku, MAX(c84::numeric) c84 FROM md.kdii WHERE c84::numeric > 1 GROUP BY btrim(c1)`);
        let n = 0;
        for (const r of rows) { const k = Number(r.c84); const cur = c84.get(r.sku) || 0; if (k > cur) c84.set(r.sku, k); n++; }
        console.log(`  md_${b.code}: ${n} SKUs con c84>1`);
        await src.end();
      } catch (e) { console.log(`  ⚠ md_${b.code}: sin conexión (${e.message.slice(0,40)}) — skip`); try { await src.end(); } catch {} }
    }

    // resolver a product_id
    const rows = [];
    let unmatched = 0;
    for (const [sku, bf] of c84) { const pid = skuToId.get(sku); if (pid) rows.push([pid, bf]); else unmatched++; }
    console.log(`\n  ${c84.size} SKUs con caja en Kepler · ${rows.length} enlazados al catálogo · ${unmatched} sin match`);

    if (!APPLY) {
      console.log('\n[DRY-RUN] no se escribió. Muestra:');
      rows.slice(0, 8).forEach(([pid, bf]) => console.log(`  ${pid.slice(0,8)}  bf=${bf}`));
      console.log('\nCorré con --apply.');
      return;
    }

    await dst.query('BEGIN');
    await dst.query(`CREATE TEMP TABLE stg_bf (product_id uuid, box_factor numeric) ON COMMIT DROP`);
    const B = 1000;
    for (let i = 0; i < rows.length; i += B) {
      const chunk = rows.slice(i, i + B);
      const vals = chunk.map((_, j) => `($${j*2+1},$${j*2+2})`).join(',');
      await dst.query(`INSERT INTO stg_bf (product_id, box_factor) VALUES ${vals}`, chunk.flat());
    }
    const up = await dst.query(`
      INSERT INTO analytics.product_box_factor AS t (tenant_id, product_id, box_factor, source, updated_at)
      SELECT $1, product_id, box_factor, 'kepler_c84', now() FROM stg_bf
      ON CONFLICT (tenant_id, product_id) DO UPDATE SET box_factor=EXCLUDED.box_factor, updated_at=now()
       WHERE t.box_factor IS DISTINCT FROM EXCLUDED.box_factor`, [M]);
    const del = await dst.query(`
      DELETE FROM analytics.product_box_factor t
       WHERE t.tenant_id=$1 AND NOT EXISTS (SELECT 1 FROM stg_bf s WHERE s.product_id=t.product_id)`, [M]);
    await dst.query('COMMIT');
    console.log(`\n[APPLY] ${up.rowCount} escritas (nuevas/cambiadas) · ${del.rowCount} borradas (ya sin caja).`);
  } catch (e) {
    await dst.query('ROLLBACK').catch(() => {});
    console.error('\nERROR (rollback):', e.message);
    process.exitCode = 1;
  } finally {
    await dst.end();
  }
})();
