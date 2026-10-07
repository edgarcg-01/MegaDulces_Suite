/**
 * Backfill de las claves de permiso de Comercial / Logística / Televenta /
 * Captura-OCR en role_permissions (JSONB) para la DB legacy.
 *
 * Contexto: el enum `Permission` creció con las fases B/C/D/E/J/V
 * (COMMERCIAL_*, LOGISTICS_*, COMMERCIAL_TELEVENTA_*, CAPTURE_TICKET_USE),
 * pero los roles seedeados originalmente solo tenían las claves de Trade
 * Marketing + las viejas LOG_* (ya removidas por 20260522104500). Resultado:
 * todo rol sin `manage:all` (es decir, todos salvo superadmin/admin que
 * entran por REPORTES_VER_GLOBAL) recibía 403 en los módulos comerciales y
 * de logística porque la clave ni siquiera existía en su JSONB.
 *
 * Asignación canónica (espejo de seeds/00_roles.js y seeds-newdb/02_...):
 *   - superadmin / admin → todas las nuevas claves en true.
 *   - supervisor / supervisor_v → lectura comercial + gestión de pedidos del
 *     equipo (confirmar/cancelar/fulfill) + ver promociones + ver televenta.
 *   - Jefe_M → lectura comercial + gestión de promociones (marketing).
 *   - colaborador / ejecutivo → vendedor de campo: lectura + crear pedido +
 *     registrar cobro.
 *
 * IDEMPOTENTE: para cada (rol, clave) solo escribe si la clave NO existe aún
 * (`permissions -> 'KEY' IS NULL`). Nunca pisa un valor true/false puesto
 * manualmente vía /admin/roles. Roles fuera del mapa (creados a mano) no se
 * tocan.
 *
 * @param { import("knex").Knex } knex
 * @returns { Promise<void> }
 */

// Claves de los namespaces nuevos (las únicas que esta migración gestiona).
const NEW_KEYS = [
  // Comercial
  'COMMERCIAL_CUSTOMERS_VER',
  'COMMERCIAL_CUSTOMERS_GESTIONAR',
  'COMMERCIAL_WAREHOUSES_VER',
  'COMMERCIAL_WAREHOUSES_GESTIONAR',
  'COMMERCIAL_PRICING_VER',
  'COMMERCIAL_PRICING_GESTIONAR',
  'COMMERCIAL_INVENTORY_VER',
  'COMMERCIAL_INVENTORY_AJUSTAR',
  'COMMERCIAL_ORDERS_VER',
  'COMMERCIAL_ORDERS_CREAR',
  'COMMERCIAL_ORDERS_CONFIRMAR',
  'COMMERCIAL_ORDERS_CANCELAR',
  'COMMERCIAL_ORDERS_FULFILL',
  'COMMERCIAL_PAYMENTS_REGISTRAR',
  'COMMERCIAL_PROMOTIONS_VER',
  'COMMERCIAL_PROMOTIONS_GESTIONAR',
  'COMMERCIAL_TELEVENTA_VER',
  'COMMERCIAL_TELEVENTA_OPERATE',
  // Captura con OCR
  'CAPTURE_TICKET_USE',
  // Logística
  'LOGISTICS_FLEET_VER',
  'LOGISTICS_FLEET_GESTIONAR',
  'LOGISTICS_SHIPMENTS_VER',
  'LOGISTICS_SHIPMENTS_GESTIONAR',
  'LOGISTICS_GUIDES_VER',
  'LOGISTICS_GUIDES_GESTIONAR',
  'LOGISTICS_EXPENSES_VER',
  'LOGISTICS_EXPENSES_GESTIONAR',
  'LOGISTICS_PAYROLL_VER',
  'LOGISTICS_PAYROLL_GESTIONAR',
  'LOGISTICS_CONFIG_GESTIONAR',
];

const trueSet = (keys) => Object.fromEntries(keys.map((k) => [k, true]));

const ALL_TRUE = trueSet(NEW_KEYS);

const SUPERVISOR = trueSet([
  'COMMERCIAL_CUSTOMERS_VER',
  'COMMERCIAL_WAREHOUSES_VER',
  'COMMERCIAL_PRICING_VER',
  'COMMERCIAL_INVENTORY_VER',
  'COMMERCIAL_ORDERS_VER',
  'COMMERCIAL_ORDERS_CONFIRMAR',
  'COMMERCIAL_ORDERS_CANCELAR',
  'COMMERCIAL_ORDERS_FULFILL',
  'COMMERCIAL_PROMOTIONS_VER',
  'COMMERCIAL_TELEVENTA_VER',
]);

const JEFE_MARKETING = trueSet([
  'COMMERCIAL_CUSTOMERS_VER',
  'COMMERCIAL_PRICING_VER',
  'COMMERCIAL_ORDERS_VER',
  'COMMERCIAL_PROMOTIONS_VER',
  'COMMERCIAL_PROMOTIONS_GESTIONAR',
]);

const FIELD = trueSet([
  'COMMERCIAL_CUSTOMERS_VER',
  'COMMERCIAL_PRICING_VER',
  'COMMERCIAL_INVENTORY_VER',
  'COMMERCIAL_ORDERS_VER',
  'COMMERCIAL_ORDERS_CREAR',
  'COMMERCIAL_PAYMENTS_REGISTRAR',
]);

// rol → valores deseados de las claves nuevas (las no listadas = false).
// Nombres canónicos snake_case + aliases legacy (`supervisor_v`, `Jefe_M`)
// por si quedan instancias viejas en alguna DB; los ausentes se omiten.
const ROLE_GRANTS = {
  superadmin: ALL_TRUE,
  admin: ALL_TRUE,
  supervisor: SUPERVISOR,
  supervisor_ventas: SUPERVISOR,
  jefe_marketing: JEFE_MARKETING,
  colaborador: FIELD,
  ejecutivo: FIELD,
  // aliases legacy deprecados
  supervisor_v: SUPERVISOR,
  Jefe_M: JEFE_MARKETING,
};

exports.up = async function (knex) {
  for (const [roleName, grants] of Object.entries(ROLE_GRANTS)) {
    const role = await knex('role_permissions')
      .where({ role_name: roleName })
      .first();
    if (!role) {
      console.log(
        `[backfill_commercial_logistics] rol "${roleName}" no existe, skip.`,
      );
      continue;
    }

    let added = 0;
    for (const key of NEW_KEYS) {
      const value = grants[key] === true;
      const patch = JSON.stringify({ [key]: value });
      const result = await knex.raw(
        `UPDATE role_permissions
           SET permissions = permissions || :patch::jsonb
         WHERE role_name = :roleName
           AND permissions -> :key IS NULL`,
        { patch, roleName, key },
      );
      added += result.rowCount ?? 0;
    }
    console.log(
      `[backfill_commercial_logistics] "${roleName}": ${added} clave(s) agregadas.`,
    );
  }
};

/**
 * @param { import("knex").Knex } knex
 * @returns { Promise<void> }
 */
exports.down = async function (knex) {
  // No-op: revertir removería claves de las que ya podría depender la
  // autorización en runtime. Si fuera necesario, hacerlo manualmente con
  // `permissions - 'KEY'`.
  console.log('[backfill_commercial_logistics] down: no-op.');
};
