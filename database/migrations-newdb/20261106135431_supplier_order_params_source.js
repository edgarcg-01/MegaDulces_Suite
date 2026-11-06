'use strict';
/**
 * `[CANON.5.25]` — Procedencia de los parámetros de pedido por proveedor (D5 del anexo CANON.5).
 *
 * `catalog.suppliers` guarda cadencia, colchón y mínimos (`cadence_days_override`, `colchon_days`,
 * `min_order_amount`, `min_order_boxes`). Los escriben dos manos: `import-supplier-params` (los
 * deriva del histórico de compras) y la pantalla `/compras/proveedores` (campo por campo). Nada
 * decía cuál era cuál, así que el importer sólo podía llenar NULL y lo derivado nunca se refrescaba.
 *
 * `order_params_source` es un mapa POR CAMPO, porque la pantalla edita un campo a la vez:
 *   {"cadence_days_override": "manual" | "derivado" | "desconocido", ...}
 *   · manual       — lo capturó una persona (lo marca la API en la misma escritura).
 *   · derivado     — lo escribió el importer; él lo refresca.
 *   · desconocido  — había un valor antes de este cambio y no coincidía con lo derivable: no se
 *                    sabe quién lo puso, así que se protege igual que manual.
 *   · (sin llave)  — lo clasifica el importer en su siguiente corrida (igual a lo derivable →
 *                    derivado; distinto → desconocido). Esa clasificación vive en el importer y NO
 *                    aquí, porque derivar exige su agrupación por episodios en JS: repetirla en SQL
 *                    serían dos implementaciones que pueden divergir.
 *
 * ── Lo medido antes (sólo lectura, 2026-11-06) ───────────────────────────────────────────────
 *  · 290 proveedores derivables; 260 con al menos un valor distinto del que se derivaría hoy.
 *  · La tabla no tiene trigger de historia y la API escribía sin `updated_by`.
 *
 * Compatible con la API desplegada: NOT NULL con DEFAULT constante (en PG ≥ 11 no reescribe la
 * tabla); el código viejo no manda la columna y recibe `{}`.
 *
 * Idempotente.
 *
 * @param { import("knex").Knex } knex
 */

exports.up = async function up(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);
  if (!(await knex.schema.withSchema('catalog').hasColumn('suppliers', 'order_params_source'))) {
    await knex.raw(`ALTER TABLE catalog.suppliers ADD COLUMN order_params_source jsonb NOT NULL DEFAULT '{}'::jsonb`);
  }
  await knex.raw(`COMMENT ON COLUMN catalog.suppliers.order_params_source IS
    'CANON.5.25 — procedencia por campo de los parámetros de pedido: manual | derivado | desconocido. El importer import-supplier-params sólo refresca lo derivado.'`);
};

/** Deshace EXACTAMENTE lo que hizo el `up`, ni una fila más. */
exports.down = async function down(knex) {
  if (await knex.schema.withSchema('catalog').hasColumn('suppliers', 'order_params_source')) {
    await knex.raw(`ALTER TABLE catalog.suppliers DROP COLUMN order_params_source`);
  }
};
