/**
 * Dedup de productos La Rosa con nombres duplicados (short-name vs SKU-format).
 *
 * Estrategia:
 *   1. Backup completo de productos La Rosa
 *   2. Remap JSONB de daily_captures (productosMarcados) reemplazando short_id → sku_id
 *   3. Delete de los 15 productos short-name (sobreviven los SKU-format)
 *   4. Reporte final
 *
 * Uso: DATABASE_URL='...' node database/dedup-larosa.js
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
  // [short_id, sku_id, short_name, sku_name]
  ['2f1de049-8f71-4403-a82d-0852df71637d', '7c227ab7-623e-494f-871d-fc9e0559b43a', 'Mazapán Clásico', 'LA ROSA MAZAPAN /30'],
  ['08e15441-c401-42d5-9a3d-9cfa320460f7', '4ce6cd0f-3b23-4471-aa49-944afd0eb448', 'Mazapán Chocolate', 'A ROSA MAZAPAN C/CHOC /16'],
  ['08fbbb40-7844-422b-ae11-1d9e84e850b7', '04dc37b1-8195-4089-b295-5fd92a2ab665', 'Mazapán Gigante', 'LA ROSA MAZAPAN GIGANTE 50G /20'],
  ['22a505de-1c76-4d69-9236-9a533080c5c8', '3a2d73aa-249a-483c-a91c-4c2523177376', 'Japonés 200g', 'A ROSA JAPONES TUBO 200G 6P NISHIYAMA'],
  ['7bc51df6-0d61-4707-91a4-d653b2f0e5b1', '18158d00-f1b3-44db-8960-82f6dd7ad86a', 'Japonés 60g', "a ROSA JAPONES TUBO 60G'12P NISHIYAMA"],
  ['bc6b0513-b800-4898-9b04-faf6bb4d01d5', '130aecea-f924-4ec1-b363-6b42e8ab291a', 'Bombón Chocolate', 'LA ROSA BOMBON C/CHOC SOP'],
  ['d27cd4d4-83dd-44ff-b53e-a74b62549ad4', 'a91cf353-e2b9-4dd1-bef9-14dbe83ee76d', 'Bombón Gigante', 'LA ROSA BOMBON SUPER GIGANTE 30P'],
  ['6b2196a8-a083-4ece-b9e6-e5c4aac7bbfb', '09b4ca2d-f560-4dfd-8164-097e2782e451', 'Nugs', 'a ROSA NUGS RECREO 56G:10P-'],
  ['7be5196d-f2b1-449e-b268-63b8a8ce4cd7', '09b4ca2d-f560-4dfd-8164-097e2782e451', 'Nugs Recreo', 'a ROSA NUGS RECREO 56G:10P-'],
  ['c44c92fa-47ed-4233-8cc9-e1a14497b9d0', '36bead7a-ca8d-487e-b3f6-0c153ac5ec8d', 'Suave Acidito', 'CAR SUAVE ACIDITO #100 LA ROSA'],
  ['a7854830-2d8f-492a-ab16-a3d2cdef4587', '5e9d70bf-30d9-4c74-979d-396e219dff5c', 'Pulparindo', 'PUTPARINBO. GRANDEY/20'],
  ['b7d9042d-47de-45aa-bfe9-4d4ae2050231', 'adfed78e-864a-452a-bb92-ee597aa17e61', 'Ranita', 'croc RANITA CROA! /12 LA ROSA'],
  ['64abf25c-4207-4b04-a743-359411b6f2f4', '4ae27c20-2283-4122-9150-61948c024aa3', 'Paleta Jumbo', 'Pat JUMBO.CEREZA /50,LA ROSA'],
  ['4ad4ff75-7caa-4a85-a379-83e2a56813fd', '152393f5-d86d-45e0-a384-158c7ff03a8e', 'Suizo', "CHOC EST SUIZO'/16 LA ROSA"],
  ['1229cf75-d9b0-40da-ad9e-f77d44f07a84', '128c6740-f357-4cff-987f-95585be27e6b', 'Malvabón', "CHOC MALVABON FRESA /12 LA'ROSA"],
];

const remap = new Map(PAIRS.map(([short, sku]) => [short, sku]));
const shortIds = PAIRS.map(([s]) => s);

(async () => {
  try {
    // 1. Backup
    console.log('► Backup de productos La Rosa...');
    await db.raw(`
      CREATE TABLE IF NOT EXISTS products_larosa_dedup_backup_2026_05_22 AS
      SELECT * FROM products
      WHERE brand_id = (SELECT id FROM brands WHERE nombre ILIKE 'la%rosa' LIMIT 1)
    `);
    const bkCount = await db('products_larosa_dedup_backup_2026_05_22').count('* as c');
    console.log(`  ✓ Backup: ${bkCount[0].c} productos respaldados`);

    // 2. Verificar que todos los short_ids existan
    const existing = await db('products').whereIn('id', shortIds).select('id', 'nombre');
    console.log(`  ✓ Verificación: ${existing.length}/${shortIds.length} short_ids encontrados`);
    if (existing.length !== shortIds.length) {
      const found = new Set(existing.map(p => p.id));
      const missing = shortIds.filter(id => !found.has(id));
      console.warn(`  ⚠ short_ids no encontrados (probablemente ya borrados):`, missing);
    }

    // 3. Verificar que todos los sku_ids existan
    const skuIds = [...new Set(PAIRS.map(([, s]) => s))];
    const existingSkus = await db('products').whereIn('id', skuIds).select('id');
    console.log(`  ✓ Verificación SKU: ${existingSkus.length}/${skuIds.length} sku_ids encontrados`);

    // 4. Remap JSONB en daily_captures
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
          // Dedupe en caso de que el remap genere duplicados dentro de la misma exhibición
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

    // 5. Delete short-name products
    console.log('\n► Delete de productos short-name...');
    const deleted = await db('products').whereIn('id', shortIds).del();
    console.log(`  ✓ ${deleted} productos short-name eliminados`);

    // 6. Reporte final
    const larosa = await db('products as p')
      .leftJoin('brands as b', 'p.brand_id', 'b.id')
      .where('b.nombre', 'ilike', 'la%rosa')
      .where('p.activo', true)
      .count('* as c');
    console.log(`\n  La Rosa productos activos restantes: ${larosa[0].c}`);
    console.log('\n✓ Dedup completado.');
  } catch (err) {
    console.error('\n✗ Error:', err.message);
    if (err.stack) console.error(err.stack);
    process.exit(1);
  } finally {
    await db.destroy();
  }
})();
