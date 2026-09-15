/**
 * `[AU.24]` — Un almacenista quedó con `superadmin` por un error de captura, y
 * el backfill de puestos lo propagó.
 *
 * ── Cómo apareció ─────────────────────────────────────────────────────────
 *
 * Cruzando el organigrama de MDTask (`[AU.23]`) contra el padrón: la nómina
 * pone a **Luis Ángel Hernández Chávez como Almacenista de 8 Esquinas** y la
 * ficha decía `role_name = superadmin`, puesto `sistemas`.
 *
 * ── Que fue un error de captura no es interpretación, está medido ─────────
 *
 * La noche del 2026-07-13 se dieron de alta cuatro fichas seguidas:
 *
 *   21:14  rafael_quirino   compras       comprador
 *   21:18  luis_hernandez   superadmin    sistemas      ← ésta
 *   21:20  luis_navarro     almacenista   almacenista
 *   21:21  brian_zavala     almacenista   almacenista
 *
 * Los tres almacenistas de esa sesión llevan el mismo rol menos uno. Y
 * `superadmin` son **170 permisos** contra los **3** de `almacenista`.
 *
 * ⚠️ **La segunda mitad es nuestra.** El puesto `sistemas` no lo eligió nadie:
 * se lo puso el backfill `[OR.1c]`, cuyo criterio guardado es «único puesto del
 * departamento cuyo default_role coincide». Derivar el puesto del rol es
 * correcto cuando el rol es correcto; con un rol mal capturado, el backfill
 * convierte un error de un campo en un error de dos. Es la forma de ADR-056:
 * un dato que no se pudo verificar se dio por bueno en vez de declararse.
 *
 * ── Por qué se corrige por migración y no desde la pantalla ───────────────
 *
 * La regla del proyecto es administrar desde la UI. Acá no aplica todavía: la
 * ficha de `/admin/personas` con el editor de acceso **no está desplegada**
 * (`[AU.10]`/`[AU.22]` esperan el redeploy), y dejar 170 permisos vivos hasta
 * entonces no se justifica. La cuenta **nunca inició sesión**, así que bajarle
 * privilegios no puede romper nada en curso.
 *
 * ⛔ Lo que NO se toca: las otras 8 cuentas `superadmin`. Dos son jefes de zona
 * (`aaron_alejo`, `ramon_rodriguez`) y eso necesita decisión de Edgar, no una
 * migración — sobre todo porque la tercera jefa de zona (`ivette_cruz`) NO lo
 * tiene, y esa asimetría hay que resolverla a propósito. Tampoco se toca
 * `rep_prueba`, que sí tuvo sesión y merece firma antes de darse de baja.
 */

const USUARIO = 'luis_hernandez';
const ROL_DESTINO = 'almacenista';
const PUESTO_DESTINO = 'almacenista';

exports.up = async function up(knex) {
  const { rows } = await knex.raw(
    `SELECT id, tenant_id, role_name, position_code, last_login_at
       FROM identity.users WHERE username = ? AND deleted_at IS NULL`,
    [USUARIO],
  );
  if (!rows.length) {
    console.log('[AU.24] no existe ' + USUARIO + ' — nada que hacer.');
    return;
  }
  const u = rows[0];

  // Idempotente: si otra sesión ya lo corrigió, no se pisa.
  if (u.role_name !== 'superadmin') {
    console.log('[AU.24] ' + USUARIO + ' ya no es superadmin (rol=' + u.role_name + ') — nada que hacer.');
    return;
  }

  // ⛔ El argumento para corregir sin firma es que la cuenta nunca se usó. Si
  //    dejó de ser cierto entre la medición y la corrida, se para y se avisa:
  //    bajarle 167 permisos a alguien que está trabajando es otra decisión.
  if (u.last_login_at) {
    throw new Error(
      '[AU.24] ABORTA: ' + USUARIO + ' inició sesión el ' + u.last_login_at.toISOString().slice(0, 10) +
        '. Se midió como cuenta nunca usada; dejó de serlo. Decidilo desde la pantalla.',
    );
  }

  const { rows: rol } = await knex.raw(
    'SELECT 1 FROM identity.role_permissions WHERE tenant_id = ? AND role_name = ?',
    [u.tenant_id, ROL_DESTINO],
  );
  if (!rol.length) throw new Error('[AU.24] ABORTA: no existe el rol ' + ROL_DESTINO + ' en este tenant.');

  const { rows: pue } = await knex.raw(
    'SELECT 1 FROM identity.positions WHERE tenant_id = ? AND code = ? AND deleted_at IS NULL',
    [u.tenant_id, PUESTO_DESTINO],
  );
  if (!pue.length) throw new Error('[AU.24] ABORTA: no existe el puesto ' + PUESTO_DESTINO + '.');

  const antes = (
    await knex.raw(
      "SELECT count(*)::int AS n FROM identity.users WHERE deleted_at IS NULL AND role_name = 'superadmin'",
    )
  ).rows[0].n;

  await knex.raw(
    `UPDATE identity.users
        SET role_name = ?, position_code = ?, updated_at = now()
      WHERE id = ?`,
    [ROL_DESTINO, PUESTO_DESTINO, u.id],
  );

  // La bitácora lleva el motivo, no sólo el cambio: el próximo que lea la ficha
  // tiene que poder saber por qué se movió sin reconstruir esta investigación.
  await knex.raw(
    `INSERT INTO identity.user_events (tenant_id, user_id, event, detalle, actor_username)
     VALUES (?, ?, 'puesto_asignado', ?::jsonb, 'migracion [AU.24]')`,
    [
      u.tenant_id,
      u.id,
      JSON.stringify({
        position_code: PUESTO_DESTINO,
        department_code: 'almacen',
        origen: 'correccion [AU.24]',
        criterio:
          'La nomina lo pone como Almacenista de 8 Esquinas. El rol superadmin vino de un error de captura del 2026-07-13 (4 altas seguidas, sus dos pares quedaron en almacenista) y el puesto sistemas lo derivo el backfill [OR.1c] a partir de ese rol. Cuenta sin ninguna sesion.',
        rol_anterior: 'superadmin',
        puesto_anterior: u.position_code,
      }),
    ],
  );

  const despues = (
    await knex.raw(
      "SELECT count(*)::int AS n FROM identity.users WHERE deleted_at IS NULL AND role_name = 'superadmin'",
    )
  ).rows[0].n;
  if (despues !== antes - 1) {
    throw new Error('[AU.24] ABORTA: superadmin ' + antes + ' -> ' + despues + ', se esperaba ' + (antes - 1) + '.');
  }

  const ver = (
    await knex.raw('SELECT role_name, position_code FROM identity.users WHERE id = ?', [u.id])
  ).rows[0];
  if (ver.role_name !== ROL_DESTINO || ver.position_code !== PUESTO_DESTINO) {
    throw new Error('[AU.24] ABORTA: la ficha quedó en rol=' + ver.role_name + ' puesto=' + ver.position_code + '.');
  }

  console.log(
    '[AU.24] ' + USUARIO + ': superadmin -> ' + ROL_DESTINO + ', puesto ' + u.position_code +
      ' -> ' + PUESTO_DESTINO + '. Cuentas superadmin: ' + antes + ' -> ' + despues + '.',
  );
};

exports.down = async function down(knex) {
  // Se devuelve el estado exacto que había, pero el evento de bitácora se
  // conserva: la investigación pasó y borrarla sería fingir que no.
  const { rows } = await knex.raw(
    'SELECT id, tenant_id FROM identity.users WHERE username = ? AND deleted_at IS NULL',
    [USUARIO],
  );
  if (!rows.length) return;
  await knex.raw(
    `UPDATE identity.users SET role_name = 'superadmin', position_code = 'sistemas', updated_at = now()
      WHERE id = ?`,
    [rows[0].id],
  );
  console.log('[AU.24] revertido: ' + USUARIO + ' vuelve a superadmin/sistemas.');
};
