/**
 * Wrapper directo para correr el seed 91_daily_captures_demo.js
 * contra la BD especificada en DATABASE_URL.
 *
 * Uso:
 *   DATABASE_URL='postgresql://...' node database/run-seed-91.js
 */
const knex = require('knex');
const path = require('path');

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error('ERROR: falta DATABASE_URL en el entorno.');
  process.exit(1);
}

const db = knex({
  client: 'pg',
  connection: { connectionString: DATABASE_URL, ssl: { rejectUnauthorized: false } },
  pool: { min: 1, max: 4 },
});

(async () => {
  try {
    const dbInfo = await db.raw('SELECT current_database() AS db, version() AS v');
    console.log(`✓ Conectado a: ${dbInfo.rows[0].db}`);
    console.log(`  ${dbInfo.rows[0].v.split(',')[0]}`);
    console.log();

    const seed = require(path.join(__dirname, 'seeds', '91_daily_captures_demo.js'));
    console.log('► Ejecutando seed 91_daily_captures_demo...\n');
    await seed.seed(db);
    console.log('\n✓ Seed completado.');
  } catch (err) {
    console.error('\n✗ Error ejecutando seed:', err.message);
    if (err.stack) console.error(err.stack);
    process.exit(1);
  } finally {
    await db.destroy();
  }
})();
