/**
 * HOTFIX — Backfill de permisos de roles (drift enum vs prod) + otorgar acceso a
 * reportes de Venta + Almacén/Movimientos a los roles operativos que hoy dan 403.
 *
 * Contexto: keys de permiso agregadas después de crear cada rol nunca se
 * backfillearon → quedaron AUSENTES en el JSONB → RolesGuard las trata como false
 * → 403 en /almacen/movimientos (COMMERCIAL_INVENTORY_VER), sell-out, salidas,
 * histórico, etc. Patrón conocido (memoria: "Permiso seed ausente prod").
 *
 * Este backfill hace DOS cosas, ambas NO-destructivas (nunca baja un true existente):
 *   1. Completa en TODOS los roles cualquier key del enum que falte, con valor false.
 *   2. Otorga (pone true) el bundle de reportes de venta + movimientos/traspasos a
 *      los roles que el usuario autorizó.
 *
 * Idempotente: re-correr no cambia nada (keys ya presentes, grants ya en true).
 * Corre como owner (postgres bypassa RLS de public.role_permissions). Multi-tenant:
 * recorre TODAS las filas (todos los tenants). Requiere re-login para tomar efecto
 * (el JWT lleva permisos snapshot).
 *
 * @param { import("knex").Knex } knex
 */

// Set completo de permisos (enum Permission). admin/superadmin ya lo tienen entero.
const ENUM = [
  'USUARIOS_VER','USUARIOS_GESTIONAR','USUARIOS_PASSWORDS','USUARIOS_ASIGNAR_RUTA',
  'REPORTES_VER_PROPIO','REPORTES_VER_EQUIPO','REPORTES_VER_GLOBAL','REPORTES_EXPORTAR','REPORTES_GESTIONAR',
  'VISITAS_REGISTRAR','VISITAS_VER','VISITAS_AUDITAR',
  'CATALOGO_GESTIONAR','PLANOGRAMAS_GESTIONAR','TIENDAS_VER','TIENDAS_CREAR','ROLES_CONFIGURAR',
  'SCORING_CONFIG_VER','SCORING_CONFIG_GESTIONAR','VER_SEGUIMIENTO','RUTAS_VER',
  'COMMERCIAL_MAP_VER','COMMERCIAL_MAP_PROSPECTS_VER','COMMERCIAL_MAP_PROSPECTS_GESTIONAR',
  'SUPERVISOR_AI_VER','SUPERVISOR_AI_APROBAR',
  'STORE_LIVE_VER','STORE_LABELS_VER','STORE_ARQUEO_CAPTURAR','STORE_ARQUEO_VER','STORE_ANALYTICS_VER',
  'COMMERCIAL_CUSTOMERS_VER','COMMERCIAL_CUSTOMERS_GESTIONAR',
  'COMMERCIAL_WAREHOUSES_VER','COMMERCIAL_WAREHOUSES_GESTIONAR','COMMERCIAL_PRICING_VER','COMMERCIAL_PRICING_GESTIONAR',
  'COMMERCIAL_INVENTORY_VER','COMMERCIAL_INVENTORY_AJUSTAR','COMMERCIAL_INVENTORY_CONTAR',
  'COMMERCIAL_INVENTORY_SUPERVISAR','COMMERCIAL_INVENTORY_RECONCILIAR','COMMERCIAL_INVENTORY_ASIGNAR',
  'COMMERCIAL_ORDERS_VER','COMMERCIAL_ORDERS_CREAR','COMMERCIAL_ORDERS_CONFIRMAR','COMMERCIAL_ORDERS_CANCELAR','COMMERCIAL_ORDERS_FULFILL',
  'COMMERCIAL_PAYMENTS_REGISTRAR','COMMERCIAL_PAYMENTS_VERIFICAR','COMMERCIAL_PAYMENTS_REVERSAR','COMMERCIAL_RIDER_LIQUIDATION_GESTIONAR',
  'COMMERCIAL_PROMOTIONS_VER','COMMERCIAL_PROMOTIONS_GESTIONAR',
  'COMMERCIAL_TELEVENTA_VER','COMMERCIAL_TELEVENTA_OPERATE',
  'CAPTURE_TICKET_USE','VENDOR_APP_ACCESS','ROUTE_TICKET_CAPTURE','ROUTE_CONTROL_VER',
  'LOGISTICS_FLEET_VER','LOGISTICS_FLEET_GESTIONAR','LOGISTICS_SHIPMENTS_VER','LOGISTICS_SHIPMENTS_GESTIONAR',
  'LOGISTICS_GUIDES_VER','LOGISTICS_GUIDES_GESTIONAR','LOGISTICS_HOME_DISPATCH',
  'LOGISTICS_EXPENSES_VER','LOGISTICS_EXPENSES_GESTIONAR','LOGISTICS_PAYROLL_VER','LOGISTICS_PAYROLL_GESTIONAR',
  'LOGISTICS_CONFIG_GESTIONAR','LOGISTICS_CARTAPORTE_VER','LOGISTICS_CARTAPORTE_GESTIONAR',
  'ROLES_VER','COMMERCIAL_ANALYTICS_VER','COMMERCIAL_SELLOUT_VER','COMMERCIAL_SALIDAS_VER','COMMERCIAL_ROUTE_SALES_VER',
  'COMMERCIAL_CUSTOMERS360_VER','COMMERCIAL_HISTORICAL_VER','COMMERCIAL_DEADSTOCK_VER','COMMERCIAL_INVHEALTH_VER',
  'COMMERCIAL_ERP_PROMOS_VER','COMMERCIAL_VENDOR_SALES_VER','COMMERCIAL_CARTERA_VER','COMMERCIAL_CARTERA_GESTIONAR',
  'COMMERCIAL_PRODUCTS_VER','COMMERCIAL_PRODUCTS_GESTIONAR','COMMERCIAL_THOT_VER','COMMERCIAL_THOT_GESTIONAR',
  'TRADE_ROUTE_PLAN_VER','TRADE_ROUTE_PLAN_GESTIONAR','LOGISTICS_TRANSFERS_VER','PORTAL_B2B_ACCESS',
  'FINANCE_EXPENSES_VER','FINANCE_AI_CHAT','FINANCE_FINDINGS_GESTIONAR',
  'RECONCILIATION_VER','RECONCILIATION_GESTIONAR','COMPRAS_VER','COMPRAS_GESTIONAR',
];

// Reportes de venta (dashboards de solo-lectura). El Command Center y los reportes
// no filtran por canal → cubren venta Kepler + Wincaja.
const SALES_REPORTS = [
  'COMMERCIAL_ANALYTICS_VER', 'COMMERCIAL_SELLOUT_VER', 'COMMERCIAL_SALIDAS_VER',
  'COMMERCIAL_ROUTE_SALES_VER', 'COMMERCIAL_HISTORICAL_VER', 'COMMERCIAL_DEADSTOCK_VER',
  'COMMERCIAL_INVHEALTH_VER', 'COMMERCIAL_CUSTOMERS360_VER',
];
// Almacén: ver inventario + Diario de movimientos + traspasos.
const WAREHOUSE_READ = ['COMMERCIAL_INVENTORY_VER', 'LOGISTICS_TRANSFERS_VER'];

// Otorgado por rol (autorizado por el usuario 2026-07-13).
const GRANTS = {
  gerente_de_zona: [...SALES_REPORTS, ...WAREHOUSE_READ],
  jefe_de_tienda: [...SALES_REPORTS, ...WAREHOUSE_READ],
  rutas: [...SALES_REPORTS, ...WAREHOUSE_READ],
  telemarketing: [...SALES_REPORTS], // sin movimientos de almacén (indicado por el usuario)
  compras: [...SALES_REPORTS],       // ya tiene inventario/compras; suma reportes de venta
};

exports.up = async function (knex) {
  const rows = await knex('public.role_permissions').select('tenant_id', 'role_name', 'permissions');
  let touched = 0;
  for (const row of rows) {
    const p = { ...(row.permissions || {}) };
    let changed = false;

    // 1. Completar keys ausentes → false (nunca baja un true existente).
    for (const k of ENUM) {
      if (!(k in p)) { p[k] = false; changed = true; }
    }
    // 2. Otorgar el bundle autorizado (solo sube a true).
    const grant = GRANTS[row.role_name];
    if (grant) {
      for (const k of grant) {
        if (p[k] !== true) { p[k] = true; changed = true; }
      }
    }

    if (changed) {
      await knex('public.role_permissions')
        .where({ tenant_id: row.tenant_id, role_name: row.role_name })
        .update({ permissions: JSON.stringify(p) });
      touched++;
    }
  }
  console.log(`[backfill_role_perms] roles actualizados: ${touched}/${rows.length}`);
};

exports.down = async function () {
  // no-op: el backfill solo agregó keys ausentes (false) y subió grants a true.
  // Revertir bajaría permisos ya otorgados; no es seguro deshacer automáticamente.
};
