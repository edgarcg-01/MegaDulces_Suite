/**
 * V.1 — Backfill: el vendedor de campo gestiona su cartera de punta a punta.
 * Otorga a los roles de campo el ciclo completo del pedido:
 *   - COMMERCIAL_ORDERS_CONFIRMAR  (aprobar preventa: pending_approval → confirmed)
 *   - COMMERCIAL_ORDERS_FULFILL    (marcar entregado en campo: confirmed → fulfilled)
 *   - COMMERCIAL_ORDERS_CANCELAR   (cancelar liberando reservas)
 *
 * El seed 00_roles.js ya los incluye en FIELD_PERMS, pero el re-seed NO pisa
 * roles ya existentes, así que estas keys quedaron en `false` (o ausentes en el
 * `vendedor` que solo vive en prod). Este backfill las activa en los roles vivos.
 *
 * Idempotente: merge `||` (sobrescribe) guardado por containment `@>` — solo
 * actualiza filas que aún NO tienen las 3 en true. Las 3 keys ya están mapeadas
 * en ability.factory (no hay riesgo de 403 por subject/action faltante).
 *
 * NOTA: el permiso vive en el JWT — los vendedores afectados deben re-loguear
 * para que el cambio surta efecto.
 *
 * @param { import("knex").Knex } knex
 */
exports.up = async function (knex) {
  const roles = ['colaborador', 'ejecutivo', 'vendedor'];
  const patch = JSON.stringify({
    COMMERCIAL_ORDERS_CONFIRMAR: true,
    COMMERCIAL_ORDERS_FULFILL: true,
    COMMERCIAL_ORDERS_CANCELAR: true,
  });
  const result = await knex.raw(
    `UPDATE role_permissions
        SET permissions = permissions || :patch::jsonb
      WHERE role_name = ANY(:roles)
        AND NOT (permissions @> :patch::jsonb)`,
    { patch, roles },
  );
  console.log(
    `[field_roles_order_lifecycle_perms] ciclo de pedido otorgado a ${result.rowCount ?? 0} rol(es) de campo.`,
  );
};

/**
 * @param { import("knex").Knex } knex
 */
exports.down = async function () {
  // No-op: revertir dejaría al vendedor sin aprobar/entregar a mitad de operación.
  console.log('[field_roles_order_lifecycle_perms] down: no-op');
};
