'use strict';
/**
 * `[MCP.6]` — Entrega de conformidad de la preventa, en el renglón de la guía de carga (Fase MCP, ADR-089).
 *
 * El repartidor (o el vendedor) registra en su celular, por cada pedido de su guía impresa:
 *  · que lo ENTREGÓ — completo o con diferencia (con nota) —, con qué documento de Kepler (la liga
 *    queda en `commercial.order_kepler_documents` con origen `celular`) y cómo le pagaron:
 *    efectivo y/o transferencia con su referencia (D11). Es la base de la liquidación (MCP.7).
 *  · o que NO SE PUDO entregar (con motivo): el pedido queda libre para salir otro día (D10).
 *
 * ── Por qué en el renglón y NO en `commercial.orders.status` ────────────────────────────────────
 * Marcar el pedido `fulfilled` lo haría FACTURAR: el reintento automático de CFDI
 * (`commercial-orders.service`, FE.5) toma todo pedido `fulfilled` sin `cfdi_uuid` cuyo cliente tenga
 * datos fiscales — y la venta de preventa YA se cobró y facturó en Kepler (D1). Además `fulfill()`
 * descuenta `commercial.stock`, que Kepler ya descontó. La mesa deriva "Entregado" de este renglón.
 *
 * Estados del renglón: 'cargado' → 'entregado' | 'no_entregado' (campo) | 'regreso' (caja) | 'quitado'.
 *
 * @param { import("knex").Knex } knex
 */

const T = 'commercial.load_guide_orders';

exports.up = async function up(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '3s'`);

  const cols = [
    ['delivered_at', (t) => t.timestamp('delivered_at', { useTz: true })],
    ['delivered_by', (t) => t.uuid('delivered_by')],
    // 'completo' | 'con_diferencia'
    ['delivery_outcome', (t) => t.string('delivery_outcome', 16)],
    ['delivery_note', (t) => t.text('delivery_note')],
    // Lo que cobró quien entregó (D11). NULL mientras no se entrega; nunca se inventa un 0.
    ['cash_amount', (t) => t.decimal('cash_amount', 14, 2)],
    ['transfer_amount', (t) => t.decimal('transfer_amount', 14, 2)],
    ['transfer_ref', (t) => t.string('transfer_ref', 60)],
    // El documento de Kepler que se ENTREGÓ, en el renglón: el cobro queda atado a ese documento
    // aunque la liga se corrigiera después (revisión independiente, 2026-10-08).
    ['delivered_folio_digital', (t) => t.string('delivered_folio_digital', 32)],
  ];
  for (const [col, def] of cols) {
    if (!(await knex.schema.withSchema('commercial').hasColumn('load_guide_orders', col))) {
      await knex.schema.withSchema('commercial').alterTable('load_guide_orders', (t) => def(t));
    }
  }

  // Los CHECK se rehacen: los estados nuevos de la entrega entran aquí.
  await knex.raw(`ALTER TABLE ${T} DROP CONSTRAINT IF EXISTS load_guide_orders_status_ck`);
  await knex.raw(`ALTER TABLE ${T} ADD CONSTRAINT load_guide_orders_status_ck
    CHECK (status IN ('cargado', 'quitado', 'regreso', 'entregado', 'no_entregado'))`);
  await knex.raw(`ALTER TABLE ${T} DROP CONSTRAINT IF EXISTS load_guide_orders_quitado_ck`);
  await knex.raw(`ALTER TABLE ${T} ADD CONSTRAINT load_guide_orders_quitado_ck
    CHECK ((status IN ('quitado', 'regreso', 'no_entregado')) = (removed_at IS NOT NULL AND removed_by IS NOT NULL))`);
  // Entregado ⇔ quién, cuándo, cómo salió y cuánto se cobró (aunque sea 0 declarado).
  await knex.raw(`ALTER TABLE ${T} DROP CONSTRAINT IF EXISTS load_guide_orders_entregado_ck`);
  await knex.raw(`ALTER TABLE ${T} ADD CONSTRAINT load_guide_orders_entregado_ck
    CHECK ((status = 'entregado') = (
      delivered_at IS NOT NULL AND delivered_by IS NOT NULL AND delivery_outcome IS NOT NULL
      AND delivered_folio_digital IS NOT NULL
      AND cash_amount IS NOT NULL AND transfer_amount IS NOT NULL))`);
  await knex.raw(`ALTER TABLE ${T} DROP CONSTRAINT IF EXISTS load_guide_orders_outcome_ck`);
  await knex.raw(`ALTER TABLE ${T} ADD CONSTRAINT load_guide_orders_outcome_ck
    CHECK (delivery_outcome IS NULL OR delivery_outcome IN ('completo', 'con_diferencia'))`);
  // Sin cobros negativos, y una transferencia lleva su referencia (D11).
  await knex.raw(`ALTER TABLE ${T} DROP CONSTRAINT IF EXISTS load_guide_orders_pago_ck`);
  await knex.raw(`ALTER TABLE ${T} ADD CONSTRAINT load_guide_orders_pago_ck
    CHECK (coalesce(cash_amount, 0) >= 0 AND coalesce(transfer_amount, 0) >= 0
           AND (coalesce(transfer_amount, 0) = 0 OR NULLIF(btrim(transfer_ref), '') IS NOT NULL))`);
  // "Con diferencia" sin decir cuál no sirve para la liquidación.
  await knex.raw(`ALTER TABLE ${T} DROP CONSTRAINT IF EXISTS load_guide_orders_diferencia_ck`);
  await knex.raw(`ALTER TABLE ${T} ADD CONSTRAINT load_guide_orders_diferencia_ck
    CHECK (delivery_outcome IS DISTINCT FROM 'con_diferencia' OR NULLIF(btrim(delivery_note), '') IS NOT NULL)`);

  // Un pedido ENTREGADO no se vuelve a entregar en otra guía.
  await knex.raw(`CREATE UNIQUE INDEX IF NOT EXISTS ux_lgo_pedido_entregado
    ON ${T} (tenant_id, order_id) WHERE status = 'entregado'`);

  // ── COMPUERTA: prueba negativa del CHECK de transferencia sin referencia ─────────────────
  const { rows: r } = await knex.raw(`SELECT tenant_id, id FROM ${T} WHERE status = 'cargado' LIMIT 1`);
  if (!r.length) {
    console.log('  [MCP.6] ◻ NO MEDIDO: no hay un renglón cargado con el que probar los CHECK.');
  } else {
    await knex.raw('SAVEPOINT mcp6_neg');
    await knex.raw(`SELECT set_config('app.tenant_id', ?, true)`, [r[0].tenant_id]);
    let rebotó = false;
    try {
      await knex.raw(
        `UPDATE ${T} SET status = 'entregado', delivered_at = now(), delivered_by = gen_random_uuid(),
                delivery_outcome = 'completo', delivered_folio_digital = '00UD0000-0000000', cash_amount = 0, transfer_amount = 100, transfer_ref = NULL
          WHERE id = ?`,
        [r[0].id],
      );
    } catch (e) {
      rebotó = /load_guide_orders_pago_ck/i.test(e.message);
    }
    await knex.raw('ROLLBACK TO SAVEPOINT mcp6_neg');
    await knex.raw('RELEASE SAVEPOINT mcp6_neg');
    if (!rebotó) throw new Error('[MCP.6] el CHECK dejó registrar una transferencia sin referencia: es decorativo.');
    console.log('  [MCP.6] prueba negativa OK: una transferencia sin referencia no se registra.');
  }
  console.log('  [MCP.6] entrega de conformidad lista en load_guide_orders.');
};

/**
 * ⚠️ DESTRUCTIVO si ya hubo entregas: los renglones 'entregado' y 'no_entregado' pasan a 'regreso'
 * (con su motivo) para que los CHECK viejos entren, y lo cobrado se pierde con las columnas.
 */
exports.down = async function down(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '3s'`);
  await knex.raw(`DROP INDEX IF EXISTS commercial.ux_lgo_pedido_entregado`);
  for (const ck of ['entregado', 'outcome', 'pago', 'diferencia', 'status', 'quitado']) {
    await knex.raw(`ALTER TABLE ${T} DROP CONSTRAINT IF EXISTS load_guide_orders_${ck}_ck`);
  }
  await knex.raw(`UPDATE ${T}
       SET removed_at = coalesce(removed_at, delivered_at, now()),
           removed_by = coalesce(removed_by, delivered_by),
           removed_reason = coalesce(removed_reason, '[down MCP.6] estaba ' || status),
           status = 'regreso'
     WHERE status IN ('entregado', 'no_entregado')`);
  await knex.raw(`ALTER TABLE ${T} ADD CONSTRAINT load_guide_orders_status_ck CHECK (status IN ('cargado', 'quitado', 'regreso'))`);
  await knex.raw(`ALTER TABLE ${T} ADD CONSTRAINT load_guide_orders_quitado_ck CHECK ((status IN ('quitado', 'regreso')) = (removed_at IS NOT NULL AND removed_by IS NOT NULL))`);
  for (const col of ['delivered_at', 'delivered_by', 'delivery_outcome', 'delivery_note', 'cash_amount', 'transfer_amount', 'transfer_ref', 'delivered_folio_digital']) {
    await knex.raw(`ALTER TABLE ${T} DROP COLUMN IF EXISTS ${col}`);
  }
};
