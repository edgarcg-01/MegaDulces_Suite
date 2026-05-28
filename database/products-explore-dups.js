/**
 * Escanea productos duplicados DENTRO de cada marca: agrupa por
 * (tenant_id, brand_id, normalize(nombre)) y reporta grupos con >1 producto.
 *
 * También detecta productos con whitespace al inicio/final del nombre.
 *
 * Uso: DATABASE_URL='...' node database/products-explore-dups.js
 */
const knex = require('knex');
const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) { console.error('falta DATABASE_URL'); process.exit(1); }
const db = knex({
  client: 'pg',
  connection: { connectionString: DATABASE_URL, ssl: DATABASE_URL.includes('localhost') ? false : { rejectUnauthorized: false } },
  pool: { min: 1, max: 4 },
});

function normalize(s) {
  if (!s) return '';
  return s.toString().normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/['`´¨]/g, '').replace(/\s+/g, ' ').trim();
}

(async () => {
  try {
    const products = await db('products')
      .leftJoin('brands', 'products.brand_id', 'brands.id')
      .whereNull('products.deleted_at')
      .select('products.id', 'products.brand_id', 'products.nombre', 'products.tenant_id', 'brands.nombre as brand_nombre');

    console.log(`Total productos activos: ${products.length}`);

    // Agrupar por (tenant, brand, normalized)
    const groups = new Map();
    for (const p of products) {
      const key = `${p.tenant_id}::${p.brand_id}::${normalize(p.nombre)}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(p);
    }
    const dupGroups = [...groups.entries()].filter(([, arr]) => arr.length > 1);

    // Whitespace anomalies (singletons)
    const wsAnomalies = products.filter(p => p.nombre !== p.nombre.trim() || /\s{2,}/.test(p.nombre));

    console.log(`\n╔═══════════════════════════════════════════════════════════════════╗`);
    console.log(`║  Grupos de productos duplicados dentro de la misma brand: ${dupGroups.length}`);
    console.log(`║  Productos con whitespace anómalo: ${wsAnomalies.length}`);
    console.log(`╚═══════════════════════════════════════════════════════════════════╝`);

    if (dupGroups.length) {
      // Agrupar grupos por brand para reporting
      const byBrand = new Map();
      for (const [key, arr] of dupGroups) {
        const brand = arr[0].brand_nombre || '(sin brand)';
        if (!byBrand.has(brand)) byBrand.set(brand, []);
        byBrand.get(brand).push(arr);
      }

      console.log('\n▶ DUPLICADOS POR MARCA\n');
      for (const [brand, groupsArr] of [...byBrand.entries()].sort()) {
        console.log(`── ${brand}  (${groupsArr.length} grupo(s)) ──`);
        for (const arr of groupsArr) {
          const norm = normalize(arr[0].nombre);
          console.log(`  • [${norm}]  (${arr.length} variantes)`);
          for (const p of arr) {
            console.log(`      ${p.id.slice(0, 8)}…  "${p.nombre}"`);
          }
        }
        console.log('');
      }
    }

    if (wsAnomalies.length) {
      console.log('\n▶ PRODUCTOS CON WHITESPACE ANÓMALO (top 30):');
      for (const p of wsAnomalies.slice(0, 30)) {
        console.log(`    ${p.id.slice(0, 8)}…  [${p.brand_nombre}]  "${p.nombre}"  (trim="${p.nombre.trim()}")`);
      }
    }

    console.log('\n✓ Exploración completa.');
  } catch (err) {
    console.error('\n✗ Error:', err.message);
    process.exit(1);
  } finally {
    await db.destroy();
  }
})();
