'use strict';
/**
 * `[CANON.7.4c]` C0 — **los lotes fechados se consumen por EVENTO del ODS, no por la copia.**
 *
 * Hoy, cuando la existencia baja de lo declarado en lotes, quien consume los lotes fechados (FEFO: lo bueno primero) es el
 * disparador `trg_rebalance_stock_lots` sobre la COPIA `commercial.stock`, que alimenta el importer
 * `import-branch-stock-live`. Para congelar la copia (`[CANON.7.5]`) ese consumo tiene que salir de ella. Y no puede
 * derivarse al leer: el consumo es IRREVERSIBLE (si después entra mercancía va a lo sin lote, el lote vendido no revive).
 *
 * Crea, sin tocar los datos:
 *   · `commercial.lotes_fefo_por_evento` — el INTERRUPTOR, que nace APAGADO (falla cerrada, como el de `[CANON.6.21]`).
 *   · `commercial.consumir_lotes_por_existencia(tenant, almacén, producto)` — si la existencia de Kepler
 *     (`analytics.v_erp_stock_on_hand`, rama `kepler_ods`, la misma de la portada y del pedido) quedó por debajo de lo
 *     declarado en lotes (`lot_code <> 'NA'`), consume la diferencia en el MISMO orden que el disparador de la copia
 *     (no vencido primero, caducidad ascendente, id) y lo escribe en `stock_lot_movements` (`out`, `kepler_existencia`).
 *     Candado por (almacén, producto).
 *   · `commercial.tg_kdil_lotes_fefo()` + dos disparadores POR SENTENCIA sobre `kepler_ods.kdil` (INSERT y UPDATE, con
 *     tablas de transición): la ingesta escribe por LOTE (`INSERT … ON CONFLICT DO UPDATE … WHERE IS DISTINCT FROM`),
 *     así que corre una vez por lote y sólo ve lo que cambió. Actúa sólo sobre los productos con lote declarado vivo
 *     (~130 el 2026-11-20). ⛔ DELETE no: un borrado de la ingesta puede ser pasajero, y consumir es para siempre.
 *     ⛔ Nunca frena la ingesta (ADR-104 §4): atrapa su error y lo deja en `analytics.llaves_sucias_errores`.
 *   · `commercial.fn_rebalance_stock_lots()` (el de la copia) con la misma llave al revés: con el interruptor PRENDIDO ya
 *     no toca los lotes. Un solo interruptor cambia de dueño el consumo, sin DDL y sin ventana con los dos (o ninguno).
 *
 * ── Lo medido antes (prod, sólo lectura, 2026-11-20) ───────────────────────────────────────────────────────────────
 *  · ~130 lotes declarados vivos (120 `EXP-…` de caducidades + ~10 de recepción); ninguno con su entrada en la bitácora.
 *  · De 151 caducidades capturadas en 60 días, 139 se volvieron lote (las otras 12 no: el `NA` de la copia no alcanzaba).
 *  · `kdil` tiene el índice `ix_kdil_suc_btrim_c3` (sucursal, btrim(c3)): la existencia de UNA celda es una búsqueda.
 *
 * ⛔ FUERA DE HORARIO: `CREATE TRIGGER` toma SHARE ROW EXCLUSIVE sobre `kdil` (frena las escrituras de la ingesta, no las
 *    lecturas) hasta el COMMIT; `lock_timeout` 5 s: si no lo obtiene, falla entera y no deja nada. Antes, mirar que no
 *    haya una transacción vieja abierta (skill `entrega` §5). `CREATE OR REPLACE TRIGGER`, nunca DROP + CREATE.
 *
 * Idempotente. Aplicarla no cambia nada: el interruptor nace apagado.
 *
 * @param { import("knex").Knex } knex
 */
const M = '00000000-0000-0000-0000-00000000d01c';
const T = 'commercial.lotes_fefo_por_evento';

/**
 * La llave en el disparador de la COPIA (`commercial.fn_rebalance_stock_lots`): se INSERTA en la definición que la base
 * tiene hoy (no se reescribe a mano: un espacio distinto ya sería otra función) y `down` quita exactamente esas líneas.
 */
const MARCA = '-- [CANON.7.4c] llave del consumo por evento del ODS';
const LLAVE = `IF EXISTS (SELECT 1 FROM ${T} WHERE encendida) THEN RETURN NULL; END IF;`;
async function definicionRebalance(knex) {
  return (await knex.raw(`SELECT pg_get_functiondef('commercial.fn_rebalance_stock_lots'::regproc) AS d`)).rows[0].d;
}
/** Inserta la llave justo después del primer BEGIN del cuerpo, con la sangría de ese BEGIN + 2. */
function conLlave(def) {
  if (def.includes(MARCA)) return def;
  const m = def.match(/\n([ \t]*)BEGIN\n/);
  if (!m) throw new Error('[CANON.7.4c] no encuentro el BEGIN de fn_rebalance_stock_lots');
  const sangria = `${m[1]}  `;
  const corte = m.index + m[0].length;
  return def.slice(0, corte) + `${sangria}${MARCA}\n${sangria}${LLAVE}\n` + def.slice(corte);
}
/** Quita exactamente las dos líneas que puso `conLlave`. */
function sinLlave(def) {
  const lineas = def.split('\n');
  const i = lineas.findIndex((l) => l.trim() === MARCA);
  if (i < 0) return def;
  if (lineas[i + 1]?.trim() !== LLAVE) throw new Error('[CANON.7.4c] la llave de fn_rebalance_stock_lots no es la que puso el up');
  lineas.splice(i, 2);
  return lineas.join('\n');
}

exports.up = async function up(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);
  for (const o of ['kepler_ods.kdil', 'commercial.stock_lots', 'commercial.stock_lot_movements', 'analytics.v_erp_stock_on_hand', 'analytics.llaves_sucias_errores']) {
    const { rows: [r] } = await knex.raw(`SELECT to_regclass(?) IS NOT NULL AS hay`, [o]);
    if (!r.hay) throw new Error(`[CANON.7.4c] falta ${o}: el disparador fallaría en cada lote de la ingesta`);
  }
  const { rows: faltan } = await knex.raw(`
    SELECT c FROM unnest(ARRAY['sucursal', 'c1', 'c3']) c
     WHERE NOT EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = 'kepler_ods.kdil'::regclass AND a.attname = c AND NOT a.attisdropped)`);
  if (faltan.length) throw new Error(`[CANON.7.4c] kepler_ods.kdil no tiene ${faltan.map((x) => x.c).join(', ')}`);

  // ── El interruptor: APAGADO ──────────────────────────────────────────────────────────────────────────────────────
  await knex.raw(`
    CREATE TABLE IF NOT EXISTS ${T} (
      tenant_id   uuid PRIMARY KEY DEFAULT public.current_tenant_id(),
      encendida   boolean NOT NULL DEFAULT false,
      nota        text,
      created_at  timestamptz NOT NULL DEFAULT now(),
      updated_at  timestamptz NOT NULL DEFAULT now(),
      created_by  uuid,
      updated_by  uuid
    )`);
  await knex.raw(`INSERT INTO ${T} (tenant_id, encendida, nota)
    VALUES ('${M}', false, 'Instalado apagado por 20261120150025 ([CANON.7.4c]). Prenderlo pasa el consumo FEFO de los lotes de la copia al ODS.')
    ON CONFLICT (tenant_id) DO NOTHING`);
  await knex.raw(`ALTER TABLE ${T} ENABLE ROW LEVEL SECURITY`);
  await knex.raw(`ALTER TABLE ${T} FORCE ROW LEVEL SECURITY`);
  await knex.raw(`DROP POLICY IF EXISTS lotes_fefo_por_evento_tenant ON ${T}`);
  await knex.raw(`CREATE POLICY lotes_fefo_por_evento_tenant ON ${T}
    USING (tenant_id = public.current_tenant_id()) WITH CHECK (tenant_id = public.current_tenant_id())`);
  await knex.raw(`GRANT SELECT ON ${T} TO app_runtime`);
  await knex.raw(`DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'dev_ro') THEN GRANT SELECT ON ${T} TO dev_ro; END IF; END $$`);
  await knex.raw(`COMMENT ON TABLE ${T} IS
    '[CANON.7.4c] Interruptor del consumo FEFO de lotes por evento del ODS (commercial.tg_kdil_lotes_fefo). Falla cerrada: '
    'apagado o sin renglón, el disparador de kdil no hace nada y el de la copia (fn_rebalance_stock_lots) sigue como antes. '
    'Prendido, consume el de kdil y el de la copia ya no toca los lotes. Apagarlo es la salida de emergencia, sin DDL.'`);

  // ── El consumo de UNA celda ──────────────────────────────────────────────────────────────────────────────────────
  await knex.raw(`
    CREATE OR REPLACE FUNCTION commercial.consumir_lotes_por_existencia(p_tenant uuid, p_warehouse uuid, p_product uuid)
    RETURNS numeric
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path = pg_catalog, pg_temp
    AS $fn$
    DECLARE
      v_exist numeric; v_lotes numeric; v_falta numeric; v_toma numeric; v_total numeric := 0; r record;
    BEGIN
      PERFORM pg_advisory_xact_lock(hashtextextended('lotes:' || p_warehouse::text || ':' || p_product::text, 0));
      SELECT COALESCE(sum(e.qty_stock_units), 0) INTO v_exist
        FROM analytics.v_erp_stock_on_hand e
       WHERE e.warehouse_id = p_warehouse AND e.product_id = p_product AND e.source = 'kepler_ods';
      SELECT COALESCE(sum(l.quantity), 0) INTO v_lotes
        FROM commercial.stock_lots l
       WHERE l.tenant_id = p_tenant AND l.warehouse_id = p_warehouse AND l.product_id = p_product
         AND l.lot_code <> 'NA' AND l.quantity > 0;
      v_falta := v_lotes - v_exist;
      IF v_falta <= 0 THEN RETURN 0; END IF;
      FOR r IN
        SELECT l.id, l.lot_code, l.expiry_date, l.quantity
          FROM commercial.stock_lots l
         WHERE l.tenant_id = p_tenant AND l.warehouse_id = p_warehouse AND l.product_id = p_product
           AND l.lot_code <> 'NA' AND l.quantity > 0
         ORDER BY (l.expiry_date IS NOT NULL AND l.expiry_date < CURRENT_DATE) ASC, l.expiry_date ASC NULLS LAST, l.id
         FOR UPDATE
      LOOP
        EXIT WHEN v_falta <= 0;
        v_toma := LEAST(r.quantity, v_falta);
        UPDATE commercial.stock_lots SET quantity = quantity - v_toma, updated_at = now() WHERE id = r.id;
        INSERT INTO commercial.stock_lot_movements
          (tenant_id, warehouse_id, product_id, lot_code, expiry_date, movement_type, quantity, reference_type)
        VALUES (p_tenant, p_warehouse, p_product, r.lot_code, r.expiry_date, 'out', v_toma, 'kepler_existencia');
        v_falta := v_falta - v_toma;
        v_total := v_total + v_toma;
      END LOOP;
      RETURN v_total;
    END
    $fn$`);
  await knex.raw(`REVOKE ALL ON FUNCTION commercial.consumir_lotes_por_existencia(uuid, uuid, uuid) FROM PUBLIC`);

  // ── El disparador de kdil ────────────────────────────────────────────────────────────────────────────────────────
  await knex.raw(`
    CREATE OR REPLACE FUNCTION commercial.tg_kdil_lotes_fefo()
    RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path = pg_catalog, pg_temp
    AS $fn$
    DECLARE r record; v_state text; v_msg text;
    BEGIN
      BEGIN
        -- Falla cerrada: apagado (o sin renglón), no hace nada.
        IF NOT EXISTS (SELECT 1 FROM ${T} WHERE encendida) THEN RETURN NULL; END IF;
        -- De las ~130 celdas con lote declarado (índice parcial) al lote de la ingesta, y no al revés: partiendo del
        -- lote, Postgres buscaba cada renglón en stock_lots (medido en prod: 60–110 ms por lote de ~1,400 renglones);
        -- así, 13–30 ms sin el índice parcial.
        FOR r IN
          WITH declarados AS MATERIALIZED (
            SELECT DISTINCT l.tenant_id, l.warehouse_id, l.product_id, w.kepler_code, p.sku::text AS sku
              FROM commercial.stock_lots l
              JOIN commercial.warehouses w ON w.tenant_id = l.tenant_id AND w.id = l.warehouse_id AND w.deleted_at IS NULL
              JOIN catalog.products p ON p.tenant_id = l.tenant_id AND p.id = l.product_id AND p.deleted_at IS NULL
             WHERE l.lot_code <> 'NA' AND l.quantity > 0)
          SELECT d.tenant_id, d.warehouse_id, d.product_id
            FROM declarados d
           WHERE EXISTS (SELECT 1 FROM new_rows n WHERE n.sucursal = d.kepler_code AND n.c1 = d.kepler_code AND btrim(n.c3) = d.sku)
        LOOP
          PERFORM commercial.consumir_lotes_por_existencia(r.tenant_id, r.warehouse_id, r.product_id);
        END LOOP;
      EXCEPTION WHEN OTHERS THEN
        GET STACKED DIAGNOSTICS v_state = RETURNED_SQLSTATE, v_msg = MESSAGE_TEXT;
        INSERT INTO analytics.llaves_sucias_errores (tabla, operacion, sqlstate, mensaje)
        VALUES ('kepler_ods.kdil · lotes FEFO', TG_OP, v_state, left(v_msg, 500));
      END;
      RETURN NULL;
    END
    $fn$`);
  await knex.raw(`REVOKE ALL ON FUNCTION commercial.tg_kdil_lotes_fefo() FROM PUBLIC`);

  // ── El de la copia, con la llave (sin tocar la tabla: sólo la función) ─────────────────────────────────────────
  await knex.raw(conLlave(await definicionRebalance(knex)));

  // ── Índice parcial de los lotes declarados (~135 de ~64 mil renglones): lo lee el disparador en cada lote ─────────
  await knex.raw(`CREATE INDEX IF NOT EXISTS ix_stock_lots_declarados ON commercial.stock_lots (tenant_id, warehouse_id, product_id)
    WHERE lot_code <> 'NA' AND quantity > 0`);

  // ── Los disparadores: AL FINAL, para retener el candado de kdil lo menos posible ─────────────────────────────────
  await knex.raw(`CREATE OR REPLACE TRIGGER tg_kdil_lotes_fefo_ins AFTER INSERT ON kepler_ods.kdil
    REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION commercial.tg_kdil_lotes_fefo()`);
  await knex.raw(`CREATE OR REPLACE TRIGGER tg_kdil_lotes_fefo_upd AFTER UPDATE ON kepler_ods.kdil
    REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION commercial.tg_kdil_lotes_fefo()`);
};

/** Deshace EXACTAMENTE lo que hizo el `up`, ni una fila más. */
exports.down = async function down(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);
  await knex.raw(`DROP TRIGGER IF EXISTS tg_kdil_lotes_fefo_ins ON kepler_ods.kdil`);
  await knex.raw(`DROP TRIGGER IF EXISTS tg_kdil_lotes_fefo_upd ON kepler_ods.kdil`);
  await knex.raw(sinLlave(await definicionRebalance(knex)));
  await knex.raw(`DROP INDEX IF EXISTS commercial.ix_stock_lots_declarados`);
  await knex.raw(`DROP FUNCTION IF EXISTS commercial.tg_kdil_lotes_fefo()`);
  await knex.raw(`DROP FUNCTION IF EXISTS commercial.consumir_lotes_por_existencia(uuid, uuid, uuid)`);
  await knex.raw(`DROP TABLE IF EXISTS ${T}`);
};
