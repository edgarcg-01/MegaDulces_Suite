/**
 * `[ID.24.1]` — La ruta de la persona, que no existía en ningún lado.
 *
 * `identity.users` tiene `zona_id` y `warehouse_code`, pero **no tiene ruta**
 * (`vendor_route_id` se borró en `20260825170000`). O sea que a los **34 de ruta
 * directa** hay que adivinarles la ruta por su zona — y `LA PIEDAD RD` tiene 6.
 *
 * El síntoma medible de ese hueco está en el alcance: `identity.role_scopes`
 * tiene la dimensión `route` en **`all` para 42 de 45 roles**. No porque alguien
 * decidiera que todos ven todas las rutas, sino porque `own` era imposible:
 * `ScopeService.COLUMNA_PROPIA` mapea `warehouse→warehouse_code`,
 * `zone→zona_id`, `customer→customer_id` y **para `route` no había columna**.
 * Con esta se puede escribir `route: own` y que signifique algo.
 *
 * FK compuesta a `trade.catalogs` (donde viven las rutas, `catalog_id='rutas'`).
 * La FK no puede exigir que sea del catálogo de rutas —eso no se expresa en una
 * FK— así que lo valida el service al escribir, igual que `assertOrgCodes` hace
 * con departamento, puesto y sucursal.
 *
 * **Backfill honesto: 3 de 34.** Sólo se asignan las rutas que el propio username
 * declara (`ruta_505`, `rvph01`, `rvph02`). Los otros 31 son nombres de persona y
 * no hay de dónde inferir: ni `daily_assignments` (0 filas) ni `commercial.orders`
 * (0 con `route_id`) tienen el vínculo. Inventarlo sería peor que dejarlo vacío —
 * una ruta equivocada manda al vendedor a las tiendas de otro. Se asignan desde
 * /admin/usuarios, que es donde vive el dato operativo.
 */

exports.up = async function up(knex) {
  const tiene = await knex.schema.withSchema('identity').hasColumn('users', 'route_id');
  if (!tiene) {
    await knex.schema.withSchema('identity').alterTable('users', (t) => {
      t.uuid('route_id').nullable();
    });
    await knex.raw(`
      ALTER TABLE identity.users
        ADD CONSTRAINT users_route_fk
        FOREIGN KEY (tenant_id, route_id) REFERENCES trade.catalogs(tenant_id, id)
        ON DELETE SET NULL`);
    await knex.raw(`
      COMMENT ON COLUMN identity.users.route_id IS
        '[ID.24.1] Ruta de la persona (trade.catalogs catalog_id=rutas). Es lo que hace posible scope route=own. La zona se DERIVA de la ruta.'`);
    await knex.raw(`
      CREATE INDEX IF NOT EXISTS users_route_idx ON identity.users (tenant_id, route_id)
        WHERE route_id IS NOT NULL`);
  }

  const norm = (v) => String(v).toUpperCase().replace(/[^A-Z0-9]/g, '');
  const tenants = await knex('identity.tenants').pluck('id');

  for (const tenant of tenants) {
    const rutas = await knex('trade.catalogs')
      .where({ tenant_id: tenant, catalog_id: 'rutas' })
      .whereNull('deleted_at')
      .select('id', 'value');
    if (!rutas.length) continue;
    const porNorm = new Map(rutas.map((r) => [norm(r.value), r.id]));

    // Sólo los usuarios cuyo USERNAME es literalmente el código de la ruta.
    const candidatos = await knex('identity.users')
      .where({ tenant_id: tenant })
      .whereNull('deleted_at')
      .whereNull('route_id')
      .select('id', 'username');

    let n = 0;
    for (const u of candidatos) {
      const rid = porNorm.get(norm(u.username));
      if (!rid) continue;
      await knex('identity.users').where({ id: u.id }).update({ route_id: rid });
      n++;
    }
    if (n) console.log(`  [ID.24.1] ${n} usuario/s con ruta deducida del username`);

    // Reporte: quién queda sin ruta y debería tenerla.
    const faltan = await knex.raw(
      `SELECT u.username
         FROM identity.users u
         LEFT JOIN identity.positions p ON p.tenant_id = u.tenant_id AND p.code = u.position_code
         LEFT JOIN identity.departments d ON d.tenant_id = u.tenant_id AND d.code = u.department_code
        WHERE u.tenant_id = ? AND u.deleted_at IS NULL AND u.route_id IS NULL
          AND coalesce(p.scope_axis, d.scope_axis) = 'ruta'
        ORDER BY u.username`,
      [tenant],
    );
    if (faltan.rows.length) {
      console.log(
        `  [ID.24.1] ${faltan.rows.length} personas de eje ruta SIN ruta (asignar en /admin/usuarios): ${faltan.rows
          .map((r) => r.username)
          .join(', ')}`,
      );
    }

    // Y la contraparte: rutas sin tiendas, de las que no se puede derivar zona.
    const huecas = await knex.raw(
      `SELECT c.value
         FROM trade.catalogs c
        WHERE c.tenant_id = ? AND c.catalog_id = 'rutas' AND c.deleted_at IS NULL
          AND NOT EXISTS (SELECT 1 FROM trade.stores s
                           WHERE s.tenant_id = c.tenant_id AND s.ruta_id = c.id AND s.deleted_at IS NULL)
        ORDER BY c.value`,
      [tenant],
    );
    if (huecas.rows.length) {
      console.log(
        `  [ID.24.1] rutas sin tiendas (no derivan zona): ${huecas.rows.map((r) => r.value).join(', ')}`,
      );
    }
  }
};

exports.down = async function down(knex) {
  const tiene = await knex.schema.withSchema('identity').hasColumn('users', 'route_id');
  if (!tiene) return;
  await knex.raw(`DROP INDEX IF EXISTS identity.users_route_idx`);
  await knex.raw(`ALTER TABLE identity.users DROP CONSTRAINT IF EXISTS users_route_fk`);
  await knex.schema.withSchema('identity').alterTable('users', (t) => t.dropColumn('route_id'));
};
