/**
 * Independencia de módulos — Fiscal: Impuestos provisionales y Expediente de
 * materialidad dejan de tomar prestado el permiso de un módulo hermano y usan el
 * suyo. Backfill para no perder acceso (target ← source):
 *
 *   - FISCAL_IMPUESTOS_VER    ← FISCAL_DIOT_VER   (impuestos.provisional pedía DIOT)
 *   - FISCAL_MATERIALIDAD_VER ← FISCAL_LISTAS_VER (materialidad.dossier pedía LISTAS)
 *
 * (El endpoint de estatus de CFDI queda en FISCAL_CFDI_VER a propósito: consultar el
 * estatus SAT de un CFDI ES una operación del módulo CFDI, no un módulo aparte.)
 *
 * customer_b2b NO hereda (internalOnly). Idempotente (`-> 'KEY' IS NULL`), aditivo.
 *
 * @param { import("knex").Knex } knex
 */
exports.up = async function (knex) {
  const derived = [
    { key: 'FISCAL_IMPUESTOS_VER', from: 'FISCAL_DIOT_VER' },
    { key: 'FISCAL_MATERIALIDAD_VER', from: 'FISCAL_LISTAS_VER' },
  ];
  let total = 0;
  for (const d of derived) {
    const res = await knex.raw(
      `UPDATE role_permissions
          SET permissions = permissions || jsonb_build_object(:key::text,
            CASE WHEN role_name = 'customer_b2b' THEN false
                 ELSE COALESCE((permissions->>:from::text)::boolean, false) END)
        WHERE permissions -> :key::text IS NULL`,
      { key: d.key, from: d.from },
    );
    total += res.rowCount ?? 0;
  }
  console.log(`[fiscal_subareas_backfill] up: filas actualizadas = ${total}`);
};

/**
 * Revierte: quita las 2 claves. Idempotente.
 * @param { import("knex").Knex } knex
 */
exports.down = async function (knex) {
  for (const k of ['FISCAL_IMPUESTOS_VER', 'FISCAL_MATERIALIDAD_VER']) {
    await knex.raw(
      `UPDATE role_permissions SET permissions = permissions - :k::text WHERE permissions -> :k::text IS NOT NULL`,
      { k },
    );
  }
  console.log('[fiscal_subareas_backfill] down: claves removidas');
};
