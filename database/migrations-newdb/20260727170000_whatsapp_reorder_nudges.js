/**
 * FIQ.10 — Nudges de reorden proactivo (whatsapp.reorder_nudges).
 *
 * Bitácora de a quién se le mandó (o se planeó) un recordatorio de reabasto:
 *   - IDEMPOTENCIA: no volver a molestar al mismo cliente en N días (índice por
 *     tenant+customer+created_at).
 *   - AUDIT: qué producto/mensaje, estado (planned/sent/skipped), motivo, campaña.
 *   - ATRIBUCIÓN (seam): cruzar created_at con el próximo pedido del cliente para
 *     medir oferta→pedido (se computa después; acá solo se registra).
 *
 * El ENVÍO real (fuera de la ventana 24h) exige plantilla Meta aprobada
 * (WHATSAPP_REORDER_TEMPLATE); sin ella el nudge queda 'skipped' reason='no_template'.
 * tenant_id + RLS FORZADO + grant app_runtime. Idempotente (hasTable).
 *
 * @param { import("knex").Knex } knex
 */
exports.up = async function (knex) {
  if (await knex.schema.withSchema('whatsapp').hasTable('reorder_nudges')) return;

  await knex.schema.withSchema('whatsapp').createTable('reorder_nudges', (t) => {
    t.uuid('id').notNullable().defaultTo(knex.raw('gen_random_uuid()'));
    t.uuid('tenant_id').notNullable();
    t.uuid('customer_id').notNullable();
    t.text('phone').notNullable(); // E.164 canónico
    t.integer('days_overdue'); // recency − cadence al momento del nudge
    t.text('top_product'); // producto habitual sugerido a reabastecer (snapshot)
    t.text('message'); // mensaje compuesto (determinista)
    t.text('status').notNullable().defaultTo('planned'); // planned | sent | skipped
    t.text('reason'); // p. ej. 'no_template' | 'not_opted_in' | 'sent'
    t.uuid('campaign_id'); // whatsapp.campaigns si se envió por plantilla
    t.timestamp('sent_at');
    t.timestamp('created_at').notNullable().defaultTo(knex.fn.now());

    t.primary('id');
    t.check(`?? IN ('planned','sent','skipped')`, ['status'], 'whatsapp_reorder_nudges_status_valid');
    // Idempotencia / anti-spam: buscar nudges recientes por cliente.
    t.index(['tenant_id', 'customer_id', 'created_at'], 'idx_reorder_nudges_customer_time');
    t.index(['tenant_id', 'phone', 'created_at'], 'idx_reorder_nudges_phone_time');
  });

  await knex.raw(`ALTER TABLE whatsapp.reorder_nudges ENABLE ROW LEVEL SECURITY`);
  await knex.raw(`ALTER TABLE whatsapp.reorder_nudges FORCE ROW LEVEL SECURITY`);
  await knex.raw(`
    CREATE POLICY tenant_isolation ON whatsapp.reorder_nudges
      USING (tenant_id = public.current_tenant_id())
      WITH CHECK (tenant_id = public.current_tenant_id())
  `);
  await knex.raw('GRANT SELECT, INSERT, UPDATE, DELETE ON whatsapp.reorder_nudges TO app_runtime');
  await knex.raw(`COMMENT ON TABLE whatsapp.reorder_nudges IS 'FIQ.10: bitácora de nudges de reorden (idempotencia anti-spam + audit + seam de atribución oferta→pedido). Envío gated por plantilla Meta aprobada.'`);
};

/**
 * @param { import("knex").Knex } knex
 */
exports.down = async function (knex) {
  await knex.schema.withSchema('whatsapp').dropTableIfExists('reorder_nudges');
};
