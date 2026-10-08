'use strict';
/**
 * `[NP.4]` **La clasificación de Compras** de cada producto que el sistema marcó como nuevo.
 *
 * El sistema propone; Compras confirma. Un código nuevo en Kepler no siempre es un producto
 * nuevo: entran recodificaciones de productos que ya existían, códigos de promoción y cosas que
 * no son mercancía. Contarlos como lanzamientos inflaría la inversión y hundiría la tasa de éxito.
 *
 * Es dato PROPIO (lo decide una persona, ningún feed lo puede ver), así que es tabla y no vista.
 * Una fila por producto vigente. Sin fila = "por confirmar": la ausencia se lee como tal, no como
 * "nuevo".
 *
 * `kind`:
 *   nuevo           — lanzamiento real; entra a los KPIs de la cohorte.
 *   recodificacion  — el mismo producto con otro código; sale de los KPIs.
 *   promocion       — código temporal de promoción o paquete; sale de los KPIs.
 *   no_mercancia    — servicios, ajustes, códigos internos; sale de los KPIs.
 *
 * Quitar la clasificación = soft-delete (deleted_at), para conservar quién decidió qué.
 *
 * @param { import("knex").Knex } knex
 */

exports.up = async function up(knex) {
  if (await knex.schema.withSchema('catalog').hasTable('new_product_reviews')) return;

  await knex.raw(`
    CREATE TABLE catalog.new_product_reviews (
      id                   uuid NOT NULL DEFAULT gen_random_uuid(),
      tenant_id            uuid NOT NULL,
      product_id           uuid NOT NULL,
      kind                 varchar(20) NOT NULL,
      note                 text,

      created_at           timestamptz NOT NULL DEFAULT now(),
      created_by           uuid,
      created_by_username  varchar(80),
      updated_at           timestamptz NOT NULL DEFAULT now(),
      updated_by           uuid,
      updated_by_username  varchar(80),
      deleted_at           timestamptz,
      deleted_by           uuid,

      PRIMARY KEY (id),
      UNIQUE (tenant_id, id),

      CONSTRAINT catalog_new_product_reviews_kind_chk
        CHECK (kind IN ('nuevo','recodificacion','promocion','no_mercancia')),
      -- Una nota vacia no es una nota: o trae texto o es NULL.
      CONSTRAINT catalog_new_product_reviews_note_chk
        CHECK (note IS NULL OR length(btrim(note)) > 0),
      -- Borrado coherente: si se borro, se sabe quien.
      CONSTRAINT catalog_new_product_reviews_deleted_chk
        CHECK ((deleted_at IS NULL AND deleted_by IS NULL) OR deleted_at IS NOT NULL),

      CONSTRAINT fk_catalog_new_product_reviews_tenant
        FOREIGN KEY (tenant_id) REFERENCES identity.tenants (id) ON DELETE RESTRICT,
      CONSTRAINT fk_catalog_new_product_reviews_product
        FOREIGN KEY (tenant_id, product_id) REFERENCES catalog.products (tenant_id, id) ON DELETE CASCADE
    )`);

  // Una clasificacion VIGENTE por producto. Parcial: las borradas quedan como historia.
  await knex.raw(`
    CREATE UNIQUE INDEX ux_new_product_reviews_vigente
      ON catalog.new_product_reviews (tenant_id, product_id)
      WHERE deleted_at IS NULL`);

  await knex.raw(`
    COMMENT ON TABLE catalog.new_product_reviews IS
      '[NP.4] Clasificacion de Compras de los productos que analytics.mv_new_products marca como nuevos. '
      'Dato propio HITL. Sin fila vigente = por confirmar. Solo kind=nuevo (o sin fila) entra a los KPIs de cohorte.'`);

  await knex.raw(`ALTER TABLE catalog.new_product_reviews ENABLE ROW LEVEL SECURITY`);
  await knex.raw(`ALTER TABLE catalog.new_product_reviews FORCE ROW LEVEL SECURITY`);
  await knex.raw(`DROP POLICY IF EXISTS tenant_isolation ON catalog.new_product_reviews`);
  await knex.raw(`
    CREATE POLICY tenant_isolation ON catalog.new_product_reviews
      USING (tenant_id = public.current_tenant_id())
      WITH CHECK (tenant_id = public.current_tenant_id())`);
  await knex.raw(`GRANT SELECT, INSERT, UPDATE ON catalog.new_product_reviews TO app_runtime`);
};

exports.down = async function down(knex) {
  await knex.schema.withSchema('catalog').dropTableIfExists('new_product_reviews');
};
