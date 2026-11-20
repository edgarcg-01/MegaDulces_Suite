'use strict';
/**
 * `[GP.11.2]` — Qué pedido trae cada carreta: `commercial.cart_occupations` (FASE_GP paso 4, D7, D9, D22).
 *
 * Es dato de piso que no existe en ningún ERP (Kepler tiene `kdm2.c59`, pero vacío o relleno: ERP_KEPLER
 * §3.y), así que es tabla propia (regla 1: la tabla real es para datos propios). Una fila = una carreta
 * ocupada por un pedido, desde que se escanea al empezar a surtir hasta que se libera.
 *
 * El pedido se identifica como ya lo hacen las olas (`wave_orders`), con un `order_id` uuid para los dos
 * orígenes:
 *  · `suite`: `commercial.orders.id` (el `PD-` de preventa). Mismo vocabulario que `wave_orders.source`.
 *  · `kepler`: el `U-D-40`, con su llave legible (`kepler_sucursal`, `kepler_serie`, `kepler_folio`) y
 *    `order_id = md5('kepler/UD40/'||suc||'/'||serie||'/'||folio)::uuid`, el MISMO CHECK que
 *    `wave_orders_kepler_id_derivado`: no hay dos formas de nombrar un pedido de Kepler.
 *
 * Lo que garantiza la BASE (no la pantalla):
 *  · **Una carreta, un pedido a la vez** (D7): índice único parcial `(tenant_id, bin_id)` mientras no se
 *    libera. Dos surtidores escaneando la misma carreta al mismo tiempo: el segundo choca aquí.
 *  · Un pedido SÍ puede tener varias carretas abiertas («agregar otra carreta» si no cabe).
 *  · La carreta es de familia `carreta` y del MISMO almacén que la ocupación (FK compuesta con
 *    `warehouse_id` + trigger de familia: una `BA053` no se ocupa como carreta).
 *  · Liberar es coherente o no es: `released_at`, `released_by` y `release_reason` van juntos. Motivos:
 *    `cargado` (D22: al cargar el camión, E4), `manual` (el coordinador, provisional hasta E4) y
 *    `deshecho` (se escaneó la carreta equivocada y se corrige en el acto).
 *  · Nunca se borra (sin GRANT de DELETE): la historia de ocupación es la que contesta P-GP.6
 *    (¿alcanzan las carretas?).
 *
 * ── Lo medido antes (prod, sólo lectura, 2026-11-20) ────────────────────────────────────────
 *  · 0 carretas dadas de alta; Surtir no pide carreta en ningún modo.
 *  · Preventa: un renglón por pedido en `presale_picks` (único por `order_id`). Kepler: por OLA en
 *    `picking_waves` (una ola puede traer varios pedidos), con el pedido en `wave_orders`.
 *
 * Tabla nueva: sin caminos de inserción previos. Compatible con la API desplegada (no la conoce).
 * Idempotente.
 *
 * @param { import("knex").Knex } knex
 */

const T = 'commercial.cart_occupations';

exports.up = async function up(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);

  if (!(await knex.schema.withSchema('commercial').hasTable('cart_occupations'))) {
    await knex.schema.withSchema('commercial').createTable('cart_occupations', (t) => {
      t.uuid('tenant_id').notNullable().defaultTo(knex.raw('public.current_tenant_id()'));
      t.uuid('id').notNullable().defaultTo(knex.raw('gen_random_uuid()'));
      t.uuid('warehouse_id').notNullable();
      t.uuid('bin_id').notNullable();
      // Mismo vocabulario que wave_orders.source: suite = commercial.orders (el PD- de preventa), kepler = U-D-40.
      t.string('source', 10).notNullable();
      t.uuid('order_id').notNullable();
      t.string('kepler_sucursal', 2);
      t.smallint('kepler_serie');
      t.string('kepler_folio', 10);
      // La ola en la que se surtió, si fue en ola (Kepler siempre; un pedido de la Suite también puede ir en ola).
      t.uuid('wave_id');
      t.timestamp('occupied_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
      t.uuid('occupied_by').notNullable();
      // El nombre AL MOMENTO: si mañana cambia la ficha, la carreta sigue diciendo quién la tomó.
      t.string('occupied_by_name', 160).notNullable();
      t.timestamp('released_at', { useTz: true });
      t.uuid('released_by');
      t.string('released_by_name', 160);
      t.string('release_reason', 10);
      t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
      t.uuid('created_by').notNullable();
      t.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
      t.uuid('updated_by').notNullable();
      t.primary(['tenant_id', 'id']);
    });

    // La carreta es de ESTE almacén: la FK va contra (tenant, almacén, id) de warehouse_bins.
    await knex.raw(`ALTER TABLE ${T} ADD CONSTRAINT cart_occupations_bin_fk
      FOREIGN KEY (tenant_id, warehouse_id, bin_id) REFERENCES commercial.warehouse_bins (tenant_id, warehouse_id, id)`);
    await knex.raw(`ALTER TABLE ${T} ADD CONSTRAINT cart_occupations_wh_fk
      FOREIGN KEY (tenant_id, warehouse_id) REFERENCES commercial.warehouses (tenant_id, id)`);

    await knex.raw(`ALTER TABLE ${T} ADD CONSTRAINT cart_occupations_source_ck CHECK (source IN ('suite', 'kepler'))`);
    // Kepler trae su llave completa y el order_id sale de ella; preventa no trae ninguna parte.
    await knex.raw(`ALTER TABLE ${T} ADD CONSTRAINT cart_occupations_kepler_llave_ck CHECK (coalesce(
      CASE source
        WHEN 'kepler' THEN kepler_sucursal IS NOT NULL AND kepler_serie IS NOT NULL AND kepler_folio IS NOT NULL
          AND order_id = md5('kepler/UD40/' || kepler_sucursal || '/' || kepler_serie || '/' || kepler_folio)::uuid
        ELSE kepler_sucursal IS NULL AND kepler_serie IS NULL AND kepler_folio IS NULL
      END, false))`);
    // Liberar: los tres juntos, con motivo conocido y después de ocupar. ⛔ Con coalesce(…, false): un
    // `release_reason` NULL hace NULL el IN, y un CHECK en NULL PASA (lo cazó la prueba de integración).
    await knex.raw(`ALTER TABLE ${T} ADD CONSTRAINT cart_occupations_liberar_ck CHECK (coalesce(
      CASE WHEN released_at IS NULL THEN released_by IS NULL AND release_reason IS NULL AND released_by_name IS NULL
           ELSE released_by IS NOT NULL AND released_by_name IS NOT NULL
             AND release_reason IN ('cargado', 'manual', 'deshecho') AND released_at >= occupied_at
      END, false))`);

    // D7: una carreta, un pedido a la vez.
    await knex.raw(`CREATE UNIQUE INDEX IF NOT EXISTS ux_cart_occupations_carreta_abierta
      ON ${T} (tenant_id, bin_id) WHERE released_at IS NULL`);
    // Las carretas de un pedido (checado, consola).
    await knex.raw(`CREATE INDEX IF NOT EXISTS idx_cart_occupations_pedido
      ON ${T} (tenant_id, order_id) WHERE released_at IS NULL`);
    // Historia por almacén (P-GP.6: ocupación máxima simultánea).
    await knex.raw(`CREATE INDEX IF NOT EXISTS idx_cart_occupations_wh_fecha
      ON ${T} (tenant_id, warehouse_id, occupied_at)`);
  }

  // Sólo una carreta se ocupa: la familia vive en warehouse_bins, así que la revisa un trigger (un CHECK
  // no puede mirar otra tabla). Se revisa al insertar y si cambia la carreta.
  await knex.raw(`
    CREATE OR REPLACE FUNCTION commercial.cart_occupations_es_carreta() RETURNS trigger
    LANGUAGE plpgsql AS $$
    DECLARE fam text; est text;
    BEGIN
      SELECT familia, estado INTO fam, est FROM commercial.warehouse_bins
       WHERE tenant_id = NEW.tenant_id AND id = NEW.bin_id;
      IF fam IS DISTINCT FROM 'carreta' THEN
        RAISE EXCEPTION 'La ubicación % no es una carreta.', NEW.bin_id USING ERRCODE = '23514';
      END IF;
      IF TG_OP = 'INSERT' AND est IS DISTINCT FROM 'activa' THEN
        RAISE EXCEPTION 'La carreta no está activa (%).', est USING ERRCODE = '23514';
      END IF;
      RETURN NEW;
    END $$`);
  await knex.raw(`DROP TRIGGER IF EXISTS trg_cart_occupations_es_carreta ON ${T}`);
  await knex.raw(`CREATE TRIGGER trg_cart_occupations_es_carreta
    BEFORE INSERT OR UPDATE OF bin_id ON ${T}
    FOR EACH ROW EXECUTE FUNCTION commercial.cart_occupations_es_carreta()`);

  await knex.raw(`ALTER TABLE ${T} ENABLE ROW LEVEL SECURITY`);
  await knex.raw(`ALTER TABLE ${T} FORCE ROW LEVEL SECURITY`);
  await knex.raw(`DROP POLICY IF EXISTS cart_occupations_tenant ON ${T}`);
  await knex.raw(`CREATE POLICY cart_occupations_tenant ON ${T}
    USING (tenant_id = public.current_tenant_id())
    WITH CHECK (tenant_id = public.current_tenant_id())`);
  // Sin DELETE: la historia de ocupación no se borra. ⛔ El GRANT solo NO basta: los privilegios por omisión
  // de `commercial` (medido en prod el 2026-11-20: `app_runtime=arwd/postgres`) ya le dan DELETE a toda tabla
  // nueva que crea postgres. Hay que quitarlo explícito.
  await knex.raw(`GRANT SELECT, INSERT, UPDATE ON ${T} TO app_runtime`);
  await knex.raw(`REVOKE DELETE, TRUNCATE ON ${T} FROM app_runtime`);

  await knex.raw(`COMMENT ON TABLE ${T} IS
    '[GP.11.2] Qué pedido trae cada carreta o carrito (FASE_GP D7/D9/D22). Una fila por carreta ocupada, desde que se escanea al surtir hasta que se libera (cargado | manual | deshecho). Única abierta por carreta; un pedido puede tener varias. order_id = commercial.orders.id (source suite) o md5(kepler/UD40/suc/serie/folio) (Kepler), como wave_orders. Dato propio; nunca se borra.'`);

  // ── COMPUERTA: RLS habilitado y forzado ──────────────────────────────────────────────────────
  const { rows } = await knex.raw(`
    SELECT c.relrowsecurity AS on, c.relforcerowsecurity AS forced
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'commercial' AND c.relname = 'cart_occupations'`);
  if (!rows[0]?.on || !rows[0]?.forced) throw new Error('[GP.11.2] RLS no quedó habilitado y forzado en cart_occupations.');
};

/** Deshace EXACTAMENTE lo que hizo el `up`: la tabla nació aquí y no la usa nadie más. */
exports.down = async function down(knex) {
  await knex.raw(`DROP TABLE IF EXISTS ${T}`);
  await knex.raw(`DROP FUNCTION IF EXISTS commercial.cart_occupations_es_carreta()`);
};
