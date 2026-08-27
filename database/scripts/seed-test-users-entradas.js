/**
 * [RE.16] Tres usuarios de prueba para recorrer el proceso de facturas de entrada, uno por
 * oficio. Existen para probar la UI y los 403 sin tener que pedirle la contraseña a nadie ni
 * tocar la cuenta de una persona real.
 *
 *   test_sucursal  auxiliar_tienda   suc 02   VER + GESTIONAR            (sube, NO valida)
 *   test_revisor   encargado_tienda  suc 02   VER + GESTIONAR + VALIDAR  (decide, su sucursal)
 *   test_admin     compras           red      VER + GESTIONAR + VALIDAR  (observa toda la red)
 *
 * Los roles NO se inventan: son los mismos que ya usan las personas reales, así que el permiso
 * y el alcance que se prueban son los de producción, no una maqueta.
 *
 * **Password conocido a propósito** — por eso el script se niega a correr contra una base que
 * no sea local/LAN. Un usuario con contraseña publicada en el repo no puede existir en prod.
 *
 * Uso:
 *   node database/scripts/seed-test-users-entradas.js            # crea o actualiza
 *   node database/scripts/seed-test-users-entradas.js --borrar   # los saca
 */
require('dotenv').config();
const bcrypt = require('bcryptjs');

const TENANT = '00000000-0000-0000-0000-00000000d01c'; // mega_dulces
const PASSWORD = 'Prueba.2026';

const USUARIOS = [
  { username: 'test_sucursal', nombre: 'Prueba · Sucursal (sube)',    role_name: 'auxiliar_tienda',  warehouse_code: '02' },
  { username: 'test_revisor',  nombre: 'Prueba · Revisor (decide)',   role_name: 'encargado_tienda', warehouse_code: '02' },
  { username: 'test_admin',    nombre: 'Prueba · Centro de control',  role_name: 'compras',          warehouse_code: null },
];

const url = process.env.DATABASE_URL_NEW;
if (!url) { console.error('Falta DATABASE_URL_NEW en el .env'); process.exit(1); }

// Guarda de seguridad: estas credenciales están escritas en el repo. Si la URL apunta a algo
// que huela a Railway/nube, se aborta — el daño de crear esto en prod no se deshace con un
// `--borrar` corrido tarde.
if (/rlwy|railway|proxy\.|\.app\b|amazonaws|neon\.tech/i.test(url)) {
  console.error('ABORTA: DATABASE_URL_NEW no parece una base local/LAN.');
  console.error('Este script crea usuarios con password conocido; nunca en un entorno remoto.');
  process.exit(1);
}

const knex = require('knex')({ client: 'pg', connection: url });
const borrar = process.argv.includes('--borrar');

(async () => {
  const nombres = USUARIOS.map((u) => u.username);

  if (borrar) {
    const n = await knex('identity.users').where({ tenant_id: TENANT }).whereIn('username', nombres).del();
    console.log(`Borrados ${n} usuarios de prueba.`);
    await knex.destroy();
    return;
  }

  // Los roles tienen que existir: si alguien los renombró (pasó con
  // encargado_sucursal → encargado_tienda), mejor fallar diciendo cuál falta que crear un
  // usuario con un rol inválido y que el login reviente por FK.
  const roles = [...new Set(USUARIOS.map((u) => u.role_name))];
  const hay = await knex('identity.role_permissions')
    .where({ tenant_id: TENANT }).whereIn('role_name', roles).pluck('role_name');
  const faltan = roles.filter((r) => !hay.includes(r));
  if (faltan.length) {
    console.error(`ABORTA: estos roles no existen en el tenant: ${faltan.join(', ')}`);
    console.error('Revisá cómo se llaman hoy en identity.role_permissions y ajustá el script.');
    process.exit(1);
  }

  const password_hash = await bcrypt.hash(PASSWORD, 10);

  for (const u of USUARIOS) {
    await knex('identity.users')
      .insert({
        tenant_id: TENANT,
        username: u.username,
        password_hash,
        nombre: u.nombre,
        role_name: u.role_name,
        warehouse_code: u.warehouse_code,
        activo: true,
        status: 'active',
        must_change_password: false,
        kind: 'interno',
        created_by: null,
      })
      .onConflict(['tenant_id', 'username'])
      // Re-correrlo restablece el password y el alcance: es la forma de recuperarlos si alguien
      // los toqueteó desde /admin/usuarios probando.
      .merge(['password_hash', 'nombre', 'role_name', 'warehouse_code', 'activo', 'status', 'must_change_password', 'deleted_at']);
  }

  const r = await knex('identity.users')
    .where({ tenant_id: TENANT }).whereIn('username', nombres)
    .select('username', 'role_name', 'warehouse_code', 'activo')
    .orderBy('username');
  console.table(r);
  console.log(`\nPassword de los tres: ${PASSWORD}`);
  console.log('Alcance efectivo: test_sucursal y test_revisor ven SÓLO la sucursal 02; test_admin ve la red.');
  await knex.destroy();
})().catch((e) => { console.error('ERROR:', e.message); process.exit(1); });
