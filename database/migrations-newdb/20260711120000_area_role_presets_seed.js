/**
 * Seed de 13 roles por ÁREA (organigrama Mega Dulces) — ver
 * `apps/view/src/app/core/constants/role-presets.ts` (fuente única del modelo).
 *
 * Modelo: 1 rol por área, permisos en 2 niveles (PRIMARIO ver+gestionar,
 * SECUNDARIO ver+gestionar salvo `prevencion_auditoria` = solo-ver global;
 * `sistemas` = acceso total). Conviven con los roles existentes (ON CONFLICT
 * DO NOTHING: no pisa un rol ya creado). role_name en minúscula snake_case.
 *
 * Idempotente. Se aplica a TODOS los tenants existentes.
 *
 * @param { import("knex").Knex } knex
 */
const MODULE_GROUPS = {
  usuarios: ['USUARIOS_VER', 'USUARIOS_GESTIONAR', 'USUARIOS_PASSWORDS', 'USUARIOS_ASIGNAR_RUTA'],
  roles: ['ROLES_VER', 'ROLES_CONFIGURAR'],
  trade: ['VISITAS_REGISTRAR', 'VISITAS_VER', 'VISITAS_AUDITAR', 'REPORTES_VER_PROPIO', 'REPORTES_VER_EQUIPO', 'REPORTES_VER_GLOBAL', 'REPORTES_EXPORTAR', 'REPORTES_GESTIONAR', 'CATALOGO_GESTIONAR', 'PLANOGRAMAS_GESTIONAR', 'TIENDAS_VER', 'TIENDAS_CREAR', 'SCORING_CONFIG_VER', 'SCORING_CONFIG_GESTIONAR', 'VER_SEGUIMIENTO', 'TRADE_ROUTE_PLAN_VER', 'TRADE_ROUTE_PLAN_GESTIONAR'],
  rutas: ['RUTAS_VER', 'COMMERCIAL_MAP_VER', 'COMMERCIAL_MAP_PROSPECTS_VER', 'COMMERCIAL_MAP_PROSPECTS_GESTIONAR', 'ROUTE_CONTROL_VER', 'ROUTE_TICKET_CAPTURE', 'COMMERCIAL_VENDOR_SALES_VER'],
  supervisor_ai: ['SUPERVISOR_AI_VER', 'SUPERVISOR_AI_APROBAR'],
  tienda: ['STORE_LIVE_VER', 'STORE_LABELS_VER'],
  comercial: ['COMMERCIAL_CUSTOMERS_VER', 'COMMERCIAL_CUSTOMERS_GESTIONAR', 'COMMERCIAL_PRICING_VER', 'COMMERCIAL_PRICING_GESTIONAR', 'COMMERCIAL_PRODUCTS_VER', 'COMMERCIAL_PRODUCTS_GESTIONAR', 'COMMERCIAL_CARTERA_VER', 'COMMERCIAL_CARTERA_GESTIONAR', 'COMMERCIAL_ORDERS_VER', 'COMMERCIAL_ORDERS_CREAR', 'COMMERCIAL_ORDERS_CONFIRMAR', 'COMMERCIAL_ORDERS_CANCELAR', 'COMMERCIAL_ORDERS_FULFILL', 'COMMERCIAL_PROMOTIONS_VER', 'COMMERCIAL_PROMOTIONS_GESTIONAR', 'COMMERCIAL_ERP_PROMOS_VER', 'COMMERCIAL_THOT_VER', 'COMMERCIAL_THOT_GESTIONAR'],
  pagos: ['COMMERCIAL_PAYMENTS_REGISTRAR', 'COMMERCIAL_PAYMENTS_VERIFICAR', 'COMMERCIAL_PAYMENTS_REVERSAR', 'COMMERCIAL_RIDER_LIQUIDATION_GESTIONAR'],
  analytics: ['COMMERCIAL_ANALYTICS_VER', 'COMMERCIAL_SELLOUT_VER', 'COMMERCIAL_SALIDAS_VER', 'COMMERCIAL_ROUTE_SALES_VER', 'COMMERCIAL_CUSTOMERS360_VER', 'COMMERCIAL_HISTORICAL_VER', 'COMMERCIAL_DEADSTOCK_VER', 'COMMERCIAL_INVHEALTH_VER'],
  almacen: ['COMMERCIAL_INVENTORY_VER', 'COMMERCIAL_INVENTORY_AJUSTAR', 'COMMERCIAL_INVENTORY_CONTAR', 'COMMERCIAL_INVENTORY_SUPERVISAR', 'COMMERCIAL_INVENTORY_RECONCILIAR', 'COMMERCIAL_INVENTORY_ASIGNAR', 'COMMERCIAL_WAREHOUSES_VER', 'COMMERCIAL_WAREHOUSES_GESTIONAR'],
  cuadre: ['RECONCILIATION_VER', 'RECONCILIATION_GESTIONAR'],
  compras: ['COMPRAS_VER', 'COMPRAS_GESTIONAR'],
  logistica: ['LOGISTICS_FLEET_VER', 'LOGISTICS_FLEET_GESTIONAR', 'LOGISTICS_SHIPMENTS_VER', 'LOGISTICS_SHIPMENTS_GESTIONAR', 'LOGISTICS_GUIDES_VER', 'LOGISTICS_GUIDES_GESTIONAR', 'LOGISTICS_EXPENSES_VER', 'LOGISTICS_EXPENSES_GESTIONAR', 'LOGISTICS_CONFIG_GESTIONAR', 'LOGISTICS_CARTAPORTE_VER', 'LOGISTICS_CARTAPORTE_GESTIONAR', 'LOGISTICS_TRANSFERS_VER'],
  nomina: ['LOGISTICS_PAYROLL_VER', 'LOGISTICS_PAYROLL_GESTIONAR'],
  reparto: ['LOGISTICS_HOME_DISPATCH'],
  televenta: ['COMMERCIAL_TELEVENTA_VER', 'COMMERCIAL_TELEVENTA_OPERATE'],
  finanzas: ['FINANCE_EXPENSES_VER', 'FINANCE_AI_CHAT', 'FINANCE_FINDINGS_GESTIONAR'],
};

const ALL_GROUPS = Object.keys(MODULE_GROUPS);

const AREA_PRESETS = [
  { role: 'sistemas', primary: ['usuarios', 'roles'], secondary: [], all: true },
  { role: 'contabilidad', primary: ['finanzas'], secondary: ['compras', 'analytics', 'logistica'] },
  { role: 'compras', primary: ['compras'], secondary: ['almacen', 'analytics'] },
  { role: 'mercadotecnia', primary: ['trade', 'analytics'], secondary: ['rutas', 'comercial'] },
  { role: 'credito_cobranza', primary: ['comercial', 'pagos'], secondary: ['finanzas', 'analytics'] },
  { role: 'prevencion_auditoria', primary: ['supervisor_ai', 'cuadre'], secondary: ALL_GROUPS.filter((g) => g !== 'supervisor_ai' && g !== 'cuadre'), secondaryMode: 'ver' },
  { role: 'tesoreria', primary: ['finanzas', 'pagos', 'reparto'], secondary: ['cuadre', 'analytics'] },
  { role: 'finanzas', primary: ['finanzas'], secondary: ['compras', 'analytics', 'logistica'] },
  { role: 'rh', primary: ['usuarios', 'nomina'], secondary: [] },
  { role: 'sucursal', primary: ['tienda', 'almacen'], secondary: ['cuadre', 'analytics'] },
  { role: 'cedis', primary: ['almacen', 'logistica', 'compras'], secondary: ['analytics'] },
  { role: 'rutas', primary: ['rutas'], secondary: ['comercial'] },
  { role: 'telemarketing', primary: ['televenta'], secondary: ['comercial'] },
];

const verOnly = (perms) => perms.filter((p) => p.endsWith('_VER'));

function resolveMap(preset) {
  const set = new Set();
  const groups = preset.all ? ALL_GROUPS : preset.primary;
  for (const g of groups) for (const p of MODULE_GROUPS[g] || []) set.add(p);
  if (!preset.all) {
    for (const g of preset.secondary) {
      const perms = MODULE_GROUPS[g] || [];
      for (const p of preset.secondaryMode === 'ver' ? verOnly(perms) : perms) set.add(p);
    }
  }
  const out = {};
  for (const p of set) out[p] = true;
  return out;
}

exports.up = async function (knex) {
  const tenants = await knex('tenants').select('id');
  for (const { id: tenantId } of tenants) {
    for (const preset of AREA_PRESETS) {
      const permissions = resolveMap(preset);
      const res = await knex.raw(
        `INSERT INTO role_permissions (id, tenant_id, role_name, permissions)
         VALUES (gen_random_uuid(), ?, ?, ?::jsonb)
         ON CONFLICT (tenant_id, role_name) DO NOTHING`,
        [tenantId, preset.role, JSON.stringify(permissions)],
      );
      console.log(`[area_role_presets] ${preset.role} @ ${tenantId}: ${res.rowCount ? 'creado' : 'ya existía (skip)'} (${Object.keys(permissions).length} perms)`);
    }
  }
};

/** down: elimina SOLO los roles seed que no tengan usuarios asignados. */
exports.down = async function (knex) {
  const names = AREA_PRESETS.map((p) => p.role);
  await knex.raw(
    `DELETE FROM role_permissions rp
      WHERE rp.role_name = ANY(?)
        AND NOT EXISTS (SELECT 1 FROM users u WHERE u.role_name = rp.role_name AND u.tenant_id = rp.tenant_id)`,
    [names],
  );
};
