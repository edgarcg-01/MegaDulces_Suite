'use strict';
/**
 * `[RH.1.4]` Fase RH (ADR-084, D1) — lo que `identity.users` necesita para recibir el padrón de Mega
 * Talento: **las bajas sin contraseña** y **un rol para quien no tiene acceso**.
 *
 * ── Por qué, medido antes (sólo lectura) ────────────────────────────────────────────────────
 *
 *  · Mega Talento tiene 1,049 fichas en `empleados`; ~484 activas y ~565 inactivas. La asistencia
 *    necesita a las inactivas COMO PERSONAS: sin ellas no sabe que alguien está dado de baja, y la
 *    paridad de 0 diferencias (`[RH.1.8]`) se midió con las bajas presentes (estado `terminated`).
 *  · La regla `users_hash_solo_falta_si_corresponde` (`[ID.31]`, mig `20260910120000`) sólo deja
 *    faltar la contraseña a `invited` y a `servicio`. Una baja que nunca tuvo cuenta (casi todas)
 *    **no cabe**: la base la rechaza. Se agrega `terminated`.
 *  · `role_name` es NOT NULL con FK. Darle a ~500 personas sin acceso un rol de verdad (cajero,
 *    almacenista) haría que el día que alguien active su cuenta entre con permisos que nadie decidió
 *    (el rol hoy hace dos trabajos: puesto y permisos). Rol nuevo `sin_acceso`, con el mapa VACÍO y
 *    alcance `none` en todas las dimensiones (ScopeService es fail-closed).
 *
 * ── Por qué agregar `terminated` es seguro ─────────────────────────────────────────────────
 *
 *  · El login (`libs/platform-core/.../login-core.ts`) busca `activo = true` y corta antes de
 *    `bcrypt.compare` si no hay hash (`[ID.31]`). La carga deja `activo = false` en toda baja.
 *  · Una cuenta que ya tenía contraseña y se da de baja la conserva: la regla sólo AFLOJA dónde puede
 *    faltar, no borra nada.
 *
 *  · La asistencia reconoce a la promotora DE MARCA por «promotor» en el departamento
 *    (`esDeptoDePromotoria`). Sin un departamento así, las ~101 promotoras quedarían en «Tienda» y
 *    saldrían con falta todos los días. Departamento nuevo `promotoria_marca`.
 *
 * ⚠️ Decisión a confirmar con Edgar (D1): el nombre del rol y que el padrón entre como `invited`.
 * ⚠️ Crea un CHECK (objeto de esquema), así que la compuerta del despliegue sí la ve.
 *
 * Idempotente. No toca ninguna fila de usuario.
 *
 * @param { import("knex").Knex } knex
 */

const ROL = 'sin_acceso';
const DIMENSIONES = ['warehouse', 'zone', 'route', 'brand', 'customer', 'expense_area'];
const REGLA = 'users_hash_solo_falta_si_corresponde';
/** [code, nombre]. El nombre DEBE contener «promotor» y no «mega dulces» (ver `esDeptoDePromotoria`). */
const DEPTO_PROMOTORIA = ['promotoria_marca', 'Promotoría de marca'];

exports.ROL = ROL;
exports.DEPTO_PROMOTORIA = DEPTO_PROMOTORIA;

exports.up = async function up(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);

  // ── 1. La regla de contraseña acepta las bajas ─────────────────────────────────────────────
  await knex.raw(`ALTER TABLE identity.users DROP CONSTRAINT IF EXISTS ${REGLA}`);
  await knex.raw(
    `ALTER TABLE identity.users ADD CONSTRAINT ${REGLA}
       CHECK (password_hash IS NOT NULL OR kind = 'servicio' OR status IN ('invited', 'terminated'))`,
  );
  await knex.raw(
    `COMMENT ON CONSTRAINT ${REGLA} ON identity.users IS
      '[ID.31] Dejó de ser NOT NULL para que status=invited sea representable. [RH.1.4] suma terminated: las bajas del padrón de Mega Talento nunca tuvieron cuenta y la asistencia las necesita como personas. El login filtra activo=true y corta antes de bcrypt.compare con hash nulo.'`,
  );

  // ── 2. El rol sin acceso, por tenant ───────────────────────────────────────────────────────
  const { rows: tenants } = await knex.raw(
    'SELECT id, slug FROM identity.tenants WHERE activo IS NOT FALSE ORDER BY slug',
  );
  for (const t of tenants) {
    // DO NOTHING: si alguien ya lo creó (o le puso algo a propósito), no se pisa.
    await knex.raw(
      `INSERT INTO identity.role_permissions (tenant_id, role_name, permissions, kind)
       VALUES (?, ?, '{}'::jsonb, 'perfil')
       ON CONFLICT (tenant_id, role_name) DO NOTHING`,
      [t.id, ROL],
    );
    for (const dimension of DIMENSIONES) {
      await knex.raw(
        // `area = '*'` y la PK de 4 columnas: `[ZN.8]` (mig `20261001120000`).
        `INSERT INTO identity.role_scopes (tenant_id, role_name, dimension, area, mode, values, nota)
         VALUES (?, ?, ?, '*', 'none', NULL, ?)
         ON CONFLICT (tenant_id, role_name, dimension, area) DO NOTHING`,
        [t.id, ROL, dimension, '[RH.1.4] persona del padrón sin acceso: no ve nada.'],
      );
    }
  }

  // ── 3. El departamento de promotoría de marca ──────────────────────────────────────────────
  // La asistencia (`esDeptoDePromotoria`, `[RH.1.5c]`) reconoce a la promotora de marca por la
  // palabra «promotor» en el NOMBRE o CÓDIGO del departamento, y la deja fuera de la medición de piso
  // (no checa en el reloj del sitio). Mandar a las ~101 promotoras a «Tienda» —lo que proponía el doc
  // de mapeos— les haría salir con falta todos los días. Copia el eje de alcance de `tienda`.
  for (const t of tenants) {
    await knex.raw(
      `INSERT INTO identity.departments (tenant_id, code, name, orden, scope_axis)
       SELECT ?, ?, ?, 120, (SELECT scope_axis FROM identity.departments WHERE tenant_id = ? AND code = 'tienda')
       ON CONFLICT (tenant_id, code) DO NOTHING`,
      [t.id, DEPTO_PROMOTORIA[0], DEPTO_PROMOTORIA[1], t.id],
    );
  }

  // ── Compuertas ─────────────────────────────────────────────────────────────────────────────
  const { rows } = await knex.raw(
    `SELECT pg_get_constraintdef(c.oid) AS def
       FROM pg_constraint c
      WHERE c.conrelid = 'identity.users'::regclass AND c.conname = ?`,
    [REGLA],
  );
  if (!rows[0] || !/terminated/.test(rows[0].def)) {
    throw new Error(`[RH.1.4] la regla ${REGLA} no quedó aceptando terminated.`);
  }
  const { rows: rol } = await knex.raw(
    `SELECT count(*)::int AS n,
            count(*) FILTER (WHERE permissions <> '{}'::jsonb)::int AS con_permisos
       FROM identity.role_permissions WHERE role_name = ? AND deleted_at IS NULL`,
    [ROL],
  );
  if (rol[0].n < tenants.length) {
    throw new Error(`[RH.1.4] el rol ${ROL} quedó en ${rol[0].n} de ${tenants.length} tenants.`);
  }
  if (rol[0].con_permisos) {
    console.log(`  ⚠️ el rol ${ROL} ya existía CON permisos en ${rol[0].con_permisos} tenant(s) — no se pisó. Revisar.`);
  }
  console.log(`  ✓ ${REGLA} acepta terminated · rol ${ROL} en ${tenants.length} tenant(s), sin permisos.`);
};

/** Deshace EXACTAMENTE lo que hizo el `up`, ni una fila más. */
exports.down = async function down(knex) {
  const { rows } = await knex.raw(
    `SELECT count(*)::int AS n FROM identity.users
      WHERE password_hash IS NULL AND status = 'terminated' AND kind <> 'servicio'`,
  );
  if (rows[0].n) {
    throw new Error(`[RH.1.4] hay ${rows[0].n} baja(s) sin contraseña: la regla vieja no las acepta. Revertir la carga primero.`);
  }
  await knex.raw(`ALTER TABLE identity.users DROP CONSTRAINT IF EXISTS ${REGLA}`);
  await knex.raw(
    `ALTER TABLE identity.users ADD CONSTRAINT ${REGLA}
       CHECK (password_hash IS NOT NULL OR kind = 'servicio' OR status = 'invited')`,
  );
  // El departamento sólo se quita si nadie lo usa (la FK es SET NULL: borrarlo con gente adentro
  // les quitaría el departamento en silencio).
  await knex.raw(
    `DELETE FROM identity.departments d WHERE d.code = ?
        AND NOT EXISTS (SELECT 1 FROM identity.users u WHERE u.tenant_id = d.tenant_id AND u.department_code = d.code)
        AND NOT EXISTS (SELECT 1 FROM identity.positions p WHERE p.tenant_id = d.tenant_id AND p.department_code = d.code)`,
    [DEPTO_PROMOTORIA[0]],
  );
  // FK RESTRICT: si alguien tiene el rol, el DELETE falla y lo dice.
  await knex.raw('DELETE FROM identity.role_scopes WHERE role_name = ?', [ROL]);
  await knex.raw(`DELETE FROM identity.role_permissions WHERE role_name = ? AND permissions = '{}'::jsonb`, [ROL]);
};
