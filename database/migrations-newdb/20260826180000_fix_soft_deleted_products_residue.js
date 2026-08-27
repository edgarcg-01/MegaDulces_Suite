/**
 * Fix de productos soft-deleted: colador de `activo` + residuo de tablas derivadas.
 *
 * Contexto (auditado en prod 2026-08-26 a raíz del SKU 68523 "PALO 4X45 500GR"):
 *  - `catalog.products.activo` en prod es una columna PLANA (is_generated=NEVER), NO generada de
 *    `deleted_at` como documenta el K-debt. Al hacer soft-delete (deleted_at=NOW()) `activo` quedaba
 *    en true → 517 productos borrados con activo=true. Los queries de /compras/pedido, workbook y
 *    salidas filtran por `pr.activo = true` → NO excluían borrados (colador latente).
 *  - Productos borrados conservaban filas en tablas derivadas: 136 en analytics.replenishment_plan
 *    y 152 en commercial.stock (residuo que el builder re-arma porque `pf` toma activo=true).
 *  - El índice único es parcial `(tenant, sku) WHERE deleted_at IS NULL` → una fila viva + una
 *    borrada del mismo sku coexisten (887 SKUs con ese patrón). El fix del feed
 *    (import-wincaja-missing-products: revivir en vez de insertar) va aparte, en código.
 *
 * Esta migración: (1) sincroniza activo con deleted_at (one-shot); (2) purga el residuo. La no
 * regeneración la garantiza el fix de `import-replenishment-plan.js` (pf con deleted_at IS NULL)
 * + los filtros `deleted_at IS NULL` en los services.
 *
 * Idempotente: re-correrla no borra de más (los WHERE son sobre el estado actual).
 */
const M = '00000000-0000-0000-0000-00000000d01c';

exports.up = async (knex) => {
  // 1) activo debe reflejar deleted_at (columna plana en prod). Solo toca las inconsistentes.
  await knex.raw(
    `UPDATE catalog.products SET activo = false, updated_at = now()
      WHERE deleted_at IS NOT NULL AND activo = true`);

  // 2) Purga de residuo en tablas derivadas de productos borrados.
  //    replenishment_plan es analytics.* (sin RLS). Owner-safe.
  await knex.raw(
    `DELETE FROM analytics.replenishment_plan rp
       USING catalog.products p
      WHERE p.id = rp.product_id AND p.deleted_at IS NOT NULL`);

  //    commercial.stock tiene RLS forzado → fijar tenant por si el rol de migración no bypassa.
  await knex.raw(`SET LOCAL app.tenant_id = '${M}'`);
  await knex.raw(
    `DELETE FROM commercial.stock s
       USING catalog.products p
      WHERE p.id = s.product_id AND p.deleted_at IS NOT NULL`);
};

// Limpieza de datos: no se revierte (no hay estado previo que restaurar con sentido).
exports.down = async () => {};
