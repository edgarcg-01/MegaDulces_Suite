/**
 * Sell-Out por vendedor — CORRECCIÓN de la mig ...180000 (regla: cross-sucursal ≠ misma persona).
 *
 * En ...180000 fundí `04:10001` "Cinthia Yaret del Valle Rueda" ($253, Yurécuaro) a `cinthia-yaret`,
 * asumiendo misma persona por nombre idéntico. El usuario corrigió la regla (2026-09-08): DOS códigos
 * en sucursales DISTINTAS NUNCA son la misma persona (salvo el cutover Wincaja→Kepler ya confirmado:
 * 10↔01 mayoreo, 50↔06 Canindo, donde la persona SÍ cambió de sucursal).
 *
 * `04:10001` NO es un cutover: `10001` es el código de mayoreo de PH (Cinthia = 01:10001). Que aparezca
 * en 04 (Yurécuaro) con el nombre byte-idéntico y sólo $253 = FUGA por catálogo `kduv` replicado entre
 * sucursales (mismo patrón que la vecinal 1V004), no una segunda Cinthia real. → exclude=true (se saca
 * del desglose). NO se funde a nadie.
 *
 * `vendor_identity` se lee EN VIVO → efecto inmediato. Idempotente (UPSERT). Reversible.
 * @param { import("knex").Knex } knex
 */
const T = '00000000-0000-0000-0000-00000000d01c';

exports.up = async function (knex) {
  await knex.raw(
    `INSERT INTO analytics.vendor_identity (tenant_id, source_branch, vendedor, canonical_key, canonical_name, exclude, note)
     VALUES (?, '04', '10001', 'leak-04-10001', 'Cinthia (fuga catálogo 04)', true, ?)
     ON CONFLICT (tenant_id, source_branch, vendedor)
     DO UPDATE SET canonical_key = EXCLUDED.canonical_key, canonical_name = EXCLUDED.canonical_name,
                   exclude = true, note = EXCLUDED.note, updated_at = now()`,
    [T, 'Cross-sucursal ≠ misma persona. Cód. mayoreo PH (10001) filtrado a Yurécuaro, $253 = fuga kduv. Purga.'],
  );
};

exports.down = async function (knex) {
  // Revertir a la (errónea) fusión previa de ...180000.
  await knex.raw(
    `UPDATE analytics.vendor_identity
        SET canonical_key = 'cinthia-yaret', canonical_name = 'Cinthia Yaret del Valle Rueda',
            exclude = false, updated_at = now()
      WHERE tenant_id = ? AND source_branch = '04' AND vendedor = '10001'`, [T]);
};
