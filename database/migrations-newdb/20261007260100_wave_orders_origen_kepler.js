/**
 * `[GP.2]` Una ola de surtido puede llevar pedidos de KEPLER (`U-D-40`), no sólo de la Suite.
 *
 * ── Por qué ──────────────────────────────────────────────────────────────────────────────
 * ADR-086: el pedido del almacén sigue naciendo y viviendo en Kepler; lo que se mueve a la Suite
 * es el trabajo de piso. El motor de surtido (Fase SU, ADR-067) sólo sabía leer
 * `commercial.orders`. Esta migración le da a `wave_orders` la forma de señalar un pedido de
 * Kepler **sin copiarlo** (regla principal: el pedido y sus renglones se leen del ODS).
 *
 * ── Cómo se identifica un pedido de Kepler ──────────────────────────────────────────────
 * Por su llave natural: `(sucursal, serie, folio)`. Pero `order_id` es `uuid NOT NULL` y de él
 * cuelgan el índice "un pedido en una sola ola viva" (`ux_wo_order_viva`) y
 * `wave_allocations.order_id`. En vez de abrirle un NULL (y reescribir ese índice y el reparto),
 * el `order_id` de un pedido Kepler es un UUID **determinista** derivado de su llave:
 *
 *     md5('kepler/UD40/' || sucursal || '/' || serie || '/' || folio)::uuid
 *
 * Mismo pedido → mismo UUID siempre, así que el índice único sigue impidiendo meterlo en dos olas.
 * El CHECK `wave_orders_kepler_id_derivado` lo obliga en la base: un `order_id` que no salga de la
 * llave se rechaza, y nadie puede apuntar un renglón Kepler a un UUID inventado.
 *
 * ⚠️ `order_id` NO tiene llave foránea (nunca la tuvo, ni hacia `commercial.orders`): por eso
 * cabe un UUID que no existe en ninguna tabla.
 *
 * Medido en prod 2026-10-07: `commercial.picking_waves` y `wave_orders` tienen **0 filas** (el
 * motor de surtido no tiene pantalla todavía). Sin datos que migrar. Aun así va con
 * `lock_timeout`: la tabla existe y podría estar tomada.
 *
 * Idempotente (hasColumn / IF NOT EXISTS).
 *
 * @param { import("knex").Knex } knex
 */
exports.up = async function up(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '3s'`);

  // ⚠️ Un builder NUEVO por pregunta: `knex.schema` acumula estado, y reusar el mismo para cuatro
  // `hasColumn` devolvía respuestas equivocadas (lo encontró el `up()` real contra Postgres).
  const tiene = (col) => knex.schema.withSchema('commercial').hasColumn('wave_orders', col);
  const faltan = {
    source: !(await tiene('source')),
    kepler_sucursal: !(await tiene('kepler_sucursal')),
    kepler_serie: !(await tiene('kepler_serie')),
    kepler_folio: !(await tiene('kepler_folio')),
  };

  if (faltan.source) {
    await knex.raw(`ALTER TABLE commercial.wave_orders
      ADD COLUMN source varchar(10) NOT NULL DEFAULT 'suite'`);
  }
  if (faltan.kepler_sucursal) {
    await knex.raw(`ALTER TABLE commercial.wave_orders ADD COLUMN kepler_sucursal varchar(2)`);
  }
  if (faltan.kepler_serie) {
    await knex.raw(`ALTER TABLE commercial.wave_orders ADD COLUMN kepler_serie smallint`);
  }
  if (faltan.kepler_folio) {
    await knex.raw(`ALTER TABLE commercial.wave_orders ADD COLUMN kepler_folio varchar(10)`);
  }

  await knex.raw(`
    DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'wave_orders_source_valido') THEN
        ALTER TABLE commercial.wave_orders
          ADD CONSTRAINT wave_orders_source_valido CHECK (source IN ('suite', 'kepler'));
      END IF;
      -- Las tres partes de la llave van juntas, y SOLO en un pedido de Kepler. Un pedido de la
      -- Suite con folio Kepler (o uno Kepler sin folio) es un renglón que nadie sabría leer.
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'wave_orders_kepler_llave') THEN
        ALTER TABLE commercial.wave_orders
          ADD CONSTRAINT wave_orders_kepler_llave CHECK (
            (source = 'kepler') = (kepler_sucursal IS NOT NULL AND kepler_serie IS NOT NULL AND kepler_folio IS NOT NULL)
            AND (source = 'kepler' OR (kepler_sucursal IS NULL AND kepler_serie IS NULL AND kepler_folio IS NULL))
          );
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'wave_orders_kepler_id_derivado') THEN
        ALTER TABLE commercial.wave_orders
          ADD CONSTRAINT wave_orders_kepler_id_derivado CHECK (
            source <> 'kepler'
            OR order_id = md5('kepler/UD40/' || kepler_sucursal || '/' || kepler_serie || '/' || kepler_folio)::uuid
          );
      END IF;
    END $$`);

  await knex.raw(`
    COMMENT ON COLUMN commercial.wave_orders.source IS
      '[GP.2] De dónde viene el pedido: suite = commercial.orders; kepler = U-D-40 leído del ODS (no se copia). Para kepler, order_id = md5(''kepler/UD40/''||sucursal||''/''||serie||''/''||folio)::uuid'`);
};

/** @param { import("knex").Knex } knex */
exports.down = async function down(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '3s'`);
  // Una ola con pedidos de Kepler no se puede leer sin estas columnas: el down sólo procede si no
  // hay ninguna. Borrarlas con datos dejaría olas apuntando a UUIDs que ya nadie sabe resolver.
  const { rows } = await knex.raw(
    `SELECT count(*)::int AS n FROM commercial.wave_orders WHERE source = 'kepler'`,
  );
  if (rows[0].n > 0) {
    throw new Error(
      `[GP.2] down abortado: hay ${rows[0].n} pedido(s) Kepler en olas. Cancelar esas olas primero.`,
    );
  }
  await knex.raw(`ALTER TABLE commercial.wave_orders
    DROP CONSTRAINT IF EXISTS wave_orders_kepler_id_derivado,
    DROP CONSTRAINT IF EXISTS wave_orders_kepler_llave,
    DROP CONSTRAINT IF EXISTS wave_orders_source_valido,
    DROP COLUMN IF EXISTS kepler_folio,
    DROP COLUMN IF EXISTS kepler_serie,
    DROP COLUMN IF EXISTS kepler_sucursal,
    DROP COLUMN IF EXISTS source`);
};
