/**
 * Auditoría read-only de role_permissions: cuántas claves tiene cada rol y si
 * SUPERVISOR_AI_* está presente. Sirve para detectar pérdida de permisos.
 * Uso: node database/scripts/roles-audit.js
 */
require('dotenv').config();
const knex = require('knex')(require('../knexfile-newdb.js').development);

(async () => {
  const rows = await knex('role_permissions').select('role_name', 'tenant_id', 'permissions');
  console.log(`role_permissions: ${rows.length} filas\n`);
  for (const r of rows) {
    const p = typeof r.permissions === 'string' ? JSON.parse(r.permissions) : r.permissions || {};
    const total = Object.keys(p).length;
    const enabled = Object.values(p).filter((v) => v === true).length;
    console.log(
      `  ${String(r.role_name).padEnd(16)} keys=${String(total).padStart(3)} enabled=${String(enabled).padStart(3)}` +
        ` SUP_AI_VER=${p.SUPERVISOR_AI_VER ?? '—'} SUP_AI_APROBAR=${p.SUPERVISOR_AI_APROBAR ?? '—'}` +
        ` tenant=${r.tenant_id ? String(r.tenant_id).slice(0, 8) : 'null'}`,
    );
  }
  await knex.destroy();
})().catch((e) => {
  console.error('ERR', e.message);
  process.exit(1);
});
