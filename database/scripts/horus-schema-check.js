/**
 * Horus — diagnóstico de schema (read-only). ¿Están aplicadas las migraciones?
 * Uso: node database/scripts/horus-schema-check.js
 */
require('dotenv').config();
const knex = require('knex')(require('../knexfile-newdb.js').development);

(async () => {
  const tables = await knex.raw(
    `SELECT table_schema, table_name FROM information_schema.tables
      WHERE table_name IN ('execution_360','execution_thresholds','supervisor_findings')
      ORDER BY 1,2`,
  );
  console.log('Tablas Horus presentes:', tables.rows);

  const migs = await knex.raw(
    `SELECT name FROM knex_migrations WHERE name LIKE '202606161%' ORDER BY name`,
  );
  console.log('Migraciones 2026-06-16 aplicadas:', migs.rows.map((r) => r.name));

  for (const t of ['execution_360', 'execution_thresholds', 'supervisor_findings']) {
    try {
      const r = await knex(`commercial.${t}`).count('* as n').first();
      console.log(`  commercial.${t}: existe, ${r.n} rows`);
    } catch (e) {
      console.log(`  commercial.${t}: ERROR — ${e.message}`);
    }
  }

  await knex.destroy();
})().catch((e) => {
  console.error('ERR', e.message);
  process.exit(1);
});
