/**
 * Fase SU.2 — El eje de FULFILLMENT: pool de pedidos y olas de surtido (ADR-067).
 *
 * ⭐ El pedido NO cambia de identidad: `commercial.orders` sigue siendo el pedido maestro con su
 * folio `PD-`. Esta migración agrega un eje PARALELO que lo referencia y nunca lo sustituye.
 *
 * ⛔ Por eso NO se toca `commercial.orders.status`. El documento origen
 * (`Flujo_Integral_Pedidos_Preventa_Mega_Dulces.md` §5) pedía 22 estados principales + 11
 * extraordinarios sobre el pedido; el CHECK vivo tiene 5 y de él cuelga TODO el flujo comercial
 * (portal, vendedor, telemarketing, tienda, bot). Además mezcla dos preguntas distintas —¿el
 * cliente ya se comprometió? vs ¿dónde va la mercancía?— y cuando un CASE mezcla dos preguntas la
 * precedencia le miente a una (ADR-057, pasó tres veces en una sola fase).
 *
 *   commercial.picking_waves  — la ola: un recorrido del almacén que sirve a VARIOS pedidos.
 *   commercial.wave_orders    — qué pedidos entraron a la ola (y el avance de cada uno).
 *
 * ⚠️ Lo que este eje NO hace, por decisión explícita de Edgar (2026-09-17): **no aparta stock.**
 * La preventa sigue sin reservar. La existencia que se vea al armar una ola es INFORMATIVA, no
 * una garantía, y el reparto de lo escaso se resuelve sobre lo que el surtidor efectivamente
 * levantó (SU.6/SU.8), no sobre una reserva previa. Por eso acá no hay ninguna columna de
 * cantidad reservada: no existe el concepto.
 *
 * ⚠️ `wave_orders` lleva UNIQUE parcial sobre `order_id` para las olas VIVAS: un pedido no puede
 * estar en dos olas a la vez, pero sí puede volver a entrar a otra si la primera se canceló. Sin
 * el `WHERE`, cancelar una ola dejaría al pedido preso para siempre.
 *
 * Convención A.0mt: tenant_id NOT NULL + RLS forzado + grants app_runtime. Idempotente (hasTable).
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
  // ── commercial.picking_waves ────────────────────────────────────────────────────────────
  if (!(await knex.schema.withSchema('commercial').hasTable('picking_waves'))) {
    await knex.raw(`
      CREATE TABLE commercial.picking_waves (
        id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id      uuid NOT NULL DEFAULT public.current_tenant_id(),
        code           varchar(20) NOT NULL,
        warehouse_id   uuid NOT NULL,
        delivery_date  date,
        status         varchar(20) NOT NULL DEFAULT 'abierta'
                       CHECK (status IN ('abierta','en_surtido','surtida','cancelada')),
        assigned_to    uuid,
        started_at     timestamptz,
        finished_at    timestamptz,
        notes          text,
        created_at     timestamptz NOT NULL DEFAULT now(),
        created_by     uuid,
        updated_at     timestamptz NOT NULL DEFAULT now(),
        updated_by     uuid,
        UNIQUE (tenant_id, code)
      )`);
    await knex.raw(`CREATE INDEX ix_pw_pendientes ON commercial.picking_waves (tenant_id, status, delivery_date)`);
    await knex.raw(`CREATE INDEX ix_pw_surtidor ON commercial.picking_waves (tenant_id, assigned_to) WHERE assigned_to IS NOT NULL`);
    await tenantRls(knex, 'commercial', 'picking_waves');
    await knex.raw(`COMMENT ON TABLE commercial.picking_waves IS
      'SU.2 - Una ola = un recorrido del almacen que sirve a VARIOS pedidos. No aparta stock (ADR-067): la existencia al armarla es informativa.'`);
    await knex.raw(`COMMENT ON COLUMN commercial.picking_waves.assigned_to IS
      'SU.2 - Surtidor responsable (identity.users.id). NULL = todavia no asignada.'`);
  }

  // ── commercial.wave_orders ──────────────────────────────────────────────────────────────
  if (!(await knex.schema.withSchema('commercial').hasTable('wave_orders'))) {
    await knex.raw(`
      CREATE TABLE commercial.wave_orders (
        id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id     uuid NOT NULL DEFAULT public.current_tenant_id(),
        wave_id       uuid NOT NULL REFERENCES commercial.picking_waves(id) ON DELETE CASCADE,
        order_id      uuid NOT NULL,
        stage         varchar(24) NOT NULL DEFAULT 'en_ola'
                      CHECK (stage IN ('en_ola','surtido','desconsolidado','checado','listo_embarque')),
        added_at      timestamptz NOT NULL DEFAULT now(),
        added_by      uuid,
        updated_at    timestamptz NOT NULL DEFAULT now(),
        UNIQUE (tenant_id, wave_id, order_id)
      )`);
    // ⚠️ Un pedido en UNA sola ola viva. El WHERE es lo que permite re-encolarlo si la ola se
    // cancela: sin el filtro, cancelar dejaría el pedido preso para siempre.
    await knex.raw(`
      CREATE UNIQUE INDEX ux_wo_order_viva ON commercial.wave_orders (tenant_id, order_id)
      WHERE stage <> 'listo_embarque'`);
    await knex.raw(`CREATE INDEX ix_wo_wave ON commercial.wave_orders (tenant_id, wave_id, stage)`);
    await tenantRls(knex, 'commercial', 'wave_orders');
    await knex.raw(`COMMENT ON TABLE commercial.wave_orders IS
      'SU.2 - Que pedidos entraron a la ola y en que etapa fisica va cada uno. El estado COMERCIAL del pedido sigue en commercial.orders.status: son dos ejes (ADR-067).'`);
  }

  // ── Secuencia de folio de ola (mismo patrón que commercial.order_sequences) ──────────────
  if (!(await knex.schema.withSchema('commercial').hasTable('wave_sequences'))) {
    await knex.raw(`
      CREATE TABLE commercial.wave_sequences (
        tenant_id     uuid NOT NULL,
        year          integer NOT NULL,
        current_value integer NOT NULL DEFAULT 0,
        updated_at    timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (tenant_id, year)
      )`);
    await tenantRls(knex, 'commercial', 'wave_sequences');
    await knex.raw(`COMMENT ON TABLE commercial.wave_sequences IS
      'SU.2 - Folio W-YYYY-NNNNN por tenant/anio, con UPSERT atomico (mismo patron que order_sequences).'`);
  }
};

exports.down = async function down(knex) {
  await knex.raw(`DROP TABLE IF EXISTS commercial.wave_orders`);
  await knex.raw(`DROP TABLE IF EXISTS commercial.picking_waves`);
  await knex.raw(`DROP TABLE IF EXISTS commercial.wave_sequences`);
};
