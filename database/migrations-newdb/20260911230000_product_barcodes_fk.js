/**
 * `[NORM.2]` `catalog.product_barcodes` se liga al producto por **`product_id` + FK**, no por un
 * `sku` de texto.
 *
 * ── El defecto ───────────────────────────────────────────────────────────────────────────
 * La tabla tiene PK (`id`) y **CERO foreign keys**: la liga al catálogo es
 * `product_barcodes.sku = products.sku`, varchar contra varchar, sin nada que la sostenga.
 * Medido en prod el 2026-09-11 sobre las 12,336 filas vivas:
 *
 *   8,681  casan con un producto vivo          ← se ligan
 *   1,744  su producto está soft-deleted       ← el producto se retiró y el barcode quedó
 *   1,910  no existe ni borrado                ← residuo de un importer retirado
 *       1  rescatable normalizando ceros
 *
 * O sea **3,655 (29.6 %) apuntan a la nada**, y nadie se enteró porque no había FK que lo
 * impidiera. Ligar por `sku` además es frágil por naturaleza: es un texto mutable del ERP.
 *
 * ── Por qué la FK va a `(tenant_id, id)` y no a `(tenant_id, sku)` ───────────────────────
 * `catalog.products` **no tiene UNIQUE sobre `(tenant_id, sku)`** — sólo `products_pkey (id)`,
 * `products_tenant_id_composite (tenant_id, id)` y `(tenant_id, brand_id, nombre)`. Sin ese
 * UNIQUE no se puede referenciar el sku. Y crearlo sería normalizar contra una columna que el
 * ERP puede renombrar. Se usa la llave que ya es estable y ya es única.
 *
 * ── Lo que esta migración NO hace, a propósito ───────────────────────────────────────────
 * ⛔ **No pone el CHECK de "toda fila viva tiene `product_id`".** Los dos escritores
 * (`normalizeBarcodesFromOds` del hop-2 e `import-product-barcodes.js`) todavía insertan sin esa
 * columna; poner la restricción antes de actualizarlos les rompería el INSERT. El CHECK va en
 * una migración posterior, cuando los escritores ya la llenen. Queda declarado en el tracker.
 *
 * @param { import("knex").Knex } knex
 */

exports.up = async function up(knex) {
  const tiene = await knex.schema.withSchema('catalog').hasColumn('product_barcodes', 'product_id');
  if (!tiene) {
    await knex.raw(`ALTER TABLE catalog.product_barcodes ADD COLUMN product_id uuid`);
  }

  // La FK compuesta. `ON DELETE CASCADE`: si el producto se borra de verdad, su código de barras
  // no tiene a qué referirse. (El soft-delete del catálogo no dispara esto — es un UPDATE.)
  await knex.raw(`
    DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'product_barcodes_product_fk') THEN
        ALTER TABLE catalog.product_barcodes
          ADD CONSTRAINT product_barcodes_product_fk
          FOREIGN KEY (tenant_id, product_id)
          REFERENCES catalog.products (tenant_id, id) ON DELETE CASCADE;
      END IF;
    END $$;`);

  await knex.raw(`CREATE INDEX IF NOT EXISTS ix_product_barcodes_product
                    ON catalog.product_barcodes (tenant_id, product_id)
                  WHERE deleted_at IS NULL`);

  // ── Backfill: resolver el sku al producto vivo ─────────────────────────────────────────
  const back = await knex.raw(`
    UPDATE catalog.product_barcodes b
       SET product_id = p.id, updated_at = now()
      FROM catalog.products p
     WHERE p.tenant_id = b.tenant_id
       AND btrim(p.sku) = btrim(b.sku)
       AND p.deleted_at IS NULL
       AND b.product_id IS NULL
       AND b.deleted_at IS NULL`);

  // ── Los que no casan: se RETIRAN (soft-delete), no se borran ───────────────────────────
  // Su `deleted_at` queda con el instante de esta migración, así que el conjunto se puede
  // volver a identificar entero con una sola consulta si alguien quiere revisarlos.
  const huerf = await knex.raw(`
    UPDATE catalog.product_barcodes b
       SET deleted_at = now(), updated_at = now()
     WHERE b.deleted_at IS NULL
       AND b.product_id IS NULL`);

  const { rows: fin } = await knex.raw(`
    SELECT count(*) FILTER (WHERE deleted_at IS NULL) AS vivos,
           count(*) FILTER (WHERE deleted_at IS NULL AND product_id IS NULL) AS vivos_sin_producto
      FROM catalog.product_barcodes`);

  console.log(
    `[NORM.2] ligados: ${back.rowCount} · retirados por huérfanos: ${huerf.rowCount} · ` +
    `vivos: ${fin[0].vivos} (sin producto: ${fin[0].vivos_sin_producto} — debe ser 0)`,
  );
  if (Number(fin[0].vivos_sin_producto) !== 0) {
    throw new Error('[NORM.2] quedaron filas vivas sin product_id: el backfill no cerró.');
  }
};

exports.down = async function down(knex) {
  // Se revierte la estructura. Los huérfanos retirados NO se resucitan: apuntaban a la nada.
  await knex.raw(`DROP INDEX IF EXISTS catalog.ix_product_barcodes_product`);
  await knex.raw(`ALTER TABLE catalog.product_barcodes DROP CONSTRAINT IF EXISTS product_barcodes_product_fk`);
  const tiene = await knex.schema.withSchema('catalog').hasColumn('product_barcodes', 'product_id');
  if (tiene) await knex.raw(`ALTER TABLE catalog.product_barcodes DROP COLUMN product_id`);
  console.log('[NORM.2] revertido. Los huérfanos retirados siguen con deleted_at (apuntaban a la nada).');
};
