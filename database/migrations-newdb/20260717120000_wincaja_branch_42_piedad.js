/**
 * Registra la sucursal Wincaja 42 = "PIEDAD ABASTOS" (La Piedad Abastos), que
 * quedo FUERA del seed original de wincaja.branches (estaban 40/44/54 pero no 42).
 *
 * Mapea a Kepler md_02 = warehouse '02' ("La Piedad Abastos"). Kepler tomo esta
 * sucursal el 2025-10-03 (tienda) / 2025-10-10 (credito); antes vivia en Wincaja.
 * Sin este registro, el silver v_sales_lines veria kepler_code=NULL => wincaja_only=true
 * => contaria TODAS las fechas y haria DOBLE CONTEO con Kepler oct-2025+. Con kepler_code
 * seteado, wincaja_only=false y el blend por fecha del gold (import-wincaja-analytics,
 * business_date < 2025-10-01) controla que solo el historico Wincaja fluya.
 *
 * Idempotente (ON CONFLICT DO NOTHING).
 */
const TENANT = '00000000-0000-0000-0000-00000000d01c';

exports.up = async function (knex) {
  await knex.raw(
    `INSERT INTO wincaja.branches
       (tenant_id, source_branch, branch_name, kepler_code, warehouse_code, status, mdb_file, notes, is_route)
     VALUES (?, '42', 'PIEDAD ABASTOS', '02', 'MD-42', 'legacy_on_kepler', '42 PIEDAD ABASTOS.MDB',
             'Kepler md_02 (warehouse 02 La Piedad Abastos); Wincaja historico < 2025-10 (Kepler la tomo 2025-10-03)', false)
     ON CONFLICT (tenant_id, source_branch) DO NOTHING`,
    [TENANT],
  );
};

exports.down = async function (knex) {
  await knex.raw(`DELETE FROM wincaja.branches WHERE tenant_id = ? AND source_branch = '42'`, [TENANT]);
};
