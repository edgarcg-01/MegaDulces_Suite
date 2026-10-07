/**
 * Fase SU.6/SU.7 — A QUIÉN LE TOCA CADA COSA, y quién lo verificó (ADR-067).
 *
 * `commercial.wave_allocations` — el reverso del consolidado: qué parte de lo levantado va a cada
 * pedido. Se escribe al CERRAR el surtido, con la lógica pura de `allocation.ts` (probada por
 * unidad: es la que decide a quién se le queda corto el pedido cuando el anaquel no alcanzó).
 *
 * ⭐ **`rule_applied` no es decoración.** §15 del documento origen pide que el surtidor no decida
 * a mano a qué cliente quitarle mercancía. Cuando alcanza para todos no hay decisión; cuando no,
 * alguien se queda corto y **eso tiene que ser explicable**: sin el rastro de la regla, el cliente
 * que recibió de menos no tiene a quién preguntarle.
 *
 * ⛔ Sigue sin haber reserva: esto reparte **un hecho** (lo que había cuando la persona pasó), no
 * una promesa. Por eso corre al cerrar y no al armar la ola.
 *
 * `wave_orders` gana `verified_at` para cerrar el ciclo hasta `listo_embarque`, que es lo que
 * engancha con la carga del camión.
 *
 * @param { import("knex").Knex } knex
 */

async function tenantRls(knex, schema, table) {
  await knex.raw(`ALTER TABLE ${schema}.${table} ENABLE ROW LEVEL SECURITY`);
  await knex.raw(`ALTER TABLE ${schema}.${table} FORCE ROW LEVEL SECURITY`);
  await knex.raw(`
    DO $$ BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_policies WHERE schemaname='${schema}' AND tablename='${table}' AND policyname='tenant_isolation'
      ) THEN
        CREATE POLICY tenant_isolation ON ${schema}.${table}
          USING (tenant_id = public.current_tenant_id())
          WITH CHECK (tenant_id = public.current_tenant_id());
      END IF;
    END $$`);
  await knex.raw(`GRANT SELECT, INSERT, UPDATE, DELETE ON ${schema}.${table} TO app_runtime`);
}

exports.up = async function up(knex) {
  if (!(await knex.schema.withSchema('commercial').hasTable('wave_allocations'))) {
    await knex.raw(`
      CREATE TABLE commercial.wave_allocations (
        id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id      uuid NOT NULL DEFAULT public.current_tenant_id(),
        wave_id        uuid NOT NULL REFERENCES commercial.picking_waves(id) ON DELETE CASCADE,
        order_id       uuid NOT NULL,
        product_id     uuid NOT NULL,
        -- Lo que ESE pedido pedía de ESE producto, en unidad base.
        qty_requested  numeric(14,3) NOT NULL CHECK (qty_requested >= 0),
        -- Lo que le tocó. Nunca mayor que lo pedido — lo garantiza la función pura y lo vigila
        -- su spec; el CHECK de acá es el cinturón por si alguien escribe a mano.
        qty_allocated  numeric(14,3) NOT NULL CHECK (qty_allocated >= 0),
        -- ⭐ POR QUÉ le tocó eso. Sin esto, un pedido corto es inexplicable.
        rule_applied   varchar(24) NOT NULL
                       CHECK (rule_applied IN ('completo','prioridad_entrega','sin_mercancia')),
        created_at     timestamptz NOT NULL DEFAULT now(),
        UNIQUE (tenant_id, wave_id, order_id, product_id),
        CONSTRAINT wave_alloc_no_mas_de_lo_pedido CHECK (qty_allocated <= qty_requested)
      )`);
    await knex.raw(`CREATE INDEX ix_wa_wave ON commercial.wave_allocations (tenant_id, wave_id)`);
    await knex.raw(`CREATE INDEX ix_wa_order ON commercial.wave_allocations (tenant_id, order_id)`);
    await tenantRls(knex, 'commercial', 'wave_allocations');
    await knex.raw(`COMMENT ON TABLE commercial.wave_allocations IS
      'SU.6 - El reverso del consolidado: que parte de lo LEVANTADO va a cada pedido, y con que regla se decidio. La logica vive en allocation.ts y esta probada por unidad.'`);
    await knex.raw(`COMMENT ON COLUMN commercial.wave_allocations.rule_applied IS
      'SU.6 - completo = alcanzaba para todos. prioridad_entrega = no alcanzaba y se sirvio por fecha de entrega y antiguedad. sin_mercancia = no se levanto nada. Es lo que hace EXPLICABLE un pedido corto.'`);
  }

  if (!(await knex.schema.withSchema('commercial').hasColumn('wave_orders', 'verified_at'))) {
    await knex.raw(`ALTER TABLE commercial.wave_orders ADD COLUMN verified_at timestamptz`);
    await knex.raw(`ALTER TABLE commercial.wave_orders ADD COLUMN verified_by uuid`);
    await knex.raw(`COMMENT ON COLUMN commercial.wave_orders.verified_by IS
      'SU.7 - Quien re-verifico ESTE pedido. Puede ser la misma persona que lo surtio (decision 2026-09-17: una sola persona); se guarda aparte para poder MEDIRLO y para encender el gate del dia que sean dos.'`);
  }
};

exports.down = async function down(knex) {
  await knex.raw(`DROP TABLE IF EXISTS commercial.wave_allocations`);
  await knex.raw(`ALTER TABLE commercial.wave_orders DROP COLUMN IF EXISTS verified_at`);
  await knex.raw(`ALTER TABLE commercial.wave_orders DROP COLUMN IF EXISTS verified_by`);
};
