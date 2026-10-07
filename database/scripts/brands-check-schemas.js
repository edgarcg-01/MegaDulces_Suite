const knex = require('knex');
const DATABASE_URL = process.env.DATABASE_URL;
const db = knex({
  client: 'pg',
  connection: { connectionString: DATABASE_URL, ssl: DATABASE_URL.includes('localhost') ? false : { rejectUnauthorized: false } },
  pool: { min: 1, max: 4 },
});
(async () => {
  try {
    const tables = [
      ['commercial', 'stock'],
      ['commercial', 'stock_movements'],
      ['commercial', 'product_prices'],
      ['commercial', 'order_lines'],
    ];
    for (const [s, t] of tables) {
      console.log(`\n══ ${s}.${t} ══`);
      const cols = await db.raw(`
        SELECT column_name, data_type, is_nullable
        FROM information_schema.columns
        WHERE table_schema=? AND table_name=?
        ORDER BY ordinal_position
      `, [s, t]);
      for (const c of cols.rows) console.log(`  ${c.column_name}  ${c.data_type}  ${c.is_nullable}`);

      const uniques = await db.raw(`
        SELECT tc.constraint_name, string_agg(kcu.column_name, ',' ORDER BY kcu.ordinal_position) AS cols
        FROM information_schema.table_constraints tc
        JOIN information_schema.key_column_usage kcu
          ON tc.constraint_name = kcu.constraint_name
        WHERE tc.table_schema=? AND tc.table_name=? AND tc.constraint_type IN ('UNIQUE','PRIMARY KEY')
        GROUP BY tc.constraint_name
      `, [s, t]);
      for (const u of uniques.rows) console.log(`  UNIQUE/PK ${u.constraint_name}: (${u.cols})`);
    }
  } finally { await db.destroy(); }
})();
