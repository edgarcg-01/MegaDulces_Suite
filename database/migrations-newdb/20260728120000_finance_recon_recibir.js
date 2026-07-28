/**
 * MA — Permiso FINANCE_RECON_RECIBIR (pool del área de Finanzas para el reparto).
 *
 * El motor de reparto de conciliación (MaatReconTasksService.financeUsers) dejaba de
 * usar FINANCE_BANK_GESTIONAR (demasiado amplio: repartidor/marketing/televenta lo
 * heredaron del anchor COMMERCIAL_ORDERS_VER) y pasa a este permiso dedicado. Solo los
 * roles del EQUIPO REAL de Finanzas lo tienen → el reparto cae únicamente en ellos.
 *
 * Grant a los 6 roles de finanzas (los de las 7 personas del equipo, 2026-07); false
 * para el resto. Editable después desde /admin/roles (quitar el permiso = deja de
 * recibir tareas). Idempotente. Requiere RE-LOGIN solo si se usara en el JWT — el
 * motor lo lee de role_permissions en runtime, así que basta correr la migración.
 *
 * @param { import("knex").Knex } knex
 */
const FINANCE_ROLES = [
  'control_depositos_pagos', 'gestor_egresos', 'auxiliar_finanzas',
  'analista_credito_cobranza', 'gestor_tesoreria', 'credito_cobranza',
];

exports.up = async function (knex) {
  // 1) true para el equipo de Finanzas (idempotente: siempre lo fija en true).
  const t = await knex('role_permissions')
    .whereIn('role_name', FINANCE_ROLES)
    .update({ permissions: knex.raw(`permissions || '{"FINANCE_RECON_RECIBIR":true}'::jsonb`) });
  // 2) false para el resto que aún no tenga la clave.
  const f = await knex.raw(
    `UPDATE role_permissions SET permissions = permissions || '{"FINANCE_RECON_RECIBIR":false}'::jsonb
       WHERE permissions -> 'FINANCE_RECON_RECIBIR' IS NULL`,
  );
  console.log(`[finance_recon_recibir] up: ${t} roles de finanzas = true, ${f.rowCount ?? 0} = false.`);
};

/** @param { import("knex").Knex } knex */
exports.down = async function (knex) {
  await knex.raw(`UPDATE role_permissions SET permissions = permissions - 'FINANCE_RECON_RECIBIR' WHERE permissions -> 'FINANCE_RECON_RECIBIR' IS NOT NULL`);
};
