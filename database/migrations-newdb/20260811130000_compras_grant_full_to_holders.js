/**
 * RA — Concede TODOS los permisos de Compras a los roles que ya tienen ALGUNO.
 *
 * Tras el split (mig 20260811120000), un rol que sólo tenía COMPRAS_VER quedó con los
 * *_VER pero sin *_GESTIONAR. Decisión del negocio: quien opera Compras debe tener acceso
 * a TODOS sus submódulos. Este backfill pone en true los 21 permisos COMPRAS_* para
 * cualquier rol que hoy tenga al menos uno en true.
 *
 * Idempotente (re-correrlo re-concede lo mismo). NO toca roles sin compras (externos,
 * b2b). El admin god-mode ya los tiene por RolesGuard. Frontend gatea por JWT → RE-LOGIN.
 *
 * @param { import("knex").Knex } knex
 */
const ALL = [
  'COMPRAS_PEDIDO_VER', 'COMPRAS_PEDIDO_GESTIONAR',
  'COMPRAS_RED_VER', 'COMPRAS_RED_GESTIONAR',
  'COMPRAS_REQUISICIONES_VER', 'COMPRAS_REQUISICIONES_GESTIONAR',
  'COMPRAS_ORDENES_VER', 'COMPRAS_ORDENES_GESTIONAR',
  'COMPRAS_ENTRADAS_VER', 'COMPRAS_ENTRADAS_GESTIONAR', 'COMPRAS_ENTRADAS_VALIDAR',
  'COMPRAS_360_VER', 'COMPRAS_COSTO_NETO_VER',
  'COMPRAS_DESCUENTOS_VER', 'COMPRAS_DESCUENTOS_GESTIONAR',
  'COMPRAS_HALLAZGOS_VER', 'COMPRAS_HALLAZGOS_GESTIONAR',
  'COMPRAS_PROVEEDORES_VER', 'COMPRAS_PROVEEDORES_GESTIONAR',
  'COMPRAS_CATEGORIAS_VER', 'COMPRAS_CATEGORIAS_GESTIONAR',
];

exports.up = async function (knex) {
  const grant = ALL.reduce((o, k) => ((o[k] = true), o), {});
  // WHERE = tiene al menos un COMPRAS_* en true (rol que opera Compras).
  const anyTrue = ALL.map((k) => `COALESCE((permissions->>'${k}')::boolean, false)`).join(' OR ');
  const res = await knex.raw(
    `UPDATE role_permissions SET permissions = permissions || ?::jsonb WHERE ${anyTrue}`,
    [JSON.stringify(grant)],
  );
  console.log(`[compras_grant_full] roles con acceso a Compras → 21 permisos: ${res.rowCount ?? 0}`);
};

/** @param { import("knex").Knex } knex — no revierte (no hay estado previo por-rol que restaurar). */
exports.down = async function () {
  console.log('[compras_grant_full] down: no-op (grant no reversible sin snapshot previo)');
};
