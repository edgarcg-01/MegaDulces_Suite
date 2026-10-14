'use strict';
/**
 * `[MCP.3]` + `[MCP.8]` — el surtido de UN pedido de preventa: quién lo empezó y a qué hora,
 * quién lo terminó, si hubo todo, y lo que se quitó del pedido.
 *
 * ── Por qué una tabla nueva ─────────────────────────────────────────────────────────────────
 * Las olas de la consola (`commercial.picking_waves`) registran quién y cuándo POR OLA, no por
 * pedido (`wave_orders` sólo tiene `added_*` y `verified_*`). El surtidor de la sucursal surte la
 * preventa pedido por pedido desde su bandeja, y la vendedora necesita ver el nombre y la hora de
 * SU pedido. Es un dato propio (HITL), no una copia: nada de esto existe en el ODS.
 *
 * ── Lo medido antes (prod, sólo lectura, 2026-10-13) ────────────────────────────────────────
 *  · 32 preventas abiertas; 1 sola entró a una ola (PD-2026-00068, W-2026-00021).
 *  · 4 avisos en `order_notifications`, 0 con acuse.
 *
 * ── Lo que guarda ───────────────────────────────────────────────────────────────────────────
 *  · `started_*`  — quien tocó «Empezar a surtir» y la hora (decisión de David, 2026-10-14).
 *  · `finished_*` — quien cerró y la hora; `outcome` completo / con_faltantes.
 *  · `report`     — lo que se quitó y lo que se ajustó, con el total antes y después. Se congela al
 *                   cerrar porque los renglones del pedido CAMBIAN (lo que no hubo se borra).
 *  · `seller_seen_at` — la vendedora vio el reporte.
 *
 * ⚠️ El código nuevo lee esta tabla: aplicarla ANTES de desplegar.
 *
 * Idempotente.
 *
 * @param { import("knex").Knex } knex
 */

exports.up = async function up(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);

  const existe = await knex.schema.withSchema('commercial').hasTable('presale_picks');
  if (!existe) {
    await knex.schema.withSchema('commercial').createTable('presale_picks', (t) => {
      t.uuid('tenant_id').notNullable().defaultTo(knex.raw('public.current_tenant_id()'));
      t.uuid('id').notNullable().defaultTo(knex.raw('gen_random_uuid()'));
      t.uuid('order_id').notNullable();
      t.uuid('warehouse_id').notNullable();
      t.uuid('started_by').notNullable();
      // Nombre de la ficha AL MOMENTO de empezar: si mañana cambia, el pedido sigue diciendo
      // quién lo surtió ese día.
      t.string('started_by_name', 160).notNullable();
      t.timestamp('started_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
      t.uuid('finished_by');
      t.string('finished_by_name', 160);
      t.timestamp('finished_at', { useTz: true });
      t.string('outcome', 20);
      t.jsonb('report');
      t.timestamp('seller_seen_at', { useTz: true });
      t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
      t.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
      t.primary(['tenant_id', 'id']);
    });

    await knex.raw(`
      ALTER TABLE commercial.presale_picks
        ADD CONSTRAINT presale_picks_order_fk
        FOREIGN KEY (tenant_id, order_id) REFERENCES commercial.orders(tenant_id, id)
        ON DELETE CASCADE`);
    await knex.raw(`
      ALTER TABLE commercial.presale_picks
        ADD CONSTRAINT presale_picks_wh_fk
        FOREIGN KEY (tenant_id, warehouse_id) REFERENCES commercial.warehouses(tenant_id, id)`);
    // Un pedido se surte una vez: dos personas no pueden empezar el mismo pedido.
    await knex.raw(`
      CREATE UNIQUE INDEX IF NOT EXISTS ux_presale_picks_order
        ON commercial.presale_picks (tenant_id, order_id)`);
    await knex.raw(`
      CREATE INDEX IF NOT EXISTS idx_presale_picks_wh
        ON commercial.presale_picks (tenant_id, warehouse_id, finished_at)`);

    // El cierre es coherente o no es: quién, cuándo y cómo se ponen JUNTOS.
    await knex.raw(`
      ALTER TABLE commercial.presale_picks
        ADD CONSTRAINT presale_picks_cierre_ck
        CHECK (
          (finished_at IS NULL AND finished_by IS NULL AND outcome IS NULL)
          OR (finished_at IS NOT NULL AND finished_by IS NOT NULL
              AND outcome IN ('completo', 'con_faltantes') AND finished_at >= started_at)
        )`);
    // Con faltantes sin reporte no se le puede decir a la vendedora qué faltó.
    await knex.raw(`
      ALTER TABLE commercial.presale_picks
        ADD CONSTRAINT presale_picks_reporte_ck
        CHECK (outcome IS DISTINCT FROM 'con_faltantes' OR report IS NOT NULL)`);
  }

  await knex.raw('ALTER TABLE commercial.presale_picks ENABLE ROW LEVEL SECURITY');
  await knex.raw('ALTER TABLE commercial.presale_picks FORCE ROW LEVEL SECURITY');
  await knex.raw('DROP POLICY IF EXISTS presale_picks_tenant ON commercial.presale_picks');
  await knex.raw(`
    CREATE POLICY presale_picks_tenant ON commercial.presale_picks
      USING (tenant_id = public.current_tenant_id())
      WITH CHECK (tenant_id = public.current_tenant_id())`);
  await knex.raw('GRANT SELECT, INSERT, UPDATE ON commercial.presale_picks TO app_runtime');

  await knex.raw(`COMMENT ON TABLE commercial.presale_picks IS
    'MCP.3/MCP.8 — surtido de un pedido de preventa: quién empezó y a qué hora, quién terminó, si hubo todo y lo que se quitó del pedido (report). Dato propio; el pedido y sus renglones viven en commercial.orders/order_lines.'`);

  // ── COMPUERTAS ─────────────────────────────────────────────────────────────────────────
  const { rows: rls } = await knex.raw(`
    SELECT c.relrowsecurity AS on, c.relforcerowsecurity AS forced
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'commercial' AND c.relname = 'presale_picks'`);
  if (!rls[0]?.on || !rls[0]?.forced) {
    throw new Error('[MCP.3] RLS no quedó habilitado+forzado en presale_picks.');
  }

  // PRUEBA NEGATIVA del CHECK de cierre: un `outcome` sin `finished_at` debe rebotar.
  // Dentro de un SAVEPOINT (la migración corre en una sola transacción) y con un pedido SIN
  // surtido: si no hay sujeto, se DECLARA en vez de darse por buena.
  const { rows: sujeto } = await knex.raw(`
    SELECT o.tenant_id, o.id, o.warehouse_id, o.user_id
      FROM commercial.orders o
     WHERE o.warehouse_id IS NOT NULL AND o.user_id IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM commercial.presale_picks p
                        WHERE p.tenant_id = o.tenant_id AND p.order_id = o.id)
     LIMIT 1`);
  if (!sujeto.length) {
    console.log('  [MCP.3] ◻ NO MEDIDO: no hay un pedido sin surtido con el que probar el CHECK de cierre.');
  } else {
    await knex.raw('SAVEPOINT mcp3_neg');
    let reboto = false;
    try {
      await knex.raw(
        `INSERT INTO commercial.presale_picks
           (tenant_id, order_id, warehouse_id, started_by, started_by_name, outcome)
         VALUES (?, ?, ?, ?, 'prueba', 'completo')`,
        [sujeto[0].tenant_id, sujeto[0].id, sujeto[0].warehouse_id, sujeto[0].user_id],
      );
    } catch (e) {
      reboto = /presale_picks_cierre_ck|violates check/i.test(e.message);
    }
    await knex.raw('ROLLBACK TO SAVEPOINT mcp3_neg');
    await knex.raw('RELEASE SAVEPOINT mcp3_neg');
    if (!reboto) {
      throw new Error('[MCP.3] el CHECK de cierre NO rechazó un outcome sin finished_at: es decorativo.');
    }
    console.log('  [MCP.3] prueba negativa del cierre OK.');
  }
  console.log('  [MCP.3] presale_picks lista · RLS forzado.');
};

/** Deshace EXACTAMENTE lo que hizo el `up`. */
exports.down = async function down(knex) {
  await knex.raw('DROP TABLE IF EXISTS commercial.presale_picks');
};
