'use strict';
/**
 * Fase UN.2 — Asigna DEPARTAMENTO y PUESTO a los usuarios existentes.
 *
 * Mapeo por `role_name` (determinista y auditable). NO toca `role_name` ni el
 * JSONB de permisos: el snapshot de privilegios efectivos debe salir idéntico
 * antes y después (database/scripts/snapshot-user-privileges.js).
 *
 * Decisiones detrás del mapeo:
 *   - `colaborador` -> ruta_directa / vendedor_ruta. Confirmado por Edgar
 *     (2026-08-20): "todos los colaboradores son de ruta". Consistente con sus
 *     zonas (LA PIEDAD RD / MORELIA / ZAMORA / NACIONAL — ninguno en las zonas
 *     VECINAL) y con que cuelgan de un `supervisor_ventas`.
 *   - `supervisor_ventas` -> ruta_directa / supervisor_rd (el organigrama lo
 *     llama SUPERVISOR DE RD; los 3 tienen equipo real: 11, 5 y 4 personas).
 *   - `cajera` -> cajas / cajera. La sucursal ya está en `warehouse_code`
 *     (verificado: el prefijo del username coincide con el tercer octeto de la
 *     IP de su sucursal Kepler — 10→01, 42→02, 40→03, 44→04, 54→05).
 *   - `customer_b2b` -> externo, SIN puesto. No son empleados, son clientes del
 *     portal; un puesto del organigrama sería mentira.
 *   - `jefe_marketing` -> administracion, PUESTO EN NULL a propósito. El
 *     organigrama solo tiene `AUX. DE MKT (1)`, y bajarle el título a una
 *     persona no es una decisión que tome una migración. Pendiente de Edgar.
 *   - `repartidor` (repartidor_smoke) -> sin tocar. Es la cuenta que usa el
 *     smoke de reparto, no una persona.
 *
 * Solo escribe donde `department_code IS NULL` -> idempotente y no pisa
 * correcciones hechas a mano después.
 *
 * @param { import("knex").Knex } knex
 */

// role_name -> [department_code, position_code | null]
const MAP = {
  cajera: ['cajas', 'cajera'],
  colaborador: ['ruta_directa', 'vendedor_ruta'],
  supervisor_ventas: ['ruta_directa', 'supervisor_rd'],
  vendedor: ['ruta_directa', 'vendedor_ruta'],
  superadmin: ['sistemas', 'sistemas'],
  jefe_marketing: ['administracion', null],
  customer_b2b: ['externo', null],
};

exports.up = async function up(knex) {
  for (const [roleName, [dept, position]] of Object.entries(MAP)) {
    // El guard de puesto se arma en JS y no en SQL: un `? IS NULL` con
    // parametro nulo no le deja inferir el tipo a Postgres (42P18-ish).
    const params = [dept, position, roleName, dept];
    let positionGuard = '';
    if (position) {
      positionGuard = `AND EXISTS (SELECT 1 FROM identity.positions p
                       WHERE p.tenant_id = u.tenant_id AND p.code = ?)`;
      params.push(position);
    }
    const res = await knex.raw(
      `UPDATE identity.users u
          SET department_code = ?, position_code = ?, updated_at = now()
        WHERE lower(u.role_name) = ?
          AND u.department_code IS NULL
          AND u.deleted_at IS NULL
          AND EXISTS (SELECT 1 FROM identity.departments d
                       WHERE d.tenant_id = u.tenant_id AND d.code = ?)
          ${positionGuard}`,
      params,
    );
    console.log(`[users_assign_dept] ${roleName} -> ${dept}/${position ?? '(sin puesto)'}: ${res.rowCount ?? 0} usuarios`);
  }

  const pend = await knex.raw(
    `SELECT u.role_name, count(*) n
       FROM identity.users u
      WHERE u.deleted_at IS NULL AND u.department_code IS NULL
      GROUP BY 1 ORDER BY 2 DESC`,
  );
  for (const r of pend.rows) {
    console.log(`[users_assign_dept] SIN DEPARTAMENTO: rol ${r.role_name} — ${r.n} usuario(s)`);
  }
};

/** @param { import("knex").Knex } knex */
exports.down = async function down(knex) {
  await knex.raw(
    `UPDATE identity.users SET department_code = NULL, position_code = NULL
      WHERE lower(role_name) = ANY(?)`,
    [Object.keys(MAP)],
  );
};
