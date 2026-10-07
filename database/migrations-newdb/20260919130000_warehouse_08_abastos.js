/**
 * `[RL.12]` Warehouse `08` (Morelia Abastos — POS Kepler `md_08`). Cierra el cutover del 2026-09-18.
 *
 * Es la pieza que `20260918250000_cutover_abastos_08_madero_32.js` dejó declarada y NO hizo, con
 * estas palabras: *"`08` todavía NO entra por el lado Kepler, y no es este archivo el que lo
 * arregla: `mv_kepler_sales_daily` hace `JOIN commercial.warehouses w ON w.code = sucursal`, y
 * Abastos es `MD-30`. Hace falta un almacén con `code = '08'` (…) sin ella, Abastos no aporta al
 * sell-out desde el 09-18"*. Acá está, y calca a `20260909160000_warehouse_07_madero.js`.
 *
 * ── El lado ODS, verificado antes de escribir ───────────────────────────────────────────────
 *   `database/importers/lib/kepler-branches.js:78` ya expone la rama:
 *       { code: '08', host: '192.168.30.30', port: 1977, db: 'md_08',
 *         replica: 'kepler_md_08', name: 'Morelia Abastos' }
 *   y en prod (`db=railway`, 2026-09-19) el ODS ya tiene la rama viva: `kepler_ods.kdii` 9,576
 *   filas y `kepler_ods.kdm1` 146 documentos, todos del 2026-09-18.
 *
 * ⚠️ Los 146 documentos son traspasos de ENTRADA (`N-A-44` ×144, más un `N-A-30` y un `N-A-45`):
 * **la tienda todavía no vende**. No hay un solo `U-D-10`, y `kdm2.c66` viene en 0 en los 10,702
 * renglones. O sea que este almacén nace para recibir surtido, y su primera venta va a ser la
 * que confirme que el carril de ventas resuelve. Se declara: no se puede afirmar todavía.
 *
 * ⚠️ El código `08` **lo elegimos nosotros, no Kepler** (`kepler-branches.js:70-72`): `md.kdm1`
 * no tiene columna `sucursal` — se la agrega el shipper. Se eligió `08` porque 00–07 estaban
 * tomados y coincide con el nombre de la base.
 *
 * ── Qué NO hace, y por qué ──────────────────────────────────────────────────────────────────
 * **No toca `MD-30`.** Madero hizo lo mismo: `20260909160000` creó el `07` y el soft-delete de
 * `MD-32` llegó aparte, tres días después (`20260911120000_cleanup_retired_lanes_md32.js`).
 * `MD-30` conserva la identidad Wincaja (`wincaja_source_branch = '30'`, la historia < 09-18) y
 * el `08` toma SÓLO la identidad Kepler (≥ 09-18) — por eso no se duplica
 * `wincaja_source_branch`: lo leen scope y recepciones, y duplicarlo los vuelve ambiguos.
 * Cada era, su casa.
 *
 * `zone_id` y `source_warehouse_id` se derivan de `MD-30` (misma plaza física, misma red de
 * resurtido) para que la migración sea portable entre entornos. Idempotente.
 *
 * @param { import("knex").Knex } knex
 */
const M = '00000000-0000-0000-0000-00000000d01c';

exports.up = async function up(knex) {
  await knex.raw(
    `INSERT INTO commercial.warehouses
       (tenant_id, code, name, kepler_code, kind, is_default, active, sells_to_public, zone_id, source_warehouse_id, display_order, short_label)
     SELECT tenant_id, '08', 'Morelia Abastos', '08', 'central', false, true, true,
            zone_id, source_warehouse_id, 10, 'MA'
       FROM commercial.warehouses
      WHERE tenant_id = ? AND code = 'MD-30'
     ON CONFLICT (tenant_id, code) DO UPDATE
       SET kepler_code = EXCLUDED.kepler_code, active = true, deleted_at = NULL, updated_at = now()`,
    [M]);

  // El usuario que imprime las etiquetas de esa tienda queda con los DOS campos poblados, como
  // su hermano `etiquetas.32` (code '07' + warehouse_id). El `warehouse_code` ya se movió a '08';
  // esto cierra el `warehouse_id`, que estaba en NULL porque el almacén no existía.
  await knex.raw(
    `UPDATE identity.users u
        SET warehouse_id = w.id, updated_at = now()
       FROM commercial.warehouses w
      WHERE w.tenant_id = u.tenant_id AND w.code = '08' AND w.deleted_at IS NULL
        AND u.tenant_id = ? AND u.warehouse_code = '08' AND u.warehouse_id IS NULL
        AND u.deleted_at IS NULL`,
    [M]);
};

exports.down = async function down(knex) {
  // Reversible sin borrar historia: se suelta el usuario y, si '08' no llegó a tener venta
  // propia, se soft-deletea. Con venta adentro NO se toca -- borrarlo la dejaria huerfana.
  await knex.raw(
    `UPDATE identity.users SET warehouse_id = NULL, updated_at = now()
      WHERE tenant_id = ?
        AND warehouse_id IN (SELECT id FROM commercial.warehouses WHERE tenant_id = ? AND code = '08')`,
    [M, M]);
  await knex.raw(
    `UPDATE commercial.warehouses SET deleted_at = now()
      WHERE tenant_id = ? AND code = '08'
        AND NOT EXISTS (SELECT 1 FROM analytics.sales_daily s
                         WHERE s.warehouse_id = commercial.warehouses.id)`,
    [M]);
};
