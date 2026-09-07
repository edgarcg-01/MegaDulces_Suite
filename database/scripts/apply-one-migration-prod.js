/**
 * Aplica UNA migración de `migrations-newdb` a PROD, por nombre de archivo.
 *
 * POR QUÉ existe: `npx knex migrate:latest --knexfile database/knexfile-newdb.js` apunta a
 * `DATABASE_URL_NEW`, que en `.env` es una COPIA LOCAL vieja — no prod (prod es `FLEET_DB_URL`,
 * ver reference_prod_db_connection_topology). Y `migrate:latest` aplicaría también las migraciones
 * pendientes de OTROS devs, que no me toca aplicar. Esto corre exactamente una, la mía.
 *
 *   node database/scripts/apply-one-migration-prod.js 20260903170000_algo.js [--list]
 *
 * NUNCA imprime la cadena de conexión.
 */
'use strict';
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '..', '.env') });

const url = process.env.FLEET_DB_URL;
if (!url) { console.error('Falta FLEET_DB_URL en .env'); process.exit(1); }

const knex = require('knex')({
  client: 'pg',
  connection: { connectionString: url, ssl: { rejectUnauthorized: false } },
  pool: { min: 0, max: 2 },
  migrations: {
    directory: path.resolve(__dirname, '..', 'migrations-newdb'),
    tableName: 'knex_migrations',
    schemaName: 'public',
  },
});

(async () => {
  const arg = process.argv[2];
  if (!arg || arg === '--list') {
    const [done, pending] = await knex.migrate.list();
    console.log(`aplicadas: ${done.length} · pendientes: ${pending.length}`);
    console.log('\nPENDIENTES:');
    pending.forEach((p) => console.log('  ·', p.file || p));
    await knex.destroy();
    return;
  }
  const [, pendingBefore] = await knex.migrate.list();
  const names = pendingBefore.map((p) => p.file || p);
  if (!names.includes(arg)) {
    console.error(`"${arg}" NO está pendiente. Pendientes:\n  ${names.join('\n  ') || '(ninguna)'}`);
    await knex.destroy();
    process.exit(2);
  }
  console.log(`aplicando ${arg} …`);
  const res = await knex.migrate.up({ name: arg });
  console.log('OK →', JSON.stringify(res));
  await knex.destroy();
})().catch(async (e) => { console.error('FALLA:', e.message); try { await knex.destroy(); } catch { /* noop */ } process.exit(1); });
