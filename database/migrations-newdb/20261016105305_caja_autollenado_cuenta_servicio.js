'use strict';
/**
 * `[CG.190]` — La cuenta de SERVICIO con la que el autollenado firma lo que registra.
 *
 * Pedido de Edgar (2026-10-16): *«nada de registrar movimientos a mano… automatiza el 100 % del
 * llenado de los movimientos pasados, actuales y futuros»*. El motor que lo hace
 * (`CajaAutollenadoService`) escribe en `finance.cash_ledger` por el MISMO camino que la persona
 * —`CashLedgerService.crearLote()`—, y ese camino exige un usuario: `created_by` es `NOT NULL`.
 *
 * ⛔ **Por qué una cuenta propia y no `superoot`.** Si el motor firma con la cuenta de una persona,
 * el libro deja de poder contestar *«¿esto lo capturó alguien o lo puso la máquina?»*, y esa
 * pregunta es la que vuelve auditable al autollenado: la tasa de corrección por fuente (ADR-070
 * §8.5 regla 4) se mide separando las dos poblaciones. Mezclarlas la borra.
 *
 * ── Lo medido antes (sólo lectura contra pg-prod, `system_identifier 7688376744939610156`) ──
 *  · `identity.users` ya tiene la convención: `svc_feeds` · `kind='servicio'` ·
 *    `role_name='servicio'`, con `password_hash` NULL. El CHECK
 *    `users_hash_solo_falta_si_corresponde` **permite** el hash NULL exactamente para
 *    `kind='servicio'` — o sea que la cuenta NO puede autenticarse, que es lo que se quiere.
 *  · `role_name` tiene FK (`fk_users_tenant_role` → `identity.role_permissions`), así que el rol
 *    se reusa, no se inventa: `servicio` ya existe porque `svc_feeds` lo usa.
 *  · `finance.cash_ledger.created_by` es `uuid NOT NULL` y **no** tiene FK a `identity.users`,
 *    pero la pantalla resuelve el nombre contra esa tabla: sin la fila, el libro mostraría un
 *    UUID crudo en cada movimiento automático.
 *
 * ⚠️ Esta migración sólo hace INSERT: la compuerta del despliegue la clasifica **NO_MEDIDO**.
 *    Aplicar a prod ANTES de que el código nuevo corra (si no, el primer `crearLote()` del motor
 *    escribe un `created_by` que nadie puede resolver a un nombre).
 *
 * Idempotente.
 *
 * @param { import("knex").Knex } knex
 */

const TENANT = '00000000-0000-0000-0000-00000000d01c';
/** Fijo y legible a propósito: se cita en el libro, en los logs y en las pruebas. */
const SVC_ID = '00000000-0000-0000-0000-0000000ca11e';
const SVC_USERNAME = 'svc_caja_autollenado';

exports.up = async function up(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);

  // El rol se COPIA del que ya usa la otra cuenta de servicio en vez de escribirse a mano: si
  // mañana el catálogo de roles cambia de nombre, esto sigue apuntando a uno que existe. Si no
  // hubiera ninguna cuenta de servicio todavía, cae a 'servicio', que es el valor medido hoy.
  const { rows } = await knex.raw(
    `SELECT role_name FROM identity.users
      WHERE tenant_id = ? AND kind = 'servicio' AND role_name IS NOT NULL
      ORDER BY created_at LIMIT 1`, [TENANT]);
  const role = rows?.[0]?.role_name || 'servicio';

  await knex.raw(
    `INSERT INTO identity.users (id, tenant_id, username, role_name, kind, status, activo,
                                 password_hash, must_change_password)
          VALUES (?, ?, ?, ?, 'servicio', 'active', true, NULL, false)
     ON CONFLICT (id) DO NOTHING`,
    [SVC_ID, TENANT, SVC_USERNAME, role]);

  // ⚠️ `ON CONFLICT (id)` no cubre el caso de que alguien ya haya creado el MISMO username con
  // otro id: ahí el índice único de username tiraría. Se verifica y se declara en vez de
  // tragárselo, porque dos cuentas con el mismo nombre harían ilegible la autoría del libro.
  const dup = await knex.raw(
    `SELECT id::text FROM identity.users WHERE tenant_id = ? AND username = ? AND id <> ?`,
    [TENANT, SVC_USERNAME, SVC_ID]);
  if (dup.rows?.length) {
    throw new Error(
      `[CG.190] Ya existe '${SVC_USERNAME}' con otro id (${dup.rows[0].id}). `
      + 'Resolver a mano cuál queda antes de aplicar: dos cuentas con el mismo nombre dejan '
      + 'el libro sin poder decir quién registró cada movimiento.');
  }
};

/** Deshace EXACTAMENTE lo que hizo el `up`, ni una fila más. */
exports.down = async function down(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);
  // ⛔ Sólo se borra si NO firmó nada. Una cuenta que ya tiene movimientos a su nombre no se
  // puede quitar sin dejar el libro con una autoría que no resuelve — y el movimiento, que es
  // dinero registrado, se queda.
  const { rows } = await knex.raw(
    `SELECT count(*)::int AS n FROM finance.cash_ledger WHERE created_by = ?`, [SVC_ID]);
  if (Number(rows?.[0]?.n || 0) > 0) return;
  await knex.raw(`DELETE FROM identity.users WHERE id = ?`, [SVC_ID]);
};
