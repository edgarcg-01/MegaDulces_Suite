/**
 * Migración: commercial.commerce_signals — log append-only del feedback loop (Fase M, Sprint M.4).
 *
 * Cierra la capa "aprende" de ADR-016: cada oferta/impresión (NBA mostrado, mensaje
 * de reorden, tarjeta vista) se loguea con su contexto. La conversión se DERIVA por
 * join con commercial.orders (oferta → pedido dentro de ventana), sin write-back ni
 * acoplar orders → intelligence.
 *
 * Append-only: sin updated_at/deleted_at. RLS forzado (patrón recommended_baskets).
 *
 * @param { import("knex").Knex } knex
 */
exports.up = async function (knex) {
  const exists = await knex.schema.withSchema('commercial').hasTable('commerce_signals');
  if (exists) return;

  await knex.schema.withSchema('commercial').createTable('commerce_signals', (table) => {
    table.uuid('id').notNullable().defaultTo(knex.raw('gen_random_uuid()'));
    table.uuid('tenant_id').notNullable();
    table.uuid('customer_id').notNullable();
    /** offer_shown | offer_message | offer_acted | ... (flexible, no CHECK) */
    table.string('signal_type', 40).notNullable();
    /** vendor | portal | whatsapp | push | televenta */
    table.string('channel', 20).notNullable();
    /** Quién la generó/vio (vendedor u operador). Null para impresiones del propio cliente. */
    table.uuid('user_id').nullable();
    table.jsonb('context').notNullable().defaultTo('{}');
    table.timestamp('created_at').notNullable().defaultTo(knex.fn.now());

    table.primary('id');
    table.index(['tenant_id', 'customer_id', 'created_at'], 'idx_commerce_signals_customer');
    table.index(['tenant_id', 'signal_type', 'created_at'], 'idx_commerce_signals_type');
  });

  await knex.raw(`
    ALTER TABLE commercial.commerce_signals
      ADD CONSTRAINT fk_commerce_signals_tenant
      FOREIGN KEY (tenant_id) REFERENCES identity.tenants(id) ON DELETE RESTRICT
  `);
  await knex.raw(`
    ALTER TABLE commercial.commerce_signals
      ADD CONSTRAINT fk_commerce_signals_customer
      FOREIGN KEY (tenant_id, customer_id)
      REFERENCES commercial.customers(tenant_id, id) ON DELETE CASCADE
  `);

  await knex.raw(`ALTER TABLE commercial.commerce_signals ENABLE ROW LEVEL SECURITY`);
  await knex.raw(`ALTER TABLE commercial.commerce_signals FORCE ROW LEVEL SECURITY`);
  await knex.raw(`
    CREATE POLICY tenant_isolation ON commercial.commerce_signals
      USING (tenant_id = public.current_tenant_id())
      WITH CHECK (tenant_id = public.current_tenant_id())
  `);
  await knex.raw(`GRANT SELECT, INSERT ON commercial.commerce_signals TO app_runtime`);

  await knex.raw(`COMMENT ON TABLE commercial.commerce_signals IS 'Feedback loop (Fase M). Log append-only de ofertas/impresiones; conversión se deriva por join con orders. RLS forzado.'`);
};

exports.down = async function (knex) {
  await knex.schema.withSchema('commercial').dropTableIfExists('commerce_signals');
};
