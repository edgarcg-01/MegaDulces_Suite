/**
 * Fix de 20260825140000: el DROP de `commercial.vendor_sale_lines.route_id` se SALTÓ.
 *
 * Causa: `knex.schema.hasColumn('commercial.vendor_sale_lines', 'route_id')` NO parsea el
 * `schema.tabla` (busca una tabla literal "commercial.vendor_sale_lines" en el search_path,
 * no la encuentra) → devolvió false → el `dropColumn` guardado nunca corrió. El NULL de
 * huérfanos de esa misma migración sí funcionó porque usaba SQL raw con schema explícito.
 *
 * Aquí se hace con SQL raw + IF EXISTS (idempotente: no-op si ya no está). route_id es una
 * columna MUERTA (1242/1242 huérfanas, ningún service la lee) — drop aprobado por Edgar.
 *
 * @param { import("knex").Knex } knex
 */
exports.up = async function up(knex) {
  await knex.raw('ALTER TABLE commercial.vendor_sale_lines DROP COLUMN IF EXISTS route_id');
};

exports.down = async function down(knex) {
  // Repone la columna vacía (estaba muerta, sin datos que restaurar).
  await knex.raw(`DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema='commercial' AND table_name='vendor_sale_lines' AND column_name='route_id'
      ) THEN
        ALTER TABLE commercial.vendor_sale_lines ADD COLUMN route_id uuid;
        COMMENT ON COLUMN commercial.vendor_sale_lines.route_id IS
          'Ruta asignada del vendedor (catalogs rutas) al momento de la captura. Para reporte venta por ruta.';
      END IF;
    END $$`);
};
