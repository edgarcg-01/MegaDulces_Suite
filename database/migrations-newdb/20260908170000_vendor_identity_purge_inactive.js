/**
 * Sell-Out por vendedor — purga de vendedores INACTIVOS >3 meses (exclude=true).
 *
 * Tras enlazar los gemelos Kepler↔Wincaja del cutover (mig 20260908160000), los únicos que
 * quedan sin venta desde antes de jun-2026 (>3 meses al 2026-09-08) son estos 10 — ninguno con
 * continuación activa. La mayoría son buckets no-persona (Ventas de Piso, Usuario 02, Abastos
 * La Piedad); dos son personas que dejaron de vender (Paulina mar-2026, Benjamín abr-2026).
 * Se sacan del desglose por vendedor con exclude=true. `vendor_identity` se lee EN VIVO →
 * efecto inmediato. Idempotente (UPSERT).
 *
 * ⚠️ REVERSIBLE: si alguno vuelve a vender, quitar su exclude (poner false) y reaparece. Un
 * ocultamiento por inactividad es un exclude manual, no un borrado.
 * @param { import("knex").Knex } knex
 */
const T = '00000000-0000-0000-0000-00000000d01c';
// [source_branch, vendedor, canonical_key, canonical_name, note] — todos exclude=true
const ROWS = [
  ['02', '1',     'purge-paulina-plascencia',   'Paulina Michelle Plascencia',   'Inactivo: última venta mar-2026 (>3m). Purga.'],
  ['03', '2',     'purge-piso-03',              'Ventas de Piso',                'Piso (no-vendedor), inactivo feb-2026. Purga.'],
  ['50', '74',    'purge-alberto-ayala-gzz',    'Alberto Ayala Gonzalez',        'Inactivo: última sep-2025 (>1a). Distinto de Alberto Ayala 30:74/75 (Morelia, activo). Purga.'],
  ['30', '23',    'purge-usuario-02',           'Usuario 02',                    'Genérico/test, inactivo dic-2025. Purga.'],
  ['05', '2',     'purge-piso-05',              'Ventas de Piso',                'Piso, inactivo abr-2026. Purga.'],
  ['05', '3',     'purge-benjamin-zaragoza',    'Benjamin Alonzo Zaragoza',      'Inactivo: última abr-2026 (>3m). Purga.'],
  ['10', '42',    'purge-abastos-piedad',       'Abastos La Piedad',             'Bucket sucursal (no-vendedor), inactivo oct-2025. Purga.'],
  ['02', '3V001', 'purge-vecinal-zamora-stray', 'Ruta Vecinal Zamora (residual)','Código vecinal residual bajo suc.02, inactivo may-2026 ($1.2k). Purga.'],
  ['50', '15',    'purge-venta-vecinal-50',     'Venta Vecinal',                 'Genérico, inactivo jul-2025. Purga.'],
  ['04', '2',     'purge-piso-04',              'Ventas de Piso',                'Piso, inactivo may-2026. Purga.'],
];

exports.up = async function (knex) {
  for (const [sb, ven, key, name, note] of ROWS) {
    await knex.raw(
      `INSERT INTO analytics.vendor_identity (tenant_id, source_branch, vendedor, canonical_key, canonical_name, exclude, note)
       VALUES (?, ?, ?, ?, ?, true, ?)
       ON CONFLICT (tenant_id, source_branch, vendedor)
       DO UPDATE SET exclude = true, note = EXCLUDED.note, updated_at = now()`,
      [T, sb, ven, key, name, note],
    );
  }
};

exports.down = async function (knex) {
  // Revertir el purgado = volver a exclude=false (no borra la fila; conserva la identidad).
  for (const [sb, ven] of ROWS) {
    await knex.raw(
      `UPDATE analytics.vendor_identity SET exclude = false, updated_at = now()
       WHERE tenant_id = ? AND source_branch = ? AND vendedor = ?`, [T, sb, ven]);
  }
};
