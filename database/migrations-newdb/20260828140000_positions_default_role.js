'use strict';
/**
 * `[ID.15]` — El PUESTO propone el perfil (Fase ID / esquema CRM-ERP).
 *
 * El hallazgo H7: el organigrama esta cargado —**43 puestos** en
 * `identity.positions`, con las etiquetas reales de RH en `org_labels`— y el
 * sistema de accesos lo ignora. Al dar de alta a alguien se elige un rol de una
 * lista larga, y el camino de menor esfuerzo es inventar uno nuevo. Asi se llego
 * a 47 roles para 142 cuentas.
 *
 * Esto ata las dos cosas: `positions.department_code` + `positions.default_role`.
 * El alta pasa a ser **persona + puesto + sucursal** y el sistema PROPONE
 * departamento y perfil; el humano confirma. Ahi muere el crecimiento del
 * catalogo.
 *
 * Dos decisiones que vale registrar:
 *
 *  - **No hay `default_scope`.** El alcance por default ya vive en
 *    `identity.role_scopes` (por rol, desde `[ID.3]`). Ponerlo tambien en el
 *    puesto crearia una segunda fuente de verdad para la misma pregunta, y
 *    cuando dos fuentes se contradicen gana la que nadie recuerda.
 *
 *  - **Los puestos sin perfil quedan en NULL, a proposito.** De los 43 puestos,
 *    hay 12 para los que HOY no existe un perfil razonable: el piso de tienda
 *    (anaquelista, empaquetador, surtidor, vendedor de piso), los choferes, el
 *    receptor de mercancia, facturacion, RH y mayoreo. Inventarles un rol
 *    parecido seria peor que dejarlo vacio: le daria permisos que nadie eligio a
 *    gente que todavia no tiene cuenta. Quedan listados al final de la corrida
 *    como el trabajo que falta.
 *
 * Aditiva e idempotente.
 *
 * @param { import("knex").Knex } knex
 */

/**
 * [codigo_puesto, department_code, default_role]
 * `null` en el rol = no hay perfil que le quede; se reporta como hueco.
 */
const MAPA = [
  // Direccion de zona
  ['jefe_zona', 'direccion_zona', 'supervisor_ventas'],
  ['supervisor_zona', 'direccion_zona', 'supervisor_ventas'],
  // Tienda / piso de venta
  ['encargado_sucursal', 'tienda', 'encargado_tienda'],
  ['auxiliar_encargado', 'tienda', 'auxiliar_tienda'],
  ['auxiliar_piso_venta', 'tienda', null],
  ['anaquelista', 'tienda', null],
  ['empaquetador', 'tienda', null],
  ['vendedor_promociones', 'tienda', null],
  ['surtidor_tienda', 'tienda', null],
  ['vendedor_piso', 'tienda', null],
  // Cajas
  ['encargado_cajas', 'cajas', 'cajero'],
  ['cajera', 'cajas', 'cajero'],
  ['caja_general', 'cajas', 'cajero'],
  // Ruta directa
  ['supervisor_rd', 'ruta_directa', 'supervisor_ventas'],
  ['vendedor_ruta', 'ruta_directa', 'vendedor_ruta'],
  ['vendedor_suplente', 'ruta_directa', 'vendedor_ruta'],
  ['chofer_rd', 'ruta_directa', null],
  // Ruta vecinal
  ['supervisor_rv', 'ruta_vecinal', 'supervisor_ventas'],
  ['vendedor_vecinal', 'ruta_vecinal', 'vendedor_ruta'],
  ['cajero_rv_promotor', 'ruta_vecinal', 'cajero'],
  ['almacenista_surtidor_rv', 'ruta_vecinal', 'almacenista'],
  // Telemarketing
  ['coordinador_tlmk', 'telemarketing', 'telemarketing'],
  ['vendedor_tlmk', 'telemarketing', 'telemarketing'],
  // Mayoreo y venta local
  ['vendedor_mayoreo', 'mayoreo', null],
  ['vendedor_local', 'mayoreo', null],
  ['facturador', 'mayoreo', null],
  // Almacen y recepcion
  ['almacenista', 'almacen', 'almacenista'],
  ['auxiliar_almacen', 'almacen', 'almacenista'],
  ['receptor_mercancia', 'almacen', null],
  ['bodeguero', 'almacen', 'almacenista'],
  ['surtidor', 'almacen', 'almacenista'],
  ['checador', 'almacen', null],
  // Logistica
  ['encargado_logistica', 'logistica', null],
  ['chofer_local', 'logistica', null],
  ['chofer_foraneo', 'logistica', null],
  ['auxiliar_chofer', 'logistica', null],
  // Operaciones
  ['encargado_operaciones', 'operaciones', 'compras_operaciones'],
  // Administracion
  ['auxiliar_administrativo', 'administracion', null],
  ['auxiliar_compras', 'operaciones', 'auxiliar_compras'],
  ['auxiliar_rh', 'administracion', null],
  ['auxiliar_mkt', 'administracion', null],
  ['intendencia', 'administracion', null],
  // Sistemas
  ['sistemas', 'sistemas', 'superadmin'],
];

exports.up = async function up(knex) {
  // ── 1. Columnas ───────────────────────────────────────────────────────────
  if (!(await knex.schema.withSchema('identity').hasColumn('positions', 'department_code'))) {
    await knex.schema.withSchema('identity').alterTable('positions', (t) => {
      t.string('department_code', 60);
    });
    await knex.raw(`COMMENT ON COLUMN identity.positions.department_code IS
      '[ID.15] Departamento al que pertenece el puesto. Lo propone el alta: elegis puesto y el departamento sale solo.'`);
  }
  if (!(await knex.schema.withSchema('identity').hasColumn('positions', 'default_role'))) {
    await knex.schema.withSchema('identity').alterTable('positions', (t) => {
      t.string('default_role', 100);
    });
    await knex.raw(`COMMENT ON COLUMN identity.positions.default_role IS
      '[ID.15] Perfil base que el alta propone para este puesto. NULL = todavia no hay perfil que le quede (ver el log de la migracion).'`);
  }

  // FK compuesta al catalogo de roles: un default_role que no existe seria una
  // propuesta que revienta al confirmarla. ON DELETE SET NULL para que borrar un
  // rol no bloquee, solo deje el puesto sin propuesta.
  const fk = await knex.raw(
    `SELECT 1 FROM pg_constraint WHERE conname = 'positions_default_role_fk'`,
  );
  if (!fk.rows.length) {
    await knex.raw(`
      ALTER TABLE identity.positions
        ADD CONSTRAINT positions_default_role_fk
        FOREIGN KEY (tenant_id, default_role)
        REFERENCES identity.role_permissions (tenant_id, role_name)
        ON DELETE SET NULL`);
  }

  // ── 2. Backfill del mapa ──────────────────────────────────────────────────
  const tenants = await knex('identity.tenants').pluck('id');
  for (const tenant of tenants) {
    const sinPerfil = [];
    const rolInexistente = [];
    let puestos = 0;

    for (const [code, dept, rol] of MAPA) {
      const existe = await knex('identity.positions')
        .where({ tenant_id: tenant, code })
        .whereNull('deleted_at')
        .first('code');
      if (!existe) continue;

      // El rol se resuelve contra el catalogo VIVO. Si el mapa quedo viejo
      // (porque `[ID.14]` renombro algo despues), se avisa y se deja NULL en vez
      // de romper la FK.
      let rolCanonico = null;
      if (rol) {
        const r = await knex('identity.role_permissions')
          .where({ tenant_id: tenant })
          .whereNull('deleted_at')
          .whereRaw('LOWER(role_name) = ?', [rol.toLowerCase()])
          .first('role_name');
        if (r) rolCanonico = r.role_name;
        else rolInexistente.push(`${code} -> ${rol}`);
      }

      await knex('identity.positions')
        .where({ tenant_id: tenant, code })
        .update({
          department_code: dept,
          default_role: rolCanonico,
          updated_at: knex.fn.now(),
        });
      puestos++;
      if (!rolCanonico) sinPerfil.push(code);
    }

    console.log(`\n  [ID.15] tenant ${tenant}: ${puestos} puesto/s con departamento asignado`);
    const conRol = await knex('identity.positions')
      .where({ tenant_id: tenant })
      .whereNotNull('default_role')
      .count('* as n')
      .first();
    console.log(`  [ID.15] ${conRol.n} puesto/s proponen un perfil base`);

    if (sinPerfil.length) {
      console.log(`\n  [ID.15] ${sinPerfil.length} puesto/s SIN perfil (es el trabajo que falta, no un error):`);
      sinPerfil.forEach((c) => console.log(`     · ${c}`));
    }
    if (rolInexistente.length) {
      console.log(`\n  OJO: el mapa apunta a roles que no existen en el catalogo:`);
      rolInexistente.forEach((c) => console.log(`     · ${c}`));
    }

    // Coherencia: usuarios cuyo departamento no coincide con el de su puesto.
    // Se REPORTA y no se corrige: puede ser un dato viejo o una excepcion real
    // (alguien de Logistica que captura gastos y quedo en administracion).
    const incoherentes = await knex.raw(
      `SELECT u.username, u.position_code, u.department_code AS depto_usuario, p.department_code AS depto_puesto
         FROM identity.users u
         JOIN identity.positions p ON p.tenant_id = u.tenant_id AND p.code = u.position_code
        WHERE u.deleted_at IS NULL AND p.department_code IS NOT NULL
          AND u.department_code IS DISTINCT FROM p.department_code
        ORDER BY 1`,
      [],
    );
    if (incoherentes.rows.length) {
      console.log(`\n  [ID.15] ${incoherentes.rows.length} usuario/s con departamento distinto al de su puesto (revisar desde la UI):`);
      incoherentes.rows
        .slice(0, 12)
        .forEach((r) => console.log(`     · ${r.username} (${r.position_code}): ${r.depto_usuario} vs ${r.depto_puesto}`));
    }
  }
};

exports.down = async function down(knex) {
  // Las columnas no se borran (regla del proyecto). Se limpia el contenido, que
  // es lo que esta migracion aporto.
  await knex('identity.positions').update({ default_role: null });
  console.log('  [ID.15] down: default_role limpiado. Las columnas se conservan.');
};
