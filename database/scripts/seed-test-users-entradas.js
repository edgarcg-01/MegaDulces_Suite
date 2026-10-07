/**
 * [RE.16] Usuarios de prueba para recorrer el proceso de facturas de entrada, uno por oficio.
 * Existen para probar la UI y los 403 sin tener que pedirle la contraseña a nadie ni tocar la
 * cuenta de una persona real.
 *
 *   test_sucursal    auxiliar_tienda   suc 02      VER + GESTIONAR            (sube, NO valida)
 *   test_revisor     encargado_tienda  suc 02      VER + GESTIONAR + VALIDAR  (decide, su sucursal)
 *   test_admin       compras           red         VER + GESTIONAR + VALIDAR  (observa toda la red)
 *   test_supervisor  direccion         suc 02+03   VER                        (observa, NO toca)
 *
 * Los roles NO se inventan: son los mismos que ya usan las personas reales, así que el permiso
 * y el alcance que se prueban son los de producción, no una maqueta.
 *
 * `[RE.16.9]` **El supervisor del capturista no tiene pantalla propia**: es el Centro de control
 * recortado por alcance. Se arma con dos piezas que ya existen y ninguna es código nuevo —
 * un rol que sólo VE (`direccion` ya lo era: VER sí, GESTIONAR/VALIDAR no) y un alcance
 * `listed` con sus sucursales. Por eso este script escribe `identity.user_scopes`: el permiso
 * se edita en `/admin/roles/:rol/permissions`, pero el ALCANCE todavía no tiene UI (ID.9).
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

// `scope` (opcional) = override por usuario en `identity.user_scopes`, dimensión `warehouse`.
// Sin él, manda el `role_scopes` del rol: `own` = la sucursal de su ficha · `all` = la red.
const USUARIOS = [
  { username: 'test_sucursal',   nombre: 'Prueba · Sucursal (sube)',       role_name: 'auxiliar_tienda',  warehouse_code: '02' },
  { username: 'test_revisor',    nombre: 'Prueba · Revisor (decide)',      role_name: 'encargado_tienda', warehouse_code: '02' },
  { username: 'test_admin',      nombre: 'Prueba · Centro de control',     role_name: 'compras',          warehouse_code: null },
  // El supervisor de varias sucursales es el caso que `own` no puede expresar: su ficha tiene
  // UNA sucursal y él responde por dos. De ahí `listed`. `mode_write: 'none'` es el cinturón:
  // aunque mañana el rol gane GESTIONAR, este usuario sigue sin poder escribir en ninguna.
  { username: 'test_supervisor', nombre: 'Prueba · Supervisor (observa)',  role_name: 'direccion',        warehouse_code: '02',
    scope: { mode: 'listed', values: ['02', '03'], mode_write: 'none', nota: 'RE.16.9 — supervisa 02 y 03; observa, no captura.' } },
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
    // `user_scopes` se va sola: su FK a `identity.users` es ON DELETE CASCADE.
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

    // Alcance por usuario. Sólo se escribe si el usuario lo declara: dejar la fila afuera NO es
    // lo mismo que ponerla en `all` — sin fila manda el rol, que es como está configurada la
    // gente real. Y si se le quitó del script, se borra: el override no puede sobrevivir a que
    // ya nadie lo pida.
    const usuario = await knex('identity.users')
      .where({ tenant_id: TENANT, username: u.username }).first('id');
    if (u.scope) {
      await knex('identity.user_scopes')
        .insert({
          tenant_id: TENANT, user_id: usuario.id, dimension: 'warehouse',
          mode: u.scope.mode, values: u.scope.values ?? null,
          mode_write: u.scope.mode_write ?? null, nota: u.scope.nota ?? null,
        })
        .onConflict(['tenant_id', 'user_id', 'dimension'])
        .merge(['mode', 'values', 'mode_write', 'nota', 'updated_at']);
    } else {
      await knex('identity.user_scopes')
        .where({ tenant_id: TENANT, user_id: usuario.id, dimension: 'warehouse' }).del();
    }
  }

  const r = await knex('identity.users AS u')
    .leftJoin('identity.user_scopes AS s', function () {
      this.on('s.tenant_id', 'u.tenant_id').andOn('s.user_id', 'u.id').andOnVal('s.dimension', 'warehouse');
    })
    .where({ 'u.tenant_id': TENANT }).whereIn('u.username', nombres)
    .select('u.username', 'u.role_name', 'u.warehouse_code', 'u.activo')
    .select(knex.raw(`COALESCE(s.mode || COALESCE(' ' || array_to_string(s.values, '+'), ''), '(del rol)') AS alcance`))
    .orderBy('u.username');
  console.table(r);
  console.log(`\nPassword de los ${USUARIOS.length}: ${PASSWORD}`);
  console.log('Alcance efectivo: test_sucursal y test_revisor ven SÓLO la 02 · test_supervisor ve 02+03 sin poder tocar · test_admin ve la red.');
  await knex.destroy();
})().catch((e) => { console.error('ERROR:', e.message); process.exit(1); });
