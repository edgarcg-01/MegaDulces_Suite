'use strict';
/**
 * `[MCP.5]` — Guías de carga de preventa (Fase MCP, ADR-089).
 *
 * El repartidor (o el vendedor) PESCA en su celular los pedidos de preventa (`PD-`) que se lleva, y
 * la cajera imprime la GUÍA DE CARGA que él firma como constancia de lo que se lleva (D8). En MCP.7
 * la liquidación se hace contra esa guía (D9). Una guía por (repartidor, sucursal, ruta, día) (D12).
 *
 * ── Por qué tablas propias y no las que ya existen ───────────────────────────────────────────────
 *  · `logistics.delivery_guides` cuelga de un embarque y de choferes de flota: es otra cosa.
 *  · `commercial.home_deliveries` es la entrega a domicilio (Fase LM) y su entrega FACTURA y mueve
 *    stock; la preventa se cobra en Kepler (D1), así que no se puede reusar.
 *  · Ninguna columna de `commercial.orders` dice quién lleva el pedido (`user_id` es quien lo levantó).
 *
 * ── Tablas ────────────────────────────────────────────────────────────────────────────────────────
 *  · `commercial.load_guides`        — la guía: folio `GDC-YYYY-NNNNN`, quién la lleva, sucursal,
 *                                      ruta, día, estado y la FOTO de su contenido al imprimirse.
 *  · `commercial.load_guide_orders`  — qué pedidos lleva. Un pedido sólo puede estar CARGADO en una
 *                                      guía a la vez; si no se entrega, sale otro día en otra (D10).
 *  · `commercial.load_guide_sequences` — contador atómico del folio por año.
 *
 * Estados de la guía: `abierta` (se le pueden agregar o quitar pedidos) → `impresa` (la cajera la
 * imprimió; queda congelada en `snapshot` y se reimprime igual) · `cancelada`.
 *
 * @param { import("knex").Knex } knex
 */

exports.up = async function up(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '3s'`);
  // Un constructor NUEVO por operación: Knex acumula las instrucciones en el mismo objeto y, reusado,
  // repetía el CREATE de la tabla anterior (medido al correr la migración de verdad).
  const S = () => knex.schema.withSchema('commercial');

  if (!(await S().hasTable('load_guide_sequences'))) {
    await S().createTable('load_guide_sequences', (t) => {
      t.uuid('tenant_id').notNullable();
      t.integer('year').notNullable();
      t.integer('current_value').notNullable().defaultTo(0);
      t.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
      t.primary(['tenant_id', 'year']);
    });
  }

  if (!(await S().hasTable('load_guides'))) {
    await S().createTable('load_guides', (t) => {
      t.uuid('tenant_id').notNullable();
      t.uuid('id').notNullable().defaultTo(knex.raw('gen_random_uuid()'));
      t.string('folio', 20).notNullable();
      // Quien se lleva la mercancía (repartidor o vendedor).
      t.uuid('rider_user_id').notNullable();
      // Sucursal Kepler (2 dígitos) de los pedidos: una guía no mezcla sucursales.
      t.string('branch', 4).notNullable();
      // Ruta de venta (customers.sales_route). 'SIN RUTA' cuando el cliente no tiene.
      t.string('sales_route', 80).notNullable();
      t.date('business_date').notNullable();
      t.string('status', 12).notNullable().defaultTo('abierta');
      // La foto de la guía al imprimirse: lo que firmó el repartidor. Se reimprime desde aquí.
      t.jsonb('snapshot');
      t.timestamp('printed_at', { useTz: true });
      t.uuid('printed_by');
      t.integer('print_count').notNullable().defaultTo(0);
      t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
      t.uuid('created_by');
      t.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
      t.uuid('updated_by');
      t.primary(['tenant_id', 'id']);
    });
    await knex.raw(`ALTER TABLE commercial.load_guides
      ADD CONSTRAINT load_guides_status_ck CHECK (status IN ('abierta', 'impresa', 'cancelada'))`);
    // Impresa ⇔ tiene foto, fecha y quién la imprimió. Una guía "impresa" sin lo que se firmó
    // no se podría reimprimir ni liquidar.
    await knex.raw(`ALTER TABLE commercial.load_guides
      ADD CONSTRAINT load_guides_impresa_ck CHECK (
        (status = 'impresa') = (snapshot IS NOT NULL AND printed_at IS NOT NULL AND printed_by IS NOT NULL)
        OR status = 'cancelada')`);
    await knex.raw(`CREATE UNIQUE INDEX IF NOT EXISTS ux_load_guides_folio
      ON commercial.load_guides (tenant_id, folio)`);
    // Una sola guía ABIERTA por (repartidor, sucursal, ruta, día): pescar más pedidos de la misma
    // ruta los agrega a esa. Ya impresa, lo que se pesque después va en una guía nueva.
    await knex.raw(`CREATE UNIQUE INDEX IF NOT EXISTS ux_load_guides_abierta
      ON commercial.load_guides (tenant_id, rider_user_id, branch, sales_route, business_date)
      WHERE status = 'abierta'`);
    await knex.raw(`CREATE INDEX IF NOT EXISTS ix_load_guides_dia
      ON commercial.load_guides (tenant_id, business_date, branch)`);
  }

  if (!(await S().hasTable('load_guide_orders'))) {
    await S().createTable('load_guide_orders', (t) => {
      t.uuid('tenant_id').notNullable();
      t.uuid('id').notNullable().defaultTo(knex.raw('gen_random_uuid()'));
      t.uuid('guide_id').notNullable();
      t.uuid('order_id').notNullable();
      t.string('status', 14).notNullable().defaultTo('cargado');
      t.timestamp('added_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
      t.uuid('added_by').notNullable();
      t.timestamp('removed_at', { useTz: true });
      t.uuid('removed_by');
      // Por qué salió: el motivo del regreso que captura la caja, o "pedido cancelado".
      t.text('removed_reason');
      t.primary(['tenant_id', 'id']);
    });
    await knex.raw(`ALTER TABLE commercial.load_guide_orders
      ADD CONSTRAINT load_guide_orders_guide_fk FOREIGN KEY (tenant_id, guide_id)
      REFERENCES commercial.load_guides(tenant_id, id) ON DELETE CASCADE`);
    await knex.raw(`ALTER TABLE commercial.load_guide_orders
      ADD CONSTRAINT load_guide_orders_order_fk FOREIGN KEY (tenant_id, order_id)
      REFERENCES commercial.orders(tenant_id, id) ON DELETE CASCADE`);
    // 'cargado' · 'quitado' (lo quitó el repartidor antes de imprimir, o se canceló el pedido) ·
    // 'regreso' (la guía ya impresa y el pedido volvió sin entregarse: sale otro día, D10).
    // MCP.6 agregará los estados de la entrega.
    await knex.raw(`ALTER TABLE commercial.load_guide_orders
      ADD CONSTRAINT load_guide_orders_status_ck CHECK (status IN ('cargado', 'quitado', 'regreso'))`);
    await knex.raw(`ALTER TABLE commercial.load_guide_orders
      ADD CONSTRAINT load_guide_orders_quitado_ck CHECK ((status IN ('quitado', 'regreso')) = (removed_at IS NOT NULL AND removed_by IS NOT NULL))`);
    // Un pedido sólo puede ir CARGADO en una guía a la vez.
    await knex.raw(`CREATE UNIQUE INDEX IF NOT EXISTS ux_lgo_pedido_cargado
      ON commercial.load_guide_orders (tenant_id, order_id) WHERE status = 'cargado'`);
    await knex.raw(`CREATE INDEX IF NOT EXISTS ix_lgo_guia
      ON commercial.load_guide_orders (tenant_id, guide_id)`);
  }

  for (const tabla of ['load_guides', 'load_guide_orders', 'load_guide_sequences']) {
    await knex.raw(`ALTER TABLE commercial.${tabla} ENABLE ROW LEVEL SECURITY`);
    await knex.raw(`ALTER TABLE commercial.${tabla} FORCE ROW LEVEL SECURITY`);
    await knex.raw(`DROP POLICY IF EXISTS ${tabla}_tenant ON commercial.${tabla}`);
    await knex.raw(`CREATE POLICY ${tabla}_tenant ON commercial.${tabla}
      USING (tenant_id = public.current_tenant_id())
      WITH CHECK (tenant_id = public.current_tenant_id())`);
    // Sin DELETE: un pedido se QUITA de la guía y una guía se CANCELA; no se borran.
    await knex.raw(`GRANT SELECT, INSERT, UPDATE ON commercial.${tabla} TO app_runtime`);
  }

  await knex.raw(`COMMENT ON TABLE commercial.load_guides IS
    'MCP.5 — guía de carga de preventa: una por (repartidor, sucursal, ruta, día). Al imprimirse se congela en snapshot (lo que firmó el repartidor) y se reimprime igual. Base de la liquidación (MCP.7).'`);
  await knex.raw(`COMMENT ON TABLE commercial.load_guide_orders IS
    'MCP.5 — pedidos PD- que lleva cada guía. Un pedido sólo puede estar cargado en una guía a la vez.'`);

  // ── COMPUERTAS ───────────────────────────────────────────────────────────────────────
  for (const tabla of ['load_guides', 'load_guide_orders', 'load_guide_sequences']) {
    const { rows } = await knex.raw(`
      SELECT c.relrowsecurity AS on, c.relforcerowsecurity AS forced
        FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'commercial' AND c.relname = ?`, [tabla]);
    if (!rows[0]?.on || !rows[0]?.forced) throw new Error(`[MCP.5] RLS no quedó forzado en ${tabla}.`);
  }

  // PRUEBA NEGATIVA: el mismo pedido cargado en dos guías tiene que rebotar.
  const { rows: pedido } = await knex.raw(`
    SELECT o.tenant_id, o.id FROM commercial.orders o
     WHERE NOT EXISTS (SELECT 1 FROM commercial.load_guide_orders g
                        WHERE g.order_id = o.id AND g.status = 'cargado')
     ORDER BY o.created_at DESC LIMIT 1`);
  const { rows: usuario } = await knex.raw(`SELECT id FROM identity.users LIMIT 1`);
  if (!pedido.length || !usuario.length) {
    console.log('  [MCP.5] ◻ NO MEDIDO: falta un pedido sin guía y un usuario para probar la llave.');
  } else {
    const tenant = pedido[0].tenant_id;
    await knex.raw('SAVEPOINT mcp5_neg');
    // RLS forzado: se fija el tenant para que el rechazo sólo pueda venir de la llave.
    await knex.raw(`SELECT set_config('app.tenant_id', ?, true)`, [tenant]);
    let rebotó = false;
    try {
      for (const sufijo of ['A', 'B']) {
        const { rows: g } = await knex.raw(
          `INSERT INTO commercial.load_guides (tenant_id, folio, rider_user_id, branch, sales_route, business_date)
           VALUES (?, ?, ?, '99', ?, current_date) RETURNING id`,
          [tenant, `GDC-CANDADO-${sufijo}`, usuario[0].id, `RUTA CANDADO ${sufijo}`],
        );
        await knex.raw(
          `INSERT INTO commercial.load_guide_orders (tenant_id, guide_id, order_id, added_by)
           VALUES (?, ?, ?, ?)`,
          [tenant, g[0].id, pedido[0].id, usuario[0].id],
        );
      }
    } catch (e) {
      rebotó = /ux_lgo_pedido_cargado/i.test(e.message);
    }
    await knex.raw('ROLLBACK TO SAVEPOINT mcp5_neg');
    await knex.raw('RELEASE SAVEPOINT mcp5_neg');
    if (!rebotó) throw new Error('[MCP.5] la llave NO impidió cargar el mismo pedido en dos guías: es decorativa.');
    console.log('  [MCP.5] prueba negativa OK: un pedido no va cargado en dos guías.');
  }
  console.log('  [MCP.5] tablas de guías de carga listas · RLS forzado.');
};

exports.down = async function down(knex) {
  await knex.raw('DROP TABLE IF EXISTS commercial.load_guide_orders');
  await knex.raw('DROP TABLE IF EXISTS commercial.load_guides');
  await knex.raw('DROP TABLE IF EXISTS commercial.load_guide_sequences');
};
