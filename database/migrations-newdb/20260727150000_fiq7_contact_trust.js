/**
 * FIQ.7 (ADR-037) — Trust-score del contacto + gate determinista.
 *
 * Detecta contactos que "solo juegan" (chatean y nunca compran) o que "no reciben
 * pedidos" (no-show/rechazo real), CERO LLM. El motor agrega señales reales por
 * teléfono E.164 → un tier (allow/require_deposit/block/handoff) que el gate del
 * bot obedece; el LLM solo comunica y NUNCA acusa (ADR-016/020).
 *
 * 2 tablas en commercial.*:
 *   1. contact_trust_features — feature store por (tenant, phone): contadores de
 *      pedidos/entregas/llamadas/conversaciones/apartados-vencidos + balance +
 *      risk_score + tier + reasons. UNIQUE (tenant_id, phone). Es la SALIDA del
 *      detector (queryable para una bandeja de ops).
 *   2. trust_thresholds — config del gate por tenant (sin hardcode): min_observations
 *      (cold-start neutro) + umbrales de fallo/cancelación/time-waster/deuda.
 *
 * `require_deposit` NO es cobro online (no hay pasarela; Fase H diferida; orders
 * cash-only): se resuelve como transferencia/anticipo verificado por un humano o
 * handoff. El gate solo EMITE el requerimiento; no toca el CHECK cash-only.
 *
 * Sin FK a public.tenants (VISTA en esta DB). tenant_id NOT NULL + RLS bastan.
 * Idempotente (hasTable).
 *
 * @param { import("knex").Knex } knex
 */
exports.up = async function (knex) {
  const TENANT_MD = '00000000-0000-0000-0000-00000000d01c';

  // ── 1. commercial.contact_trust_features ───────────────────────────────────
  if (!(await knex.schema.withSchema('commercial').hasTable('contact_trust_features'))) {
    await knex.schema.withSchema('commercial').createTable('contact_trust_features', (t) => {
      t.uuid('id').notNullable().defaultTo(knex.raw('gen_random_uuid()'));
      t.uuid('tenant_id').notNullable();
      t.text('phone').notNullable(); // E.164 canónico (dígitos, sin +)
      t.uuid('customer_id'); // si se resolvió

      t.integer('orders_created').notNullable().defaultTo(0);
      t.integer('orders_confirmed').notNullable().defaultTo(0);
      t.integer('orders_fulfilled').notNullable().defaultTo(0);
      t.integer('orders_cancelled').notNullable().defaultTo(0);
      // Entregas a domicilio: total vs fallidas (rechazo/no-localizado/dir-errónea) = no-show.
      t.integer('deliveries_total').notNullable().defaultTo(0);
      t.integer('deliveries_failed').notNullable().defaultTo(0);
      // Llamadas de televenta: total vs improductivas (no contesta / no venta).
      t.integer('calls_total').notNullable().defaultTo(0);
      t.integer('calls_unproductive').notNullable().defaultTo(0);
      // Conversaciones del bot: total vs sin pedido → señal "solo juega".
      t.integer('conversations_total').notNullable().defaultTo(0);
      t.integer('conversations_without_order').notNullable().defaultTo(0);
      t.integer('reservations_expired').notNullable().defaultTo(0); // apartados FIQ.6 vencidos
      t.decimal('balance', 14, 2).notNullable().defaultTo(0); // deuda snapshot

      t.integer('observations').notNullable().defaultTo(0); // volumen de señal (cold-start guard)
      t.decimal('risk_score', 5, 4).notNullable().defaultTo(0); // 0..1 (mayor = más riesgo)
      t.text('tier').notNullable().defaultTo('neutral'); // neutral|allow|require_deposit|block|handoff
      t.jsonb('reasons').notNullable().defaultTo('[]');
      t.timestamp('computed_at').notNullable().defaultTo(knex.fn.now());
      t.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
      t.timestamp('updated_at').notNullable().defaultTo(knex.fn.now());

      t.primary('id');
      t.unique(['tenant_id', 'phone'], { indexName: 'commercial_contact_trust_features_phone_unique' });
      t.check(
        `?? IN ('neutral','allow','require_deposit','block','handoff')`,
        ['tier'],
        'commercial_contact_trust_tier_valid',
      );
      t.index(['tenant_id', 'tier'], 'idx_contact_trust_tier');
      t.index(['tenant_id', 'customer_id'], 'idx_contact_trust_customer');
    });

    await knex.raw(`ALTER TABLE commercial.contact_trust_features ENABLE ROW LEVEL SECURITY`);
    await knex.raw(`ALTER TABLE commercial.contact_trust_features FORCE ROW LEVEL SECURITY`);
    await knex.raw(`
      CREATE POLICY tenant_isolation ON commercial.contact_trust_features
        USING (tenant_id = public.current_tenant_id())
        WITH CHECK (tenant_id = public.current_tenant_id())
    `);
    await knex.raw('GRANT SELECT, INSERT, UPDATE, DELETE ON commercial.contact_trust_features TO app_runtime');
    await knex.raw(`COMMENT ON TABLE commercial.contact_trust_features IS 'FIQ.7 (ADR-037): feature store del trust-score por contacto (E.164). Salida del detector determinista (tier + reasons). CERO LLM.'`);
  }

  // ── 2. commercial.trust_thresholds (config del gate por tenant) ─────────────
  if (!(await knex.schema.withSchema('commercial').hasTable('trust_thresholds'))) {
    await knex.schema.withSchema('commercial').createTable('trust_thresholds', (t) => {
      t.uuid('tenant_id').notNullable();
      t.integer('min_observations').notNullable().defaultTo(3); // < → tier neutral (cold-start)
      t.decimal('block_fail_rate', 4, 3).notNullable().defaultTo(0.5); // tasa entregas fallidas ≥ → block
      t.decimal('deposit_fail_rate', 4, 3).notNullable().defaultTo(0.25); // ≥ → require_deposit
      t.integer('block_fail_count').notNullable().defaultTo(2); // fallos absolutos ≥ (con tasa) → block
      t.decimal('deposit_cancel_rate', 4, 3).notNullable().defaultTo(0.5); // tasa cancelación ≥ → deposit
      t.integer('deposit_playing_convos').notNullable().defaultTo(6); // convos sin pedido ≥ (0 pedidos) → deposit
      t.decimal('deposit_min_balance', 14, 2).notNullable().defaultTo(0.01); // deuda ≥ → deposit
      t.timestamp('updated_at').notNullable().defaultTo(knex.fn.now());

      t.primary('tenant_id');
    });

    await knex.raw(`ALTER TABLE commercial.trust_thresholds ENABLE ROW LEVEL SECURITY`);
    await knex.raw(`ALTER TABLE commercial.trust_thresholds FORCE ROW LEVEL SECURITY`);
    await knex.raw(`
      CREATE POLICY tenant_isolation ON commercial.trust_thresholds
        USING (tenant_id = public.current_tenant_id())
        WITH CHECK (tenant_id = public.current_tenant_id())
    `);
    await knex.raw('GRANT SELECT, INSERT, UPDATE, DELETE ON commercial.trust_thresholds TO app_runtime');
    await knex.raw(`COMMENT ON TABLE commercial.trust_thresholds IS 'FIQ.7 (ADR-037): umbrales del gate de confianza por tenant (sin hardcode). require_deposit = transferencia/anticipo verificado por humano (no cobro online).'`);

    // Seed de defaults para Mega Dulces (idempotente por el hasTable de arriba).
    await knex('commercial.trust_thresholds').insert({ tenant_id: TENANT_MD }).onConflict('tenant_id').ignore();
  }
};

/**
 * @param { import("knex").Knex } knex
 */
exports.down = async function (knex) {
  await knex.schema.withSchema('commercial').dropTableIfExists('contact_trust_features');
  await knex.schema.withSchema('commercial').dropTableIfExists('trust_thresholds');
};
