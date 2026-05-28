/**
 * Fix FK `fk_catalogs_tenant_parent` en `catalogs`.
 *
 * Estado previo:
 *   FOREIGN KEY (tenant_id, parent_id) REFERENCES catalogs(tenant_id, id)
 *
 * Problema: el código (`catalogs.service.ts`) asume que `parent_id` de una ruta
 * apunta a `zones.id`. Pero en la new DB las zonas viven en tabla `zones`,
 * no en `catalogs` (la migración eliminó los rows con catalog_id='zonas'),
 * así que ningún UPDATE con parent_id=zone_uuid pasa la FK.
 *
 * Solución: cambiar la FK para que apunte a `zones(tenant_id, id)`.
 *
 * Verificado pre-migration: 0 rows con parent_id != NULL → safe para cambiar.
 * Si en el futuro se quiere jerarquía interna en catalogs, este modelo no
 * sirve y habría que volver a una FK polimórfica (validada por trigger o code).
 *
 * @param { import("knex").Knex } knex
 */
exports.up = async function (knex) {
  // Drop la FK vieja si existe
  const old = await knex.raw(`
    SELECT 1 FROM pg_constraint WHERE conname = 'fk_catalogs_tenant_parent'
  `);
  if (old.rows.length > 0) {
    await knex.raw(
      'ALTER TABLE catalogs DROP CONSTRAINT fk_catalogs_tenant_parent',
    );
  }

  // Crea la nueva apuntando a zones
  const fresh = await knex.raw(`
    SELECT 1 FROM pg_constraint WHERE conname = 'fk_catalogs_tenant_parent_zones'
  `);
  if (fresh.rows.length === 0) {
    await knex.raw(`
      ALTER TABLE catalogs
        ADD CONSTRAINT fk_catalogs_tenant_parent_zones
        FOREIGN KEY (tenant_id, parent_id)
        REFERENCES zones(tenant_id, id)
        ON DELETE SET NULL
    `);
  }
};

/**
 * @param { import("knex").Knex } knex
 */
exports.down = async function (knex) {
  await knex
    .raw('ALTER TABLE catalogs DROP CONSTRAINT IF EXISTS fk_catalogs_tenant_parent_zones');
  await knex.raw(`
    ALTER TABLE catalogs
      ADD CONSTRAINT fk_catalogs_tenant_parent
      FOREIGN KEY (tenant_id, parent_id)
      REFERENCES catalogs(tenant_id, id)
      ON DELETE CASCADE
  `);
};
