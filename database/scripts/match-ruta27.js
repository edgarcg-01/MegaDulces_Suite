"use strict";

/**
 * READ-ONLY: matchea por nombre los clientes de las capturas del ERP (ruta 27,
 * por día) contra commercial.customers (code LIKE '27%') → códigos exactos.
 * Uso: $env:PROD_DATABASE_URL='...'; node database/scripts/match-ruta27.js --day=3
 */
const { Client } = require('pg');
const PROD_URL = process.env.PROD_DATABASE_URL;
if (!PROD_URL) { console.error('Falta PROD_DATABASE_URL'); process.exit(1); }
const dayArg = process.argv.find((a) => a.startsWith('--day='));
const DAY = dayArg ? Number(dayArg.split('=')[1]) : null;

const PATTERNS_BY_DAY = {
  6: [ // SÁBADO (de la captura)
    'aba tere', 'abarrotes chelo', 'abarrotes el tio', 'adela mendez', 'bertha gonzalez',
    'esthela rojas', 'josefina arellano', 'juani licea', 'karen garcia', 'mirian gallardo',
    'monica licea', 'olivia bravo', 'ramon carranza', 'roberto reyes', 'rodolfo ayala',
    'ruth yajaira', 'vinos y licores',
  ],
  5: [ // VIERNES (de la captura)
    'aba tere', 'abarrotes ana', 'abarrotes el kiosco', 'abarrotes gaby', 'abarrotes navarro',
    'abarrotes reyes', 'adela mendez', 'alejandra orozco', 'ana bertha', 'ana laura',
    'ana maria rodriguez', 'karen garcia', 'laura romero', 'maria de la luz',
    'maria elena granados', 'maria socorro delgado', 'mauro guillen', 'micelenia',
    'papeleria', 'patricia alaniz', 'tienda garcia',
  ],
  4: [ // JUEVES (de la captura)
    'abarrotes betty', 'abarrotes el ranchito', 'abarrotes el trigre', 'hecelchakan',
    'abarrotes la rielera', 'abarrotes rios', 'abarrotes trujillo', 'antonia ramirez',
    'aurora garcia', 'cecilia medina', 'elena aguirre', 'esthela rojas',
    'francisco vazquez', 'juana bernal', 'juana hernandez', 'karen garcia',
    'lidia esparza', 'lucia hern', 'maria bernal', 'martha atilano',
    'salvador pacheco', 'tortas alex', 'tortilleria san juan',
  ],
  3: [ // MIÉRCOLES (de la captura)
    'aba tere', 'abarrotes avila', 'abarrotes casilda', 'abarrotes don tomas',
    'abarrotes don to', 'abarrotes el compa', 'abarrotes gaby', 'abarrotes garcia',
    'tiendita de andy', 'abarrotes lolis', 'abarrotes molina', 'abarrotes rodriguez',
    'abarrotes zenteno', 'ana maria garcia', 'andrea jazmin', 'bertha gonzalez',
    'cenaduria rodriguez', 'claudia e', 'gracia hurtado', 'karen garcia',
    'ma angeles barron', 'maria luisa morales', 'mini super', 'silvestre duran', 'tienda garcia',
  ],
};
const PATTERNS = PATTERNS_BY_DAY[DAY];
if (!PATTERNS) { console.error(`No hay patrones para --day=${DAY}`); process.exit(1); }

(async () => {
  const c = new Client({ connectionString: PROD_URL, ssl: { rejectUnauthorized: false } });
  await c.connect();
  const where = PATTERNS.map((_, i) => `name ILIKE $${i + 1}`).join(' OR ');
  const params = PATTERNS.map((p) => `%${p}%`);
  const r = await c.query(`
    SELECT code, name FROM commercial.customers
    WHERE deleted_at IS NULL AND code LIKE '27%' AND (${where})
    ORDER BY name`, params);
  console.log(`day=${DAY} — MATCHES (${r.rows.length} filas; patrones ${PATTERNS.length}):`);
  for (const x of r.rows) console.log(`  '${x.code}',`.padEnd(16) + `// ${x.name}`);
  await c.end();
})().catch((e) => { console.error('ERROR:', e.message); process.exit(1); });
