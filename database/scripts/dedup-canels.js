/**
 * Dedup de productos Canel's con nombres duplicados (short-name vs SKU-format).
 * Solo 4 pares claros (Canel's tiene SKUs distintos legítimos para bulk vs individual).
 *
 * Uso: DATABASE_URL='...' node database/dedup-canels.js
 */
const knex = require('knex');

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error('ERROR: falta DATABASE_URL');
  process.exit(1);
}

const db = knex({
  client: 'pg',
  connection: { connectionString: DATABASE_URL, ssl: { rejectUnauthorized: false } },
  pool: { min: 1, max: 4 },
});

// Mapping short_id → sku_id (SKU-format sobrevive)
const PAIRS = [
  ['56ecccb9-654b-4fd4-96b6-cf12b44f2ac2', '24d1afd4-8883-40a5-8ead-cb05591afaa7', 'Goma Tueni',       'CANELS GOMITAS TUENI 1.35 KG'],
  ['3d4d9cad-54f2-4b16-9483-88c97519e6f7', '18a3f918-397a-4e86-87d9-e6c017951332', 'Paletón Vaquita',  'VAQUITA PALETON.TIRA.10P'],
  ['ed1874a8-c9cb-4698-a1c5-2a3124fc852d', 'ac75f3b3-512e-4122-b9ba-3829d82a5fb7', 'Pal ICEE',         'PAL ICEE BISABOR 285GR'],
  ['a3d0a90f-74fb-49c4-b034-417646fce20b', '0c20a39d-c740-4d66-9e5d-a550f1c103fd', 'Cherry Sours',     'CANELS CHERRY. BLS.454G'],
];

const remap = new Map(PAIRS.map(([s, sku]) => [s, sku]));
const shortIds = PAIRS.map(([s]) => s);

(async () => {
  try {
    console.log('► Backup de productos Canel\'s...');
    await db.raw(`
      CREATE TABLE IF NOT EXISTS products_canels_dedup_backup_2026_05_22 AS
      SELECT * FROM products
      WHERE brand_id = (SELECT id FROM brands WHERE nombre ILIKE 'canel%' LIMIT 1)
    `);
    const bkCount = await db('products_canels_dedup_backup_2026_05_22').count('* as c');
    console.log(`  ✓ Backup: ${bkCount[0].c} productos respaldados`);

    const existing = await db('products').whereIn('id', shortIds).select('id', 'nombre');
    console.log(`  ✓ Verificación: ${existing.length}/${shortIds.length} short_ids encontrados`);
    const skuIds = [...new Set(PAIRS.map(([, s]) => s))];
    const existingSkus = await db('products').whereIn('id', skuIds).select('id');
    console.log(`  ✓ Verificación SKU: ${existingSkus.length}/${skuIds.length} sku_ids encontrados`);

    console.log('\n► Remap de productosMarcados en daily_captures...');
    const captures = await db('daily_captures').select('id', 'exhibiciones');
    console.log(`  Procesando ${captures.length} capturas...`);
    let totalRemapped = 0;
    let capturesAffected = 0;
    await db.transaction(async (trx) => {
      for (const cap of captures) {
        const exh = typeof cap.exhibiciones === 'string' ? JSON.parse(cap.exhibiciones) : cap.exhibiciones;
        if (!Array.isArray(exh)) continue;
        let changed = false;
        const updatedExh = exh.map((e) => {
          if (!Array.isArray(e.productosMarcados)) return e;
          const remapped = e.productosMarcados.map((pid) => {
            if (remap.has(pid)) {
              totalRemapped++;
              changed = true;
              return remap.get(pid);
            }
            return pid;
          });
          const uniq = [...new Set(remapped)];
          return { ...e, productosMarcados: uniq };
        });
        if (changed) {
          capturesAffected++;
          await trx('daily_captures').where({ id: cap.id }).update({ exhibiciones: JSON.stringify(updatedExh) });
        }
      }
    });
    console.log(`  ✓ ${totalRemapped} referencias remapeadas en ${capturesAffected} capturas`);

    console.log('\n► Delete de productos short-name...');
    const deleted = await db('products').whereIn('id', shortIds).del();
    console.log(`  ✓ ${deleted} productos short-name eliminados`);

    const canels = await db('products as p')
      .leftJoin('brands as b', 'p.brand_id', 'b.id')
      .where('b.nombre', 'ilike', 'canel%')
      .where('p.activo', true)
      .count('* as c');
    console.log(`\n  Canel's productos activos restantes: ${canels[0].c}`);
    console.log('\n✓ Dedup completado.');
  } catch (err) {
    console.error('\n✗ Error:', err.message);
    if (err.stack) console.error(err.stack);
    process.exit(1);
  } finally {
    await db.destroy();
  }
})();
