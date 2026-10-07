'use strict';
/**
 * Cambia la contraseña de un usuario existente en `identity.users`.
 *
 * Por qué un script y no la UI: para desbloquear un login cuando no hay
 * superadmin a mano (o la contraseña del superadmin es la que se perdió).
 * El hash es bcrypt cost 10 — el MISMO que usa `UsersService.update()`
 * (libs/trade/src/lib/users/users.service.ts) y contra el que compara
 * `AuthMtService.login()`. No cambiar el cost sin cambiar ambos.
 *
 * Corre como `postgres` (superusuario) → bypassea el RLS forzado de
 * identity.users, por eso no hace falta SET LOCAL app.tenant_id.
 *
 * Uso:
 *   node database/scripts/set-user-password.js --user=superoot                    # dry-run
 *   node database/scripts/set-user-password.js --user=superoot --password=Nueva123 --apply
 *   node database/scripts/set-user-password.js --user=superoot --apply            # genera una random
 *   node database/scripts/set-user-password.js --list                             # lista usuarios
 *
 *   # Contra otra DB (staging platform_test, prod Railway…):
 *   DATABASE_URL_NEW=postgresql://... node database/scripts/set-user-password.js --user=x --apply
 */

const path = require('path');
const crypto = require('crypto');
require('dotenv').config({ path: path.resolve(__dirname, '..', '..', '.env') });

const bcrypt = require('bcryptjs');

const arg = (name) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : undefined;
};

const DST = process.env.DATABASE_URL_NEW;
if (!DST) { console.error('Falta DATABASE_URL_NEW (revisá tu .env)'); process.exit(1); }

const APPLY = process.argv.includes('--apply');
const LIST = process.argv.includes('--list');
const USERNAME = (arg('user') || '').trim().toLowerCase();
const TENANT_SLUG = arg('tenant') || 'mega_dulces';
// El login pide minLength(6); la random se queda holgada por arriba.
const PASSWORD = arg('password') || crypto.randomBytes(9).toString('base64url');

const knex = require('knex')({ client: 'pg', connection: DST, pool: { min: 0, max: 2 } });

(async () => {
  // La tabla vivió en `public` antes de la migración a `identity`. Resolver el
  // schema en runtime evita que el script se rompa según contra qué DB corra.
  const { rows: loc } = await knex.raw(
    `SELECT table_schema FROM information_schema.tables
      WHERE table_name = 'users' AND table_schema IN ('identity','public')
      ORDER BY (table_schema = 'identity') DESC LIMIT 1`,
  );
  if (!loc.length) throw new Error('No encontré la tabla users en identity ni public.');
  const T = `${loc[0].table_schema}.users`;

  const tenant = await knex('tenants').where({ slug: TENANT_SLUG }).select('id', 'slug').first();
  if (!tenant) throw new Error(`No existe el tenant "${TENANT_SLUG}".`);

  console.log(`DB   : ${DST.replace(/:\/\/([^:]+):[^@]+@/, '://$1:***@')}`);
  console.log(`Tabla: ${T}   Tenant: ${tenant.slug}\n`);

  if (LIST || !USERNAME) {
    const users = await knex(T).where({ tenant_id: tenant.id }).whereNull('deleted_at')
      .orderBy('username').select('username', 'nombre', 'role_name', 'activo');
    console.log('USUARIO                   ROL                  ACT  NOMBRE');
    for (const u of users) {
      console.log(`${u.username.padEnd(25)} ${String(u.role_name).padEnd(20)} ${u.activo ? ' si' : ' NO'}  ${u.nombre || ''}`);
    }
    console.log(`\n${users.length} usuarios. Elegí uno con --user=<username>.`);
    return;
  }

  const user = await knex(T).where({ tenant_id: tenant.id, username: USERNAME })
    .select('id', 'username', 'nombre', 'role_name', 'activo', 'deleted_at').first();
  if (!user) throw new Error(`No existe el usuario "${USERNAME}" en el tenant ${tenant.slug}. Corré --list.`);

  console.log(`Usuario : ${user.username} (${user.nombre || 'sin nombre'}) · rol ${user.role_name} · ${user.activo ? 'activo' : 'INACTIVO'}${user.deleted_at ? ' · BORRADO' : ''}`);
  console.log(`Password: ${PASSWORD}${arg('password') ? '' : '   (generada — copiala)'}`);

  if (!APPLY) {
    console.log('\nDRY-RUN. Nada se escribió. Repetí con --apply para aplicar.');
    return;
  }

  const password_hash = await bcrypt.hash(PASSWORD, 10);
  await knex(T).where({ id: user.id }).update({ password_hash, updated_at: knex.fn.now() });

  // Releer y comparar: confirma que el hash quedó guardado y que el login va a pasar.
  const fresh = await knex(T).where({ id: user.id }).select('password_hash').first();
  const ok = await bcrypt.compare(PASSWORD, fresh.password_hash);
  console.log(ok ? '\n✅ Contraseña actualizada y verificada.' : '\n❌ Se escribió pero la verificación falló.');
  if (!ok) process.exitCode = 1;
})()
  .catch((e) => { console.error('\nERROR:', e.message); process.exitCode = 1; })
  .finally(() => knex.destroy());
