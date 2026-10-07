/**
 * Fase K integridad: trigger + función que marca `products.embedding` como
 * stale cuando se modifica algo que afecta el `source_text` del embedding.
 *
 * **Comportamiento**:
 *   - Al INSERT en products: `embedding_updated_at = NULL` (señal de pendiente).
 *   - Al UPDATE products.nombre o .brand_id: `embedding_updated_at = NULL` y
 *     `embedding_source_text = NULL` (marca stale). El valor del `embedding`
 *     se mantiene como estaba (degrada elegante: match-ai sigue funcionando
 *     con embedding viejo hasta que el scanner lo refresca).
 *
 * **Por qué BEFORE UPDATE y no AFTER**: queremos modificar el row antes de
 * que se persista, evitando un UPDATE adicional. NEW es mutable en BEFORE.
 *
 * **Excepción importante**: cuando el SCANNER del cron actualiza el
 * embedding después de calcularlo, NO debe re-disparar el trigger. Esto se
 * logra porque el scanner solo escribe `embedding`, `embedding_source_text`,
 * `embedding_updated_at` — el trigger checa `nombre`/`brand_id`, no esos.
 *
 * **Idempotente**: DROP IF EXISTS antes de crear.
 *
 * @param { import("knex").Knex } knex
 */
exports.up = async function (knex) {
  await knex.raw(`
    CREATE OR REPLACE FUNCTION products_mark_embedding_stale() RETURNS trigger AS $$
    BEGIN
      IF TG_OP = 'INSERT' THEN
        -- Productos recién insertados arrancan pendientes de embed.
        NEW.embedding_updated_at := NULL;
        NEW.embedding_source_text := NULL;
        RETURN NEW;
      END IF;

      -- UPDATE: solo marcar stale si cambia algo del source_text.
      IF NEW.nombre IS DISTINCT FROM OLD.nombre
         OR NEW.brand_id IS DISTINCT FROM OLD.brand_id THEN
        NEW.embedding_updated_at := NULL;
        NEW.embedding_source_text := NULL;
        -- NO tocamos NEW.embedding — queda valor viejo para degradación elegante.
      END IF;

      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql;
  `);

  await knex.raw(`DROP TRIGGER IF EXISTS trg_products_embedding_staleness ON products`);
  await knex.raw(`
    CREATE TRIGGER trg_products_embedding_staleness
      BEFORE INSERT OR UPDATE ON products
      FOR EACH ROW
      EXECUTE FUNCTION products_mark_embedding_stale();
  `);
};

/**
 * @param { import("knex").Knex } knex
 */
exports.down = async function (knex) {
  await knex.raw(`DROP TRIGGER IF EXISTS trg_products_embedding_staleness ON products`);
  await knex.raw(`DROP FUNCTION IF EXISTS products_mark_embedding_stale()`);
};
