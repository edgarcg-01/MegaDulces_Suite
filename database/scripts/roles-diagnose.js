/**
 * Diagnóstico read-only de role_permissions: tenant_id COMPLETO por fila,
 * permisos diagnóstico, constraints de la tabla y el rol/tenant de superoot.
 * Sirve para entender duplicados de rol y el 403 de superoot.
 * Uso: node database/scripts/roles-diagnose.js
 */
require('dotenv').config();
const knex = require('knex')(require('../knexfile-newdb.js').development);

(async () => {
  const rows = await knex('role_permissions').select('*');
  console.log(`=== role_permissions: ${rows.length} filas ===`);
  for (const r of rows) {
    const p = typeof r.permissions === 'string' ? JSON.parse(r.permissions) : r.permissions || {};
    console.log(
      `role=${String(r.role_name).padEnd(17)} tenant=${r.tenant_id || 'NULL'} ` +
        `keys=${String(Object.keys(p).length).padStart(3)} ` +
        `REP_PROPIO=${p.REPORTES_VER_PROPIO ?? '—'} VISITAS_VER=${p.VISITAS_VER ?? '—'} SUP_AI_VER=${p.SUPERVISOR_AI_VER ?? '—'}`,
    );
  }

  console.log('\n=== Constraints de role_permissions ===');
  const cons = await knex.raw(
    `SELECT n.nspname AS schema, c.conname, pg_get_constraintdef(c.oid) AS def
       FROM pg_constraint c
       JOIN pg_class t ON t.oid = c.conrelid
       JOIN pg_namespace n ON n.oid = t.relnamespace
      WHERE t.relname = 'role_permissions'`,
  );
  cons.rows.forEach((c) => console.log(`  [${c.schema}] ${c.conname}: ${c.def}`));

  console.log('\n=== user superoot ===');
  try {
    const u = await knex('users')
      .where('username', 'superoot')
      .select('username', 'role_name', 'tenant_id', 'activo');
    console.log(u);
  } catch (e) {
    console.log('users query err:', e.message);
  }

  await knex.destroy();
})().catch((e) => {
  console.error('ERR', e.message);
  process.exit(1);
});
