/**
 * RS.11 — reclasifica `01:10003` de "piso oculto" → VENDEDOR de telemarketing "VENTAS TLMK PH".
 *
 * Contexto: `20260903120000_vendor_identity_kepler.js` marcó `01:10003 "SUCURSAL PADRE HIDALGO PISO"`
 * como `exclude=true` (lo clasificó como bucket de piso, no persona). Pero el catálogo `kduv` del CEDIS
 * lo nombra `00:10M03 "TLMKT PADRE HIDALGO"` = telemarketing. Decisión de negocio del usuario (2026-09-07,
 * confirmada): es el telemarketing de Padre Hidalgo y debe aparecer en el desglose por vendedor con el
 * rótulo "VENTAS TLMK PH". Reclasifica ~$353k/60d de "piso oculto" a telemarketing.
 *
 * NO edita la migración aplicada: hace su propio UPSERT (exclude=false + canonical_name). Sin merge con
 * hermano Wincaja (no se identificó uno; queda como su propia columna). vendor_identity es una tabla que
 * el servicio lee EN VIVO (canonVendor) → efecto inmediato, sin re-materializar nada.
 * Idempotente: INSERT ... ON CONFLICT DO UPDATE. @param { import("knex").Knex } knex
 */

const T = '00000000-0000-0000-0000-00000000d01c';

exports.up = async function (knex) {
  await knex.raw(
    `INSERT INTO analytics.vendor_identity (tenant_id, source_branch, vendedor, canonical_key, canonical_name, exclude, note)
     VALUES (?, '01', '10003', 'ventas-tlmk-ph', 'VENTAS TLMK PH', false,
             'Telemarketing Padre Hidalgo (kduv 00:10M03 TLMKT PADRE HIDALGO). Reclasificado de piso→vendedor por decisión de negocio 2026-09-07.')
     ON CONFLICT (tenant_id, source_branch, vendedor)
     DO UPDATE SET canonical_key = 'ventas-tlmk-ph', canonical_name = 'VENTAS TLMK PH', exclude = false,
                   note = EXCLUDED.note, updated_at = now()`,
    [T],
  );
};

exports.down = async function (knex) {
  // Revertir = volver a ocultarlo como piso (estado de 20260903120000).
  await knex.raw(
    `UPDATE analytics.vendor_identity
        SET exclude = true, canonical_key = 'kepler-01-10003', canonical_name = 'SUCURSAL PADRE HIDALGO PISO', updated_at = now()
      WHERE tenant_id = ? AND source_branch = '01' AND vendedor = '10003'`,
    [T],
  );
};
