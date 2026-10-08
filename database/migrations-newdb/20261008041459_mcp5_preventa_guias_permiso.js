'use strict';
/**
 * `[MCP.5]` — Reparto de `PREVENTA_GUIAS_GESTIONAR` (Fase MCP, ADR-089).
 *
 * La guía de carga de preventa la imprime la CAJERA (decisión de Francisco, D8: "la cajera imprime
 * la guía y la firma el repartidor"), y en MCP.7 la misma caja recibe contra ella la liquidación.
 *
 * ── Lo medido en prod antes de escribir esto (solo lectura, 2026-10-08) ─────────────────────────
 *  · `cajero` (19 personas activas) NO tiene ninguna clave de pedidos: sólo STORE_ARQUEO_CAPTURAR.
 *  · STORE_ARQUEO_CAPTURAR = true en cajero, auxiliar_tienda, encargado_tienda, piso_tienda (1
 *    persona; también cuenta caja, así que también imprime la guía) y superadmin.
 *  · `superadmin`/`admin` NO se escriben: entran por nombre de rol (ADR-054).
 *
 * ── Qué hace ────────────────────────────────────────────────────────────────────────────────────
 * DERIVA el reparto del estado vivo: todo rol con STORE_ARQUEO_CAPTURAR = true recibe la clave
 * ("quien cuenta la caja imprime la guía"), sin una lista de roles escrita a mano que envejezca.
 * Sólo pone `true` si la clave NO existe en el mapa (`permissions -> 'X' IS NULL`, no el operador
 * `?`). Un `false` explícito —puesto por un humano desde /admin/roles— se respeta y se reporta.
 *
 * El ALCANCE no se toca: cajero, auxiliar y encargado de tienda ya traen warehouse:own, así que
 * cada caja ve las guías de su sucursal.
 *
 * Idempotente.
 *
 * @param { import("knex").Knex } knex
 */

const CLAVE = 'PREVENTA_GUIAS_GESTIONAR';
const FUENTE = 'STORE_ARQUEO_CAPTURAR';

exports.up = async function up(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);
  const tenant = (await knex.raw(`SELECT id FROM identity.tenants WHERE slug = 'mega_dulces'`)).rows[0]?.id;
  if (!tenant) {
    console.log('  [MCP.5] ◻ NO APLICA: no existe el tenant mega_dulces en esta base.');
    return;
  }

  const r = await knex.raw(
    `UPDATE identity.role_permissions
        SET permissions = permissions || jsonb_build_object(?::text, true), updated_at = now()
      WHERE tenant_id = ? AND deleted_at IS NULL
        AND lower(role_name) NOT IN ('superadmin', 'admin')
        AND (permissions -> ?)::text = 'true'
        AND permissions -> ? IS NULL
      RETURNING role_name`,
    [CLAVE, tenant, FUENTE, CLAVE],
  );
  console.log(`  [MCP.5] ${CLAVE} → ${r.rows.map((x) => x.role_name).join(', ') || '(ningún rol nuevo)'}`);

  // Un false explícito en un rol que cuenta la caja se respeta, pero se dice en voz alta.
  const conFalse = await knex.raw(
    `SELECT role_name FROM identity.role_permissions
      WHERE tenant_id = ? AND deleted_at IS NULL
        AND (permissions -> ?)::text = 'true'
        AND (permissions -> ?)::text = 'false'`,
    [tenant, FUENTE, CLAVE],
  );
  if (conFalse.rows.length) {
    console.log(`  ⚠️ [MCP.5] siguen en false explícito: ${conFalse.rows.map((x) => x.role_name).join(', ')}`);
  }
};

exports.down = async function down(knex) {
  const tenant = (await knex.raw(`SELECT id FROM identity.tenants WHERE slug = 'mega_dulces'`)).rows[0]?.id;
  if (!tenant) return;
  // Sólo donde está en true: un false puesto a mano no se borra.
  await knex.raw(
    `UPDATE identity.role_permissions SET permissions = permissions - ?::text, updated_at = now()
      WHERE tenant_id = ? AND (permissions -> ?)::text = 'true'`,
    [CLAVE, tenant, CLAVE],
  );
};
