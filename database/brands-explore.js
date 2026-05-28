/**
 * Exploración de marcas: detecta duplicados e irregularidades.
 *
 * Agrupa por (tenant_id, LOWER(TRIM(unaccent(nombre)))) — todo lo que colapse a
 * la misma clave normalizada se considera duplicado entre sí. Reporta también
 * cuántos products + captures + commercial.product_prices referencian cada brand.
 *
 * Uso: DATABASE_URL='...' node database/brands-explore.js
 *      DATABASE_URL='...' node database/brands-explore.js --tenant <uuid>
 */
const knex = require('knex');

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error('ERROR: falta DATABASE_URL');
  process.exit(1);
}

const args = process.argv.slice(2);
const tenantArgIdx = args.indexOf('--tenant');
const tenantFilter = tenantArgIdx >= 0 ? args[tenantArgIdx + 1] : null;

const db = knex({
  client: 'pg',
  connection: { connectionString: DATABASE_URL, ssl: DATABASE_URL.includes('localhost') ? false : { rejectUnauthorized: false } },
  pool: { min: 1, max: 4 },
});

function normalize(s) {
  if (!s) return '';
  return s
    .toString()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/['`´¨]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

(async () => {
  try {
    console.log('▶ Conectando a DB...');
    await db.raw('SELECT 1');
    console.log('  ✓ OK');

    // Detectar si la DB tiene tenant_id (nueva DB) o no (legacy)
    const hasTenant = await db.raw(`
      SELECT 1 FROM information_schema.columns
      WHERE table_name='brands' AND column_name='tenant_id'
    `);
    const isMt = hasTenant.rows.length > 0;
    console.log(`  Schema: ${isMt ? 'multi-tenant (nueva DB)' : 'legacy'}`);

    // Detectar si existe commercial.product_prices
    const hasCommercial = await db.raw(`
      SELECT 1 FROM information_schema.tables
      WHERE table_schema='commercial' AND table_name='product_prices'
    `);
    const hasCom = hasCommercial.rows.length > 0;

    console.log('\n▶ Cargando marcas...');
    const brandsQ = db('brands').select('*').orderBy('nombre');
    if (isMt && tenantFilter) brandsQ.where('tenant_id', tenantFilter);
    const brands = await brandsQ;
    console.log(`  Total marcas: ${brands.length}`);
    if (!brands.length) {
      console.log('  (vacío — fin)');
      return;
    }

    console.log('\n▶ Contando productos por marca (todos, incluido soft-deleted)...');
    const productCountsRaw = await db.raw(`
      SELECT brand_id,
             COUNT(*) AS total,
             SUM(CASE WHEN deleted_at IS NULL THEN 1 ELSE 0 END) AS active
      FROM products
      GROUP BY brand_id
    `);
    const productCounts = new Map(productCountsRaw.rows.map(r => [r.brand_id, { total: Number(r.total), active: Number(r.active || 0) }]));

    let priceCounts = new Map();
    if (hasCom) {
      try {
        const priceCountsRaw = await db.raw(`
          SELECT p.brand_id, COUNT(*) AS c
          FROM commercial.product_prices pp
          JOIN products p ON p.id = pp.product_id
          GROUP BY p.brand_id
        `);
        priceCounts = new Map(priceCountsRaw.rows.map(r => [r.brand_id, Number(r.c)]));
      } catch (e) {
        console.warn(`  (no se pudo contar product_prices: ${e.message})`);
      }
    }

    // Capturas que referencian brand_id directamente vía exhibiciones JSONB.
    // Evitamos `exh ? 'brandId'` porque knex escapa `?` como bind param.
    // El IS NOT NULL ya cubre el caso de keys ausentes.
    let captureBrandRefs = new Map();
    try {
      const refsRaw = await db.raw(`
        SELECT (exh->>'brandId') AS brand_id, COUNT(*) AS c
        FROM daily_captures dc
        CROSS JOIN LATERAL jsonb_array_elements(dc.exhibiciones) AS exh
        WHERE exh->>'brandId' IS NOT NULL
        GROUP BY 1
      `);
      captureBrandRefs = new Map(refsRaw.rows.map(r => [r.brand_id, Number(r.c)]));
    } catch (e) {
      console.warn(`  (no se pudo contar refs brand en daily_captures: ${e.message})`);
    }

    // Agrupar por (tenant_id, normalized)
    const groups = new Map();
    for (const b of brands) {
      const key = `${b.tenant_id || 'legacy'}::${normalize(b.nombre)}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(b);
    }

    const dupGroups = [...groups.entries()].filter(([, arr]) => arr.length > 1);
    const singletonIrregulars = [...groups.entries()].filter(([, arr]) => {
      if (arr.length !== 1) return false;
      const b = arr[0];
      return b.nombre !== b.nombre.trim() || /[A-Z]/.test(b.nombre) !== /[a-z]/.test(b.nombre);
    });

    console.log(`\n╔══════════════════════════════════════════════════════════════════════════════╗`);
    console.log(`║  RESUMEN`);
    console.log(`╠══════════════════════════════════════════════════════════════════════════════╣`);
    console.log(`║  Total marcas: ${brands.length}`);
    console.log(`║  Grupos de duplicados: ${dupGroups.length}`);
    console.log(`║  Total marcas en duplicados: ${dupGroups.reduce((a, [, arr]) => a + arr.length, 0)}`);
    console.log(`║  Marcas con whitespace/case raro (singletons): ${singletonIrregulars.length}`);
    console.log(`╚══════════════════════════════════════════════════════════════════════════════╝`);

    if (dupGroups.length === 0) {
      console.log('\n✓ No hay grupos de duplicados.');
    } else {
      console.log('\n▶ GRUPOS DE DUPLICADOS\n');
      let groupIdx = 0;
      for (const [key, arr] of dupGroups) {
        groupIdx++;
        const [tid, norm] = key.split('::');
        console.log(`#${groupIdx} normalizado="${norm}" tenant=${tid.slice(0, 8)}…  (${arr.length} brands)`);
        for (const b of arr) {
          const pc = productCounts.get(b.id) || { total: 0, active: 0 };
          const prc = priceCounts.get(b.id) || 0;
          const capr = captureBrandRefs.get(b.id) || 0;
          const sd = b.deleted_at ? ' [soft-deleted]' : '';
          const ac = b.activo === false ? ' [inactiva]' : '';
          console.log(`    • ${b.id}  nombre="${b.nombre}"  prods=${pc.active}/${pc.total}  prices=${prc}  capRefs=${capr}${sd}${ac}`);
        }
        console.log('');
      }
    }

    if (singletonIrregulars.length) {
      console.log('\n▶ SINGLETONS CON IRREGULARIDADES (whitespace, todo MAYÚSCULAS, etc.)\n');
      for (const [, arr] of singletonIrregulars) {
        const b = arr[0];
        const pc = productCounts.get(b.id) || { total: 0, active: 0 };
        console.log(`    • ${b.id}  nombre="${b.nombre}"  prods=${pc.active}/${pc.total}`);
      }
    }

    console.log('\n✓ Exploración completa.');
  } catch (err) {
    console.error('\n✗ Error:', err.message);
    if (err.stack) console.error(err.stack);
    process.exit(1);
  } finally {
    await db.destroy();
  }
})();
