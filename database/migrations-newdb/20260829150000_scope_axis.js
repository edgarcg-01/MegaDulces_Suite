/**
 * `[ID.24]` — La columna que divide poblaciones: **el eje de alcance**.
 *
 * El formulario de usuarios pregunta zona Y sucursal a todo el mundo porque no
 * había forma de saber cuál de las dos le corresponde a cada persona. La medición
 * dice que la operación ya tiene la respuesta y sólo faltaba escribirla:
 *
 *     ruta_directa  →  34 personas, 34 con zona, **0 con sucursal**
 *     cajas         →  27 personas,  0 con zona, **27 con sucursal**
 *
 * No es casualidad: cada población tiene UN eje y llena sólo ese campo. Lo que
 * faltaba era declararlo.
 *
 * **Por qué en el PUESTO y no en el departamento** (esto lo decide la data, no el
 * gusto): dentro de `ruta_directa` conviven `vendedor_ruta` (31 personas, su eje
 * es **su ruta**) y `supervisor_rd` (3, su eje es **la zona entera**, una por
 * plaza). Dos ejes en el mismo departamento ⇒ el departamento no alcanza.
 *
 * **Por qué TAMBIÉN en el departamento:** 77 de 149 usuarios no tienen puesto
 * asignado, y sólo 7 no tienen departamento. Sin el fallback, más de la mitad del
 * padrón se queda sin eje. Resolución: `puesto → departamento → (nada)`, la misma
 * forma que `default_role`.
 *
 * **Lo que este eje NO hace: no otorga nada.** El alcance real lo siguen
 * decidiendo `role_scopes`/`user_scopes` (ADR-050). Esto decide **qué pregunta el
 * alta** y **de dónde se deriva la zona**. Mantenerlo fuera del camino de
 * autorización es lo que hace que agregarlo sea seguro.
 *
 * Vocabulario (uno por dimensión de alcance, más `red`):
 *   `ruta`      la persona trae una ruta; la zona sale de la ruta
 *   `zona`      supervisa varias rutas de una plaza (supervisores, jefes de zona)
 *   `sucursal`  está parada en una tienda o almacén; la zona sale de la sucursal
 *   `red`       oficinas: no se le pregunta lugar, su alcance es la red
 *   `cartera`   televenta: su universo son los clientes que atiende, no un lugar
 *   `cliente`   externo (portal B2B): su propio `customer_id`
 */

const EJES = ['ruta', 'zona', 'sucursal', 'red', 'cartera', 'cliente'];

/** Eje por DEPARTAMENTO — el fallback de los 77 sin puesto. */
const POR_DEPARTAMENTO = {
  ruta_directa: 'ruta',
  ruta_vecinal: 'ruta',
  direccion_zona: 'zona',
  cajas: 'sucursal',
  tienda: 'sucursal',
  almacen: 'sucursal',
  mayoreo: 'sucursal',
  telemarketing: 'cartera',
  externo: 'cliente',
  administracion: 'red',
  operaciones: 'red',
  sistemas: 'red',
  logistica: 'red', // Los choferes cruzan sucursales: su eje es la red, no una.
};

/**
 * Eje por PUESTO, sólo donde DIFIERE de su departamento. Lo demás hereda —
 * repetir el valor del departamento en 35 puestos sería inventar 35 lugares
 * donde el dato puede quedar en desacuerdo consigo mismo.
 */
const POR_PUESTO = {
  // En ruta_directa/ruta_vecinal el supervisor no trae ruta: cubre la plaza.
  supervisor_rd: 'zona',
  supervisor_rv: 'zona',
  // El almacenista y el cajero de Ruta Vecinal trabajan en la base de la RV, no
  // recorriendo: su eje es el lugar, aunque su departamento sea de ruta.
  almacenista_surtidor_rv: 'sucursal',
  cajero_rv_promotor: 'sucursal',
  // El chofer de ruta directa acompaña al vendedor: mismo eje que él (hereda),
  // pero el facturador de mayoreo factura para toda la red.
  facturador: 'red',
  // Mercadotecnia y RH son de oficina aunque el organigrama los cuelgue de
  // administración; ya heredan `red`. Intendencia también.
};

exports.up = async function up(knex) {
  for (const tabla of ['departments', 'positions']) {
    const tiene = await knex.schema.withSchema('identity').hasColumn(tabla, 'scope_axis');
    if (!tiene) {
      await knex.schema.withSchema('identity').alterTable(tabla, (t) => {
        t.string('scope_axis', 12).nullable();
      });
      await knex.raw(`
        ALTER TABLE identity.${tabla}
          ADD CONSTRAINT ${tabla}_scope_axis_check
          CHECK (scope_axis IS NULL OR scope_axis IN (${EJES.map((e) => `'${e}'`).join(', ')}))`);
    }
  }
  await knex.raw(`
    COMMENT ON COLUMN identity.departments.scope_axis IS
      '[ID.24] Eje de alcance por defecto del departamento. Fallback del puesto. NO otorga acceso: decide que pregunta el alta y de donde se deriva la zona.'`);
  await knex.raw(`
    COMMENT ON COLUMN identity.positions.scope_axis IS
      '[ID.24] Eje de alcance del puesto. NULL = hereda del departamento. Se escribe solo donde DIFIERE (ej. supervisor_rd es zona aunque su depto sea ruta).'`);

  const tenants = await knex('identity.tenants').pluck('id');
  for (const tenant of tenants) {
    let dep = 0;
    for (const [code, eje] of Object.entries(POR_DEPARTAMENTO)) {
      const r = await knex('identity.departments')
        .where({ tenant_id: tenant, code })
        .whereNull('scope_axis')
        .update({ scope_axis: eje });
      dep += r;
    }
    let pue = 0;
    for (const [code, eje] of Object.entries(POR_PUESTO)) {
      const r = await knex('identity.positions')
        .where({ tenant_id: tenant, code })
        .whereNull('scope_axis')
        .update({ scope_axis: eje });
      pue += r;
    }
    if (!dep && !pue) continue;
    console.log(`  [ID.24] tenant ${tenant}: ${dep} departamentos + ${pue} puestos con eje declarado`);

    // Cobertura real del padrón: cuánta gente queda con eje resuelto.
    const cob = await knex.raw(
      `SELECT coalesce(p.scope_axis, d.scope_axis) eje, count(*)::int n
         FROM identity.users u
         LEFT JOIN identity.positions p
           ON p.tenant_id = u.tenant_id AND p.code = u.position_code
         LEFT JOIN identity.departments d
           ON d.tenant_id = u.tenant_id AND d.code = u.department_code
        WHERE u.tenant_id = ? AND u.deleted_at IS NULL
        GROUP BY 1 ORDER BY 2 DESC`,
      [tenant],
    );
    for (const r of cob.rows) {
      console.log(`     ${String(r.n).padStart(4)}  ${r.eje ?? '(sin eje: ni puesto ni departamento)'}`);
    }
    const sinDepto = await knex('identity.departments')
      .where({ tenant_id: tenant })
      .whereNull('scope_axis')
      .whereNull('deleted_at')
      .pluck('code');
    if (sinDepto.length) {
      console.log(`  [ID.24] ⚠ departamentos sin eje (definir a mano): ${sinDepto.join(', ')}`);
    }
  }
};

exports.down = async function down(knex) {
  for (const tabla of ['departments', 'positions']) {
    const tiene = await knex.schema.withSchema('identity').hasColumn(tabla, 'scope_axis');
    if (!tiene) continue;
    await knex.raw(`ALTER TABLE identity.${tabla} DROP CONSTRAINT IF EXISTS ${tabla}_scope_axis_check`);
    await knex.schema.withSchema('identity').alterTable(tabla, (t) => t.dropColumn('scope_axis'));
  }
};
