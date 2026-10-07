/**
 * RV — PH vecinal: mostrar el NOMBRE de la persona en vez del código de ruta.
 *
 * La venta vecinal de PH fluye por dos rutas (kdm1.c12): 1V001 "RUTA VECINAL PH 01" y
 * 1V002 "RUTA VECINAL PH 02". Las trabajan dos personas (kduv sb01, codigos persona
 * inactivos 10V01/10V02). Mapeo confirmado por el usuario 2026-09-08:
 *   01:1V001 → Candy (Maria Cande Salgado)   ·   01:1V002 → Rafael (Rafael Villalobos Campos)
 *
 * vendor_identity se lee EN VIVO (canonVendor) → efecto inmediato, sin re-materializar.
 * canonical_key distinto por persona (no colapsan entre si). Idempotente (UPSERT).
 * @param { import("knex").Knex } knex
 */
const T = '00000000-0000-0000-0000-00000000d01c';
const ROWS = [
  ['01', '1V001', 'ph-vecinal-candy', 'Candy Salgado', 'RV PH 01 (Maria Cande Salgado).'],
  ['01', '1V002', 'ph-vecinal-rafael', 'Rafael Villalobos', 'RV PH 02 (Rafael Villalobos Campos).'],
];

exports.up = async function (knex) {
  for (const [sb, ven, key, name, note] of ROWS) {
    await knex.raw(
      `INSERT INTO analytics.vendor_identity (tenant_id, source_branch, vendedor, canonical_key, canonical_name, exclude, note)
       VALUES (?, ?, ?, ?, ?, false, ?)
       ON CONFLICT (tenant_id, source_branch, vendedor)
       DO UPDATE SET canonical_key = EXCLUDED.canonical_key, canonical_name = EXCLUDED.canonical_name,
                     exclude = false, note = EXCLUDED.note, updated_at = now()`,
      [T, sb, ven, key, name, note],
    );
  }
};

exports.down = async function (knex) {
  for (const [sb, ven] of ROWS) {
    await knex.raw(`DELETE FROM analytics.vendor_identity WHERE tenant_id = ? AND source_branch = ? AND vendedor = ?`, [T, sb, ven]);
  }
};
