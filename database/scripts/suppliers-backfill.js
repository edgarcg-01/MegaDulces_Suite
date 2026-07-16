/* eslint-disable no-console */
/**
 * Backfill de catalog.products.supplier_id faltante: asigna el PROVEEDOR DOMINANTE de la
 * MARCA del producto (el supplier más común entre los productos de esa marca que sí lo
 * tienen), solo cuando es inequívoco (cobertura ≥ THRESHOLD). Corre DESPUÉS de consolidar
 * marcas y proveedores. Idempotente (solo toca supplier_id NULL).
 *
 *   DATABASE_URL=… node database/scripts/suppliers-backfill.js            # dry-run
 *   DATABASE_URL=… node database/scripts/suppliers-backfill.js --execute
 *   THRESHOLD=0.7 (default) — fracción mínima del dominante para asignar.
 */
const knex = require('knex');
const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) { console.error('falta DATABASE_URL'); process.exit(1); }
const EXECUTE = process.argv.includes('--execute');
const THRESHOLD = Number(process.env.THRESHOLD || 0.7);
const M = '00000000-0000-0000-0000-00000000d01c';
const db = knex({ client: 'pg', connection: { connectionString: DATABASE_URL, ssl: DATABASE_URL.includes('localhost') ? false : { rejectUnauthorized: false } }, pool: { min: 1, max: 4 } });

(async () => {
  console.log(`▶ ${EXECUTE ? '🔥 EXECUTE' : '🧪 DRY-RUN'} · umbral dominante ${THRESHOLD} · ${DATABASE_URL.split('@')[1]}`);
  // dominante por marca: supplier con más productos (entre los que tienen supplier)
  const rows = await db.raw(`
    SELECT p.brand_id, p.supplier_id, count(*) n
    FROM catalog.products p
    WHERE p.tenant_id=? AND p.deleted_at IS NULL AND p.supplier_id IS NOT NULL AND p.brand_id IS NOT NULL
    GROUP BY 1,2`, [M]);
  const byBrand = new Map();
  for (const r of rows.rows) { const b = byBrand.get(r.brand_id) || { total: 0, sup: new Map() }; b.total += Number(r.n); b.sup.set(r.supplier_id, Number(r.n)); byBrand.set(r.brand_id, b); }
  const dominant = new Map(); // brand_id → { supplier_id, cov }
  for (const [bid, b] of byBrand) {
    let best = null, bn = 0;
    for (const [sid, n] of b.sup) if (n > bn) { bn = n; best = sid; }
    dominant.set(bid, { supplier_id: best, cov: bn / b.total });
  }
  // productos sin supplier con marca
  const noSup = await db('catalog.products').where({ tenant_id: M }).whereNull('deleted_at').whereNull('supplier_id').whereNotNull('brand_id').select('id', 'brand_id');
  const supName = new Map((await db('catalog.suppliers').where({ tenant_id: M }).select('id', 'name')).map((s) => [s.id, s.name]));
  let fill = 0, skipAmb = 0, skipNoBrandSup = 0;
  const plan = []; const bySupCount = new Map();
  for (const p of noSup) {
    const d = dominant.get(p.brand_id);
    if (!d || !d.supplier_id) { skipNoBrandSup++; continue; }
    if (d.cov < THRESHOLD) { skipAmb++; continue; }
    plan.push({ id: p.id, supplier_id: d.supplier_id });
    bySupCount.set(d.supplier_id, (bySupCount.get(d.supplier_id) || 0) + 1);
    fill++;
  }
  console.log(`\nProductos sin proveedor (con marca): ${noSup.length}`);
  console.log(`  ✅ a rellenar (dominante ≥${THRESHOLD}): ${fill}`);
  console.log(`  ⏭️  marca con proveedor ambiguo (<${THRESHOLD}): ${skipAmb}`);
  console.log(`  ⏭️  marca sin ningún proveedor: ${skipNoBrandSup}`);
  console.log('\nTop proveedores a asignar:');
  for (const [sid, n] of [...bySupCount.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12)) console.log(`  ${n.toString().padStart(4)}  ${supName.get(sid) || sid}`);
  if (!EXECUTE) { console.log('\n(dry-run) --execute para aplicar.'); await db.destroy(); return; }
  await db.transaction(async (trx) => {
    let done = 0;
    for (let i = 0; i < plan.length; i += 500) {
      const chunk = plan.slice(i, i + 500);
      for (const it of chunk) done += await trx('catalog.products').where({ id: it.id }).whereNull('supplier_id').update({ supplier_id: it.supplier_id, updated_at: trx.fn.now() });
    }
    console.log(`\n✓ ${done} productos con supplier_id asignado.`);
  });
  await db.destroy();
})().catch((e) => { console.error('✗', e.message); process.exit(1); });
