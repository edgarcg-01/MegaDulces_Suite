/**
 * Fase P2.2d (FEFO) — el decremento del trigger consume NO-VENCIDOS primero,
 * vencidos al final.
 *
 * Antes (P2.1a) el loop FEFO decrementaba `ORDER BY expiry_date ASC` → un lote ya
 * VENCIDO (fecha más temprana) salía PRIMERO en cada venta. Eso despacha producto
 * caducado en silencio.
 *
 * Política warn-only (decisión 2026-06-18): no se bloquea la venta, pero el stock
 * bueno se consume primero y lo vencido solo se toca como último recurso (cuando ya
 * no queda nada bueno). Así la venta normal nunca despacha vencido, y el aviso
 * `sold_expired` (en OrdersService.fulfill) dispara solo cuando de verdad se forzó.
 *
 * El invariante SUM(lotes)=stock.quantity se mantiene idéntico (cambia QUÉ lote baja,
 * no cuánto). Solo se reemplaza la función; el trigger sigue ligado por nombre.
 *
 * @param { import("knex").Knex } knex
 */
exports.up = async function (knex) {
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
        UPDATE commercial.stock_lots SET quantity = 0, updated_at = now()
         WHERE tenant_id = NEW.tenant_id AND warehouse_id = NEW.warehouse_id
           AND product_id = NEW.product_id AND lot_code = 'NA' AND expiry_date IS NULL;
        v_short := -v_target;
        FOR r IN
          SELECT id, quantity FROM commercial.stock_lots
           WHERE tenant_id = NEW.tenant_id AND warehouse_id = NEW.warehouse_id
             AND product_id = NEW.product_id AND lot_code <> 'NA' AND quantity > 0
           ORDER BY (expiry_date IS NOT NULL AND expiry_date < CURRENT_DATE) ASC,
                    expiry_date ASC NULLS LAST, id
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
};

exports.down = async function (knex) {
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
};
