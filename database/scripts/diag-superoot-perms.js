/* eslint-disable no-console */
/**
 * Diagnóstico read-only: por qué el RolesGuard tira 403 a superoot.
 * Replica lo que ve el guard: KNEX_CONNECTION = DATABASE_URL (user postgres,
 * bypassa RLS) → role_permissions WHERE role_name = <rol de superoot>.
 */
require('dotenv').config({ path: require('path').resolve(__dirname, '..', '..', '.env') });

const url = process.env.DATABASE_URL || process.env.DATABASE_URL_NEW_RUNTIME;
console.log('Conexión:', process.env.DATABASE_URL ? 'DATABASE_URL (postgres — igual que el guard)' : 'NEW_RUNTIME (fallback)');
const knex = require('knex')({ client: 'pg', connection: url });
const TENANT = '00000000-0000-0000-0000-00000000d01c';

(async () => {
  try {
    let user = null;
    try {
      user = await knex('users').where({ username: 'superoot' }).first();
    } catch { /* maybe RLS */ }
    if (!user) {
      try { await knex.raw(`SET app.tenant_id = '${TENANT}'`); } catch { /* noop */ }
      user = await knex('users').where({ username: 'superoot' }).first();
    }
    console.log('\nUSER superoot:', user
      ? { username: user.username, role_name: user.role_name, activo: user.activo, tenant_id: user.tenant_id }
      : '❌ NO EXISTE');

    const roleName = user?.role_name;
    if (roleName) {
      const rp = await knex('role_permissions').where({ role_name: roleName }).first();
      if (!rp) {
        console.log(`\nrole_permissions["${roleName}"]: ❌ FILA AUSENTE`);
      } else {
        const p = rp.permissions || {};
        const trueKeys = Object.keys(p).filter((k) => p[k]);
        console.log(`\nrole_permissions["${roleName}"]: ${trueKeys.length} permisos en true`);
        console.log('  REPORTES_VER_GLOBAL (= manage:all):', p.REPORTES_VER_GLOBAL);
        console.log('  USUARIOS_VER:', p.USUARIOS_VER);
        console.log('  REPORTES_VER_PROPIO:', p.REPORTES_VER_PROPIO);
        console.log('  keys(true):', trueKeys.length ? trueKeys.join(', ') : '(NINGUNO)');
      }
    }

    const all = await knex('role_permissions').select('role_name').orderBy('role_name');
    console.log('\nRoles en role_permissions:', all.map((r) => r.role_name).join(', '));

    // Detalle de TODAS las filas 'superadmin' (hay duplicado): tenant + count
    const sup = await knex('role_permissions').where({ role_name: 'superadmin' }).select('*');
    console.log(`\nFilas 'superadmin': ${sup.length}`);
    for (const r of sup) {
      const p = r.permissions || {};
      const n = Object.keys(p).filter((k) => p[k]).length;
      console.log(`  - id=${r.id ?? '?'} tenant_id=${r.tenant_id ?? 'NULL'} permisos_true=${n} REPORTES_VER_GLOBAL=${p.REPORTES_VER_GLOBAL ?? false} USUARIOS_VER=${p.USUARIOS_VER ?? false}`);
    }
    console.log('\nsuperoot.tenant_id =', user?.tenant_id);
  } catch (e) {
    console.error('ERR:', e.message);
  } finally {
    await knex.destroy();
  }
})();
