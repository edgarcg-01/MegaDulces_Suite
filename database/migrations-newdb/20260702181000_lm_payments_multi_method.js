/**
 * Fase LM.0 (M1bis + M3) — pagos multi-método (quita cash-only GLOBAL).
 *
 * DECISIÓN 2026-07-02 (ADR-027): se acepta el cambio a nivel de TODA la
 * plataforma, no solo domicilio. Cierra la deuda "PaymentsService deferred
 * post-beta" de Fase B. Métodos: cash | transfer | card | prepaid.
 *
 *   'card' = SOLO registro/captura (terminal externa cobró). NO hay pasarela
 *            ni terminal integrada — se guarda el hecho + referencia/voucher.
 *            Procesamiento real de tarjeta → Fase H.
 *
 * Columnas nuevas en payments para el flujo de última milla:
 *   - status: received | verified | reversed (transfer requiere verificación).
 *   - cash_received / change_given: efectivo recibido y cambio (§8.2, solo cash).
 *   - proof_url: comprobante transferencia / foto de voucher de tarjeta.
 *   - liquidation_id: FK al corte de caja del repartidor (se cablea en M5).
 *
 * Idempotente: DROP CONSTRAINT IF EXISTS + hasColumn.
 *
 * @param { import("knex").Knex } knex
 */
exports.up = async function (knex) {
  // ── orders.payment_method: quitar cash-only ──────────────────────────────
  await knex.raw(`ALTER TABLE commercial.orders DROP CONSTRAINT IF EXISTS commercial_orders_payment_method_beta_cash_only`);
  await knex.raw(`ALTER TABLE commercial.orders DROP CONSTRAINT IF EXISTS commercial_orders_payment_method_check`);
  await knex.raw(`
    ALTER TABLE commercial.orders
      ADD CONSTRAINT commercial_orders_payment_method_check
      CHECK (payment_method IN ('cash', 'transfer', 'card', 'prepaid'))
  `);

  // ── payments.payment_method: quitar cash-only ────────────────────────────
  await knex.raw(`ALTER TABLE commercial.payments DROP CONSTRAINT IF EXISTS commercial_payments_method_beta_cash_only`);
  await knex.raw(`ALTER TABLE commercial.payments DROP CONSTRAINT IF EXISTS commercial_payments_method_check`);
  await knex.raw(`
    ALTER TABLE commercial.payments
      ADD CONSTRAINT commercial_payments_method_check
      CHECK (payment_method IN ('cash', 'transfer', 'card', 'prepaid'))
  `);

  // ── payments: columnas nuevas ────────────────────────────────────────────
  const add = async (col, cb) => {
    if (!(await knex.schema.hasColumn('commercial.payments', col))) {
      await knex.schema.withSchema('commercial').alterTable('payments', cb);
    }
  };
  await add('status', (t) => t.string('status', 20).notNullable().defaultTo('received'));
  await add('cash_received', (t) => t.decimal('cash_received', 14, 2));
  await add('change_given', (t) => t.decimal('change_given', 14, 2));
  await add('proof_url', (t) => t.text('proof_url'));
  await add('liquidation_id', (t) => t.uuid('liquidation_id')); // FK se agrega en M5

  await knex.raw(`ALTER TABLE commercial.payments DROP CONSTRAINT IF EXISTS commercial_payments_status_check`);
  await knex.raw(`
    ALTER TABLE commercial.payments
      ADD CONSTRAINT commercial_payments_status_check
      CHECK (status IN ('received', 'verified', 'reversed'))
  `);

  await knex.raw(`
    COMMENT ON COLUMN commercial.payments.payment_method IS
      'cash | transfer | card | prepaid. card = SOLO registro (terminal externa), sin pasarela integrada. reference = folio transferencia o nº autorización/voucher.'
  `);
};

/**
 * @param { import("knex").Knex } knex
 */
exports.down = async function (knex) {
  await knex.raw(`ALTER TABLE commercial.payments DROP CONSTRAINT IF EXISTS commercial_payments_status_check`);
  for (const col of ['liquidation_id', 'proof_url', 'change_given', 'cash_received', 'status']) {
    if (await knex.schema.hasColumn('commercial.payments', col)) {
      await knex.schema.withSchema('commercial').alterTable('payments', (t) => t.dropColumn(col));
    }
  }
  // Revertir a cash-only (estado beta original).
  await knex.raw(`ALTER TABLE commercial.payments DROP CONSTRAINT IF EXISTS commercial_payments_method_check`);
  await knex.raw(`ALTER TABLE commercial.payments ADD CONSTRAINT commercial_payments_method_beta_cash_only CHECK (payment_method IN ('cash'))`);
  await knex.raw(`ALTER TABLE commercial.orders DROP CONSTRAINT IF EXISTS commercial_orders_payment_method_check`);
  await knex.raw(`ALTER TABLE commercial.orders ADD CONSTRAINT commercial_orders_payment_method_beta_cash_only CHECK (payment_method IN ('cash'))`);
};
