/**
 * Detalle de productos por grupo de marca duplicada. Muestra colisiones por
 * normalized(nombre) — si ambas brands tienen un producto que normaliza igual,
 * habrá que fusionar también esos productos.
 *
 * Uso: DATABASE_URL='...' node database/brands-explore-detail.js
 */
const knex = require('knex');

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error('ERROR: falta DATABASE_URL');
  process.exit(1);
}

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
    const brands = await db('brands').select('*').orderBy('nombre');
    const groups = new Map();
    for (const b of brands) {
      const key = `${b.tenant_id || 'legacy'}::${normalize(b.nombre)}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(b);
    }

    const dupGroups = [...groups.entries()].filter(([, arr]) => arr.length > 1);
    console.log(`Grupos de duplicados: ${dupGroups.length}\n`);

    let idx = 0;
    for (const [key, arr] of dupGroups) {
      idx++;
      const [, norm] = key.split('::');
      console.log(`══════════════════════════════════════════════════════════════════════════`);
      console.log(`#${idx} normalizado="${norm}"`);
      console.log(`══════════════════════════════════════════════════════════════════════════`);

      // Productos por brand (todos, no soft-deleted)
      const productsByBrand = new Map();
      for (const b of arr) {
        const prods = await db('products')
          .where({ brand_id: b.id })
          .whereNull('deleted_at')
          .select('id', 'nombre', 'activo', 'puntuacion', 'orden')
          .orderBy('nombre');
        productsByBrand.set(b.id, prods);
        console.log(`\n• Brand "${b.nombre}" id=${b.id.slice(0,8)}… (${prods.length} productos activos)`);
        for (const p of prods) {
          console.log(`    - ${p.id.slice(0,8)}…  "${p.nombre}"  punt=${p.puntuacion}  orden=${p.orden}`);
        }
      }

      // Colisiones cross-brand por normalized(nombre)
      const nameMap = new Map(); // norm → [{brand_id, product}]
      for (const [bid, prods] of productsByBrand) {
        for (const p of prods) {
          const k = normalize(p.nombre);
          if (!nameMap.has(k)) nameMap.set(k, []);
          nameMap.get(k).push({ brand_id: bid, product: p });
        }
      }
      const collisions = [...nameMap.entries()].filter(([, arr]) => arr.length > 1);
      if (collisions.length) {
        console.log(`\n  ⚠ COLISIONES de nombre (mismo producto en ambas brands):`);
        for (const [norm2, items] of collisions) {
          console.log(`    [${norm2}]`);
          for (const it of items) {
            console.log(`      brand=${it.brand_id.slice(0,8)}… product=${it.product.id.slice(0,8)}… "${it.product.nombre}"`);
          }
        }
      } else {
        console.log(`\n  ✓ Sin colisiones de nombre — merge directo posible (solo UPDATE brand_id)`);
      }
      console.log('');
    }

    console.log('\n✓ Detalle completo.');
  } catch (err) {
    console.error('\n✗ Error:', err.message);
    if (err.stack) console.error(err.stack);
    process.exit(1);
  } finally {
    await db.destroy();
  }
})();
