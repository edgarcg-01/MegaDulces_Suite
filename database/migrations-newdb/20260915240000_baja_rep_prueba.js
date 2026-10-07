/**
 * `[AU.27]` — `rep_prueba` («REPARTIDOR PRUEBA») deja de estar activa en producción.
 *
 * Salió del cruce MDTask↔padrón: es una de las seis cuentas internas que no
 * corresponden a una persona. A diferencia de las otras cinco (`superoot`,
 * `superuser`, `ruta_505`, y dos cajas de tienda), ésta no tiene ninguna
 * función: el nombre dice lo que es.
 *
 * ── Por qué ésta sí y las otras no ────────────────────────────────────────
 *
 * Porque se midió qué deja atrás, y no deja nada:
 *   · `commercial.orders.created_by` → **0**
 *   · `identity.user_scopes` → **0**
 *   · `identity.user_events` → 2 (quedan; la bitácora es append-only y borrar
 *     el rastro de una cuenta que existió sería fingir que no existió)
 *
 * `superoot` y `superuser` son cuentas de plataforma en uso diario. `ruta_505`
 * es la que Edgar tiene que decidir si es tableta o persona. Las dos cajas
 * (`10aux`, `10c03`) tienen nombre de pila y las usa una tienda.
 *
 * ── Baja blanda, no DELETE ────────────────────────────────────────────────
 *
 * `deleted_at` + `status='terminated'`. Un DELETE se llevaría los 2 eventos y,
 * si mañana aparece una FK nueva que la referencia, dejaría un hueco. La ficha
 * deja de contar en el padrón (`[AU.12]` ya hace que `findAll` filtre
 * `deleted_at`) y deja de poder iniciar sesión.
 */

const USUARIO = 'rep_prueba';

exports.up = async function up(knex) {
  const { rows } = await knex.raw(
    `SELECT id, tenant_id, nombre, status, last_login_at
       FROM identity.users WHERE username = ? AND deleted_at IS NULL`,
    [USUARIO],
  );
  if (!rows.length) {
    console.log('[AU.27] ' + USUARIO + ' ya no está activa — nada que hacer.');
    return;
  }
  const u = rows[0];

  // ⛔ Se midió que no deja nada atrás. Si dejó de ser cierto, se para: dar de
  //    baja una cuenta que quedó atada a un pedido real es otra decisión.
  const { rows: dep } = await knex.raw(
    `SELECT (SELECT count(*)::int FROM commercial.orders WHERE created_by = ?) AS pedidos,
            (SELECT count(*)::int FROM identity.user_scopes WHERE user_id = ?) AS alcances`,
    [u.id, u.id],
  );
  if (dep[0].pedidos || dep[0].alcances) {
    throw new Error(
      '[AU.27] ABORTA: ' + USUARIO + ' tiene ' + dep[0].pedidos + ' pedido(s) y ' +
        dep[0].alcances + ' regla(s) de alcance. Se midió en 0 y 0; dejó de ser una cuenta vacía.',
    );
  }

  // ⚠️ Y que el nombre siga diciendo lo que decía: si alguien reutilizó la
  //    cuenta para una persona real, el nombre es lo primero que cambia.
  if (!/prueba|test/i.test(u.nombre || '')) {
    throw new Error(
      '[AU.27] ABORTA: la cuenta ahora se llama "' + u.nombre + '". Se identificó por ser ' +
        '«REPARTIDOR PRUEBA»; si es de alguien, la baja se decide con nombre y apellido.',
    );
  }

  const antes = (
    await knex.raw(
      "SELECT count(*)::int AS n FROM identity.users WHERE deleted_at IS NULL AND kind = 'interno'",
    )
  ).rows[0].n;

  await knex.raw(
    `UPDATE identity.users
        SET deleted_at = now(), status = 'terminated', activo = false, updated_at = now()
      WHERE id = ?`,
    [u.id],
  );

  await knex.raw(
    `INSERT INTO identity.user_events (tenant_id, user_id, event, detalle, actor_username)
     VALUES (?, ?, 'baja', ?::jsonb, 'migracion [AU.27]')`,
    [
      u.tenant_id,
      u.id,
      JSON.stringify({
        origen: 'cruce organigrama MDTask [AU.27]',
        criterio:
          'Cuenta de prueba activa en produccion. Medido antes de la baja: 0 pedidos, 0 reglas de alcance, ' +
          'ultima sesion ' + (u.last_login_at ? u.last_login_at.toISOString().slice(0, 10) : 'ninguna') + '. ' +
          'Baja blanda: los eventos se conservan.',
        status_anterior: u.status,
      }),
    ],
  );

  const despues = (
    await knex.raw(
      "SELECT count(*)::int AS n FROM identity.users WHERE deleted_at IS NULL AND kind = 'interno'",
    )
  ).rows[0].n;
  if (despues !== antes - 1) {
    throw new Error('[AU.27] ABORTA: internos ' + antes + ' -> ' + despues + ', se esperaba ' + (antes - 1) + '.');
  }

  const { rows: ver } = await knex.raw(
    'SELECT deleted_at, status FROM identity.users WHERE id = ?',
    [u.id],
  );
  if (!ver[0].deleted_at || ver[0].status !== 'terminated') {
    throw new Error('[AU.27] ABORTA: la ficha quedó en status=' + ver[0].status + '.');
  }

  console.log('[AU.27] ' + USUARIO + ' dada de baja. Internos activos: ' + antes + ' -> ' + despues + '.');
};

exports.down = async function down(knex) {
  await knex.raw(
    `UPDATE identity.users
        SET deleted_at = NULL, status = 'active', activo = true, updated_at = now()
      WHERE username = ?`,
    [USUARIO],
  );
  console.log('[AU.27] revertido: ' + USUARIO + ' vuelve a estar activa.');
};
