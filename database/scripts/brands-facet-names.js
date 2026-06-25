/**
 * Lista los nombres de marca TAL CUAL los recibe el carrusel del portal
 * (catalog.brands → COALESCE(display_name, nombre)), con # de productos, y
 * para cada uno: si matchea una marca conocida (keyword), su slug, y si existe
 * el archivo de logo en apps/portal/public/assets/brands. Reporta los faltantes.
 *
 * Solo lectura.
 *   DATABASE_URL='postgresql://...' node database/scripts/brands-facet-names.js
 */
const knex = require('knex');
const fs = require('fs');
const path = require('path');

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) { console.error('falta DATABASE_URL'); process.exit(1); }

const db = knex({
  client: 'pg',
  connection: { connectionString: DATABASE_URL, ssl: DATABASE_URL.includes('localhost') ? false : { rejectUnauthorized: false } },
  pool: { min: 1, max: 4 },
});

// Mismas reglas que el componente brands-carousel.
const KNOWN = [
  { re: /hershey/, slug: 'hersheys' },
  { re: /\bmars\b|effem/, slug: 'mars' },
  { re: /mondelez|ricolino/, slug: 'ricolino' },
  { re: /ferrero/, slug: 'ferrero' },
  { re: /arcor/, slug: 'arcor' },
  { re: /perfetti|van melle/, slug: 'perfetti-van-melle' },
  { re: /barcel|bimbo/, slug: 'bimbo' },
  { re: /canel/, slug: 'canels' },
  { re: /de la rosa|dulces de la rosa/, slug: 'de-la-rosa' },
  { re: /jovy/, slug: 'jovy' },
  { re: /payaso|globo/, slug: 'globo-payaso' },
  { re: /delicias/, slug: 'delicias' },
  { re: /gonac/, slug: 'gonac' },
  { re: /nutresa/, slug: 'nutresa' },
];
const norm = (s) => (s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').trim();
const ASSETS = path.resolve(__dirname, '../../apps/portal/public/assets/brands');
function fileFor(slug) {
  for (const ext of ['svg', 'png', 'webp']) {
    if (fs.existsSync(path.join(ASSETS, `${slug}.${ext}`))) return `${slug}.${ext}`;
  }
  return null;
}

(async () => {
  try {
    const { rows } = await db.raw(`
      SELECT COALESCE(b.display_name, b.nombre) AS brand, COUNT(p.id)::int AS productos
      FROM catalog.products p
      LEFT JOIN catalog.brands b ON b.id = p.brand_id AND b.tenant_id = p.tenant_id
      GROUP BY 1
      ORDER BY productos DESC
      LIMIT 60
    `);

    const relevant = rows.filter((r) => r.brand && !/clasificar|abarrotes|bolsas/i.test(r.brand));

    const needKeyword = []; // nombre relevante que NO matchea ninguna regla
    const needFile = [];    // matchea pero no hay archivo de logo

    console.log('\n  PROD  MATCH         LOGO            MARCA (como la ve el portal)');
    console.log('  ──────────────────────────────────────────────────────────────────');
    for (const r of relevant) {
      const n = norm(r.brand);
      const m = KNOWN.find((k) => k.re.test(n));
      const file = m ? fileFor(m.slug) : null;
      const matchTxt = (m ? m.slug : '—').padEnd(12);
      const logoTxt = (file || (m ? 'FALTA' : '—')).padEnd(14);
      console.log(`  ${String(r.productos).padStart(4)}  ${matchTxt} ${logoTxt}  ${r.brand}`);
      if (!m) needKeyword.push(r.brand);
      else if (!file) needFile.push(m.slug);
    }

    console.log('\n  ▸ Reconocidas SIN archivo de logo (sube el archivo):');
    console.log('    ' + ([...new Set(needFile)].join(', ') || '(ninguna)'));
    console.log('\n  ▸ NO reconocidas por keyword (dime si alguna es una marca real para mapearla):');
    needKeyword.slice(0, 30).forEach((b) => console.log('    • ' + b));
    console.log('');
  } catch (e) {
    console.error('ERROR:', e.message);
    process.exit(1);
  } finally {
    await db.destroy();
  }
})();
