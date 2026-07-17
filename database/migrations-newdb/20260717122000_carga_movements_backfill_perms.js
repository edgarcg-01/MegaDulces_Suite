/**
 * Independencia de módulos — Carga al camión + Diario de movimientos como features
 * propias. Sus endpoints dejaron de pedir COMMERCIAL_ORDERS_* / COMMERCIAL_INVENTORY_*
 * y ahora piden permisos propios. Backfill para no perder acceso (target ← source):
 *
 *   - COMMERCIAL_CARGA_VER        ← COMMERCIAL_ORDERS_VER      (GET load-status)
 *   - COMMERCIAL_CARGA_GESTIONAR  ← COMMERCIAL_ORDERS_FULFILL  (PUT/bulk load-status)
 *   - COMMERCIAL_MOVEMENTS_VER    ← COMMERCIAL_INVENTORY_VER   (diario de movimientos)
 *   - COMMERCIAL_MOVEMENTS_GESTIONAR ← COMMERCIAL_INVENTORY_SUPERVISAR (marcar auditado)
 *
 * customer_b2b (externo) NO hereda (internalOnly). Idempotente (`-> 'KEY' IS NULL`),
 * aditivo (no borra el permiso viejo). Re-login para el gating de UI.
 *
 * @param { import("knex").Knex } knex
 */
exports.up = async function (knex) {
  const derived = [
    { key: 'COMMERCIAL_CARGA_VER', from: 'COMMERCIAL_ORDERS_VER' },
    { key: 'COMMERCIAL_CARGA_GESTIONAR', from: 'COMMERCIAL_ORDERS_FULFILL' },
    { key: 'COMMERCIAL_MOVEMENTS_VER', from: 'COMMERCIAL_INVENTORY_VER' },
    { key: 'COMMERCIAL_MOVEMENTS_GESTIONAR', from: 'COMMERCIAL_INVENTORY_SUPERVISAR' },
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
  console.log(`[carga_movements_backfill_perms] up: filas actualizadas = ${total}`);
};

/**
 * Revierte: quita las 4 claves. Idempotente.
 * @param { import("knex").Knex } knex
 */
exports.down = async function (knex) {
  for (const k of ['COMMERCIAL_CARGA_VER', 'COMMERCIAL_CARGA_GESTIONAR', 'COMMERCIAL_MOVEMENTS_VER', 'COMMERCIAL_MOVEMENTS_GESTIONAR']) {
    await knex.raw(
      `UPDATE role_permissions SET permissions = permissions - :k::text WHERE permissions -> :k::text IS NOT NULL`,
      { k },
    );
  }
  console.log('[carga_movements_backfill_perms] down: claves removidas');
};
