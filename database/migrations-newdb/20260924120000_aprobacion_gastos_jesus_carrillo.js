/**
 * `[GX.17]` — **Quién da luz verde a un gasto.**
 *
 * La sección de gastos se parte en dos: *Gastos* (todos capturan forma de pago + foto) y
 * *Aprobación de gastos* (sólo cuatro personas autorizan). Las cuatro, decididas directo
 * con el usuario:
 *
 * | Persona | Usuario | Rol | ¿Ya podía? |
 * |---|---|---|---|
 * | Luis Francisco López | `superuser` | `superadmin` | ✅ god-mode |
 * | Guillermo López Gutiérrez | `guillermo_lopez` | `superadmin` | ✅ god-mode |
 * | María de la Paz Gutiérrez | `maria_gutierrez` | `tesoreria` | ✅ por su rol |
 * | Juan Jesús Carrillo | `jesus_carrillo` | `finanzas_operativo` | ❌ **le faltaba** |
 *
 * ## ⚠️ Por qué va por PERSONA y no por rol
 * Medido en `platform_test` el 2026-09-24: `FINANCE_EXPENSES_COMPROBAR` hoy lo concede **un
 * solo rol**, `tesoreria`, que tiene **exactamente una persona** (María). O sea que la lista
 * de quién firma ya era casi la pedida.
 *
 * El rol de Jesús, `finanzas_operativo`, lo comparten **6 personas activas**. Dárselo al rol
 * le habría dado la firma a **5 personas más que nadie nombró** — y aprobar un gasto es
 * mover dinero. Por eso va como override de persona en `identity.user_permissions`, que es
 * el mecanismo que el propio repo señala para este caso (ver el comentario de
 * `20260911090000_grant_catalogo_interno_administrativo_piso_tienda.js`).
 *
 * ⛔ **No se crea un permiso nuevo.** `FINANCE_EXPENSES_COMPROBAR` ya existe y ya gatea
 * `approve` / `validate` / `reject` desde GX.7. Inventar `FINANCE_EXPENSES_APROBAR` habría
 * dejado dos llaves para la misma puerta.
 *
 * Idempotente: `ON CONFLICT DO NOTHING` sobre la PK. **No** pisa un `allow = false` puesto a
 * mano desde `/admin/usuarios` — si alguien se lo quitó a propósito, se respeta.
 *
 * ⚠️ Requiere **RE-LOGIN de Jesús**: los permisos viajan en el JWT y el token ya emitido no
 * los trae.
 *
 * @param { import("knex").Knex } knex
 */

const USERNAME = 'jesus_carrillo';
const CLAVE = 'FINANCE_EXPENSES_COMPROBAR';

exports.up = async function (knex) {
  // La tabla llegó con `[ID.21]`. Si el entorno es anterior, no se inventa nada: se avisa.
  const hay = await knex.schema.withSchema('identity').hasTable('user_permissions');
  if (!hay) {
    console.log('[gx17_aprobacion] identity.user_permissions no existe — nada que hacer');
    return;
  }

  const u = await knex('users').where({ username: USERNAME }).whereNull('deleted_at')
    .first('id', 'tenant_id', 'nombre', 'role_name');
  if (!u) {
    // No se falla: un entorno puede no tener a esta persona (local, una copia vieja). Lo que
    // no se hace es fingir que se aplicó.
    console.log(`[gx17_aprobacion] no existe el usuario ${USERNAME} en este entorno — se omite`);
    return;
  }

  const res = await knex.raw(
    `INSERT INTO identity.user_permissions (tenant_id, user_id, permission_key, allow, nota)
     VALUES (?, ?, ?, true, ?)
     ON CONFLICT (tenant_id, user_id, permission_key) DO NOTHING`,
    [u.tenant_id, u.id, CLAVE,
      '[GX.17] Aprobación de gastos. Por persona y no por su rol: finanzas_operativo lo comparten 6 y sólo él fue nombrado.'],
  );
  console.log(`[gx17_aprobacion] up: ${CLAVE} → ${u.nombre} (${USERNAME}, rol ${u.role_name}) · filas = ${res.rowCount ?? 0}`);
};

/** @param { import("knex").Knex } knex */
exports.down = async function (knex) {
  const hay = await knex.schema.withSchema('identity').hasTable('user_permissions');
  if (!hay) return;
  const u = await knex('users').where({ username: USERNAME }).first('id', 'tenant_id');
  if (!u) return;
  await knex('identity.user_permissions')
    .where({ tenant_id: u.tenant_id, user_id: u.id, permission_key: CLAVE })
    .del();
  console.log(`[gx17_aprobacion] down: ${CLAVE} retirado de ${USERNAME}`);
};
