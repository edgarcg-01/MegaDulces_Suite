'use strict';
/**
 * `[GP.3]` — Al arrancar una ola se congela lo que pidió CADA pedido, con la presentación de la
 * hoja, y se agrega el índice de "tomar el siguiente".
 *
 * ── Por qué ──────────────────────────────────────────────────────────────────────────────────
 * 1. **El reparto leía el pedido en vivo al cerrar la ola** (`repartirYGuardar` →
 *    `lineasDePedidos`). Con pedidos de la Suite no importa (un `confirmed` no cambia); con pedidos
 *    de Kepler sí: siguen editables en Kepler mientras se surten (ADR-086). GP.2 lo resolvió
 *    FRENANDO el cierre si el pedido cambió; con esta tabla el reparto usa lo que se pidió al
 *    arrancar, que es contra lo que el surtidor caminó, y el cambio se vuelve un aviso, no un freno.
 * 2. **El surtidor cuenta en la presentación de la hoja** (3 BTO), no en la unidad base (75 KG).
 *    `wave_lines` sólo guardaba la base. Las dos columnas nuevas guardan la presentación sumada
 *    cuando todos los pedidos la piden igual; si no, quedan NULL y la pantalla muestra la base.
 * 3. **"Tomar el siguiente"** (decisión de Francisco, 2026-10-07, `FASE_GP` §8): el surtidor pide
 *    trabajo y el sistema le da la ola libre más vieja de su almacén. El índice parcial cubre
 *    exactamente esa búsqueda (`status='abierta' AND assigned_to IS NULL`).
 *
 * ── Lo medido antes (sólo lectura, prod 2026-10-08) ──────────────────────────────────────────
 *  · `commercial.picking_waves`, `wave_orders`, `wave_lines`: **0 filas**. No hay datos que migrar.
 *  · Renglones `U-D-40` de telemarketing PH, 30 días: la presentación (`kdm2.c55`) difiere de la
 *    unidad base (`c11`) en miles de renglones (PAQ/CJA 1,729 · PZA/CJA 382 · KG/BTO 262).
 *
 * Crea esquema (tabla, columnas, índice): la compuerta del despliegue la clasifica y no frena.
 * Igual va ANTES del código: el código nuevo escribe en estas columnas al arrancar una ola.
 *
 * Idempotente (hasTable / hasColumn / IF NOT EXISTS).
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
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);

  // ── 1. Lo que pidió cada pedido, congelado al arrancar ─────────────────────────────────────
  if (!(await knex.schema.withSchema('commercial').hasTable('wave_order_lines'))) {
    await knex.raw(`
      CREATE TABLE commercial.wave_order_lines (
        id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id            uuid NOT NULL DEFAULT public.current_tenant_id(),
        wave_id              uuid NOT NULL REFERENCES commercial.picking_waves(id) ON DELETE CASCADE,
        -- Sin FK a propósito, igual que wave_orders.order_id: puede ser un pedido de la Suite o
        -- el UUID derivado de un pedido de Kepler (ver 20261007260100).
        order_id             uuid NOT NULL,
        order_code           varchar(30) NOT NULL,
        product_id           uuid NOT NULL,
        -- En unidad BASE: es la que se reparte. Mismo criterio que wave_lines.qty_requested.
        qty_requested        numeric(14,3) NOT NULL CHECK (qty_requested > 0),
        qty_unit             varchar(16),
        -- La presentación de la hoja (Kepler kdm2.c56/c55). NULL en pedidos de la Suite.
        qty_presentacion     numeric(14,3) CHECK (qty_presentacion IS NULL OR qty_presentacion >= 0),
        unidad_presentacion  varchar(16),
        -- Lo que ordena el reparto cuando no alcanza (allocation.ts · ordenDeAtencion).
        delivery_date        date,
        confirmed_at         timestamptz,
        created_at           timestamptz NOT NULL DEFAULT now(),
        created_by           uuid,
        UNIQUE (tenant_id, wave_id, order_id, product_id)
      )`);
    await knex.raw(`CREATE INDEX ix_wol_wave ON commercial.wave_order_lines (tenant_id, wave_id)`);
    await tenantRls(knex, 'commercial', 'wave_order_lines');
    await knex.raw(`COMMENT ON TABLE commercial.wave_order_lines IS
      '[GP.3] Lo que pidió cada pedido de la ola, congelado al arrancar el surtido. El reparto se calcula contra esto, no contra el pedido en vivo (un pedido de Kepler sigue editable mientras se surte).'`);
  }

  // ── 2. La presentación que ve el surtidor ───────────────────────────────────────────────────
  const tiene = (col) => knex.schema.withSchema('commercial').hasColumn('wave_lines', col);
  if (!(await tiene('qty_presentacion'))) {
    await knex.raw(`ALTER TABLE commercial.wave_lines
      ADD COLUMN qty_presentacion numeric(14,3)
        CHECK (qty_presentacion IS NULL OR qty_presentacion >= 0)`);
  }
  if (!(await tiene('unidad_presentacion'))) {
    await knex.raw(`ALTER TABLE commercial.wave_lines ADD COLUMN unidad_presentacion varchar(16)`);
  }
  await knex.raw(`COMMENT ON COLUMN commercial.wave_lines.qty_presentacion IS
    '[GP.3] Suma en la presentación de la hoja (3 BTO) cuando todos los pedidos la piden igual. NULL = mezclada o sin presentación: la pantalla muestra la unidad base.'`);

  // ── 3. De dónde salió la ola y quién la armó ───────────────────────────────────────────────
  // `origen`: TELEMARK / SUCURSAL cuando todos sus pedidos Kepler son de ese origen; NULL si
  // mezcla o es de la Suite. Sin esto, el surtidor que pidió "Telemarketing" se llevaba una ola
  // de Sucursal (lo encontró la revisión: el filtro sólo se usaba al ARMAR, no al TOMAR).
  // `armada_por`: 'auto' = la armó "tomar siguiente" desde el pool; 'consola' = una persona.
  // Si una ola no arranca al tomarla, sólo las 'auto' se cancelan solas: una armada a mano
  // (partir un pedido, urgentes) no se tira sin que alguien lo decida.
  const tieneW = (col) => knex.schema.withSchema('commercial').hasColumn('picking_waves', col);
  if (!(await tieneW('origen'))) {
    await knex.raw(`ALTER TABLE commercial.picking_waves ADD COLUMN origen varchar(10)`);
  }
  if (!(await tieneW('armada_por'))) {
    await knex.raw(`ALTER TABLE commercial.picking_waves
      ADD COLUMN armada_por varchar(10) NOT NULL DEFAULT 'consola'
        CHECK (armada_por IN ('consola', 'auto'))`);
  }

  // ── 4. "Tomar el siguiente": la ola libre más vieja de un almacén ──────────────────────────
  await knex.raw(`
    CREATE INDEX IF NOT EXISTS ix_pw_libres ON commercial.picking_waves (tenant_id, warehouse_id, created_at)
     WHERE status = 'abierta' AND assigned_to IS NULL`);
};

/** Deshace EXACTAMENTE lo que hizo el `up`, ni una fila más. */
exports.down = async function down(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);
  // Con olas arrancadas, esta tabla es el ÚNICO registro de lo que pidió cada pedido al
  // arrancar: borrarla dejaría sin base el reparto de esas olas. Sólo se deshace vacía.
  if (await knex.schema.withSchema('commercial').hasTable('wave_order_lines')) {
    const { rows } = await knex.raw(`SELECT count(*)::int AS n FROM commercial.wave_order_lines`);
    if (rows[0].n > 0) {
      throw new Error(`[GP.3] down abortado: wave_order_lines tiene ${rows[0].n} fila(s) de olas arrancadas.`);
    }
  }
  await knex.raw(`DROP INDEX IF EXISTS commercial.ix_pw_libres`);
  await knex.raw(`ALTER TABLE commercial.picking_waves
    DROP COLUMN IF EXISTS armada_por,
    DROP COLUMN IF EXISTS origen`);
  await knex.raw(`ALTER TABLE commercial.wave_lines
    DROP COLUMN IF EXISTS unidad_presentacion,
    DROP COLUMN IF EXISTS qty_presentacion`);
  await knex.raw(`DROP TABLE IF EXISTS commercial.wave_order_lines`);
};
