'use strict';
/**
 * `[RE.ETQ.2.4]` — Reparto de `ALMACEN_ETIQUETAS_CAJA` (regla 20: un módulo no está entregado hasta que su
 * permiso está repartido en prod).
 *
 * ✅ **Confirmado por Sistemas el 2026-11-19**: los 4 roles de `REPARTO` (21 personas medidas ese día). Va por ROL:
 * quien se dé de alta después con uno de esos roles la hereda sin tocar nada. Un rol NUEVO no la recibe solo
 * (la clave no se deriva de otras, ADR-054): se le da desde /admin/roles, donde aparece como «Etiquetas de caja
 * (Almacén)».
 *
 * ── Lo medido en prod antes de escribir esto (sólo lectura, 2026-11-19) ────────────────────────
 *  · La recepción de la Suite (Andén) cuelga de COMMERCIAL_INVENTORY_RECIBIR: la tienen `almacenista` (9
 *    personas, en 01/02/03/06 y sin almacén) y `supervisor` (1).
 *  · En Suc 08 (el piloto) no hay ningún `almacenista`: reciben los encargados. `encargado_tienda` = 10 personas
 *    en 01–08; `encargado_bodega` = 1, en el CEDIS 00 (el que más etiqueta: 1,897 cajas al día).
 *  · Ninguno de los 4 roles tiene todavía la clave.
 *  · `superadmin` no se reparte: entra por nombre de rol (ADR-054).
 *
 * ── Qué hace ────────────────────────────────────────────────────────────────────────────────────
 *   Pone la clave en `true` SÓLO si no existe en el mapa del rol (`permissions -> 'X' IS NULL`, no el operador
 *   `?`). Un `false` explícito —puesto por un humano desde /admin/roles— se respeta y se reporta ([LC.6.2]).
 *   El ALCANCE no se toca: cada rol trae el suyo y el servicio lo aplica con ScopeService (cada quien su sucursal).
 *
 * ⚠️ Sólo hace UPDATE (no crea objetos de esquema): la compuerta del despliegue la clasifica NO_MEDIDO. Se aplica
 *    a mano, una por una, ANTES de mergear. Las personas afectadas tienen que volver a entrar (el JWT trae los
 *    permisos).
 *
 * Idempotente.
 *
 * @param { import("knex").Knex } knex
 */

const CLAVE = 'ALMACEN_ETIQUETAS_CAJA';
const REPARTO = ['almacenista', 'encargado_tienda', 'encargado_bodega', 'supervisor'];

exports.up = async function up(knex) {
  await knex.raw(`SET LOCAL lock_timeout = '5s'`);
  const tenant = (await knex.raw(`SELECT id FROM identity.tenants WHERE slug = 'mega_dulces'`)).rows[0]?.id;
  if (!tenant) throw new Error('No se encontró el tenant mega_dulces.');

  const existentes = new Set(
    (
      await knex('identity.role_permissions').where({ tenant_id: tenant }).whereNull('deleted_at').whereIn('role_name', REPARTO).select('role_name')
    ).map((r) => r.role_name),
  );
  const faltan = REPARTO.filter((r) => !existentes.has(r));
  if (faltan.length) console.log(`  ⚠️ [RE.ETQ.2.4] roles que no existen en esta base (se saltan): ${faltan.join(', ')}`);

  for (const rol of REPARTO.filter((r) => existentes.has(r))) {
    const r = await knex.raw(
      `UPDATE identity.role_permissions
          SET permissions = permissions || jsonb_build_object(?::text, true), updated_at = now()
        WHERE tenant_id = ? AND role_name = ? AND deleted_at IS NULL AND permissions -> ? IS NULL
        RETURNING role_name`,
      [CLAVE, tenant, rol, CLAVE],
    );
    console.log(`  [RE.ETQ.2.4] ${rol} → ${r.rows.length ? CLAVE : '(ya la tenía o está en false explícito)'}`);
  }

  const conFalse = await knex.raw(
    `SELECT role_name FROM identity.role_permissions
      WHERE tenant_id = ? AND deleted_at IS NULL AND role_name = ANY(?::text[]) AND (permissions -> ?)::text = 'false'`,
    [tenant, REPARTO, CLAVE],
  );
  if (conFalse.rows.length) {
    console.log(`  ⚠️ [RE.ETQ.2.4] siguen en false explícito: ${conFalse.rows.map((r) => r.role_name).join(', ')}`);
  }
};

/** Quita la clave sólo donde está en `true`: un `false` puesto a mano se respeta igual que en el `up`. */
exports.down = async function down(knex) {
  const tenant = (await knex.raw(`SELECT id FROM identity.tenants WHERE slug = 'mega_dulces'`)).rows[0]?.id;
  if (!tenant) return;
  await knex.raw(
    `UPDATE identity.role_permissions SET permissions = permissions - ?::text, updated_at = now()
      WHERE tenant_id = ? AND (permissions -> ?)::text = 'true'`,
    [CLAVE, tenant, CLAVE],
  );
};
