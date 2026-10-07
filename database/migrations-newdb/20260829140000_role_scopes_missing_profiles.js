/**
 * `[ID.21.1]` — Los 3 perfiles de `[ID.17]` se quedaron sin alcance.
 *
 * Lo encontró el smoke `test-newdb-identity-scopes`, que verifica el invariante
 * "todo rol no-god declara sus 6 dimensiones":
 *
 *     ✗ administrativo(-6), piso_tienda(-6), servicio(-6)
 *
 * `[ID.17]` creó los tres perfiles y les fijó los PERMISOS, pero sólo le puso
 * alcance a `direccion` y `auditor_externo`. Los otros tres quedaron con cero
 * filas en `identity.role_scopes`.
 *
 * Hoy no se nota: esos 28 usuarios tienen 0 permisos, así que no llegan a
 * ninguna query con alcance. La trampa es para dentro de un rato — el tracker
 * invita explícitamente a darle permisos a `administrativo` desde /admin/roles,
 * y en cuanto eso pase, **los 25 no verían absolutamente nada** y nadie sabría
 * por qué: sin fila, `[ID.3]` resuelve `none` (fail-closed, y está bien que sea
 * así). Justo el modo de falla que el invariante existe para atrapar.
 *
 * Se escriben filas EXPLÍCITAS en vez de dejarlas ausentes aunque el efecto
 * inmediato sea el mismo: ausente significa "nadie lo configuró", explícito
 * significa "se decidió". Es la diferencia entre un hueco y una declaración, y
 * es lo único que hace auditable el panel de "Acceso efectivo".
 *
 * Modos: lo más conservador que sigue siendo útil — cada persona ve **su**
 * sucursal y **su** zona, y nada más. Escritura en `none` en los tres: ninguno
 * tiene permisos de escritura, y si mañana se le da uno, ampliar el alcance
 * tiene que ser una decisión aparte y visible.
 *
 * `superadmin` sigue con 0 filas a propósito: `isPlatformAdminRole` lo resuelve
 * como `all` antes de leer la tabla, y el smoke lo exceptúa por eso.
 */

const DIMENSIONES = ['warehouse', 'zone', 'route', 'brand', 'expense_area', 'customer'];

/** rol → { dimensión: modo de lectura }. Lo que no se lista queda en `none`. */
const ALCANCE = {
  administrativo: {
    propios: { warehouse: 'own', zone: 'own' },
    nota: '[ID.21.1] administrativo de oficinas: su sucursal y su zona. Sin permisos de escritura.',
  },
  piso_tienda: {
    propios: { warehouse: 'own', zone: 'own' },
    nota: '[ID.21.1] piso de venta: su tienda y su zona. Sin permisos de escritura.',
  },
  servicio: {
    // Cuenta de servicio: el login la rechaza por `kind` y los feeds escriben
    // como superusuario de Postgres (bypassean RLS). La declaración honesta es
    // "esta identidad no lee a través de la app".
    propios: {},
    nota: '[ID.21.1] cuenta de servicio: no lee por la app (los feeds van por superusuario). Sin acceso interactivo.',
  },
};

exports.up = async function up(knex) {
  const tenants = await knex('identity.tenants').pluck('id');

  for (const tenant of tenants) {
    for (const [rol, cfg] of Object.entries(ALCANCE)) {
      const existe = await knex('identity.role_permissions')
        .where({ tenant_id: tenant, role_name: rol })
        .first('role_name');
      if (!existe) continue; // Otro tenant sin estos perfiles: no es un error.

      let escritas = 0;
      for (const dim of DIMENSIONES) {
        const fila = {
          tenant_id: tenant,
          role_name: rol,
          dimension: dim,
          mode: cfg.propios[dim] ?? 'none',
          mode_write: 'none',
          nota: cfg.nota,
        };
        const r = await knex('identity.role_scopes')
          .insert(fila)
          .onConflict(['tenant_id', 'role_name', 'dimension'])
          // No pisa lo que alguien ya configuró a mano: sólo completa el hueco.
          .ignore();
        if (r.rowCount) escritas++;
      }
      if (escritas) {
        console.log(`  [ID.21.1] ${rol}: ${escritas} dimensión/es completadas`);
      }
    }

    // Reporte del invariante, para que se vea si quedó algo suelto.
    const flojos = await knex.raw(
      `SELECT rp.role_name,
              (SELECT count(*) FROM identity.role_scopes rs
                WHERE rs.tenant_id = rp.tenant_id AND rs.role_name = rp.role_name)::int dims
         FROM identity.role_permissions rp
        WHERE rp.tenant_id = ? AND rp.deleted_at IS NULL
          AND LOWER(rp.role_name) NOT IN ('superadmin', 'admin')
        ORDER BY 2`,
      [tenant],
    );
    const incompletos = flojos.rows.filter((r) => r.dims < DIMENSIONES.length);
    if (incompletos.length) {
      console.log(
        `  [ID.21.1] ⚠ siguen sin sus 6 dimensiones: ${incompletos.map((r) => `${r.role_name}(${r.dims})`).join(', ')}`,
      );
    }
  }
};

exports.down = async function down(knex) {
  const tenants = await knex('identity.tenants').pluck('id');
  for (const tenant of tenants) {
    await knex('identity.role_scopes')
      .where({ tenant_id: tenant })
      .whereIn('role_name', Object.keys(ALCANCE))
      .whereLike('nota', '[ID.21.1]%')
      .del();
  }
};
