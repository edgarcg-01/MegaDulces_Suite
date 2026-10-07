/**
 * Verifica que la normalización aplicó correctamente en prod.
 */
const knex = require('knex');
const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) { console.error('falta DATABASE_URL'); process.exit(1); }
const db = knex({
  client: 'pg',
  connection: { connectionString: DATABASE_URL, ssl: DATABASE_URL.includes('localhost') ? false : { rejectUnauthorized: false } },
  pool: { min: 1, max: 4 },
});

(async () => {
  try {
    const host = new URL(DATABASE_URL.replace('postgresql', 'http')).host;
    console.log(`▶ DB host: ${host}\n`);

    const totals = await db.raw(`
      SELECT
        (SELECT COUNT(*) FROM brands WHERE deleted_at IS NULL) AS brands_activos,
        (SELECT COUNT(*) FROM products WHERE deleted_at IS NULL) AS productos_activos,
        (SELECT to_regclass('public.products_normalize_backup_20260528') IS NOT NULL) AS backup_existe
    `);
    const t = totals.rows[0];
    console.log(`Brands activas:     ${t.brands_activos}`);
    console.log(`Productos activos:  ${t.productos_activos}`);
    console.log(`Backup table:       ${t.backup_existe ? '✓ products_normalize_backup_20260528 existe' : '✗ NO existe'}`);

    if (t.backup_existe) {
      const bkCount = await db('products_normalize_backup_20260528').count('* as c').first();
      console.log(`Backup rows:        ${bkCount.c}`);
    }

    console.log(`\n▶ Productos con sufijo " / N" remanentes (dentro de la misma brand donde existe bare):`);
    const remaining = await db.raw(`
      WITH stripped AS (
        SELECT id, brand_id, nombre,
               TRIM(regexp_replace(nombre, '\\s+/\\s+.+$', '', 'g')) AS bare
        FROM products
        WHERE deleted_at IS NULL
      )
      SELECT s1.brand_id, s1.id, s1.nombre AS con_suffix, s2.nombre AS bare_match
      FROM stripped s1
      JOIN stripped s2 ON s1.brand_id = s2.brand_id
                       AND s1.bare = s2.nombre
                       AND s1.id != s2.id
      WHERE s1.nombre ~ '\\s+/\\s+'
      LIMIT 20
    `);
    if (!remaining.rows.length) console.log('  ✓ NINGUNO (cleanup completo)');
    else for (const r of remaining.rows) console.log(`    ⚠ ${r.id.slice(0,8)}…  "${r.con_suffix}"  bare="${r.bare_match}"`);

    console.log(`\n▶ Verificación cross-brand fixes (4 productos):`);
    const crossChecks = [
      { nombre: 'BIMBO PASTELITO HERSHEYS 250GR', expected_brand: 'BIMBO BARCEL' },
      { nombre: 'BIMBO CANELITAS SOBRE 360G',    expected_brand: 'BIMBO BARCEL' },
      { nombre: 'GLOBO METAL DORADO #9',         expected_brand: 'GLOBO PAYASO' },
      { nombre: 'GALL WAFER CHOCOLATE 156GR',    expected_brand: 'TINAJITA' },
    ];
    for (const c of crossChecks) {
      const rows = await db('products as p')
        .leftJoin('brands as b', 'p.brand_id', 'b.id')
        .whereRaw('LOWER(TRIM(p.nombre)) LIKE ?', [`%${c.nombre.toLowerCase()}%`])
        .whereNull('p.deleted_at')
        .select('p.id', 'p.nombre', 'b.nombre as brand');
      console.log(`  • "${c.nombre}" (esperado en ${c.expected_brand}):`);
      if (!rows.length) { console.log(`      ✗ NO encontrado`); continue; }
      for (const r of rows) {
        const ok = r.brand === c.expected_brand ? '✓' : '✗';
        console.log(`      ${ok} ${r.id.slice(0,8)}…  "${r.nombre}"  → brand="${r.brand}"`);
      }
    }

    console.log(`\n▶ Marcas activas (top 5 por # productos):`);
    const topBrands = await db('brands as b')
      .leftJoin('products as p', function () { this.on('p.brand_id', 'b.id').andOnNull('p.deleted_at'); })
      .whereNull('b.deleted_at')
      .select('b.nombre').count('p.id as c')
      .groupBy('b.id', 'b.nombre').orderBy('c', 'desc').limit(5);
    for (const b of topBrands) console.log(`  ${b.c.toString().padStart(4)} prods  ${b.nombre}`);

    console.log('\n✓ Verificación completa.');
  } catch (err) {
    console.error('\n✗ Error:', err.message);
    process.exit(1);
  } finally {
    await db.destroy();
  }
})();
