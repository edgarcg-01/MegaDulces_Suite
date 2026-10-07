/**
 * Revierte 20260825170000_drop_vendor_route_id — el drop se aprobó con una premisa FALSA:
 * "route_id es columna muerta, ningún service la lee". En realidad CommercialVendorSalesService
 * la usa en 3 lugares:
 *   - el INSERT de POST /commercial/vendor-sales (`route_id: dto.route_id ?? null`),
 *   - el reporte `porRuta` ("venta por ruta": whereNotNull route_id + groupBy route_id),
 *   - el reporte `porCaptura` (enriquece con route_name joineando trade.catalogs por route_id).
 *
 * El drop rompió el endpoint en prod (42703: column "route_id" does not exist). Los 1242 huérfanos
 * eran NULL porque el frontend TODAVÍA no envía route_id (feature a completar), no porque esté
 * muerta. Se re-agrega la columna nullable (como estaba; no había datos que restaurar).
 *
 * Idempotente: ADD COLUMN sólo si no existe (DO block).
 * @param { import("knex").Knex } knex
 */
exports.up = async function up(knex) {
  await knex.raw(`DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'commercial' AND table_name = 'vendor_sale_lines' AND column_name = 'route_id'
      ) THEN
        ALTER TABLE commercial.vendor_sale_lines ADD COLUMN route_id uuid;
        COMMENT ON COLUMN commercial.vendor_sale_lines.route_id IS
          'Ruta asignada del vendedor (trade.catalogs) al momento de la captura. Para el reporte venta por ruta (porRuta / porCaptura). Nullable: el frontend aún no la envía en todas las capturas.';
      END IF;
    END $$`);
};

exports.down = async function down(knex) {
  await knex.raw('ALTER TABLE commercial.vendor_sale_lines DROP COLUMN IF EXISTS route_id');
};
