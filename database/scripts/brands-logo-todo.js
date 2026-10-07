/**
 * Lista de marcas del catálogo ordenadas por # de productos, para priorizar
 * qué logos conseguir primero (carrusel "Top marcas" del portal). Reporta
 * también cobertura de imágenes por marca (cuántos SKUs ya tienen foto).
 *
 * Solo lectura. Introspección defensiva del schema (nombre/name, deleted_at/activo).
 *
 * Uso:
 *   DATABASE_URL='postgresql://user:pass@host:port/db' node database/scripts/brands-logo-todo.js
 *   ... node database/scripts/brands-logo-todo.js --top 40
 *   ... node database/scripts/brands-logo-todo.js --csv > marcas.csv
 */
const knex = require('knex');

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error('ERROR: falta DATABASE_URL (export DATABASE_URL=postgresql://...)');
  process.exit(1);
}

const args = process.argv.slice(2);
const topIdx = args.indexOf('--top');
const TOP = topIdx >= 0 ? parseInt(args[topIdx + 1], 10) || 40 : 40;
const CSV = args.includes('--csv');

const db = knex({
  client: 'pg',
  connection: {
    connectionString: DATABASE_URL,
    ssl: DATABASE_URL.includes('localhost') ? false : { rejectUnauthorized: false },
  },
  pool: { min: 1, max: 4 },
});

async function col(table, candidates) {
  const r = await db.raw(
    `SELECT column_name FROM information_schema.columns WHERE table_name = ? AND column_name = ANY(?)`,
    [table, candidates],
  );
  const found = new Set(r.rows.map((x) => x.column_name));
  return candidates.find((c) => found.has(c)) || null;
}

(async () => {
  try {
    await db.raw('SELECT 1');

    const brandName = (await col('brands', ['nombre', 'name', 'brand_name'])) || 'nombre';
    const prodSoftDel = await col('products', ['deleted_at']);
    const prodActivo = await col('products', ['activo']);
    const hasImage = await col('products', ['image_url']);

    const whereActive = prodSoftDel
      ? `WHERE p.${prodSoftDel} IS NULL`
      : prodActivo
        ? `WHERE p.${prodActivo} = true`
        : '';

    const imgExpr = hasImage
      ? `COUNT(p.${hasImage}) FILTER (WHERE p.${hasImage} IS NOT NULL)`
      : `0`;

    const sql = `
      SELECT b.id AS brand_id,
             b.${brandName} AS marca,
             COUNT(p.id)::int AS productos,
             ${imgExpr}::int AS con_imagen
      FROM products p
      JOIN brands b ON b.id = p.brand_id
      ${whereActive}
      GROUP BY b.id, b.${brandName}
      ORDER BY productos DESC, marca ASC
    `;
    const { rows } = await db.raw(sql);

    if (CSV) {
      console.log('marca,productos,con_imagen,brand_id');
      for (const r of rows) console.log(`"${r.marca}",${r.productos},${r.con_imagen},${r.brand_id}`);
      return;
    }

    const total = rows.reduce((s, r) => s + r.productos, 0);
    console.log(`\n  ${rows.length} marcas · ${total} productos activos\n`);
    console.log('  #   PRODUCTOS  C/IMG   MARCA');
    console.log('  ─────────────────────────────────────────────');
    rows.slice(0, TOP).forEach((r, i) => {
      const n = String(i + 1).padStart(3);
      const p = String(r.productos).padStart(8);
      const im = String(r.con_imagen).padStart(5);
      console.log(`  ${n} ${p}   ${im}   ${r.marca}`);
    });
    if (rows.length > TOP) console.log(`  … +${rows.length - TOP} marcas más (usa --top ${rows.length} o --csv).`);
    console.log('');
  } catch (e) {
    console.error('ERROR:', e.message);
    process.exit(1);
  } finally {
    await db.destroy();
  }
})();
