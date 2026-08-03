/**
 * Fase CC (extensión) — Permisos de Comprobantes de Pago a Proveedor y de Entrada.
 *
 * VER = capturista adjunta el comprobante + OCR; GESTIONAR = revisor valida/rechaza.
 * Backfill que ancla a los permisos de Bancos (misma área de Finanzas), para que
 * ningún rol que ya opera Finanzas pierda acceso:
 *   - FINANCE_PAYMENTS_VER       ← FINANCE_BANK_VER        (pago a proveedor)
 *   - FINANCE_PAYMENTS_GESTIONAR ← FINANCE_BANK_GESTIONAR
 *   - FINANCE_RECEIPTS_VER       ← FINANCE_BANK_VER        (orden de entrada)
 *   - FINANCE_RECEIPTS_GESTIONAR ← FINANCE_BANK_GESTIONAR
 *
 * Idempotente (patrón `-> 'KEY' IS NULL`). customer_b2b explícito en false.
 * Requiere RE-LOGIN (el JWT lleva los permisos).
 * @param { import("knex").Knex } knex
 */
exports.up = async function (knex) {
  const ANCHOR = {
    FINANCE_PAYMENTS_VER: 'FINANCE_BANK_VER',
    FINANCE_PAYMENTS_GESTIONAR: 'FINANCE_BANK_GESTIONAR',
    FINANCE_RECEIPTS_VER: 'FINANCE_BANK_VER',
    FINANCE_RECEIPTS_GESTIONAR: 'FINANCE_BANK_GESTIONAR',
  };
  for (const [key, anchor] of Object.entries(ANCHOR)) {
    const res = await knex.raw(
      `UPDATE role_permissions
          SET permissions = permissions || jsonb_build_object('${key}',
                CASE WHEN role_name = 'customer_b2b' THEN false
                     ELSE COALESCE((permissions->>'${anchor}')::boolean, false) END)
        WHERE permissions -> '${key}' IS NULL`,
    );
    console.log(`[finance_supplier_receipt_perms] up ${key} ← ${anchor}: filas = ${res.rowCount ?? 0}`);
  }
};

/** @param { import("knex").Knex } knex */
exports.down = async function (knex) {
  for (const key of ['FINANCE_PAYMENTS_VER', 'FINANCE_PAYMENTS_GESTIONAR', 'FINANCE_RECEIPTS_VER', 'FINANCE_RECEIPTS_GESTIONAR']) {
    await knex.raw(`UPDATE role_permissions SET permissions = permissions - '${key}' WHERE permissions -> '${key}' IS NOT NULL`);
  }
};
