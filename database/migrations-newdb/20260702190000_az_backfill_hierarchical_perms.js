/**
 * Fase AZ — Backfill de los permisos jerárquicos nuevos hacia los roles vivos.
 *
 * Al partir permisos que antes gateaban varios módulos (ver
 * docs/IMPLEMENTACION/FASES/FASE_AZ_AUTHZ_JERARQUICO.md §6), cada rol debe recibir
 * los permisos DERIVADOS del permiso viejo que ya tenía, para NO perder acceso.
 * Regla: `nuevo = valor del permiso origen que lo gateaba`, por rol.
 *
 * Excepción de seguridad: `customer_b2b` (rol EXTERNO del Portal B2B) tiene
 * COMMERCIAL_ORDERS_VER sólo para ver SUS pedidos (scoped). NO debe heredar
 * COMMERCIAL_ANALYTICS_VER / LOGISTICS_TRANSFERS_VER (analítica interna del tenant).
 *
 * Idempotente: cada clave se escribe sólo si aún no existe (`-> 'KEY' IS NULL`,
 * NO el operador `?` que knex no escapa). No borra nada. Los permisos viejos se
 * conservan (se retiran en F4). Los permisos viajan en el JWT → re-login para el
 * gating de UI; la autz backend es fresca (cache 30s).
 *
 * @param { import("knex").Knex } knex
 */
exports.up = async function (knex) {
  // nuevo ← origen. internalOnly = no derivar para customer_b2b (externo).
  const derived = [
    { key: 'COMMERCIAL_ANALYTICS_VER', from: 'COMMERCIAL_ORDERS_VER', internalOnly: true },
    { key: 'LOGISTICS_TRANSFERS_VER', from: 'COMMERCIAL_ORDERS_VER', internalOnly: true },
    { key: 'COMMERCIAL_CARTERA_VER', from: 'USUARIOS_ASIGNAR_RUTA' },
    { key: 'COMMERCIAL_CARTERA_GESTIONAR', from: 'USUARIOS_ASIGNAR_RUTA' },
    { key: 'TRADE_ROUTE_PLAN_VER', from: 'USUARIOS_ASIGNAR_RUTA' },
    { key: 'TRADE_ROUTE_PLAN_GESTIONAR', from: 'USUARIOS_ASIGNAR_RUTA' },
    { key: 'COMMERCIAL_PRODUCTS_VER', from: 'CATALOGO_GESTIONAR' },
    { key: 'COMMERCIAL_PRODUCTS_GESTIONAR', from: 'CATALOGO_GESTIONAR' },
    { key: 'COMMERCIAL_THOT_VER', from: 'COMMERCIAL_CUSTOMERS_GESTIONAR' },
    { key: 'COMMERCIAL_THOT_GESTIONAR', from: 'COMMERCIAL_CUSTOMERS_GESTIONAR' },
    { key: 'ROLES_VER', from: 'ROLES_CONFIGURAR' },
  ];

  let total = 0;
  for (const d of derived) {
    const valueExpr = d.internalOnly
      ? `CASE WHEN role_name = 'customer_b2b' THEN false
               ELSE COALESCE((permissions->>:from::text)::boolean, false) END`
      : `COALESCE((permissions->>:from::text)::boolean, false)`;
    const res = await knex.raw(
      `UPDATE role_permissions
          SET permissions = permissions || jsonb_build_object(:key::text, ${valueExpr})
        WHERE permissions -> :key::text IS NULL`,
      { key: d.key, from: d.from },
    );
    total += res.rowCount ?? 0;
  }

  // PORTAL_B2B_ACCESS: acceso a la app Portal B2B — deriva del rol, no de un permiso.
  const portal = await knex.raw(
    `UPDATE role_permissions
        SET permissions = permissions || jsonb_build_object('PORTAL_B2B_ACCESS', role_name = 'customer_b2b')
      WHERE permissions -> 'PORTAL_B2B_ACCESS' IS NULL`,
  );
  total += portal.rowCount ?? 0;

  console.log(`[az_backfill_hierarchical_perms] up: filas actualizadas = ${total}`);
};

/**
 * Revierte: quita las 12 claves AZ del JSONB de todos los roles. Idempotente.
 * @param { import("knex").Knex } knex
 */
exports.down = async function (knex) {
  const keys = [
    'COMMERCIAL_ANALYTICS_VER',
    'LOGISTICS_TRANSFERS_VER',
    'COMMERCIAL_CARTERA_VER',
    'COMMERCIAL_CARTERA_GESTIONAR',
    'TRADE_ROUTE_PLAN_VER',
    'TRADE_ROUTE_PLAN_GESTIONAR',
    'COMMERCIAL_PRODUCTS_VER',
    'COMMERCIAL_PRODUCTS_GESTIONAR',
    'COMMERCIAL_THOT_VER',
    'COMMERCIAL_THOT_GESTIONAR',
    'ROLES_VER',
    'PORTAL_B2B_ACCESS',
  ];
  for (const k of keys) {
    await knex.raw(
      `UPDATE role_permissions
          SET permissions = permissions - :k::text
        WHERE permissions -> :k::text IS NOT NULL`,
      { k },
    );
  }
  console.log('[az_backfill_hierarchical_perms] down: claves AZ removidas');
};
