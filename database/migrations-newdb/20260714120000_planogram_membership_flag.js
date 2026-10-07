/**
 * Normaliza el planograma: membresía explícita para separarlo del catálogo ERP.
 *
 * `catalog.products` contiene TANTO el planograma de trade (~1,189 productos,
 * cohorte de mayo, embebidos en Fase K) COMO el volcado del catálogo ERP (~6,452
 * productos, imports masivos de jun). El endpoint `/planograms/brands` devolvía
 * TODO sin filtrar → `/dashboard/captures` (y `/admin/planograma`) mostraban el
 * catálogo ERP entero (razones sociales de proveedores + basura tipo "PRODUCTOS
 * A ELIMINAR").
 *
 * Solución NO destructiva: `catalog.products.in_planogram` marca qué productos son
 * del planograma. NO borramos nada — portal / vendor / take-order siguen usando
 * `catalog.products` completo. El endpoint de trade filtra por este flag.
 *
 * Seed idempotente = cohorte mayo (`embedding IS NOT NULL`, == creados < jun, ==
 * corpus Fase K) ∪ productos YA usados en `daily_captures` (verificado: ~396
 * productos de la cohorte junio se auditan hoy y no deben perderse). Bump de
 * `updated_at` para invalidar el cache del cliente móvil (getVersion).
 *
 * @param { import("knex").Knex } knex
 */
exports.up = async function (knex) {
  const hasCol = await knex.schema
    .withSchema('catalog')
    .hasColumn('products', 'in_planogram');
  if (!hasCol) {
    await knex.schema.withSchema('catalog').alterTable('products', (t) => {
      t.boolean('in_planogram').notNullable().defaultTo(false);
    });
    await knex.raw(`
      COMMENT ON COLUMN catalog.products.in_planogram IS
        'true = producto del planograma de trade (captura/auditoría en ruta). '
        'El catálogo ERP completo vive en esta misma tabla; este flag lo separa. '
        'Curado desde /admin/planograma.'
    `);
  }

  await knex.raw(`
    CREATE INDEX IF NOT EXISTS idx_products_in_planogram
      ON catalog.products (tenant_id, in_planogram)
      WHERE in_planogram = true
  `);

  // Seed idempotente: solo toca filas aún en false que califican.
  const res = await knex.raw(`
    WITH used AS (
      SELECT DISTINCT (jsonb_array_elements_text(
               jsonb_array_elements(exhibiciones) -> 'productosMarcados')) AS pid
      FROM trade.daily_captures
      WHERE exhibiciones IS NOT NULL
    )
    UPDATE catalog.products p
       SET in_planogram = true,
           updated_at = NOW()
     WHERE p.in_planogram = false
       AND (
         p.embedding IS NOT NULL
         OR p.id::text IN (SELECT pid FROM used)
       )
  `);
  // eslint-disable-next-line no-console
  console.log(`[planogram_membership] productos marcados in_planogram: ${res.rowCount ?? '?'}`);
};

exports.down = async function (knex) {
  await knex.raw(`DROP INDEX IF EXISTS catalog.idx_products_in_planogram`);
  const hasCol = await knex.schema
    .withSchema('catalog')
    .hasColumn('products', 'in_planogram');
  if (hasCol) {
    await knex.schema.withSchema('catalog').alterTable('products', (t) => {
      t.dropColumn('in_planogram');
    });
  }
};
