/**
 * Proyecto Tienda (TDA) — asignación de sucursal al usuario para el scoping del
 * monitor de tickets en vivo.
 *
 * `warehouse_code` = código de sucursal Kepler ('00'..'05'). NULL = rol global
 * (ve TODAS las sucursales y puede usar el filtro). Cuando está seteado, el
 * backend fuerza que ese usuario solo reciba/consulte SU sucursal (snapshot
 * filtrado + room WS por sucursal).
 *
 * Idempotente (hasColumn). Viaja en el JWT → los usuarios afectados deben
 * RE-LOGUEAR para que el scoping tome efecto.
 *
 * @param { import("knex").Knex } knex
 */
exports.up = async function (knex) {
  const has = await knex.schema.hasColumn('users', 'warehouse_code');
  if (!has) {
    await knex.schema.alterTable('users', (t) => {
      t.string('warehouse_code', 4)
        .nullable()
        .comment("Sucursal Kepler asignada ('00'..'05'). NULL = ve todas (rol global). Scoping del monitor Tienda.");
    });
  }
};

exports.down = async function (knex) {
  const has = await knex.schema.hasColumn('users', 'warehouse_code');
  if (has) {
    await knex.schema.alterTable('users', (t) => t.dropColumn('warehouse_code'));
  }
};
