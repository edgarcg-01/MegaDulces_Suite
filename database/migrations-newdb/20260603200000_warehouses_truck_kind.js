/**
 * Fase 2 Cierre de ruta: warehouse "camión" por vendedor.
 *
 * Agrega a commercial.warehouses:
 *   - kind: 'central' | 'truck' (camión de ruta del vendedor)
 *   - owner_user_id: vendedor dueño del camión (public.users es VISTA → sin FK)
 *
 * El ticket de carga descarga stock al camión del vendedor (movement type 'in').
 *
 * @param { import("knex").Knex } knex
 */
exports.up = async function (knex) {
  const hasKind = await knex.schema.withSchema('commercial').hasColumn('warehouses', 'kind');
  if (!hasKind) {
    await knex.schema.withSchema('commercial').alterTable('warehouses', (t) => {
      t.string('kind', 20).notNullable().defaultTo('central');
      t.uuid('owner_user_id'); // sin FK: public.users es vista; integridad por app
    });
    await knex.raw(
      `CREATE INDEX IF NOT EXISTS idx_commercial_warehouses_owner ON commercial.warehouses (tenant_id, owner_user_id)`,
    );
    await knex.raw(`COMMENT ON COLUMN commercial.warehouses.kind IS 'central | truck (camión de ruta del vendedor)'`);
    await knex.raw(`COMMENT ON COLUMN commercial.warehouses.owner_user_id IS 'Vendedor dueño del camión (solo kind=truck). FK omitida: users es vista.'`);
  }
};

exports.down = async function (knex) {
  const hasKind = await knex.schema.withSchema('commercial').hasColumn('warehouses', 'kind');
  if (hasKind) {
    await knex.schema.withSchema('commercial').alterTable('warehouses', (t) => {
      t.dropColumn('kind');
      t.dropColumn('owner_user_id');
    });
  }
};
