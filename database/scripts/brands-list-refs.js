/**
 * Lista todas las FK que apuntan a products.id y brands.id para saber qué hay
 * que remapear antes de fusionar marcas.
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
    for (const target of ['products', 'brands']) {
      console.log(`\n══════ FKs apuntando a ${target}(id) ══════`);
      const fks = await db.raw(`
        SELECT
          tc.table_schema AS schema,
          tc.table_name   AS table_name,
          tc.constraint_name AS constraint_name,
          string_agg(kcu.column_name, ',' ORDER BY kcu.ordinal_position) AS columns,
          string_agg(ccu.column_name, ',' ORDER BY kcu.ordinal_position) AS ref_columns,
          ccu.table_schema AS ref_schema,
          ccu.table_name   AS ref_table
        FROM information_schema.table_constraints tc
        JOIN information_schema.key_column_usage kcu
          ON tc.constraint_name = kcu.constraint_name
          AND tc.table_schema = kcu.table_schema
        JOIN information_schema.constraint_column_usage ccu
          ON tc.constraint_name = ccu.constraint_name
        WHERE tc.constraint_type = 'FOREIGN KEY'
          AND ccu.table_name = ?
        GROUP BY tc.table_schema, tc.table_name, tc.constraint_name, ccu.table_schema, ccu.table_name
        ORDER BY 1, 2
      `, [target]);
      for (const r of fks.rows) {
        console.log(`  ${r.schema}.${r.table_name}.(${r.columns}) → ${r.ref_schema}.${r.ref_table}.(${r.ref_columns})  [${r.constraint_name}]`);
      }
    }

    // JSONB refs en daily_captures (no son FK)
    console.log(`\n══════ JSONB refs en daily_captures.exhibiciones ══════`);
    console.log('  exhibiciones[].brandId         (uuid de brand)');
    console.log('  exhibiciones[].productosMarcados[]  (array de uuids de product)');
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  } finally {
    await db.destroy();
  }
})();
