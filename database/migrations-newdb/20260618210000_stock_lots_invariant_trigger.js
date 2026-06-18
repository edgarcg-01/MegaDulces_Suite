/**
 * Fase P2.1a (FEFO) — trigger que mantiene el invariante stock ↔ stock_lots.
 *
 * En vez de threading lógica de lotes por los ~7 writers de commercial.stock
 * (incluido el hot path de pedidos), un trigger AFTER UPDATE OF quantity en
 * commercial.stock mantiene automáticamente:
 *     SUM(stock_lots.quantity) por (tenant,wh,product) = stock.quantity
 *
 * Mecánica: el lote 'NA' (sin caducidad) es el BALANCEADOR.
 *   - aumento de stock → NA sube (o se crea).
 *   - baja dentro del buffer NA → NA baja.
 *   - baja que EXCEDE NA → NA=0 y se decrementan lotes reales FEFO (caducidad ASC).
 * Cero cambios al order flow / ajustes / reconcile / route — todos escriben stock
 * y el trigger reconcilia los lotes.
 *
 * Alcance fase 1 = QUANTITY. El reserved a nivel de lote se DIFIERE (P2.3, FEFO
 * reserve): se ponen en 0 los `reserved_quantity` de lotes para que las bajas de
 * quantity no choquen con el CHECK quantity>=reserved. El reserved sigue vivo en
 * commercial.stock (total), intacto.
 *
 * @param { import("knex").Knex } knex
 */
exports.up = async function (knex) {
  // Diferir reserved por lote (fase 1 mantiene solo el invariante de quantity).
  await knex.raw(`UPDATE commercial.stock_lots SET reserved_quantity = 0 WHERE reserved_quantity <> 0`);

  await knex.raw(`
    CREATE OR REPLACE FUNCTION commercial.fn_rebalance_stock_lots() RETURNS trigger
    LANGUAGE plpgsql AS $$
    DECLARE
      v_non_na   numeric;
      v_target   numeric;
      v_short    numeric;
      v_upd      int;
      r          record;
    BEGIN
      SELECT COALESCE(SUM(quantity), 0) INTO v_non_na
        FROM commercial.stock_lots
       WHERE tenant_id = NEW.tenant_id AND warehouse_id = NEW.warehouse_id
         AND product_id = NEW.product_id AND lot_code <> 'NA';

      v_target := NEW.quantity - v_non_na;

      IF v_target >= 0 THEN
        -- NA balancea el total.
        UPDATE commercial.stock_lots
           SET quantity = v_target, updated_at = now()
         WHERE tenant_id = NEW.tenant_id AND warehouse_id = NEW.warehouse_id
           AND product_id = NEW.product_id AND lot_code = 'NA' AND expiry_date IS NULL;
        GET DIAGNOSTICS v_upd = ROW_COUNT;
        IF v_upd = 0 THEN
          INSERT INTO commercial.stock_lots
            (tenant_id, warehouse_id, product_id, lot_code, expiry_date, quantity, reserved_quantity)
          VALUES (NEW.tenant_id, NEW.warehouse_id, NEW.product_id, 'NA', NULL, v_target, 0);
        END IF;
      ELSE
        -- La baja excede el buffer NA: NA=0 y decrementar lotes reales FEFO.
        UPDATE commercial.stock_lots SET quantity = 0, updated_at = now()
         WHERE tenant_id = NEW.tenant_id AND warehouse_id = NEW.warehouse_id
           AND product_id = NEW.product_id AND lot_code = 'NA' AND expiry_date IS NULL;
        v_short := -v_target;
        FOR r IN
          SELECT id, quantity FROM commercial.stock_lots
           WHERE tenant_id = NEW.tenant_id AND warehouse_id = NEW.warehouse_id
             AND product_id = NEW.product_id AND lot_code <> 'NA' AND quantity > 0
           ORDER BY expiry_date ASC NULLS LAST, id
        LOOP
          EXIT WHEN v_short <= 0;
          IF r.quantity >= v_short THEN
            UPDATE commercial.stock_lots SET quantity = quantity - v_short, updated_at = now() WHERE id = r.id;
            v_short := 0;
          ELSE
            UPDATE commercial.stock_lots SET quantity = 0, updated_at = now() WHERE id = r.id;
            v_short := v_short - r.quantity;
          END IF;
        END LOOP;
      END IF;

      RETURN NULL;
    END;
    $$;
  `);

  await knex.raw(`DROP TRIGGER IF EXISTS trg_rebalance_stock_lots ON commercial.stock`);
  await knex.raw(`
    CREATE TRIGGER trg_rebalance_stock_lots
      AFTER INSERT OR UPDATE OF quantity ON commercial.stock
      FOR EACH ROW EXECUTE FUNCTION commercial.fn_rebalance_stock_lots()
  `);
};

exports.down = async function (knex) {
  await knex.raw(`DROP TRIGGER IF EXISTS trg_rebalance_stock_lots ON commercial.stock`);
  await knex.raw(`DROP FUNCTION IF EXISTS commercial.fn_rebalance_stock_lots()`);
};
