/**
 * `[ID.24.2]` — Alinear el ALCANCE con el eje. Dos bugs vivos que el eje destapó.
 *
 * Al tener por fin la columna que divide poblaciones se puede cruzar "cuál es tu
 * eje" contra "qué dice tu `role_scopes`", y sale esto:
 *
 *     eje red        →  32 personas con `zone: own` y SIN zona   → no ven nada
 *                       25 personas con `warehouse: own` y SIN sucursal → nada
 *     eje sucursal   →  28 personas con `zone: own` y SIN zona   → no ven nada
 *
 * El patrón es uno solo: **`own` en una dimensión que no es tu eje significa
 * "nada"**, porque `own` resuelve al valor de tu ficha y ahí no hay valor. Es
 * fail-closed silencioso — la persona no ve un error, ve una pantalla vacía.
 * Todavía casi no muerde porque poquísimos módulos consumen `ScopeService`
 * (`[ID.4]`: se migran de a uno), y por eso conviene arreglarlo ahora y no
 * cuando la mitad del sistema dependa de él.
 *
 * Dos correcciones, cada una en su nivel:
 *
 * **1. Los de oficina ven la red** (`role_scopes`). Para los roles cuya gente es
 * 100% de eje `red`, `zone` y `warehouse` pasan de `own` a `all`. No es una
 * ampliación inventada: es lo que `[ID.3]` ya había decidido para la población
 * administrativa ("red completa") y que quedó mal escrito. Un gerente de compras
 * con `warehouse: own` y sin sucursal no ve NINGUNA sucursal, que es lo contrario
 * de su trabajo.
 *
 * **2. A los de sucursal se les llena la zona** (`users.zona_id`). Acá el modo
 * está bien —su zona SÍ es su plaza— lo que faltaba era el valor, y desde
 * `[ID.23]` es derivable: `warehouses.zone_id`. Se corrige el DATO, no la regla.
 *
 * Lo que este parche NO toca, a propósito:
 *   - **`superadmin`**: `isPlatformAdminRole` lo resuelve como `all` antes de
 *     leer la tabla. Escribirle filas sería ruido.
 *   - **`servicio`** y **`repartidor`**: el primero no entra por login; el
 *     segundo cuelga de `logistica` (que mapeé a `red`) pero su eje real es el
 *     lugar de donde sale a repartir. Ampliarle el alcance apoyándome en una
 *     clasificación de la que no estoy seguro sería justo el tipo de decisión
 *     silenciosa que esta fase vino a eliminar. Quedan reportados.
 *   - **Eje `ruta` con `warehouse: own` sin sucursal** (31 personas): que un
 *     vendedor de ruta vea —o no— el inventario de una sucursal es una decisión
 *     de negocio, no un bug de escritura. `all` lo abriría, `none` lo cerraría
 *     explícitamente; las dos son elecciones y ninguna es obviamente correcta.
 *     Se reporta y se decide aparte.
 */

const EJE_SQL = `coalesce(ps.scope_axis, d.scope_axis)`;
const EXCLUIDOS = ['superadmin', 'admin', 'servicio', 'repartidor'];

exports.up = async function up(knex) {
  const tenants = await knex('identity.tenants').pluck('id');

  for (const tenant of tenants) {
    // ── 1. Los roles 100% de oficina ven la red ────────────────────────────
    const roles = await knex.raw(
      `WITH eje AS (
         SELECT u.role_name, ${EJE_SQL} axis
           FROM identity.users u
           LEFT JOIN identity.positions ps ON ps.tenant_id = u.tenant_id AND ps.code = u.position_code
           LEFT JOIN identity.departments d ON d.tenant_id = u.tenant_id AND d.code = u.department_code
          WHERE u.tenant_id = ? AND u.deleted_at IS NULL
       )
       SELECT role_name, count(*)::int n
         FROM eje
        WHERE lower(role_name) <> ALL(?)
        GROUP BY role_name
       HAVING count(*) = count(*) FILTER (WHERE axis = 'red')
        ORDER BY 2 DESC`,
      [tenant, EXCLUIDOS],
    );

    let corregidos = 0;
    for (const { role_name, n } of roles.rows) {
      const r = await knex('identity.role_scopes')
        .where({ tenant_id: tenant, role_name })
        .whereIn('dimension', ['warehouse', 'zone'])
        .where({ mode: 'own' })
        .update({
          mode: 'all',
          values: null,
          nota: '[ID.24.2] eje red: su alcance es la red. Con "own" y sin sucursal/zona no veia nada.',
        });
      if (r) {
        corregidos += r;
        console.log(`  [ID.24.2] ${role_name} (${n} personas): ${r} dimensión/es own → all`);
      }
    }
    if (!corregidos) console.log('  [ID.24.2] no había roles de oficina con "own" que corregir');

    // ── 2. Llenar la zona derivable de la gente de sucursal ────────────────
    const derivables = await knex.raw(
      `SELECT u.id, u.username, u.warehouse_code, w.zone_id, z.name zona
         FROM identity.users u
         JOIN commercial.warehouses w
           ON w.tenant_id = u.tenant_id AND w.code = u.warehouse_code AND w.deleted_at IS NULL
         JOIN trade.zones z ON z.tenant_id = w.tenant_id AND z.id = w.zone_id
        WHERE u.tenant_id = ? AND u.deleted_at IS NULL
          AND u.zona_id IS NULL AND w.zone_id IS NOT NULL`,
      [tenant],
    );
    for (const u of derivables.rows) {
      await knex('identity.users').where({ id: u.id }).update({ zona_id: u.zone_id });
    }
    if (derivables.rows.length) {
      console.log(
        `  [ID.24.2] ${derivables.rows.length} usuarios con zona derivada de su sucursal ` +
          `(${[...new Set(derivables.rows.map((r) => r.zona))].join(', ')})`,
      );
    }

    // ── 3. Lo que queda ciego y NO se toca: reporte explícito ──────────────
    const ciegos = await knex.raw(
      `WITH eje AS (
         SELECT u.id, u.username, u.role_name, u.warehouse_code, u.zona_id, u.route_id,
                ${EJE_SQL} axis
           FROM identity.users u
           LEFT JOIN identity.positions ps ON ps.tenant_id = u.tenant_id AND ps.code = u.position_code
           LEFT JOIN identity.departments d ON d.tenant_id = u.tenant_id AND d.code = u.department_code
          WHERE u.tenant_id = ? AND u.deleted_at IS NULL
       )
       SELECT e.axis, rs.dimension, count(*)::int n
         FROM eje e
         JOIN identity.role_scopes rs
           ON rs.tenant_id = ? AND lower(rs.role_name) = lower(e.role_name) AND rs.mode = 'own'
        WHERE (rs.dimension = 'warehouse' AND e.warehouse_code IS NULL)
           OR (rs.dimension = 'zone'      AND e.zona_id IS NULL)
           OR (rs.dimension = 'route'     AND e.route_id IS NULL)
        GROUP BY 1, 2 ORDER BY 3 DESC`,
      [tenant, tenant],
    );
    if (ciegos.rows.length) {
      console.log('  [ID.24.2] siguen con "own" sin valor propio (decisión pendiente, no bug de escritura):');
      ciegos.rows.forEach((r) =>
        console.log(`     eje ${String(r.axis ?? '—').padEnd(9)} dimensión ${String(r.dimension).padEnd(10)} ${r.n} personas`),
      );
    }
  }
};

exports.down = async function down(knex) {
  const tenants = await knex('identity.tenants').pluck('id');
  for (const tenant of tenants) {
    // Sólo revierte lo que esta migración escribió, identificado por su nota.
    await knex('identity.role_scopes')
      .where({ tenant_id: tenant })
      .whereLike('nota', '[ID.24.2]%')
      .update({ mode: 'own', nota: null });
    // La zona derivada NO se revierte: es un dato correcto que faltaba, y
    // borrarlo dejaría a esa gente peor que antes de la migración.
  }
};
