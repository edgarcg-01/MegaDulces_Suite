/**
 * Detección fuzzy de duplicados de brand: usa similarity (pg_trgm) y
 * Levenshtein-style detection para encontrar pares parecidos que el normalize
 * estricto no detecta (typos, espacios diferentes, abreviaciones).
 *
 * También cuenta soft-deleted brands/products como diagnóstico.
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
    // Habilitar pg_trgm si no está
    try { await db.raw(`CREATE EXTENSION IF NOT EXISTS pg_trgm`); } catch {}

    console.log('▶ Tombstones (soft-deleted):');
    const softBrands = await db('brands').whereNotNull('deleted_at').count('* as c').first();
    const softProds = await db('products').whereNotNull('deleted_at').count('* as c').first();
    console.log(`  brands soft-deleted: ${softBrands.c}`);
    console.log(`  products soft-deleted: ${softProds.c}`);

    console.log('\n▶ Pares de brand parecidos (similarity > 0.6, distinct ids):');
    const pairs = await db.raw(`
      SELECT b1.id AS id1, b1.nombre AS n1,
             b2.id AS id2, b2.nombre AS n2,
             similarity(LOWER(b1.nombre), LOWER(b2.nombre)) AS sim
      FROM brands b1
      JOIN brands b2 ON b1.id < b2.id AND b1.tenant_id = b2.tenant_id
      WHERE similarity(LOWER(b1.nombre), LOWER(b2.nombre)) > 0.6
        AND b1.deleted_at IS NULL AND b2.deleted_at IS NULL
      ORDER BY sim DESC
    `);
    if (!pairs.rows.length) console.log('  (ninguno)');
    for (const r of pairs.rows) {
      console.log(`  sim=${Number(r.sim).toFixed(2)}  "${r.n1}" (${r.id1.slice(0,8)}…)  vs  "${r.n2}" (${r.id2.slice(0,8)}…)`);
    }

    console.log('\n▶ Pares de products parecidos dentro de la misma brand (similarity > 0.8):');
    const prodPairs = await db.raw(`
      SELECT p1.id AS id1, p1.nombre AS n1,
             p2.id AS id2, p2.nombre AS n2,
             b.nombre AS brand,
             similarity(LOWER(p1.nombre), LOWER(p2.nombre)) AS sim
      FROM products p1
      JOIN products p2 ON p1.id < p2.id AND p1.brand_id = p2.brand_id AND p1.tenant_id = p2.tenant_id
      JOIN brands b ON b.id = p1.brand_id
      WHERE similarity(LOWER(p1.nombre), LOWER(p2.nombre)) > 0.8
        AND p1.deleted_at IS NULL AND p2.deleted_at IS NULL
      ORDER BY sim DESC
      LIMIT 100
    `);
    if (!prodPairs.rows.length) console.log('  (ninguno)');
    for (const r of prodPairs.rows) {
      console.log(`  sim=${Number(r.sim).toFixed(2)}  [${r.brand}]  "${r.n1}" (${r.id1.slice(0,8)}…)  vs  "${r.n2}" (${r.id2.slice(0,8)}…)`);
    }

    console.log('\n▶ Pares de products parecidos CROSS-brand (similarity > 0.85):');
    const crossBrand = await db.raw(`
      SELECT p1.id AS id1, p1.nombre AS n1, b1.nombre AS brand1,
             p2.id AS id2, p2.nombre AS n2, b2.nombre AS brand2,
             similarity(LOWER(p1.nombre), LOWER(p2.nombre)) AS sim
      FROM products p1
      JOIN products p2 ON p1.id < p2.id AND p1.brand_id != p2.brand_id AND p1.tenant_id = p2.tenant_id
      JOIN brands b1 ON b1.id = p1.brand_id
      JOIN brands b2 ON b2.id = p2.brand_id
      WHERE similarity(LOWER(p1.nombre), LOWER(p2.nombre)) > 0.85
        AND p1.deleted_at IS NULL AND p2.deleted_at IS NULL
      ORDER BY sim DESC
      LIMIT 50
    `);
    if (!crossBrand.rows.length) console.log('  (ninguno)');
    for (const r of crossBrand.rows) {
      console.log(`  sim=${Number(r.sim).toFixed(2)}  [${r.brand1}] "${r.n1}"  vs  [${r.brand2}] "${r.n2}"`);
    }

    console.log('\n✓ Fuzzy scan completo.');
  } catch (err) {
    console.error('\n✗ Error:', err.message);
    process.exit(1);
  } finally {
    await db.destroy();
  }
})();
