'use strict';
/**
 * `[MCP.7]` — Liquidación contra la guía de carga (Fase MCP, ADR-089, D9/D10/D11).
 *
 * Al regresar, quien entregó liquida en caja las guías que trajo (una por ruta, D12). El efectivo
 * se cuenta UNA vez por denominación; las transferencias se liquidan con su referencia. Sustituye
 * la tira de ingresos reimpresa y firmada: el comprobante sale en PDF desde aquí.
 *
 *  · `commercial.load_guide_liquidations` — una por regreso: qué guías cubre, el total de los
 *    documentos entregados, lo declarado al entregar (efectivo / transferencia), lo contado y la
 *    diferencia. La diferencia SIEMPRE lleva nota (diferencia con nombre).
 *  · `commercial.load_guide_liquidation_sequences` — folio `LQP-YYYY-NNNNN`.
 *  · `commercial.load_guides` gana el estado `liquidada` y `liquidation_id`.
 *
 * ── Por qué NO se extiende `commercial.rider_liquidations` (Fase LM), como decía el plan ────────
 * Medido al diseñar: su esperado sale de `commercial.payments` (la preventa no escribe ahí: el
 * cobro es de Kepler), su llave única es UN corte por repartidor y día (el repartidor puede hacer
 * dos vueltas) y la cajera no tiene su permiso. Extenderla obligaba a romper las tres cosas en una
 * tabla que usa otra fase. Se calca su patrón (folio, arqueo jsonb, quién cierra) en una tabla propia.
 *
 * @param { import("knex").Knex } knex
 */

exports.up = async function up(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '3s'`);
  const S = () => knex.schema.withSchema('commercial');

  if (!(await S().hasTable('load_guide_liquidation_sequences'))) {
    await S().createTable('load_guide_liquidation_sequences', (t) => {
      t.uuid('tenant_id').notNullable();
      t.integer('year').notNullable();
      t.integer('current_value').notNullable().defaultTo(0);
      t.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
      t.primary(['tenant_id', 'year']);
    });
  }

  if (!(await S().hasTable('load_guide_liquidations'))) {
    await S().createTable('load_guide_liquidations', (t) => {
      t.uuid('tenant_id').notNullable();
      t.uuid('id').notNullable().defaultTo(knex.raw('gen_random_uuid()'));
      t.string('folio', 20).notNullable();
      // Quien entregó y liquida (el repartidor o el vendedor de las guías).
      t.uuid('rider_user_id').notNullable();
      t.string('branch', 4).notNullable();
      t.date('business_date').notNullable();
      // Σ de los documentos de Kepler ENTREGADOS en las guías (lo que Kepler ya dio por cobrado).
      t.decimal('documents_total', 14, 2).notNullable();
      // Lo que quien entregó declaró en el celular, pedido por pedido (MCP.6).
      t.decimal('declared_cash', 14, 2).notNullable();
      t.decimal('declared_transfer', 14, 2).notNullable();
      // El arqueo: lo que la caja contó, por denominación (catálogo de libs/contracts/money).
      t.decimal('counted_cash', 14, 2).notNullable();
      t.jsonb('cash_breakdown').notNullable();
      // contado − declarado: negativo = faltante, positivo = sobrante.
      t.decimal('cash_difference', 14, 2).notNullable();
      // Lo que Kepler dio por cobrado y quien entregó NO declaró cobrar, en pedidos entregados
      // "completo" (los "con diferencia" ya traen su nota por pedido). Es el hueco entre el documento
      // y lo declarado que nadie explicó: también exige nota.
      t.decimal('unexplained_difference', 14, 2).notNullable().defaultTo(0);
      t.text('notes');
      // La foto que se imprime y se firma; se reimprime desde aquí.
      t.jsonb('snapshot').notNullable();
      t.integer('print_count').notNullable().defaultTo(1);
      t.timestamp('liquidated_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
      t.uuid('liquidated_by').notNullable();
      t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
      t.primary(['tenant_id', 'id']);
    });
    await knex.raw(`ALTER TABLE commercial.load_guide_liquidations
      ADD CONSTRAINT load_guide_liquidations_montos_ck CHECK (
        documents_total >= 0 AND declared_cash >= 0 AND declared_transfer >= 0 AND counted_cash >= 0)`);
    // La diferencia no se captura: se deriva. Así no puede contradecir a lo contado y lo declarado.
    await knex.raw(`ALTER TABLE commercial.load_guide_liquidations
      ADD CONSTRAINT load_guide_liquidations_diferencia_ck CHECK (cash_difference = counted_cash - declared_cash)`);
    // Diferencia con nombre (D9): un faltante o sobrante sin explicación no se cierra.
    await knex.raw(`ALTER TABLE commercial.load_guide_liquidations
      ADD CONSTRAINT load_guide_liquidations_nota_ck CHECK (
        (cash_difference = 0 AND unexplained_difference = 0) OR NULLIF(btrim(notes), '') IS NOT NULL)`);
    await knex.raw(`CREATE UNIQUE INDEX IF NOT EXISTS ux_lgl_folio
      ON commercial.load_guide_liquidations (tenant_id, folio)`);
    await knex.raw(`CREATE INDEX IF NOT EXISTS ix_lgl_dia
      ON commercial.load_guide_liquidations (tenant_id, business_date, branch)`);
  }

  // La guía: `liquidada` ⇔ tiene su liquidación. Liquidada conserva la foto impresa.
  if (!(await S().hasColumn('load_guides', 'liquidation_id'))) {
    await S().alterTable('load_guides', (t) => t.uuid('liquidation_id'));
  }
  await knex.raw(`ALTER TABLE commercial.load_guides DROP CONSTRAINT IF EXISTS load_guides_liquidation_fk`);
  await knex.raw(`ALTER TABLE commercial.load_guides
    ADD CONSTRAINT load_guides_liquidation_fk FOREIGN KEY (tenant_id, liquidation_id)
    REFERENCES commercial.load_guide_liquidations(tenant_id, id)`);
  await knex.raw(`ALTER TABLE commercial.load_guides DROP CONSTRAINT IF EXISTS load_guides_status_ck`);
  await knex.raw(`ALTER TABLE commercial.load_guides
    ADD CONSTRAINT load_guides_status_ck CHECK (status IN ('abierta', 'impresa', 'liquidada', 'cancelada'))`);
  await knex.raw(`ALTER TABLE commercial.load_guides DROP CONSTRAINT IF EXISTS load_guides_impresa_ck`);
  await knex.raw(`ALTER TABLE commercial.load_guides
    ADD CONSTRAINT load_guides_impresa_ck CHECK (
      (status IN ('impresa', 'liquidada')) = (snapshot IS NOT NULL AND printed_at IS NOT NULL AND printed_by IS NOT NULL)
      OR status = 'cancelada')`);
  await knex.raw(`ALTER TABLE commercial.load_guides DROP CONSTRAINT IF EXISTS load_guides_liquidada_ck`);
  await knex.raw(`ALTER TABLE commercial.load_guides
    ADD CONSTRAINT load_guides_liquidada_ck CHECK ((status = 'liquidada') = (liquidation_id IS NOT NULL))`);
  await knex.raw(`CREATE INDEX IF NOT EXISTS ix_load_guides_liquidacion
    ON commercial.load_guides (tenant_id, liquidation_id) WHERE liquidation_id IS NOT NULL`);
  // Los intentos fallidos (I2) se cuentan por pedido en cada renglón de la mesa y al pescar.
  await knex.raw(`CREATE INDEX IF NOT EXISTS ix_lgo_pedido_fallido
    ON commercial.load_guide_orders (tenant_id, order_id) WHERE status IN ('regreso', 'no_entregado')`);

  for (const tabla of ['load_guide_liquidations', 'load_guide_liquidation_sequences']) {
    await knex.raw(`ALTER TABLE commercial.${tabla} ENABLE ROW LEVEL SECURITY`);
    await knex.raw(`ALTER TABLE commercial.${tabla} FORCE ROW LEVEL SECURITY`);
    await knex.raw(`DROP POLICY IF EXISTS ${tabla}_tenant ON commercial.${tabla}`);
    await knex.raw(`CREATE POLICY ${tabla}_tenant ON commercial.${tabla}
      USING (tenant_id = public.current_tenant_id())
      WITH CHECK (tenant_id = public.current_tenant_id())`);
    // Sin DELETE: una liquidación cerrada es un comprobante firmado.
    await knex.raw(`GRANT SELECT, INSERT, UPDATE ON commercial.${tabla} TO app_runtime`);
  }

  await knex.raw(`COMMENT ON TABLE commercial.load_guide_liquidations IS
    'MCP.7 — liquidación de las guías de carga de preventa al regresar: documentos entregados, efectivo/transferencia declarados, arqueo por denominación y diferencia con nota. Sustituye la tira de ingresos reimpresa.'`);

  // ── COMPUERTAS ───────────────────────────────────────────────────────────────────────
  for (const tabla of ['load_guide_liquidations', 'load_guide_liquidation_sequences']) {
    const { rows } = await knex.raw(`
      SELECT c.relrowsecurity AS on, c.relforcerowsecurity AS forced
        FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'commercial' AND c.relname = ?`, [tabla]);
    if (!rows[0]?.on || !rows[0]?.forced) throw new Error(`[MCP.7] RLS no quedó forzado en ${tabla}.`);
  }

  // PRUEBA NEGATIVA: un faltante sin nota tiene que rebotar.
  const { rows: usuario } = await knex.raw(`SELECT tenant_id, id FROM identity.users LIMIT 1`);
  if (!usuario.length) {
    console.log('  [MCP.7] ◻ NO MEDIDO: no hay un usuario con el que probar el CHECK de la nota.');
  } else {
    await knex.raw('SAVEPOINT mcp7_neg');
    await knex.raw(`SELECT set_config('app.tenant_id', ?, true)`, [usuario[0].tenant_id]);
    let rebotó = false;
    try {
      await knex.raw(
        `INSERT INTO commercial.load_guide_liquidations
           (tenant_id, folio, rider_user_id, branch, business_date, documents_total, declared_cash,
            declared_transfer, counted_cash, cash_breakdown, cash_difference, notes, snapshot, liquidated_by)
         VALUES (?, 'LQP-CANDADO', ?, '99', current_date, 100, 100, 0, 90, '{}'::jsonb, -10, NULL, '{}'::jsonb, ?)`,
        [usuario[0].tenant_id, usuario[0].id, usuario[0].id],
      );
    } catch (e) {
      rebotó = /load_guide_liquidations_nota_ck/i.test(e.message);
    }
    await knex.raw('ROLLBACK TO SAVEPOINT mcp7_neg');
    await knex.raw('RELEASE SAVEPOINT mcp7_neg');
    if (!rebotó) throw new Error('[MCP.7] el CHECK dejó cerrar un faltante sin nota: es decorativo.');
    console.log('  [MCP.7] prueba negativa OK: un faltante sin nota no se liquida.');
  }
  console.log('  [MCP.7] liquidación de guías lista · RLS forzado.');
};

/**
 * ⚠️ Si ya hubo liquidaciones, sus guías vuelven a `impresa` y el comprobante se pierde con la tabla.
 */
exports.down = async function down(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '3s'`);
  for (const ck of ['liquidada', 'impresa', 'status']) {
    await knex.raw(`ALTER TABLE commercial.load_guides DROP CONSTRAINT IF EXISTS load_guides_${ck}_ck`);
  }
  await knex.raw(`ALTER TABLE commercial.load_guides DROP CONSTRAINT IF EXISTS load_guides_liquidation_fk`);
  await knex.raw(`UPDATE commercial.load_guides SET status = 'impresa' WHERE status = 'liquidada'`);
  await knex.raw(`DROP INDEX IF EXISTS commercial.ix_load_guides_liquidacion`);
  await knex.raw(`DROP INDEX IF EXISTS commercial.ix_lgo_pedido_fallido`);
  await knex.raw(`ALTER TABLE commercial.load_guides DROP COLUMN IF EXISTS liquidation_id`);
  await knex.raw(`ALTER TABLE commercial.load_guides
    ADD CONSTRAINT load_guides_status_ck CHECK (status IN ('abierta', 'impresa', 'cancelada'))`);
  await knex.raw(`ALTER TABLE commercial.load_guides
    ADD CONSTRAINT load_guides_impresa_ck CHECK (
      (status = 'impresa') = (snapshot IS NOT NULL AND printed_at IS NOT NULL AND printed_by IS NOT NULL)
      OR status = 'cancelada')`);
  await knex.raw('DROP TABLE IF EXISTS commercial.load_guide_liquidations');
  await knex.raw('DROP TABLE IF EXISTS commercial.load_guide_liquidation_sequences');
};
